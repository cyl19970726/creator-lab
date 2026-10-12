#!/usr/bin/env node
import { Command } from "commander";
import { Pool } from "pg";

type RunRow = { id: string; parent_run_id: string | null; depth: number; document: {
  workflowId: string; workflowRevision: string; state: string } };
type EventRow = { run_id: string; seq: string | number; type: string; timestamp: string;
  turn: number | null; call_id: string | null; name: string | null; usage: unknown;
  output_chars: number | null; output_text_chars: number | null;
  generated_characters: number | null; function_argument_characters: number | null };
type Usage = { inputTokens: number; outputTokens: number; reasoningTokens: number; cachedTokens: number };
type ToolReading = { name: string; outputChars: number | null; outputTextChars: number | null; failed: boolean };
type ResponseReading = { requestSeq: number; responseSeq: number; turn: number | null; startedAt: string;
  endedAt: string; durationMs: number; usage: Usage; generatedCharacters: number;
  functionArgumentCharacters: number; tools: ToolReading[] };
type RunReading = { id: string; parentRunId: string | null; depth: number; workflowId: string; revision: string; state: string;
  startedAt: string | null; endedAt: string | null; durationMs: number | null; currentElapsedMs: number | null; activeMs: number;
  responses: ResponseReading[]; unmatchedRequests: number; unmatchedResponses: number;
  draftEvents: { staged: number; accepted: number; patched: number }; totals: Usage & { requests: number; requestDurationMs: number;
    generatedCharacters: number; functionArgumentCharacters: number } };
type RootReading = { rootRunId: string; runs: RunReading[];
  totals: Usage & { requests: number; requestDurationMs: number; generatedCharacters: number;
    functionArgumentCharacters: number; draftStaged: number; draftAccepted: number; draftPatched: number } };

const terminal = new Set(["workflow.completed", "workflow.failed", "workflow.needs_review", "workflow.blocked",
  "workflow.canceled"]);
const terminalStates = new Set(["succeeded", "failed", "needs_review", "blocked", "canceled"]);
const zeroUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0 });
const asObject = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
const duration = (start: string, end: string): number => Math.max(0, Date.parse(end) - Date.parse(start));

function usage(value: unknown): Usage {
  const item = asObject(value);
  return { inputTokens: count(item.input_tokens), outputTokens: count(item.output_tokens),
    reasoningTokens: count(asObject(item.output_tokens_details).reasoning_tokens),
    cachedTokens: count(asObject(item.input_tokens_details).cached_tokens) };
}

function addUsage(target: Usage, extra: Usage): void {
  target.inputTokens += extra.inputTokens; target.outputTokens += extra.outputTokens;
  target.reasoningTokens += extra.reasoningTokens; target.cachedTokens += extra.cachedTokens;
}

function readRun(row: RunRow, events: EventRow[], observedAt: string): RunReading {
  const ordered = [...events].sort((a, b) => Number(a.seq) - Number(b.seq));
  const requests: EventRow[] = [];
  const responses: ResponseReading[] = [];
  const calls = new Map<string, ToolReading>();
  const totals = { ...zeroUsage(), requests: 0, requestDurationMs: 0, generatedCharacters: 0,
    functionArgumentCharacters: 0 };
  const draftEvents = { staged: 0, accepted: 0, patched: 0 };
  let startedAt: string | null = null, endedAt: string | null = null, activeStart: string | null = null, activeMs = 0;
  let lastResponse: ResponseReading | null = null, unmatchedResponses = 0;
  for (const event of ordered) {
    if (event.type === "workflow.started") {
      startedAt ??= event.timestamp;
      activeStart = event.timestamp;
    } else if (terminal.has(event.type) || event.type === "workflow.waiting") {
      if (terminal.has(event.type)) endedAt = event.timestamp;
      if (activeStart) { activeMs += duration(activeStart, event.timestamp); activeStart = null; }
    } else if (event.type === "siwc.request") {
      requests.push(event);
      lastResponse = null;
    } else if (event.type === "siwc.response") {
      const request = requests.shift();
      if (!request) { unmatchedResponses++; continue; }
      const measured = duration(request.timestamp, event.timestamp);
      const consumed = usage(event.usage);
      const response: ResponseReading = { requestSeq: Number(request.seq), responseSeq: Number(event.seq), turn: event.turn,
        startedAt: request.timestamp, endedAt: event.timestamp, durationMs: measured, usage: consumed,
        generatedCharacters: count(event.generated_characters),
        functionArgumentCharacters: count(event.function_argument_characters), tools: [] };
      responses.push(response); lastResponse = response;
      totals.requests++; totals.requestDurationMs += measured; addUsage(totals, consumed);
      totals.generatedCharacters += response.generatedCharacters;
      totals.functionArgumentCharacters += response.functionArgumentCharacters;
    } else if (event.type === "siwc.tool_call") {
      if (!lastResponse) continue;
      const tool: ToolReading = { name: event.name ?? "unknown", outputChars: null, outputTextChars: null, failed: false };
      lastResponse.tools.push(tool);
      if (event.call_id) calls.set(event.call_id, tool);
    } else if (event.type === "siwc.tool_result" || event.type === "siwc.tool_failed") {
      const tool = event.call_id ? calls.get(event.call_id) : undefined;
      if (tool) {
        tool.outputChars = event.output_chars;
        tool.outputTextChars = event.output_text_chars;
        tool.failed = event.type === "siwc.tool_failed";
      }
    } else if (event.type === "responses.draft_staged") draftEvents.staged++;
    else if (event.type === "responses.draft_accepted") draftEvents.accepted++;
    else if (event.type === "responses.draft_patched") draftEvents.patched++;
  }
  if (activeStart) activeMs += duration(activeStart, observedAt);
  if (!terminalStates.has(row.document.state)) endedAt = null;
  return { id: row.id, parentRunId: row.parent_run_id, depth: row.depth,
    workflowId: row.document.workflowId, revision: row.document.workflowRevision, state: row.document.state,
    startedAt, endedAt, durationMs: startedAt && endedAt ? duration(startedAt, endedAt) : null,
    currentElapsedMs: startedAt && !endedAt ? duration(startedAt, observedAt) : null, activeMs,
    responses, unmatchedRequests: requests.length, unmatchedResponses, draftEvents, totals };
}

