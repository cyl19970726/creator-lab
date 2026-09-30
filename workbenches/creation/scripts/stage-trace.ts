import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { WorkflowEvent } from '@signal-room/workflow';
import { codexSessionFile, summarizeCodexAttempt } from '@signal-room/workflow-codex';
import { SQLiteWorkflowRunStore } from '@signal-room/workflow-sqlite';

/**
 * Tuning evidence for one stage run: per agent attempt — who, how long, tokens, what it searched,
 * which commands failed, how big its prompt/input/output were, and the Codex session file for a full forensic read.
 *   pnpm stage:trace <topicId> [runId]
 * Writes <runDir>/trace.md next to the run's assets.
 */
const [topicId, requestedRun] = process.argv.slice(2);
if (!topicId) throw new Error('Usage: stage-trace.ts <topicId> [runId]');
const root = path.resolve('.local/stages', topicId);
const store = new SQLiteWorkflowRunStore(new DatabaseSync(path.join(root, 'ledger.sqlite'), { readOnly: true }));
const runs = await store.listRuns({ metadata: { topicId } });
// listRuns returns newest first.
const run = requestedRun ? runs.find(r => r.id === requestedRun) : runs[0];
if (!run) throw new Error(`No run found for ${topicId}`);

const events = await store.listEvents(run.id);
const steps = await store.listSteps(run.id);
type AgentEvent = WorkflowEvent & { data?: Record<string, unknown> };
const started = events.filter(e => e.type === 'agent.started') as AgentEvent[];
/** Local ~/.codex/config.toml warnings repeat on every call; they are environment noise, not agent errors. */
const KNOWN_NOISE = /ignoring \d+ unrecognized configuration setting|Under-development features enabled/;

const rows: string[] = [];
const details: string[] = [];
for (const start of started) {
  const done = events.find(e => e.type === 'agent.completed' && e.attemptId === start.attemptId) as AgentEvent | undefined;
  const step = steps.find(s => s.id === start.stepRunId);
  const dir = path.join(root, 'traces', run.id, start.stepRunId ?? '', start.attemptId ?? '');
  if (!existsSync(path.join(dir, 'runtime.json'))) continue;
  const a = summarizeCodexAttempt(dir, { ignoreErrors: KNOWN_NOISE });
  const seconds = done ? Math.round((Date.parse(done.timestamp) - Date.parse(start.timestamp)) / 1000) : undefined;
  const usage = a.usage;
  const failedCommands = a.commands.filter(c => c.exitCode !== 0 && c.exitCode !== null);
  rows.push(`| ${step?.key ?? ''} | ${a.agentId} | ${a.model} · ${a.reasoningEffort} | ${seconds ?? (a.state === 'failed' ? '失败' : '…')} | ${Math.round((usage?.inputTokens ?? 0) / 1000)}k / ${usage?.cachedInputTokens ? Math.round(usage.cachedInputTokens / 1000) + 'k' : '0'} / ${usage?.outputTokens ?? 0} | ${a.chars.prompt} / ${a.chars.input} / ${a.chars.output} | ${a.searches.length} | ${a.commands.length}${failedCommands.length ? `（${failedCommands.length} 失败）` : ''} | ${a.errors.length} |`);
  const session = a.threadId ? codexSessionFile(a.threadId, { startedAt: start.timestamp }) : undefined;
  details.push([
    `### ${step?.key ?? ''} · ${a.agentId}`,
    `- Codex：${a.codexRuntimeVersion}（${a.codexPath}）`,
    `- Codex 会话：${a.threadId ?? '无'}${a.threadId ? ` → ${session ?? '（未在 ~/.codex 找到）'}` : ''}`,
    a.searches.length ? `- 搜索：\n${a.searches.map(q => `  - ${q}`).join('\n')}` : '- 搜索：无',
    failedCommands.length ? `- 失败的命令：\n${failedCommands.map(c => `  - (${c.exitCode}) ${c.command.slice(0, 160)}`).join('\n')}` : '',
    a.filesChanged.length ? `- 改动文件：${a.filesChanged.length} 个` : '',
    a.errors.length ? `- 错误：\n${a.errors.map(e => `  - ${e.slice(0, 200)}`).join('\n')}` : '',
    a.failure ? `- 失败：${a.failure.slice(0, 300)}` : '',
  ].filter(Boolean).join('\n'));
}

const md = [
  `# Trace · ${run.workflowId} · ${run.id}`, '',
  `状态：${run.state}　revision：${run.workflowRevision}`, '',
  '| 步骤 | 角色 | 模型 | 秒 | 输入/缓存/输出 tokens | prompt/输入/输出 字符 | 搜索 | 命令 | 错误 |',
  '|---|---|---|---|---|---|---|---|---|',
  ...rows, '', '## 每次调用', '', ...details, '',
].join('\n');
const outDir = path.join(root, String(run.metadata?.stage ?? 'b1'), run.id);
if (existsSync(outDir)) writeFileSync(path.join(outDir, 'trace.md'), md);
console.log(md);
