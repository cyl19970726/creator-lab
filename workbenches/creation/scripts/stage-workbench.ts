import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RunRecord } from '@signal-room/workflow';
import { SQLiteWorkflowRunStore } from '@signal-room/workflow-sqlite';

/**
 * The piece's workbench: one page with the three stages as rows (current version, main asset, the creator's
 * verdict) and the full tuning history below. Each run links to its stage page (`stage:render`).
 *   pnpm stage:workbench <topicId>      → .local/stages/<topicId>/index.html
 * Human-gate records come from .local/stages/<topicId>/decisions.json.
 */
const [topicId] = process.argv.slice(2);
if (!topicId) throw new Error('Usage: stage-workbench.ts <topicId>');
const root = path.resolve('.local/stages', topicId);
const store = new SQLiteWorkflowRunStore(new DatabaseSync(path.join(root, 'ledger.sqlite'), { readOnly: true }));

interface Review { reviewer: string; verdict: 'accept' | 'revise' | 'invalid'; notes: string[]; at: string }
interface Decisions { title: string; current: Record<string, string>; runs: Record<string, { purpose: string; review?: Review }> }
const decisionsFile = path.join(root, 'decisions.json');
const decisions: Decisions = existsSync(decisionsFile)
  ? JSON.parse(readFileSync(decisionsFile, 'utf8'))
  : { title: topicId, current: {}, runs: {} };

const STAGES = [
  { id: 'b1', name: 'B1 定题', question: '选对这一篇要回答的问题，并确认我们答得上、答得好', asset: 'b1-content-decision' },
  { id: 'b2', name: 'B2 成稿', question: '让观众跟得上，并愿意看完', asset: 'b2-script' },
  { id: 'b3', name: 'B3 成片', question: '成品把稿子讲出来，而且在手机上看得清', asset: 'b3-script-file' },
] as const;

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const runs = (await store.listRuns({ metadata: { topicId } })).filter(r => STAGES.some(s => s.id === r.metadata?.stage));

interface RunView { run: RunRecord; stage: string; started?: string; minutes?: number; internal?: string; payload?: Record<string, unknown>; video?: string }
async function view(run: RunRecord): Promise<RunView> {
  const stage = String(run.metadata?.stage);
  const spec = STAGES.find(s => s.id === stage)!;
  const events = await store.listEvents(run.id);
  const started = events[0]?.timestamp;
  const ended = events.at(-1)?.timestamp;
  const artifacts = await store.listArtifacts(run.id);
  // The workflow's own verdict is how the run ended, not the last reviewer artifact (a finalize run imports an
  // earlier editor verdict but is judged only by its closing fact check).
  const reason = (run.output as { details?: { reason?: string } } | undefined)?.details?.reason;
  const byReason: Record<string, string> = {
    'awaiting-human-review': 'pass', 'final-edits-fact-checked': 'pass', 'final-edits-with-fact-issues': 'revise',
    'not-converged': 'revise', 'final-edits-unreviewed': 'invalid', blocked: 'blocked',
  };
  const internal = run.state === 'failed' ? 'blocked' : byReason[reason ?? ''];
  const assetRef = artifacts.filter(a => a.type === spec.asset).at(-1);
  const payload = assetRef ? await store.getArtifactPayload(assetRef.id) as Record<string, unknown> : undefined;
  const runDir = path.join(root, stage, run.id);
  const video = existsSync(runDir) ? readdirSync(runDir).filter(f => f.endsWith('.mp4')).sort().reverse()[0] : undefined;
  return { run, stage, started, minutes: started && ended ? Math.round((Date.parse(ended) - Date.parse(started)) / 6000) / 10 : undefined, internal, payload, video };
}
const views = await Promise.all(runs.map(view));

// Every run gets its stage page, so every history row can be opened.
for (const v of views) {
  const page = path.join(root, v.stage, v.run.id, 'index.html');
  if (!existsSync(page)) execFileSync('npx', ['tsx', 'scripts/render-stage.ts', topicId, v.run.id], { stdio: 'ignore' });
}