async function readTree(pool: Pool, workspaceId: string, rootRunId: string, observedAt: string): Promise<RootReading> {
  const runs = await pool.query<RunRow>(`WITH RECURSIVE tree AS (
    SELECT id, parent_run_id, document, 0 AS depth FROM aw_runs WHERE workspace_id=$1 AND id=$2
    UNION ALL
    SELECT child.id, child.parent_run_id, child.document, parent.depth + 1
    FROM aw_runs child JOIN tree parent ON child.parent_run_id=parent.id
    WHERE child.workspace_id=$1
  ) SELECT id, parent_run_id, depth, document FROM tree ORDER BY depth, id`, [workspaceId, rootRunId]);
  if (runs.rows.length === 0) throw new Error(`Run not found in workspace: ${rootRunId}`);
  const ids = runs.rows.map((row) => row.id);
  // Project only safe event metadata. Tool arguments, output bodies, model text and credentials never leave PostgreSQL.
  const events = await pool.query<EventRow>(`SELECT run_id, seq, document->>'type' AS type,
    document->>'timestamp' AS timestamp,
    CASE WHEN document->'data'->>'turn' ~ '^[0-9]+$' THEN (document->'data'->>'turn')::integer ELSE NULL END AS turn,
    document->'data'->>'callId' AS call_id, document->'data'->>'name' AS name,
    CASE WHEN document->>'type'='siwc.response' THEN document->'data'->'usage' ELSE NULL END AS usage,
    CASE WHEN document->>'type'='siwc.response' THEN (
      SELECT COALESCE(sum(length(part->>'text')),0)::integer
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(document->'data'->'visibleOutput')='array'
        THEN document->'data'->'visibleOutput' ELSE '[]'::jsonb END) AS item
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(item->'content')='array'
        THEN item->'content' ELSE '[]'::jsonb END) AS part
      WHERE item->>'type'='message' AND part->>'type'='output_text'
    ) ELSE NULL END AS generated_characters,
    CASE WHEN document->>'type'='siwc.response' THEN (
      SELECT COALESCE(sum(length(item->>'arguments')),0)::integer
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(document->'data'->'visibleOutput')='array'
        THEN document->'data'->'visibleOutput' ELSE '[]'::jsonb END) AS item
      WHERE item->>'type'='function_call'
    ) ELSE NULL END AS function_argument_characters,
    CASE WHEN document->>'type'='siwc.tool_result' THEN length((document->'data'->'output')::text) ELSE NULL END AS output_chars,
    CASE WHEN document->>'type'='siwc.tool_result' THEN length(document->'data'->'output'->>'text') ELSE NULL END AS output_text_chars
    FROM aw_events WHERE workspace_id=$1 AND run_id=ANY($2::text[])
      AND (document->>'type' IN ('workflow.started','workflow.completed','workflow.failed','workflow.needs_review',
        'workflow.blocked','workflow.canceled','workflow.waiting','siwc.request','siwc.response',
        'siwc.tool_call','siwc.tool_result','siwc.tool_failed','responses.draft_staged',
        'responses.draft_accepted','responses.draft_patched')) ORDER BY run_id, seq`, [workspaceId, ids]);
  const byRun = new Map<string, EventRow[]>();
  for (const event of events.rows) {
    const entries = byRun.get(event.run_id) ?? [];
    entries.push(event); byRun.set(event.run_id, entries);
  }
  const readings = runs.rows.map((row) => readRun(row, byRun.get(row.id) ?? [], observedAt));
  const totals = { ...zeroUsage(), requests: 0, requestDurationMs: 0, generatedCharacters: 0,
    functionArgumentCharacters: 0, draftStaged: 0, draftAccepted: 0, draftPatched: 0 };
  for (const run of readings) {
    addUsage(totals, run.totals); totals.requests += run.totals.requests;
    totals.requestDurationMs += run.totals.requestDurationMs;
    totals.generatedCharacters += run.totals.generatedCharacters;
    totals.functionArgumentCharacters += run.totals.functionArgumentCharacters;
    totals.draftStaged += run.draftEvents.staged; totals.draftAccepted += run.draftEvents.accepted;
    totals.draftPatched += run.draftEvents.patched;
  }
  return { rootRunId, runs: readings, totals };
}

