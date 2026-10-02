import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workflow, type WorkflowDefinition, type WorkflowTerminal } from "@signal-room/workflow";
import { z } from 'zod';
import { b3DesignerContext, b3InspectorContext, briefSchema } from './brief.js';
import {
  check, dependency, isTerminal, listOf, objectSchema, oneOf, stageAgent, str, strList,
  type RoleSpec, type StageModel,
} from './runtime.js';

/**
 * B3 · 成片. The finished piece must carry the B2 script and read well on a phone.
 * Earlier B3 only registered media made elsewhere ("It does not create media"), so the host made every
 * video by hand. Here the deterministic assembly line (voice → frames → index → retime → check → snapshots
 * → render) runs as workflow tasks, a designer agent writes the frame specs inside the episode project,
 * and an inspector agent must actually open the snapshot contact sheets before judging.
 */
export const B3_REVISION = 'b3-v9';
export const b3StandardsPath = fileURLToPath(new URL('./standards/b3.md', import.meta.url));

const segmentSchema = z.object({ time: z.string(), voiceover: z.string().min(1), onScreenText: z.string(), visual: z.string().min(1) });
const scriptSchema = z.object({ title: z.string().min(1), coverText: z.string(), segments: z.array(segmentSchema).min(1) }).passthrough();
type Segment = z.infer<typeof segmentSchema>;
export const b3InputSchema = z.object({
  topicId: z.string().min(1),
  /** The accepted piece brief; it must already carry B2's accepted script. */
  brief: briefSchema.refine(b => !!b.script, 'B3 needs a brief that already contains the accepted B2 script'),
  /** Absolute path of the episode project; created from the template when missing. */
  episodeDir: z.string().refine(p => path.isAbsolute(p), 'episodeDir must be absolute'),
  templateDir: z.string().refine(p => path.isAbsolute(p), 'templateDir must be absolute'),
  /** A finished episode whose frame specs show the account's visual language. */
  referenceDir: z.string().refine(p => path.isAbsolute(p), 'referenceDir must be absolute'),
  scope: z.enum(['sample', 'full']),
  sampleSegments: z.number().int().min(1).max(6),
  voice: z.enum(['placeholder', 'minimax']),
  standards: z.string().min(1),
  maxRevisions: z.number().int().min(0).max(3),
  /** Frame specs the creator already approved in the sample; the designer keeps them unless an inspection names them. */
  keepSpecs: z.array(z.string()).optional(),
  /** The creator's review of the previous cut; its notes are the first fix request and outrank the inspector. */
  humanReview: z.object({ reviewer: z.string().min(1), notes: z.array(z.object({ line: z.string(), fix: z.string() })).min(1) }).strict().optional(),
}).strict();
export type B3Input = z.infer<typeof b3InputSchema>;

const designSchema = z.object({
  files: z.array(z.string()).min(1),
  buildCheckPassed: z.boolean(),
  notes: z.string(),
});
const inspectionSchema = z.object({
  imagesOpened: z.array(z.string()),
  verdict: z.enum(['pass', 'revise', 'blocked']),
  criteria: z.array(z.object({ id: z.string(), result: z.enum(['ok', 'weak', 'fail']), reason: z.string() })).min(1),
  issues: z.array(z.object({ line: z.string(), standard: z.string(), problem: z.string(), fix: z.string() })),
  summary: z.string().min(1),
});
export type Design = z.infer<typeof designSchema>;
export type Inspection = z.infer<typeof inspectionSchema>;

const COMMON = '用中文输出。只返回符合 schema 的 JSON。';

