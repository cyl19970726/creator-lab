import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import MarkdownIt from 'markdown-it';
import type { ArtifactRef, StepRecord, WorkflowEvent } from '@signal-room/workflow';
import { SQLiteWorkflowRunStore } from '@signal-room/workflow-sqlite';
import { B1_ROLES } from '../src/stages/b1.js';
import { B2_ROLES } from '../src/stages/b2.js';
import { B3_ROLES } from '../src/stages/b3.js';
import type { RoleSpec } from '../src/stages/runtime.js';
import { findRunVideo } from '../src/stages/video-artifacts.js';

/**
 * Renders one stage run as a single reading page, in the order a creator reviews it:
 * the stage's decision → how the reviewers judged it → why the workflow has these roles → progress → inputs and outputs.
 *   pnpm stage:render <topicId> [runId]     (latest run of the topic when runId is omitted)
 */
const [topicId, requestedRun] = process.argv.slice(2);
if (!topicId) throw new Error('Usage: render-stage.ts <topicId> [runId]');
const root = path.resolve('.local/stages', topicId);
const store = new SQLiteWorkflowRunStore(new DatabaseSync(path.join(root, 'ledger.sqlite'), { readOnly: true }));
const md = new MarkdownIt({ linkify: true });

const runs = await store.listRuns({ metadata: { topicId } });
// listRuns returns newest first.
const run = requestedRun ? runs.find(r => r.id === requestedRun) : runs[0];
if (!run) throw new Error(`No run found for ${topicId}${requestedRun ? ` / ${requestedRun}` : ''}`);
const stage = String(run.metadata?.stage ?? 'b1');
const roles: Record<string, RoleSpec> = Object.fromEntries(
  Object.values<RoleSpec>(stage === 'b3' ? B3_ROLES : stage === 'b2' ? B2_ROLES : B1_ROLES).map(role => [role.id, role]),
);

const steps = await store.listSteps(run.id);
const events = await store.listEvents(run.id);
const artifacts = await store.listArtifacts(run.id);
const payloads = new Map<string, Record<string, unknown>>();
for (const ref of artifacts) payloads.set(ref.id, await store.getArtifactPayload(ref.id) as Record<string, unknown>);

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const time = (iso?: string) => iso ? new Date(iso).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '';
const seconds = (a?: string, b?: string) => a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 1000) : undefined;
const last = (type: string) => artifacts.filter(a => a.type === type).at(-1);
const byType = (type: string) => artifacts.filter(a => a.type === type);

// ---- phases, in run order, with timing and the role that worked inside them
const phases = steps.filter(s => s.kind === 'phase');
const eventsOf = (step: StepRecord) => events.filter(e => e.stepRunId === step.id);
const childAgents = (phase: StepRecord) => steps.filter(s => s.kind === 'agent' && s.key.startsWith(`${phase.key}:`));
const agentInfo = (step: StepRecord) => {
  const started = events.find(e => e.stepRunId === step.id && e.type === 'agent.started') as WorkflowEvent & { data?: Record<string, unknown> } | undefined;
  const done = events.find(e => e.stepRunId === step.id && e.type === 'agent.completed') as WorkflowEvent & { data?: { usage?: Record<string, number> } } | undefined;
  return { id: String(started?.data?.agentId ?? ''), model: String(started?.data?.model ?? ''), effort: String(started?.data?.reasoningEffort ?? ''), usage: done?.data?.usage };
};

const gate = (run.output as { details?: { reason?: string; rounds?: number } } | undefined)?.details;
const stateLabel: Record<string, [string, string]> = {
  'awaiting-human-review': ['等你审', 'wait'], 'not-converged': ['内部没审过，等你决定', 'warn'], 'final-edits-fact-checked': ['已按主编最后意见改完并核过事实，等你审', 'wait'], 'final-edits-with-fact-issues': ['改完了，但事实核查还有问题', 'warn'], blocked: ['卡住了', 'bad'],
};
const [stateText, stateClass] = run.state === 'running' ? ['运行中', 'run'] : stateLabel[gate?.reason ?? ''] ?? [run.state, 'warn'];
const firstEvent = events[0]?.timestamp;
const lastEvent = events.at(-1)?.timestamp;
const totalTokens = phases.flatMap(childAgents).map(agentInfo).reduce((sum, a) => sum + (a.usage?.inputTokens ?? 0) + (a.usage?.outputTokens ?? 0), 0);

// ---- the stage's main asset
const mainRef = stage === 'b3' ? last('b3-script-file') : stage === 'b2' ? last('b2-script') : last('b1-content-decision');
const main = mainRef ? payloads.get(mainRef.id) : undefined;
const verdictRef = stage === 'b3' ? last('b3-inspection') : stage === 'b2' ? last('b2-editor') : last('b1-challenge');
const verdict = verdictRef ? payloads.get(verdictRef.id) as { verdict?: string; summary?: string; criteria?: Array<{ id: string; result: string; reason: string }>; mustChange?: unknown[] } : undefined;
const inputFile = path.join(root, stage, run.id, 'input.json');
const input = existsSync(inputFile) ? JSON.parse(readFileSync(inputFile, 'utf8')) as Record<string, unknown> : undefined;

