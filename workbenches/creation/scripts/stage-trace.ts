import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { WorkflowEvent } from '@signal-room/workflow';
import { SQLiteWorkflowRunStore } from '@signal-room/workflow-sqlite';

/**
 * Tuning evidence for one stage run: per agent attempt — who, how long, tokens, what it searched,
 * how big its prompt/input/output were, and the Codex session file for a full forensic read.
 *   pnpm stage:trace <topicId> [runId]
 * Writes <runDir>/trace.md next to the run's assets.
 */
const [topicId, requestedRun] = process.argv.slice(2);
if (!topicId) throw new Error('Usage: stage-trace.ts <topicId> [runId]');
const root = path.resolve('.local/stages', topicId);
const store = new SQLiteWorkflowRunStore(new DatabaseSync(path.join(root, 'ledger.sqlite'), { readOnly: true }));
const runs = await store.listRuns({ metadata: { topicId } });
const run = requestedRun ? runs.find(r => r.id === requestedRun) : runs.at(-1);
if (!run) throw new Error(`No run found for ${topicId}`);

const events = await store.listEvents(run.id);
const steps = await store.listSteps(run.id);
type AgentEvent = WorkflowEvent & { data?: Record<string, unknown> };
const started = events.filter(e => e.type === 'agent.started') as AgentEvent[];
/** Local ~/.codex/config.toml warnings repeat on every call; they are environment noise, not agent errors. */
const KNOWN_NOISE = /ignoring \d+ unrecognized configuration setting|Under-development features enabled/;

/** Codex SDK threads are ordinary Codex sessions under ~/.codex/sessions/YYYY/MM/DD; match the file name by thread id. */
function sessionFile(threadId: string, startedAt: string): string | undefined {
  const base = path.join(homedir(), '.codex/sessions');
  const day = new Date(startedAt);
  for (const offset of [0, -1, 1]) {
    const d = new Date(day.getTime() + offset * 86_400_000);
    const dir = path.join(base, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    const hit = existsSync(dir) ? readdirSync(dir).find(name => name.includes(threadId)) : undefined;
    if (hit) return path.join(dir, hit);
  }
  return undefined;
}

const rows: string[] = [];
const details: string[] = [];
for (const start of started) {
  const done = events.find(e => e.type === 'agent.completed' && e.attemptId === start.attemptId) as AgentEvent | undefined;
  const failed = events.find(e => e.type === 'agent.failed' && e.attemptId === start.attemptId) as AgentEvent | undefined;
  const step = steps.find(s => s.id === start.stepRunId);
  const dir = path.join(root, 'traces', run.id, start.stepRunId ?? '', start.attemptId ?? '');
  const read = (name: string) => existsSync(path.join(dir, name)) ? readFileSync(path.join(dir, name), 'utf8') : '';
  const traceEvents = read('events.jsonl').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return {}; } });
  const items = traceEvents.filter(e => e.type === 'item.completed').map(e => e.item ?? {});
  const searches = items.filter(i => i.type === 'web_search').flatMap(i => i.action?.queries ?? (i.query ? [i.query] : []));
  const errors = items.filter(i => i.type === 'error' && !KNOWN_NOISE.test(String(i.message)));
  const usage = (done?.data?.usage ?? {}) as Record<string, number>;
  const threadId = String(done?.data?.threadId ?? traceEvents.find(e => e.type === 'thread.started')?.thread_id ?? '');
  const seconds = done ? Math.round((Date.parse(done.timestamp) - Date.parse(start.timestamp)) / 1000) : undefined;
  const role = String(start.data?.agentId ?? '');
  rows.push(`| ${step?.key ?? ''} | ${role} | ${start.data?.model} · ${start.data?.reasoningEffort} | ${seconds ?? (failed ? '失败' : '…')} | ${Math.round((usage.inputTokens ?? 0) / 1000)}k / ${usage.cachedInputTokens ? Math.round(usage.cachedInputTokens / 1000) + 'k' : '0'} / ${usage.outputTokens ?? 0} | ${read('prompt.txt').length} / ${read('input.json').length} / ${read('last-message.txt').length} | ${searches.length} | ${errors.length} |`);
  details.push([
    `### ${step?.key ?? ''} · ${role}`,
    `- Codex 会话：${threadId || '无'}${threadId ? ` → ${sessionFile(threadId, start.timestamp) ?? '（未在 ~/.codex/sessions 找到）'}` : ''}`,
    searches.length ? `- 搜索：\n${searches.map((q: string) => `  - ${q}`).join('\n')}` : '- 搜索：无',
    errors.length ? `- 错误：\n${errors.map(e => `  - ${String(e.message).slice(0, 200)}`).join('\n')}` : '',
    failed ? `- 失败：${JSON.stringify(failed.data).slice(0, 300)}` : '',
  ].filter(Boolean).join('\n'));
}

const md = [
  `# Trace · ${run.workflowId} · ${run.id}`, '',
  `状态：${run.state}　revision：${run.workflowRevision}`, '',
  '| 步骤 | 角色 | 模型 | 秒 | 输入/缓存/输出 tokens | prompt/输入/输出 字符 | 搜索 | 错误 |',
  '|---|---|---|---|---|---|---|---|',
  ...rows, '', '## 每次调用', '', ...details, '',
].join('\n');
const outDir = path.join(root, String(run.metadata?.stage ?? 'b1'), run.id);
if (existsSync(outDir)) writeFileSync(path.join(outDir, 'trace.md'), md);
console.log(md);