export const B3_ROLES = {
  designer: {
    id: 'b3-designer', title: '画面设计者',
    guards: '把每段稿子做成一帧真正能渲染的画面；B3 不能只登记别处做好的东西。',
    prompt: `你是竖屏科技视频的画面设计者，在给定的视频工程目录（episodeDir）里工作。先读工程里的 frame.md（版式与视觉规范）和给出的参考帧规格（referenceSpecs，账号已发布作品的写法）。你还会收到作品档案里给你的部分：core（这一篇的核心问题、一句话答案、钩子和各节拍的画面想法）和 notesForB3（上游——B2 主编、事实核查、创作者——留给制作的话，必须逐条落实）；第一段画面要把钩子表达出来，全片画面合起来要让观众得到那句一句话答案。然后再为每一行口播写一个帧规格文件 frames-spec/NN-slug.py（NN 与 SCRIPT.md 的 Line 编号一致），格式与参考完全相同：SPEC = dict(kind="shell", name="NN-slug", cid="NN-slug", p="fNN", dur=该行配音秒数+0.6, body=..., css=..., tl=...)。页脚编号写 "NN/总段数"（总段数以 SCRIPT.md 的行数为准）。相邻或相同结构的段落不要用同一种版式（例如两段都是三张竖排卡片），每段的画面要和别的段一眼区分开。每帧从 0 秒起就要看得到这一段的主视觉：入场动画从可见状态开始（例如从 0.6 透明度或略小尺寸起步），不要从全透明或空背景开始。每帧一个主画面，主视觉占画面中部至少四成高度，不要只放一行标题或一个数字；把这一段的核心动作或对比画出来（静音也能看懂这一段在讲什么），屏幕文字用该段的 onScreenText，画面兑现该段的 visual 意图；遵守 frame.md 的安全区（内容 y≤1340，字幕带 y1390–1570 留空，右侧按钮区避让）。字体只用已有 @font-face 的：中文用工程 assets/fonts 里的 Noto Sans CJK SC；要用其他字体（如 Space Grotesk）必须在该帧 css 里写 @font-face，否则渲染时会回退成衬线并让技术检查报错。写完在 episodeDir 里运行 python3 scripts/build-frames.py --check，有错就改规格重跑，直到通过。不要自己截图、打开浏览器或调用其他应用（你的沙箱不能联网，截图工具会卡住）；只用 build-frames.py --check 自检，截图和看图由流程和成品检查者负责。改动要最小化：只动被点名的问题，避免引入文字重叠（hf-check 的 layout 检查会报 content_overlap）。收到修改请求（fixRequest：创作者的审阅意见优先级最高，其次是成品检查意见和技术检查 hf-check 的报错）时只改相关的行，改完用 --only NN 重建再跑 --check。不要改 scripts/ 下的文件，不要改 SCRIPT.md。keepSpecs 里列出的规格已经通过创作者的样片审阅，保持原样，只在检查意见点名时才改。files 写你创建或修改的规格文件路径；buildCheckPassed 如实填写最后一次 --check 的结果。${COMMON}`,
    outputSchema: objectSchema({ files: strList, buildCheckPassed: { type: 'boolean' }, notes: str }),
  },
  inspector: {
    id: 'b3-inspector', title: '成品检查',
    guards: '替你先看成品：必须实际打开快照图逐格检查，看不到图就不许判通过。',
    prompt: `你是成品检查，代表创作者本人看画面。你会收到快照 contact sheet 图片路径（按时间顺序：前三格是 0、0.5、1 秒，之后每格对应一行口播画面稳定后的时刻）以及每行的口播、屏幕文字和画面意图。必须用查看图片的工具逐张打开这些图（imagesOpened 写你实际打开的路径），只看 contactSheets 列表里的图，不要打开工程目录里的其他图片（可能是旧版本的残留）；任何一张打不开，verdict=blocked 并说明。按标准卡 V1–V7 逐条给 ok / weak / fail；V5/V6 要核对每格的页脚编号与段数一致；V7 要比较各格之间是否有两段版式几乎一样；V3 要做静音测试：只看这一格画面、不看口播，写下你认为这一段在讲什么，再和口播对照，对不上就是 fail；scope 为 full 时，看完所有格再对照 core.oneLineAnswer：只看画面的观众能不能得到这句话；scope 为 sample 时只检查样片这几段各自是否讲对了自己那部分，不要求样片讲完整个答案；notesForB3 里的要求没落实的要指出来；并在 issues 里写出具体是第几行（line 用 "01" 这样的编号）、违反哪条、问题是什么、怎么改（改成什么样）。只提会改变观感的问题。标准卡末尾的用户审阅记录权重最高。${COMMON}`,
    outputSchema: objectSchema({
      imagesOpened: strList,
      verdict: oneOf('pass', 'revise', 'blocked'),
      criteria: listOf(objectSchema({ id: str, result: oneOf('ok', 'weak', 'fail'), reason: str })),
      issues: listOf(objectSchema({ line: str, standard: str, problem: str, fix: str })),
      summary: str,
    }),
  },
} satisfies Record<string, RoleSpec>;