type HumanReview = { reviewer?: string; verdict?: string; notes?: string[] };
// The creator's verdict on THIS run comes from the piece's decision record; the review this run started from is shown separately.
const decisionsFile = path.join(root, 'decisions.json');
const decided = existsSync(decisionsFile)
  ? (JSON.parse(readFileSync(decisionsFile, 'utf8')) as { runs?: Record<string, { purpose?: string; review?: HumanReview }> }).runs?.[run.id]
  : undefined;
const human: HumanReview | undefined = decided?.review;
const incomingRef = last('b1-human-review');
const incoming: HumanReview | undefined = incomingRef
  ? payloads.get(incomingRef.id) as HumanReview
  : (input?.prior as { humanReview?: HumanReview } | undefined)?.humanReview ?? (input?.humanReview as HumanReview | undefined);
const incomingNotes = (incoming?.notes ?? []).map(n => typeof n === 'string' ? n : `${(n as { line?: string }).line ?? ''}：${(n as { fix?: string }).fix ?? ''}`);
const video = stage === 'b3' ? findRunVideo(path.join(root, stage, run.id), Boolean(last('b3-video'))) : undefined;

const resultPill = (r: string) => `<span class="pill ${r === 'ok' || r === 'pass' || r === 'accept' ? 'good' : r === 'weak' || r === 'invalid' ? 'warn' : 'bad'}">${esc({ ok: '通过', weak: '偏弱', fail: '不通过', pass: '通过', revise: '要改', blocked: '卡住', accept: '通过', reject: '否决', invalid: '无效运行' }[r] ?? r)}</span>`;

function phaseRows(): string {
  return phases.map(p => {
    const ev = eventsOf(p);
    const start = ev.find(e => e.type === 'phase.started')?.timestamp ?? ev[0]?.timestamp;
    const end = ev.findLast?.(e => e.type === 'phase.completed' || e.type === 'step.completed')?.timestamp;
    const agents = childAgents(p).map(agentInfo);
    const who = agents.map(a => roles[a.id]?.title ?? a.id).filter(Boolean).join(' + ') || '—';
    const produced = (p.artifactBindings ?? []).map(b => `<a href="#a-${esc(b.artifact.id)}">${esc(b.title ?? b.role)}</a>`).join('、');
    const status = p.state === 'succeeded' ? 'done' : p.state === 'running' ? 'run' : p.state === 'needs_review' ? 'wait' : 'bad';
    const def = p.phaseDefinition as { title?: string; purpose?: string } | undefined;
    return `<tr class="${status}"><td class="t">${time(start)}</td><td><b>${esc(def?.title ?? p.key)}</b><div class="sub">${esc(def?.purpose ?? '')}</div></td><td>${esc(who)}</td><td class="num">${seconds(start, end) ?? '…'} 秒</td><td>${produced || '—'}</td></tr>`;
  }).join('\n');
}

function strip(): string {
  return phases.map(p => {
    const def = p.phaseDefinition as { title?: string } | undefined;
    const status = p.state === 'succeeded' ? 'done' : p.state === 'running' ? 'run' : 'wait';
    return `<li class="${status}"><span class="dot"></span>${esc(def?.title ?? p.key)}</li>`;
  }).join('') + `<li class="gate ${stateClass}"><span class="dot"></span>你</li>`;
}

function roleRows(): string {
  const used = new Map<string, ReturnType<typeof agentInfo>>();
  for (const a of phases.flatMap(childAgents).map(agentInfo)) if (a.id && !used.has(a.id)) used.set(a.id, a);
  return Object.values(roles).map(role => {
    const a = used.get(role.id);
    return `<tr class="${a ? '' : 'idle'}"><td><b>${esc(role.title)}</b></td><td>${esc(role.guards)}</td><td class="mono">${a ? `${esc(a.model)} · ${esc(a.effort)}` : '本次未运行'}</td></tr>`;
  }).join('\n');
}

function criteriaRows(): string {
  return (verdict?.criteria ?? []).map(c => `<tr><td class="mono">${esc(c.id)}</td><td>${resultPill(c.result)}</td><td>${esc(c.reason)}</td></tr>`).join('\n');
}