const pill = (verdict?: string) => {
  const map: Record<string, [string, string]> = {
    accept: ['通过', 'good'], pass: ['通过', 'good'], revise: ['要改', 'warn'], blocked: ['卡住', 'bad'], invalid: ['无效运行', 'mute'],
  };
  const [text, cls] = map[verdict ?? ''] ?? ['待审', 'wait'];
  return `<span class="pill ${cls}">${text}</span>`;
};
const time = (iso?: string) => iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
const link = (v: RunView) => `${v.stage}/${v.run.id}/index.html`;

function assetSummary(v: RunView): string {
  const p = v.payload ?? {};
  if (v.stage === 'b1') {
    return `<div class="asset"><div class="asset-title">${esc(p.workingTitle)}</div>
      <div class="kv"><span>一句话答案</span><p>${esc(p.oneLineAnswer)}</p></div>
      <div class="kv"><span>开头钩子</span><p>${esc(p.hook)}</p></div>
      <div class="kv"><span>节拍</span><ol>${((p.beats as Array<{ beat: string }>) ?? []).map(b => `<li>${esc(b.beat.replace(/^\d+[.、．｜|]\s*/, ''))}</li>`).join('')}</ol></div></div>`;
  }
  if (v.stage === 'b2') {
    const segments = (p.segments as Array<{ time: string; voiceover: string }>) ?? [];
    return `<div class="asset"><div class="asset-title">${esc(p.title)}</div>
      <div class="kv"><span>封面字</span><p>${esc(p.coverText)}　·　约 ${esc(p.estimatedSeconds)} 秒　·　${segments.length} 段</p></div>
      <div class="kv"><span>开口第一句</span><p>${esc(segments[0]?.voiceover)}</p></div></div>`;
  }
  const video = v.video ? `<video controls preload="metadata" src="${esc(`${v.stage}/${v.run.id}/${v.video}`)}"></video>` : '<p class="sub">这次运行没有保存视频。</p>';
  return `<div class="asset asset-video">${video}<p class="sub">${esc((v.run.output as { details?: { voice?: string } })?.details?.voice === 'placeholder' ? '占位配音（macOS 语音），正式配音待定' : '')}</p></div>`;
}

