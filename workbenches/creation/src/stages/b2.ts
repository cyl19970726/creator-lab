import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { workflow, type ArtifactRef, type WorkflowDefinition, type WorkflowTerminal } from '@signal-room/workflow';
import { z } from 'zod';
import {
  check, dependency, isTerminal, listOf, objectSchema, oneOf, stageAgent, str, strList,
  type RoleSpec, type StageModel,
} from './runtime.js';
import type { Published } from './b1.js';

/**
 * B2 · 成稿. Turns the accepted B1 decision into a complete script a viewer can follow and will finish.
 * Past runs failed by letting evidence review only ever add material; here the fact checker may only
 * flag errors with an equal-or-shorter fix, and the editor arbitrates against the B1 decision and a length budget.
 */
export const B2_REVISION = 'b2-v1';
export const b2StandardsPath = fileURLToPath(new URL('./standards/b2.md', import.meta.url));

export const b2InputSchema = z.object({
  topicId: z.string().min(1),
  decision: z.record(z.string(), z.unknown()),
  account: z.object({ name: z.string(), positioning: z.string() }).passthrough(),
  form: z.string().min(1),
  materials: z.array(z.object({ id: z.string().min(1), title: z.string(), text: z.string().min(1) }).strict()).min(1),
  standards: z.string().min(1),
  maxSeconds: z.number().int().min(15).max(600),
  maxRevisions: z.number().int().min(0).max(3),
}).strict();
export type B2Input = z.infer<typeof b2InputSchema>;

const segmentSchema = z.object({ time: z.string(), voiceover: z.string().min(1), onScreenText: z.string(), visual: z.string().min(1) });
const scriptSchema = z.object({
  title: z.string().min(1), coverText: z.string().min(1), estimatedSeconds: z.number().int().positive(),
  segments: z.array(segmentSchema).min(3), sourcesUsed: z.array(z.string()), changesFromPrevious: z.string(),
});
const readerSchema = z.object({
  retell: z.string().min(1), oneLineAnswerAsUnderstood: z.string().min(1),
  lostAt: z.array(z.object({ segment: z.string(), why: z.string() })),
  boredAt: z.array(z.object({ segment: z.string(), why: z.string() })),
  keepWatchingAt3s: z.object({ yes: z.boolean(), why: z.string() }),
  keepWatchingAt30s: z.object({ yes: z.boolean(), why: z.string() }),
  mostMemorable: z.string(),
});
const factSchema = z.object({
  issues: z.array(z.object({
    segment: z.string(), claim: z.string(), problem: z.enum(['wrong', 'overclaim', 'unsupported']),
    evidence: z.string(), fix: z.string(),
  })),
  summary: z.string().min(1),
});
const editorSchema = z.object({
  verdict: z.enum(['pass', 'revise', 'blocked']),
  criteria: z.array(z.object({ id: z.string(), result: z.enum(['ok', 'weak', 'fail']), reason: z.string() })).min(1),
  mustChange: z.array(z.object({ segment: z.string(), change: z.string() })),
  rejectedSuggestions: z.array(z.object({ from: z.string(), suggestion: z.string(), why: z.string() })),
  secondsBudget: z.number().int().positive(),
  summary: z.string().min(1),
});
export type Script = z.infer<typeof scriptSchema>;
export type ColdRead = z.infer<typeof readerSchema>;
export type FactCheck = z.infer<typeof factSchema>;
export type EditorVerdict = z.infer<typeof editorSchema>;

const COMMON = '用中文输出。只返回符合 schema 的 JSON。';
const segmentJson = objectSchema({ time: str, voiceover: str, onScreenText: str, visual: str });