function artifactBlocks(): string {
  return artifacts.map((ref: ArtifactRef, index) => {
    const payload = payloads.get(ref.id) ?? {};
    const body = typeof payload.markdown === 'string' ? md.render(payload.markdown) : `<pre>${esc(JSON.stringify(payload, null, 2))}</pre>`;
    const producer = steps.find(s => s.id === ref.producedBy.stepRunId);
    const who = producer ? roles[agentInfo(producer).id]?.title : undefined;
    return `<details id="a-${esc(ref.id)}"><summary><span class="idx">${index + 1}</span> ${esc(ref.type)}<span class="sub">　${esc(who ?? (producer?.kind === 'publish' ? '工作流发布' : ''))} · ${esc(ref.sha256.slice(0, 8))}</span></summary><div class="doc">${body}</div></details>`;
  }).join('\n');
}

function inputBlock(): string {
  if (!input) return '<p class="sub">本次运行没有保存输入副本。</p>';
  const materials = (input.materials as Array<{ id: string; title: string }> | undefined) ?? [];
  const account = input.account as { name?: string; positioning?: string } | undefined;
  const notes = byType('b1-research-notes').flatMap(ref => ((payloads.get(ref.id)?.notes as Array<{ id: string; title: string; url: string; publisher: string }> | undefined) ?? []));
  return `<table class="rows">
<tr><th>选题判断</th><td>${esc(input.opportunity ?? '')}</td></tr>
<tr><th>账号</th><td>${esc(account?.name ?? '')}：${esc(account?.positioning ?? '')}</td></tr>
<tr><th>载体</th><td>${esc(input.form ?? '')}</td></tr>
<tr><th>给定材料</th><td>${materials.map(m => `<div><span class="mono">${esc(m.id)}</span> ${esc(m.title)}</div>`).join('')}</td></tr>
${notes.length ? `<tr><th>workflow 补的材料</th><td>${notes.map(n => `<div><span class="mono">${esc(n.id)}</span> <a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a> <span class="sub">${esc(n.publisher)}</span></div>`).join('')}</td></tr>` : ''}
</table>`;
}