function seconds(milliseconds: number | null): string { return milliseconds === null ? "—" : `${(milliseconds / 1000).toFixed(2)}s`; }
function printText(roots: RootReading[], workspaceId: string): void {
  process.stdout.write(`Workspace ${workspaceId}\n`);
  process.stdout.write("wall/elapsedSoFar includes suspended child waits; active excludes workflow.waiting gaps. Queue wait is unavailable because aw_runs.created_at is an identity, not a timestamp.\n");
  for (const root of roots) {
    process.stdout.write(`Root ${root.rootRunId}\n`);
    for (const run of root.runs) {
      process.stdout.write(`${"  ".repeat(run.depth)}${run.workflowId}@${run.revision} ${run.state} ${run.id}\n`);
      process.stdout.write(`${"  ".repeat(run.depth + 1)}${run.startedAt ?? "—"} → ${run.endedAt ?? "—"} wall=${seconds(run.durationMs)} elapsedSoFar=${seconds(run.currentElapsedMs)} active=${seconds(run.activeMs)}\n`);
      for (const response of run.responses) {
        const u = response.usage;
        const tools = response.tools.map((tool) => `${tool.name}:${tool.outputChars ?? "?"}chars${tool.outputTextChars === null ? "" : `(${tool.outputTextChars} text)`}${tool.failed ? "!" : ""}`).join(", ") || "none";
        process.stdout.write(`${"  ".repeat(run.depth + 2)}request#${response.requestSeq}→response#${response.responseSeq} turn=${response.turn ?? "?"} ${seconds(response.durationMs)} input=${u.inputTokens} output=${u.outputTokens} reasoning=${u.reasoningTokens} cached=${u.cachedTokens} generatedChars=${response.generatedCharacters} functionArgChars=${response.functionArgumentCharacters} tools=[${tools}]\n`);
      }
      const t = run.totals;
      process.stdout.write(`${"  ".repeat(run.depth + 1)}Σ requests=${t.requests} modelTime=${seconds(t.requestDurationMs)} input=${t.inputTokens} output=${t.outputTokens} reasoning=${t.reasoningTokens} cached=${t.cachedTokens} generatedChars=${t.generatedCharacters} functionArgChars=${t.functionArgumentCharacters} drafts=${run.draftEvents.staged}/${run.draftEvents.accepted}/${run.draftEvents.patched} (staged/accepted/patched) unmatched=${run.unmatchedRequests}/${run.unmatchedResponses}\n`);
    }
    const t = root.totals;
    process.stdout.write(`TOTAL requests=${t.requests} modelTime=${seconds(t.requestDurationMs)} input=${t.inputTokens} output=${t.outputTokens} reasoning=${t.reasoningTokens} cached=${t.cachedTokens} generatedChars=${t.generatedCharacters} functionArgChars=${t.functionArgumentCharacters} drafts=${t.draftStaged}/${t.draftAccepted}/${t.draftPatched}\n`);
  }
}

async function main(): Promise<void> {
  const command = new Command().name("benchmark-post-workflow")
    .description("Read-only workflow and SIWC timing summary from PostgreSQL")
    .requiredOption("--run <uuid>", "Root workflow UUID; repeatable", (value: string, previous: string[]) => [...previous, value], [] as string[])
    .option("--json", "Print JSON instead of text")
    .option("--workspace <id>", "Workflow workspace", "creator-lab-analysis")
    .parse(process.argv);
  const options = command.opts<{ run: string[]; json?: boolean; workspace: string }>();
  const ids = [...new Set(options.run)];
  if (ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id))) {
    throw new Error("Each --run must be a UUID");
  }
  const connectionString = process.env.SELF_MEDIA_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error("Set SELF_MEDIA_DATABASE_URL or DATABASE_URL");
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000 });
  try {
    const observedAt = new Date().toISOString();
    const roots: RootReading[] = [];
    for (const id of ids) roots.push(await readTree(pool, options.workspace, id, observedAt));
    if (options.json) process.stdout.write(`${JSON.stringify({ workspaceId: options.workspace, observedAt, roots }, null, 2)}\n`);
    else printText(roots, options.workspace);
  } finally { await pool.end(); }
}

main().catch((error: unknown) => {
  const safe = error instanceof Error && (error.message.startsWith("Each --run") || error.message.startsWith("Set SELF_MEDIA_DATABASE_URL")
    || error.message.startsWith("Run not found")) ? error.message : "PostgreSQL benchmark query failed";
  process.stderr.write(`${safe}\n`);
  process.exitCode = 1;
});