export interface B3GateDetails {
  stage: 'B3';
  scope: 'sample' | 'full';
  reason: 'awaiting-human-review' | 'not-converged' | 'blocked';
  video?: string;
  contactSheets: string[];
  voice: 'placeholder' | 'minimax';
  rounds: number;
}

// ---------- deterministic assembly helpers (run as workflow tasks) ----------

function run(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

function seconds(time: string, fallback = 8): number {
  const m = time.match(/(\d+(?:\.\d+)?)\s*[–-]\s*(\d+(?:\.\d+)?)/);
  return m ? Math.max(2, Math.round(Number(m[2]) - Number(m[1]))) : fallback;
}

export function scriptMarkdown(title: string, segments: Segment[], voice: B3Input['voice']): string {
  const lines = segments.map((s, i) => {
    const n = String(i + 1).padStart(2, '0');
    const label = (s.onScreenText.split(/\n|｜/)[0] || s.time).trim().slice(0, 24);
    return `### Line ${n} — ${label} (F${n} · ~${seconds(s.time)}s)\n\n    ${s.voiceover.replace(/\s*\n\s*/g, '')}\n`;
  });
  return [`# SCRIPT — ${title}`, '', `**Voice:** ${voice === 'placeholder' ? '占位（macOS say），定稿前需换正式配音' : 'MiniMax speech-2.8-hd'}`, '', '---', '', ...lines].join('\n');
}

export function storyboardMarkdown(title: string, segments: Segment[]): string {
  const beats = segments.map((s, i) => `### Beat ${String(i + 1).padStart(2, '0')} · ${s.time}\n\n- 屏幕文字：${s.onScreenText || '—'}\n- 画面：${s.visual}\n`);
  return [`# STORYBOARD — ${title}`, '', 'cover_beat: 1', '', ...beats].join('\n');
}

/** Technical check errors with the frame and element they point at, so the designer can fix them without searching. */
export function locatedErrors(checkJson: unknown): Array<{ line: string; code: string; message: string; selector: string; time: number | null }> {
  const found: Array<{ line: string; code: string; message: string; selector: string; time: number | null }> = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    const item = node as Record<string, unknown>;
    if (item.severity === 'error' && typeof item.code === 'string') {
      const source = String(item.sourceFile ?? '');
      const line = source.match(/frames\/(\d\d)-/)?.[1] ?? 'all';
      found.push({ line, code: item.code, message: String(item.message ?? ''), selector: String(item.selector ?? ''), time: typeof item.time === 'number' ? item.time : null });
      return;
    }
    Object.values(item).forEach(walk);
  };
  walk(checkJson);
  return found;
}