export const B2_ROLES = {
  writer: {
    id: 'b2-writer', title: '作者',
    guards: '把 B1 的决定写成观众能看完的完整稿。',
    prompt: `你是竖屏科技视频的编剧。按 B1 内容决定写完整稿：标题、封面字（≤12 字）、按时间切分的段落（每段：时间、口播、屏幕文字、画面意图）。口播约每秒 4 个汉字，总时长不超过给定上限。第一句就是钩子；一段只引入一个新概念，术语出现时立刻给白话；核心机制必须有一个具体例子或类比；结尾留一个可带走的判断并连到账号视角。事实只能来自提供的材料，sourcesUsed 写材料 id。收到主编意见时逐条执行 mustChange，任何新增必须替换掉等长的旧内容，并在 changesFromPrevious 说明；首版写"首版"。${COMMON}`,
    outputSchema: objectSchema({
      title: str, coverText: str, estimatedSeconds: { type: 'integer' }, segments: listOf(segmentJson),
      sourcesUsed: strList, changesFromPrevious: str,
    }),
  },
  reader: {
    id: 'b2-cold-reader', title: '无提示读者',
    guards: '防止讲不懂、留不住：只看观众能看到的东西。',
    prompt: `你是一个刷到这条视频的普通观众：对 AI 感兴趣，但不懂强化学习术语。你只能看到标题、封面字和每段的口播、屏幕文字、画面描述。诚实地回答：你学到了什么（用自己的话复述）、你理解的一句话结论、在哪一段跟丢了、在哪一段想划走、3 秒和 30 秒时还会不会继续看、最记得住的是什么。不要评价写作技巧，不要给修改建议，只报告你的真实体验。${COMMON}`,
    outputSchema: objectSchema({
      retell: str, oneLineAnswerAsUnderstood: str,
      lostAt: listOf(objectSchema({ segment: str, why: str })), boredAt: listOf(objectSchema({ segment: str, why: str })),
      keepWatchingAt3s: objectSchema({ yes: { type: 'boolean' }, why: str }), keepWatchingAt30s: objectSchema({ yes: { type: 'boolean' }, why: str }),
      mostMemorable: str,
    }),
  },
  checker: {
    id: 'b2-fact-checker', title: '事实核查',
    guards: '防止说错、说过头；但不许要求加料。',
    prompt: `你是事实核查。逐段检查口播和屏幕文字里的事实性说法是否与提供的材料一致：只报告 wrong（错）、overclaim（说过头）、unsupported（材料里没有）三类问题，每条给出材料依据，以及一个长度相同或更短的改法。你不得要求补充背景、增加限定语或加入材料里的其他细节——那不是你的职责。没有问题就返回空 issues。${COMMON}`,
    outputSchema: objectSchema({
      issues: listOf(objectSchema({ segment: str, claim: str, problem: oneOf('wrong', 'overclaim', 'unsupported'), evidence: str, fix: str })),
      summary: str,
    }),
  },
  editor: {
    id: 'b2-editor', title: '主编',
    guards: '以 B1 决定为准取舍各方意见，守住时长，替你先审。',
    prompt: `你是主编，代表创作者本人。你收到 B1 内容决定、当前稿、无提示读者的真实体验、事实核查意见和标准卡。按标准卡 T1–T8 逐条给 ok / weak / fail；任何 fail 则 revise；稿子无法兑现 B1 决定且需要回到 B1 时 blocked。mustChange 只写会改变结果的修改，具体到段落和"改成什么"；事实错误必须改；读者跟丢或想划走的地方优先处理。对不采纳的意见写进 rejectedSuggestions 并说明理由（例如会让稿子变长、偏离 B1）。给出本轮时长预算 secondsBudget。标准卡末尾的用户审阅记录权重最高。${COMMON}`,
    outputSchema: objectSchema({
      verdict: oneOf('pass', 'revise', 'blocked'),
      criteria: listOf(objectSchema({ id: str, result: oneOf('ok', 'weak', 'fail'), reason: str })),
      mustChange: listOf(objectSchema({ segment: str, change: str })),
      rejectedSuggestions: listOf(objectSchema({ from: str, suggestion: str, why: str })),
      secondsBudget: { type: 'integer' }, summary: str,
    }),
  },
} satisfies Record<string, RoleSpec>;

export interface B2GateDetails {
  stage: 'B2';
  reason: 'awaiting-human-review' | 'not-converged' | 'blocked';
  script: ArtifactRef;
  editor: ArtifactRef;
  rounds: number;
}

export function scriptMarkdown(script: Script): string {
  const rows = script.segments.map(s => `| ${s.time} | ${s.voiceover} | ${s.onScreenText || '—'} | ${s.visual} |`).join('\n');
  return [
    `# ${script.title}`, '', `封面字：**${script.coverText}**　·　预计 ${script.estimatedSeconds} 秒`, '',
    '| 时间 | 口播 | 屏幕文字 | 画面 |', '|---|---|---|---|', rows, '',
    `来源：${script.sourcesUsed.join('、') || '无'}`, '', `本版改动：${script.changesFromPrevious}`, '',
  ].join('\n');
}

/** What a viewer can see or hear; the cold reader gets nothing else. */
function viewerView(script: Script) {
  return {
    title: script.title, coverText: script.coverText,
    segments: script.segments.map(s => ({ time: s.time, voiceover: s.voiceover, onScreenText: s.onScreenText, visual: s.visual })),
  };
}