function stageRow(spec: typeof STAGES[number]): string {
  const currentId = decisions.current[spec.id];
  const v = views.find(x => x.run.id === currentId) ?? views.filter(x => x.stage === spec.id).at(-1);
  if (!v) return `<section class="stage"><header><h2>${spec.name}</h2><p class="sub">${spec.question}</p></header><p class="sub">还没有运行。</p></section>`;
  const review = decisions.runs[v.run.id]?.review;
  const count = views.filter(x => x.stage === spec.id).length;
  return `<section class="stage" id="${spec.id}">
    <header><div><h2>${spec.name}</h2><p class="sub">${spec.question}</p></div>
      <div class="meta"><span class="mono">${esc(v.run.workflowRevision)}</span><span>${time(v.started)}</span><a class="open" href="${link(v)}">打开阶段页 →</a></div></header>
    <div class="body">${assetSummary(v)}
      <div class="verdicts">
        <div class="vrow"><span class="who">workflow 审阅</span>${pill(v.internal)}</div>
        <div class="vrow"><span class="who">你</span>${pill(review?.verdict)}</div>
        ${review ? `<ul class="notes">${review.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
        <p class="sub">共 ${count} 次运行，见下方调优历史</p>
      </div></div></section>`;
}

const strip = STAGES.map(spec => {
  const review = decisions.runs[decisions.current[spec.id] ?? '']?.review;
  const cls = review?.verdict === 'accept' ? 'done' : review ? 'warn' : 'wait';
  return `<li class="${cls}"><a href="#${spec.id}"><span class="dot"></span>${spec.name}</a></li>`;
}).join('') + '<li class="wait"><span class="dot"></span>发布</li>';

interface BriefView { version: number; sources: Array<{ stage: string; runId: string; revision: string; reviewer: string }>; notesForB2: Array<{ from: string; note: string }>; notesForB3: Array<{ from: string; note: string }>; materials: Array<{ id: string; title: string }>; audienceQuestion: { questionInAudienceWords?: string; currentIntuition?: string } }
const briefDir = path.join(root, 'brief');
const briefs: BriefView[] = existsSync(briefDir)
  ? readdirSync(briefDir).filter(f => /^v\d+\.json$/.test(f)).map(f => JSON.parse(readFileSync(path.join(briefDir, f), 'utf8')) as BriefView).sort((a, b) => b.version - a.version)
  : [];
const notesList = (notes: Array<{ from: string; note: string }>) => notes.length
  ? `<ul class="notes">${notes.map(n => `<li><span class="sub">${esc(n.from)}：</span>${esc(n.note)}</li>`).join('')}</ul>` : '<p class="sub">（无）</p>';
const briefSection = briefs.length ? `<section class="brief"><h2>作品档案</h2>
<p class="sub">每次你在某个阶段判通过（<code>pnpm stage:accept</code>），程序就生成新一版档案；下一阶段只从档案里取输入。最新一版在上。</p>
${briefs.map(b => `<details ${b === briefs[0] ? 'open' : ''}><summary>档案 v${b.version} · 来源 ${b.sources.map(s => `${s.stage.toUpperCase()} ${esc(s.revision)}（${esc(s.runId.slice(0, 8))}）`).join(' → ')} · <a href="brief/v${b.version}.json">JSON</a></summary>
<div class="kv"><span>观众问题</span><p>${esc(b.audienceQuestion?.questionInAudienceWords)}<br><span class="sub">原来的直觉：${esc(b.audienceQuestion?.currentIntuition)}</span></p></div>
<div class="kv"><span>材料</span><p>${b.materials.map(m => esc(m.id)).join('、')}</p></div>
<div class="kv"><span>写给 B2 的话</span>${notesList(b.notesForB2)}</div>
<div class="kv"><span>写给 B3 的话</span>${notesList(b.notesForB3)}</div></details>`).join('\n')}</section>` : '';

const history = [...views].sort((a, b) => Date.parse(a.started ?? '') - Date.parse(b.started ?? '')).map(v => {
  const d = decisions.runs[v.run.id];
  const current = decisions.current[v.stage] === v.run.id;
  return `<tr class="${current ? 'current' : ''}"><td class="mono">${v.stage.toUpperCase()}</td><td class="mono">${esc(v.run.workflowRevision)}${v.run.metadata?.briefVersion ? `<br><span class="sub">档案 v${esc(v.run.metadata.briefVersion)}</span>` : ''}</td>
    <td>${esc(d?.purpose ?? '')}${current ? ' <span class="tag">当前采用</span>' : ''}</td><td class="t">${time(v.started)}</td><td class="num">${v.minutes ?? '—'} 分</td>
    <td>${pill(v.internal)}</td><td>${pill(d?.review?.verdict)}</td><td class="note">${esc(d?.review?.notes?.[0] ?? '')}</td>
    <td><a href="${link(v)}">查看</a></td></tr>`;
}).join('\n');

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>作品工作台 · ${esc(decisions.title)}</title>
<style>
:root{--bg:#F3F5F8;--surface:#fff;--ink:#17202B;--muted:#5A6573;--line:#DCE1E8;--accent:#2B59C3;--good:#1E8A6E;--warn:#B8760C;--bad:#C0412B;--mute:#8A95A3;
--sans:"PingFang SC","Hiragino Sans GB","Noto Sans SC","Microsoft YaHei",system-ui,sans-serif;--mono:ui-monospace,"SF Mono",Menlo,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#0F141A;--surface:#161D26;--ink:#E3E8EE;--muted:#9BA7B5;--line:#2A3441;--accent:#86A8FF;--good:#43C39C;--warn:#E3A83F;--bad:#EC735C;--mute:#6F7B89;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 var(--sans)}
main{max-width:1080px;margin:0 auto;padding:24px 18px 80px}
.eyebrow{font:600 12px var(--mono);color:var(--muted);letter-spacing:.08em}
h1{font-size:26px;line-height:1.35;margin:6px 0 4px;text-wrap:balance}
.strip{list-style:none;display:flex;flex-wrap:wrap;gap:6px 22px;padding:12px 0;margin:14px 0 8px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);font-size:14px}
.strip li,.strip a{display:flex;align-items:center;gap:7px;color:var(--ink);text-decoration:none}.strip .wait{color:var(--muted)}
.dot{width:10px;height:10px;border-radius:50%;background:var(--line)}.done .dot{background:var(--good)}.warn .dot{background:var(--warn)}
.stage{border-bottom:1px solid var(--line);padding:22px 0}
.stage header{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:flex-start}
h2{font-size:19px;margin:0}.sub{color:var(--muted);font-size:13px;margin:2px 0}
.meta{display:flex;gap:14px;align-items:center;color:var(--muted);font-size:13px;flex-wrap:wrap}
.open{color:var(--accent);font-weight:600;text-decoration:none}
.body{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:24px;margin-top:14px}@media (max-width:820px){.body{grid-template-columns:1fr}}
.asset{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:14px 18px}
.asset-title{font-size:18px;font-weight:700;margin-bottom:8px;text-wrap:balance}
.kv{display:grid;grid-template-columns:88px 1fr;gap:10px;padding:6px 0;border-top:1px solid var(--line)}
.kv span{color:var(--muted);font-size:13px}.kv p,.kv ol{margin:0}.kv ol{padding-left:18px}
.asset-video{display:flex;flex-direction:column;align-items:flex-start}
video{height:520px;max-width:100%;aspect-ratio:9/16;background:#000;border-radius:6px}
.verdicts{display:flex;flex-direction:column;gap:8px}
.vrow{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--line)}
.who{font-size:14px}.notes{margin:4px 0;padding-left:18px;font-size:13px;color:var(--ink)}
.pill{display:inline-block;padding:1px 10px;border-radius:99px;font-size:12px;font-weight:600;border:1px solid currentColor;white-space:nowrap}
.pill.good{color:var(--good)}.pill.warn{color:var(--warn)}.pill.bad{color:var(--bad)}.pill.wait{color:var(--muted)}.pill.mute{color:var(--mute);border-style:dashed}
section.history{margin-top:34px}.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;background:var(--surface);border:1px solid var(--line);border-radius:8px;font-size:13px}
th,td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:500}
tr.current td{background:color-mix(in srgb,var(--good) 8%,transparent)}
.tag{font-size:11px;color:var(--good);border:1px solid var(--good);border-radius:4px;padding:0 5px;margin-left:4px;white-space:nowrap}
.mono{font-family:var(--mono);font-size:12px}.t{font:12px var(--mono);color:var(--muted);white-space:nowrap}.num{white-space:nowrap;font-variant-numeric:tabular-nums}
.note{color:var(--muted);min-width:220px}a{color:var(--accent)}
section.brief{margin-top:34px}section.brief details{background:var(--surface);border:1px solid var(--line);border-radius:8px;margin:8px 0;padding:4px 16px 10px}section.brief summary{cursor:pointer;padding:8px 0;font-weight:600}code{font-family:var(--mono);font-size:12px}
</style></head><body><main>
<div class="eyebrow">作品工作台 · ${esc(topicId)}</div>
<h1>${esc(decisions.title)}</h1>
<p class="sub">每个阶段一行：当前采用的版本、它的主资产、workflow 内部审阅和你的判断。点"打开阶段页"看这一阶段 AI 为什么这样设计、进度、输入和全部产出。</p>
<p><a href="flow.html">流程全图：每个角色拿到了什么、产出了什么 →</a></p>
<ol class="strip">${strip}</ol>
${STAGES.map(stageRow).join('\n')}
${briefSection}
<section class="history"><h2>调优历史</h2><p class="sub">每一次运行，按时间顺序。"评估"是同一份输入上的对比重跑，"生产"是做这篇作品本身；绿色行是当前采用的版本。</p>
<div class="scroll"><table><tr><th>阶段</th><th>版本</th><th>用途</th><th>开始</th><th>用时</th><th>workflow 审阅</th><th>你</th><th>你的意见（首条）</th><th></th></tr>
${history}</table></div></section>
</main></body></html>`;

writeFileSync(path.join(root, 'index.html'), html);
copyFileSync(path.resolve('docs/workflows/stage-flow.html'), path.join(root, 'flow.html'));
console.log(path.join(root, 'index.html'));