export function createB3Workflow(config: B3Input, model: { worker: StageModel; judge: StageModel }): WorkflowDefinition<B3Input, WorkflowTerminal<never>> {
  const frozen = b3InputSchema.parse(config);
  const designer = stageAgent<unknown, Design>(B3_ROLES.designer, model.judge, B3_REVISION, {
    sandbox: 'workspace-write', additionalDirectories: [frozen.episodeDir, frozen.referenceDir],
  });
  const inspector = stageAgent<unknown, Inspection>(B3_ROLES.inspector, model.judge, B3_REVISION, {
    sandbox: 'read-only', additionalDirectories: [frozen.episodeDir],
  });

  return workflow<B3Input, WorkflowTerminal<never>>('creation.b3', { revision: B3_REVISION }, async (ctx, rawInput) => {
    const input = b3InputSchema.parse(rawInput);
    if (JSON.stringify(input) !== JSON.stringify(frozen)) throw new Error('B3 workflow configuration and input differ');
    const script = scriptSchema.parse(input.brief.script);
    const segments = input.scope === 'sample' ? script.segments.slice(0, input.sampleSegments) : script.segments;
    const dir = input.episodeDir;

    const prepared = await ctx.phase('b3-prepare', {
      title: '建工程与稿件', purpose: '从模板建视频工程，把 B2 定稿写成装配线要的 SCRIPT/STORYBOARD', order: 10,
      expectedArtifacts: [{ role: 'script-file', title: 'SCRIPT.md', required: true }],
    }, async phase => {
      const files = await phase.task('write-project', ({ dir: target }: { dir: string }) => {
        if (!existsSync(target)) run(path.dirname(target), 'bash', [path.join(input.templateDir, 'scripts/new-episode.sh'), path.basename(target), path.dirname(target)]);
        const scriptFile = scriptMarkdown(script.title, segments, input.voice);
        const storyboard = storyboardMarkdown(script.title, segments);
        writeFileSync(path.join(target, 'SCRIPT.md'), scriptFile);
        writeFileSync(path.join(target, 'STORYBOARD.md'), storyboard);
        return { script: scriptFile, storyboard, lines: segments.length };
      }, { dir });
      const ref = await phase.publish('script-file', 'b3-script-file', { markdown: files.script, storyboard: files.storyboard, lines: files.lines }, { validation: 'valid', review: 'not_applicable' });
      await phase.bindArtifact(ref, { role: 'script-file', title: 'SCRIPT.md', primary: true });
      return { ref, lines: files.lines };
    });
    if (isTerminal(prepared)) return prepared;

    const voiced = await ctx.phase('b3-voice', {
      title: input.voice === 'placeholder' ? '配音（占位）' : '配音', purpose: '逐行生成配音，得到每行实际时长，画面按它定时', order: 20,
      expectedArtifacts: [{ role: 'voice-manifest', title: '配音清单', required: true }],
    }, async phase => {
      const manifest = await phase.task('tts', () => {
        run(dir, 'bash', [input.voice === 'placeholder' ? 'scripts/tts-placeholder.sh' : 'scripts/tts.sh']);
        return JSON.parse(readFileSync(path.join(dir, 'assets/voice-minimax/manifest.json'), 'utf8')) as { lines: Array<{ index: number; durationMs: number; text: string }> };
      }, { lines: prepared.lines, voice: input.voice });
      const ref = await phase.publish('voice-manifest', 'b3-voice-manifest', { voice: input.voice, lines: manifest.lines.map(l => ({ index: l.index, seconds: l.durationMs / 1000 })) }, { validation: 'valid', review: 'not_applicable', dependsOn: [dependency(prepared.ref)] });
      await phase.bindArtifact(ref, { role: 'voice-manifest', title: '配音清单', primary: true });
      return { ref, durations: manifest.lines.map(l => l.durationMs / 1000) };
    });
    if (isTerminal(voiced)) return voiced;

    const referenceSpecs = readdirSync(path.join(input.referenceDir, 'frames-spec')).filter(f => f.endsWith('.py')).sort().slice(0, 3)
      .map(f => ({ file: f, content: readFileSync(path.join(input.referenceDir, 'frames-spec', f), 'utf8') }));
    const lines = segments.map((s, i) => ({ line: String(i + 1).padStart(2, '0'), ...s, voiceSeconds: voiced.durations[i] }));

    const buildAndInspect = async (round: number, fix?: Inspection) => {
      const designed = await ctx.phase(`b3-design-${round}`, {
        title: round === 0 ? '画面设计' : `画面修改 v${round + 1}`, purpose: B3_ROLES.designer.guards, order: 30 + round * 10,
        expectedArtifacts: [{ role: 'frame-specs', title: '帧规格', required: true }],
      }, async phase => {
        const value = await phase.agent('design', designer, {
          episodeDir: dir, lines, referenceSpecs, standards: input.standards, keepSpecs: input.keepSpecs ?? [], ...b3DesignerContext(input.brief),
          ...(fix ? { fixRequest: fix.issues } : {}),
        });
        const checked = await phase.validate('check-design', value, v => check(designSchema, v));
        if (!checked.valid) return phase.blocked({ reason: 'invalid-design-report', details: checked.details });
        // Do not trust the agent's own report: rebuild and check the frames here.
        const built = await phase.task('verify-frames', () => {
          try { return { ok: true, output: run(dir, 'python3', ['scripts/build-frames.py', '--check']).slice(-2000) }; }
          catch (error) { return { ok: false, output: String((error as { stdout?: string }).stdout ?? error).slice(-2000) }; }
        }, { round, files: value.files });
        const specs = readdirSync(path.join(dir, 'frames-spec')).filter(f => f.endsWith('.py')).sort()
          .map(f => ({ file: f, content: readFileSync(path.join(dir, 'frames-spec', f), 'utf8') }));
        const ref = await phase.publish('frame-specs', 'b3-frame-specs', { report: value, build: built, specs }, {
          validation: built.ok ? 'valid' : 'invalid', review: 'pending', dependsOn: [dependency(voiced.ref)],
        });
        await phase.bindArtifact(ref, { role: 'frame-specs', title: '帧规格', primary: true });
        if (!built.ok) return phase.blocked({ reason: 'frames-do-not-build', output: built.output });
        return { ref };
      });
      if (isTerminal(designed)) return designed;

      const assembled = await ctx.phase(`b3-assemble-${round}`, {
        title: `装配与快照 v${round + 1}`, purpose: '挂载、按配音对时、跑技术检查、在每段稳定点截图', order: 33 + round * 10,
        expectedArtifacts: [{ role: 'assembly', title: '装配报告', required: true }],
      }, async phase => {
        const report = await phase.task('assemble', () => {
          // Only this round's snapshots may be inspected: stale images once made the inspector judge an old cut.
          rmSync(path.join(dir, 'snapshots/review'), { recursive: true, force: true });
          const index = run(dir, 'node', ['scripts/make-index.mjs', '--force']).slice(-800);
          const retime = run(dir, 'node', ['scripts/retime-to-minimax.mjs']).slice(-800);
          let technical = '';
          try { technical = run(dir, 'bash', ['scripts/hf-check.sh']); }
          catch (error) { technical = String((error as { stdout?: string }).stdout ?? error); }
          technical = technical.slice(-1500);
          let errors: ReturnType<typeof locatedErrors> = [];
          try { errors = locatedErrors(JSON.parse(readFileSync(path.join(dir, '.hf/check.json'), 'utf8'))); } catch { errors = []; }
          const snapshots = run(dir, 'bash', ['scripts/snapshot-review.sh']).slice(-1500);
          const sheets = readdirSync(path.join(dir, 'snapshots/review')).filter(f => /^contact-\d+\.jpg$/.test(f)).sort()
            .map(f => path.join(dir, 'snapshots/review', f));
          return { index, retime, technical, errors, green: /→\s*GREEN/.test(technical), snapshots, sheets, settle: readFileSync(path.join(dir, 'snapshots/settle.txt'), 'utf8').trim() };
        }, { round });
        const ref = await phase.publish('assembly', 'b3-assembly', report, { validation: 'valid', review: 'not_applicable', dependsOn: [dependency(designed.ref)] });
        await phase.bindArtifact(ref, { role: 'assembly', title: '装配报告', primary: true });
        return { ref, report };
      });
      if (isTerminal(assembled)) return assembled;

      if (!assembled.report.green) {
        const technicalFix: Inspection = {
          imagesOpened: [], verdict: 'revise', summary: '技术检查未通过（hf-check RED），先修技术问题再看画面',
          criteria: [{ id: 'V5', result: 'fail', reason: '技术检查报错' }],
          issues: assembled.report.errors.length
            ? assembled.report.errors.map(e => ({ line: e.line, standard: `hf-check:${e.code}`, problem: `${e.message}（元素 ${e.selector}${e.time !== null ? `，${e.time}s` : ''}）`, fix: '只改这一帧里这个元素的位置或尺寸，消除报错，不动其他内容' }))
            : [{ line: 'all', standard: 'hf-check', problem: assembled.report.technical, fix: '按报错修改相关帧规格，直到 hf-check GREEN' }],
        };
        return { inspection: technicalFix, inspectionRef: assembled.ref, sheets: assembled.report.sheets, technicalRed: true };
      }

      const inspected = await ctx.phase(`b3-inspect-${round}`, {
        title: `成品检查 v${round + 1}`, purpose: B3_ROLES.inspector.guards, order: 36 + round * 10,
        expectedArtifacts: [{ role: 'inspection', title: '成品检查', required: true }],
      }, async phase => {
        const value = await phase.agent('inspect', inspector, {
          contactSheets: assembled.report.sheets, settlePoints: assembled.report.settle, lines, technicalCheck: assembled.report.technical,
          standards: input.standards, scope: input.scope, ...b3InspectorContext(input.brief),
        });
        const checked = await phase.validate('check-inspection', value, v => check(inspectionSchema, v));
        if (!checked.valid) return phase.blocked({ reason: 'invalid-inspection', details: checked.details });
        const ref = await phase.publish('inspection', 'b3-inspection', value, { validation: 'valid', review: 'not_applicable', dependsOn: [dependency(assembled.ref)] });
        await phase.bindArtifact(ref, { role: 'inspection', title: '成品检查', primary: true });
        return { value, ref };
      });
      if (isTerminal(inspected)) return inspected;
      return { inspection: inspected.value, inspectionRef: inspected.ref, sheets: assembled.report.sheets, technicalRed: false };
    };

    let fix: Inspection | undefined = input.humanReview ? {
      imagesOpened: [], verdict: 'revise', summary: `创作者审阅（${input.humanReview.reviewer}）`,
      criteria: [{ id: 'human', result: 'fail', reason: '创作者要求修改' }],
      issues: input.humanReview.notes.map(n => ({ line: n.line, standard: 'creator', problem: '创作者审阅意见', fix: n.fix })),
    } : undefined;
    for (let round = 0; ; round++) {
      const result = await buildAndInspect(round, fix);
      if (isTerminal(result)) return result;
      const verdict = result.inspection.verdict;
      // An inspector that could not open the images must not be able to pass the piece.
      const sawImages = result.technicalRed || result.inspection.imagesOpened.length >= result.sheets.length;
      ctx.decide(`inspection-route-${round}`, { verdict, sawImages, technicalRed: result.technicalRed, round });
      if (verdict === 'blocked' || !sawImages || (result.technicalRed && round >= input.maxRevisions)) {
        const details: B3GateDetails = { stage: 'B3', scope: input.scope, reason: 'blocked', contactSheets: result.sheets, voice: input.voice, rounds: round + 1 };
        return ctx.needsReview(details);
      }
      if (verdict === 'pass' || round >= input.maxRevisions) {
        const rendered = await ctx.phase('b3-render', {
          title: input.scope === 'sample' ? '渲染样片' : '渲染成片', purpose: '导出视频与封面，核对时长与画面', order: 90,
          expectedArtifacts: [{ role: 'video', title: '视频', required: true }],
        }, async phase => {
          const video = await phase.task('render', () => {
            let log = '';
            try { log = run(dir, 'bash', ['scripts/render.sh']); }
            catch (error) { log = String((error as { stdout?: string }).stdout ?? error); }
            const exports = readdirSync(path.join(dir, 'exports')).filter(f => f.endsWith('.mp4')).map(f => path.join(dir, 'exports', f));
            return { log: log.slice(-2000), exports };
          }, { round });
          const ref = await phase.publish('video', 'b3-video', video, { validation: video.exports.length ? 'valid' : 'invalid', review: 'pending', dependsOn: [dependency(result.inspectionRef)] });
          await phase.bindArtifact(ref, { role: 'video', title: '视频', primary: true });
          return { ref, video };
        });
        if (isTerminal(rendered)) return rendered;
        const details: B3GateDetails = {
          stage: 'B3', scope: input.scope, reason: verdict === 'pass' ? 'awaiting-human-review' : 'not-converged',
          video: rendered.video.exports[0], contactSheets: result.sheets, voice: input.voice, rounds: round + 1,
        };
        return ctx.needsReview(details);
      }
      fix = result.inspection;
    }
  });
}

export function readB3Standards(): string {
  return readFileSync(b3StandardsPath, 'utf8');
}