export function createB2Workflow(model: { worker: StageModel; judge: StageModel }): WorkflowDefinition<B2Input, WorkflowTerminal<never>> {
  const writer = stageAgent<unknown, Script>(B2_ROLES.writer, model.judge, B2_REVISION);
  const reader = stageAgent<unknown, ColdRead>(B2_ROLES.reader, model.worker, B2_REVISION);
  const checker = stageAgent<unknown, FactCheck>(B2_ROLES.checker, model.worker, B2_REVISION);
  const editor = stageAgent<unknown, EditorVerdict>(B2_ROLES.editor, model.judge, B2_REVISION);

  return workflow<B2Input, WorkflowTerminal<never>>('creation.b2', { revision: B2_REVISION }, async (ctx, rawInput) => {
    const input = b2InputSchema.parse(rawInput);
    const brief = { decision: input.decision, account: input.account, form: input.form, maxSeconds: input.maxSeconds, materials: input.materials };

    const write = (round: number, previous?: { script: Published<Script>; verdict: Published<EditorVerdict> }) =>
      ctx.phase(`b2-draft-${round}`, {
        title: round === 0 ? '完整稿 v1' : `完整稿 v${round + 1}（按主编意见修订）`,
        purpose: B2_ROLES.writer.guards, order: 10 + round * 10,
        expectedArtifacts: [{ role: 'script', title: '完整稿', required: true }],
      }, async phase => {
        const value = await phase.agent('write', writer, previous
          ? { ...brief, previousScript: previous.script.value, editor: previous.verdict.value }
          : brief);
        const checked = await phase.validate('check-script', value, v => check(scriptSchema, v));
        if (!checked.valid) return phase.blocked({ reason: 'invalid-script', details: checked.details });
        const ref = await phase.publish('script', 'b2-script', { ...value, markdown: scriptMarkdown(value) }, {
          validation: 'valid', review: 'pending',
          dependsOn: previous ? [dependency(previous.script.ref), dependency(previous.verdict.ref)] : [],
        });
        await phase.bindArtifact(ref, { role: 'script', title: '完整稿', primary: true });
        return { value, ref };
      });

    const first = await write(0);
    if (isTerminal(first)) return first;
    let script: Published<Script> = first;

    for (let round = 0; ; round++) {
      const current = script;
      const reviewed = await ctx.phase(`b2-review-${round}`, {
        title: `读者与核查 v${round + 1}`, purpose: '无提示读者报告真实体验；事实核查只指错误', order: 15 + round * 10,
        expectedArtifacts: [{ role: 'cold-read', title: '读者体验', required: true }, { role: 'fact-check', title: '事实核查', required: true }],
      }, async phase => {
        const both = await phase.parallel('reviewers', {
          reader: () => phase.agent('cold-read', reader, viewerView(current.value)),
          checker: () => phase.agent('fact-check', checker, { script: current.value, materials: input.materials }),
        }, { concurrency: 2 });
        const readerOut = both.reader as ColdRead;
        const checkerOut = both.checker as FactCheck;
        const readerOk = await phase.validate('check-cold-read', readerOut, v => check(readerSchema, v));
        const checkerOk = await phase.validate('check-fact-check', checkerOut, v => check(factSchema, v));
        if (!readerOk.valid || !checkerOk.valid) return phase.blocked({ reason: 'invalid-review', details: [readerOk, checkerOk] });
        const readerRef = await phase.publish('cold-read', 'b2-cold-read', readerOut, { validation: 'valid', review: 'not_applicable', dependsOn: [dependency(current.ref)] });
        const checkerRef = await phase.publish('fact-check', 'b2-fact-check', checkerOut, { validation: 'valid', review: 'not_applicable', dependsOn: [dependency(current.ref)] });
        await phase.bindArtifact(readerRef, { role: 'cold-read', title: '读者体验', primary: true });
        await phase.bindArtifact(checkerRef, { role: 'fact-check', title: '事实核查' });
        return { reader: { value: readerOut, ref: readerRef }, checker: { value: checkerOut, ref: checkerRef } };
      });
      if (isTerminal(reviewed)) return reviewed;

      const edited = await ctx.phase(`b2-editor-${round}`, {
        title: `主编 v${round + 1}`, purpose: B2_ROLES.editor.guards, order: 18 + round * 10,
        expectedArtifacts: [{ role: 'editor', title: '主编意见', required: true }],
      }, async phase => {
        const value = await phase.agent('edit', editor, {
          decision: input.decision, standards: input.standards, maxSeconds: input.maxSeconds,
          script: current.value, coldRead: reviewed.reader.value, factCheck: reviewed.checker.value,
        });
        const checked = await phase.validate('check-editor', value, v => check(editorSchema, v));
        if (!checked.valid) return phase.blocked({ reason: 'invalid-editor-verdict', details: checked.details });
        const ref = await phase.publish('editor', 'b2-editor', value, {
          validation: 'valid', review: 'not_applicable',
          dependsOn: [dependency(current.ref), dependency(reviewed.reader.ref), dependency(reviewed.checker.ref)],
        });
        await phase.bindArtifact(ref, { role: 'editor', title: '主编意见', primary: true });
        return { value, ref };
      });
      if (isTerminal(edited)) return edited;

      const verdict = edited.value.verdict;
      ctx.decide(`editor-route-${round}`, { verdict, round });
      if (verdict === 'pass' || verdict === 'blocked' || round >= input.maxRevisions) {
        const reason = verdict === 'pass' ? 'awaiting-human-review' : verdict === 'blocked' ? 'blocked' : 'not-converged';
        const details: B2GateDetails = { stage: 'B2', reason, script: current.ref, editor: edited.ref, rounds: round + 1 };
        return ctx.needsReview(details);
      }
      const revised = await write(round + 1, { script: current, verdict: edited });
      if (isTerminal(revised)) return revised;
      script = revised;
    }
  });
}

export function readB2Standards(): string {
  return readFileSync(b2StandardsPath, 'utf8');
}