const decisionHtml = main && typeof main.markdown === 'string' ? md.render(main.markdown) : '<p class="sub">还没有产出。</p>';
const title = String(main?.workingTitle ?? main?.title ?? (input?.script as { title?: string } | undefined)?.title ?? topicId);

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(stage.toUpperCase())} · ${esc(title)}</title>
<style>
:root{--bg:#F3F5F8;--surface:#fff;--ink:#17202B;--muted:#5A6573;--line:#DCE1E8;--accent:#2B59C3;--good:#1E8A6E;--warn:#B8760C;--bad:#C0412B;--run:#2B59C3;
--sans:"PingFang SC","Hiragino Sans GB","Noto Sans SC","Microsoft YaHei",system-ui,sans-serif;--mono:ui-monospace,"SF Mono",Menlo,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#0F141A;--surface:#161D26;--ink:#E3E8EE;--muted:#9BA7B5;--line:#2A3441;--accent:#86A8FF;--good:#43C39C;--warn:#E3A83F;--bad:#EC735C;--run:#86A8FF;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 var(--sans)}
main{max-width:920px;margin:0 auto;padding:24px 18px 80px}
header .stage{font:600 13px var(--mono);color:var(--muted);letter-spacing:.06em}
h1{font-size:26px;line-height:1.35;margin:6px 0 10px;text-wrap:balance}
.meta{display:flex;flex-wrap:wrap;gap:8px 16px;color:var(--muted);font-size:13px;align-items:center}
.pill{display:inline-block;padding:1px 10px;border-radius:99px;font-size:12px;font-weight:600;border:1px solid currentColor}
.pill.good{color:var(--good)}.pill.warn{color:var(--warn)}.pill.bad{color:var(--bad)}.pill.wait{color:var(--warn)}.pill.run{color:var(--run)}
.strip{list-style:none;display:flex;flex-wrap:wrap;gap:6px 18px;padding:12px 0;margin:14px 0 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);font-size:13px}
.strip li{display:flex;align-items:center;gap:6px;color:var(--muted)}.strip .dot{width:9px;height:9px;border-radius:50%;background:var(--line)}
.strip .done .dot{background:var(--good)}.strip .run .dot{background:var(--run)}.strip .gate{color:var(--ink);font-weight:600}.strip .gate .dot{background:var(--warn)}
section{margin-top:34px}h2{font-size:17px;margin:0 0 4px}section>.sub{margin:0 0 12px}
.sub{color:var(--muted);font-size:13px}
.doc{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:6px 22px}
.doc h1{font-size:21px}.doc h2{font-size:16px;margin-top:18px}
.doc strong{color:var(--ink)}
.twocol{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media (max-width:720px){.twocol{grid-template-columns:1fr}}
.col{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:12px 16px}
.col h3{margin:0 0 6px;font-size:14px}
table{border-collapse:collapse;width:100%}td,th{text-align:left;vertical-align:top;padding:9px 10px;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:500;width:110px;font-size:13px}
.rows{background:var(--surface);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.num{font-variant-numeric:tabular-nums;white-space:nowrap}.t{font:12px var(--mono);color:var(--muted);white-space:nowrap}
.mono{font-family:var(--mono);font-size:12px}
tr.idle td{color:var(--muted)}tr.run td:first-child{box-shadow:inset 3px 0 var(--run)}tr.bad td:first-child{box-shadow:inset 3px 0 var(--bad)}
.scroll{overflow-x:auto}
details{background:var(--surface);border:1px solid var(--line);border-radius:8px;margin:8px 0}
summary{cursor:pointer;padding:10px 14px;font-weight:600}.idx{display:inline-block;min-width:20px;color:var(--muted);font:12px var(--mono)}
details .doc{border:0;border-top:1px solid var(--line);border-radius:0}
pre{white-space:pre-wrap;font:12px/1.55 var(--mono);margin:12px 0}
video{height:560px;max-width:100%;aspect-ratio:9/16;background:#000;border-radius:6px}
.incoming{margin-top:12px}
a{color:var(--accent)}
</style></head><body><main>
<header>
<p><a href="../../index.html">← 返回作品工作台</a></p>
<div class="stage">${esc(stage.toUpperCase())} · ${esc({ b1: '定题', b2: '成稿', b3: '成片' }[stage] ?? stage)} · ${esc(topicId)}</div>
<h1>${esc(title)}</h1>
<div class="meta">${human?.verdict ? `<span class="pill ${human.verdict === 'accept' ? 'good' : 'warn'}">${esc({ accept: '你已通过', revise: '你要求修改', invalid: '无效运行' }[human.verdict] ?? human.verdict)}</span><span class="sub">workflow：${esc(stateText)}</span>` : `<span class="pill ${stateClass}">${esc(stateText)}</span>`}<span>${time(firstEvent)} – ${time(lastEvent)}（${Math.round((seconds(firstEvent, lastEvent) ?? 0) / 6) / 10} 分钟）</span><span>内部审阅 ${gate?.rounds ?? '—'} 轮</span><span>约 ${Math.round(totalTokens / 1000)}k tokens</span><span class="mono">run ${esc(run.id.slice(0, 8))} · ${esc(run.workflowRevision)}</span></div>
<ol class="strip">${strip()}</ol>
</header>

${video ? `<section><h2>成片</h2><p class="sub">${esc(video)}</p><video controls preload="metadata" src="${esc(video)}"></video></section>` : ''}
<section><h2>这一阶段的${stage === 'b3' ? '稿件文件' : '决定'}</h2><p class="sub">workflow 交到你手上的主资产（最后一版）。</p><div class="doc">${decisionHtml}</div></section>

<section><h2>审阅</h2><p class="sub">左边是 workflow 内部的审阅者按标准卡给的判断；右边是你的判断。两边长期一致，这道闸才可以交给 agent。</p>
<div class="twocol">
<div class="col"><h3>${esc({ b1: '挑战者', b2: '主编', b3: '成品检查' }[stage] ?? '审阅者')} ${verdict?.verdict ? resultPill(verdict.verdict) : ''}</h3><p>${esc(verdict?.summary ?? '尚未审阅')}</p><div class="scroll"><table>${criteriaRows()}</table></div></div>
<div class="col"><h3>你 ${human?.verdict ? resultPill(human.verdict) : '<span class="pill wait">待审</span>'}</h3>${human ? `<p class="sub">${esc(human.reviewer ?? '')}</p><ol>${(human.notes ?? []).map(n => `<li>${esc(n)}</li>`).join('')}</ol>` : '<p class="sub">这一版还没有你的审阅。你的意见会写回标准卡，并作为下一轮最高优先级的输入。</p>'}</div>
</div>${incomingNotes.length ? `<div class="col incoming"><h3>这一轮是按这些意见改的</h3><p class="sub">${esc(incoming?.reviewer ?? '')}</p><ol>${incomingNotes.map(n => `<li>${esc(n)}</li>`).join('')}</ol></div>` : ''}</section>

<section><h2>为什么是这个 workflow</h2><p class="sub">每个角色都对应这个阶段的一种常见失败。</p><div class="scroll"><table class="rows">${roleRows()}</table></div></section>

<section><h2>进度</h2><p class="sub">按实际运行顺序，一行一步。</p><div class="scroll"><table class="rows"><tr><th>开始</th><th>步骤</th><th>谁在做</th><th>用时</th><th>产出</th></tr>${phaseRows()}</table></div></section>

<section><h2>输入</h2>${inputBlock()}</section>

<section><h2>全部产出</h2><p class="sub">workflow 发布的每一份资产，按顺序；点开看原文。</p>${artifactBlocks()}</section>
</main></body></html>`;

const outDir = path.join(root, stage, run.id);
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'index.html');
writeFileSync(outFile, html);
console.log(outFile);
