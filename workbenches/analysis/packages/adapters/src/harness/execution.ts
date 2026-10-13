import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, closeSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type BoundedPostExecutionKind = "full" | "reviewer";
export type BoundedPostExecutionInput = {
  /** Stable host-owned identity for this release/first round. Never derive it from a caller's request. */
  scopeKey: string;
  kind: BoundedPostExecutionKind;
  sourceWorkflowRunId?: string;
  candidateArtifactId?: string;
  sourceReviewArtifactId?: string;
  caseLabel?: string;
};
export type BoundedPostExecutionReceipt = {
  id: string;
  input: BoundedPostExecutionInput;
  state: "prepared" | "running" | "succeeded" | "failed" | "timed_out" | "interrupted";
  preparedAt: string;
  startedAt?: string;
  finishedAt?: string;
  pid?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  summaryPath: string;
  scriptSha256: string;
  dependencySha256: Record<string, string>;
  snapshotSha256: string;
  snapshot: Record<string, unknown>;
  result?: Record<string, unknown>;
  failure?: string;
};

type Options = {
  receiptsDir: string;
  analysisRoot?: string;
  /** Injectable launch paths permit local process tests without a database or model. */
  launcher?: { command: string; argsPrefix: readonly string[] };
  scripts?: Partial<Record<BoundedPostExecutionKind, string>>;
  /** Defaults to the SDK transport source and manifest; tests can inject local fixtures. */
  frozenFiles?: readonly string[];
};

const FULL_TIMEOUT_MS = 60 * 60_000;
const REVIEWER_TIMEOUT_MS = 15 * 60_000;
const DRY_RUN_TIMEOUT_MS = 2 * 60_000;
const MAX_DRY_RUN_BYTES = 2_000_000;
const MAX_SUMMARY_BYTES = 8_000_000;

function sha(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Execution script did not return a JSON object");
  return value as Record<string, unknown>;
}
function assertInput(input: BoundedPostExecutionInput): BoundedPostExecutionInput {
  if (!input || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.scopeKey)) throw new Error("Invalid execution scopeKey");
  if (input.kind !== "full" && input.kind !== "reviewer") throw new Error("Unsupported execution kind");
  for (const field of [input.sourceWorkflowRunId, input.candidateArtifactId, input.sourceReviewArtifactId]) {
    if (field !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(field))) throw new Error("Invalid execution source ID");
  }
  if (input.caseLabel !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.caseLabel)) {
    throw new Error("Invalid execution case label");
  }
  if (input.kind === "full" && (!input.sourceWorkflowRunId || input.sourceReviewArtifactId)) {
    throw new Error("Full execution requires a workflow run and cannot select a review");
  }
  if (input.kind === "reviewer" && !input.sourceWorkflowRunId && !input.sourceReviewArtifactId && !input.candidateArtifactId) {
    throw new Error("Reviewer execution requires a source candidate, review, or workflow");
  }
  if (input.kind === "reviewer" && input.sourceWorkflowRunId && input.sourceReviewArtifactId) {
    throw new Error("Reviewer execution can select only one history source");
  }
  return { ...input, caseLabel: input.caseLabel ?? "harness-first" };
}
function executionArgs(input: BoundedPostExecutionInput, summaryPath: string, dryRun: boolean): string[] {
  const args = ["--case", input.caseLabel!, "--output", summaryPath];
  if (input.sourceWorkflowRunId) args.push("--source-workflow-run-id", input.sourceWorkflowRunId);
  if (input.candidateArtifactId) args.push("--candidate-artifact-id", input.candidateArtifactId);
  if (input.sourceReviewArtifactId) args.push("--source-review-artifact-id", input.sourceReviewArtifactId);
  if (input.kind === "reviewer") args.push("--repeat", "1");
  if (dryRun) args.push("--dry-run");
  return args;
}
function assertSnapshot(kind: BoundedPostExecutionKind, row: Record<string, unknown>, summaryPath: string): void {
  if (row.mode !== "dry-run" || row.summaryPath !== summaryPath || row.model !== "gpt-6-luna"
    || row.reasoningEffort !== "medium" || row.registrationEnabled !== false || row.currentBatchMutation !== false) {
    throw new Error("Dry-run is outside the approved bounded execution contract");
  }
  if (kind === "full") {
    const candidate = record(row.sourceCandidateArtifact);
    const sdk = record(row.sdk);
    if (typeof candidate.sha256 !== "string" || typeof candidate.reportSha256 !== "string"
      || typeof sdk.sourceSha256 !== "string" || typeof sdk.packageSha256 !== "string"
      || !Array.isArray(row.promptHashes) || row.candidateMode !== "rebuild" || row.evaluationMode !== "fresh") {
      throw new Error("Full dry-run lacks frozen candidate, SDK, or prompt evidence");
    }
  } else {
    const candidate = record(row.candidateArtifact);
    if (typeof candidate.sha256 !== "string" || typeof candidate.reportSha256 !== "string"
      || typeof row.currentPromptSha256 !== "string" || row.repeat !== 1
      || row.repairOnFindings !== false || row.reportOverride !== null) {
      throw new Error("Reviewer dry-run must bind one old candidate without repeat, repair, or report override");
    }
  }
}
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function stopGroup(child: ChildProcess): void {
  if (!child.pid) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* already exited */ } }
  const hardStop = setTimeout(() => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already exited */ } }
  }, 5_000);
  hardStop.unref();
}
function saveReceipt(file: string, receipt: BoundedPostExecutionReceipt): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try { renameSync(temporary, file); } catch (error) { rmSync(temporary, { force: true }); throw error; }
}
function readReceipt(file: string): BoundedPostExecutionReceipt | undefined {
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, "utf8")) as BoundedPostExecutionReceipt;
}
function readSummary(file: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  const { size } = statSync(file);
  if (size > MAX_SUMMARY_BYTES) throw new Error("Execution summary exceeds size limit");
  return record(JSON.parse(readFileSync(file, "utf8")));
}
export function createBoundedPostExecutionProvider(options: Options) {
  if (!isAbsolute(options.receiptsDir)) throw new Error("receiptsDir must be absolute");
  const analysisRoot = resolve(options.analysisRoot ?? join(import.meta.dirname, "../../../../"));
  const scripts = {
    full: options.scripts?.full ?? join(analysisRoot, "scripts/benchmark-post-workflow-run.ts"),
    reviewer: options.scripts?.reviewer ?? join(analysisRoot, "scripts/benchmark-post-reviewer.ts"),
  };
  const launcher = options.launcher ?? { command: process.execPath, argsPrefix: ["--import", "tsx"] };
  const frozenFiles = options.frozenFiles ?? [
    resolve(analysisRoot, "../../vendor/agent-workflow/packages/agent-sdk/src/responses.ts"),
    resolve(analysisRoot, "../../vendor/agent-workflow/packages/agent-sdk/package.json"),
  ];
  const dependencyHashes = () => Object.fromEntries(frozenFiles.map(file => [file, sha(readFileSync(file))]));
  const fileFor = (id: string) => join(options.receiptsDir, `${id}.json`);
  const active = new Set<string>();
  const environment = () => ({ ...process.env, SELF_MEDIA_BUILDER_MODEL: "gpt-6-luna",
    SELF_MEDIA_BUILDER_REASONING_EFFORT: "medium", SELF_MEDIA_EVALUATOR_REASONING_EFFORT: "medium" });
  const invoke = (kind: BoundedPostExecutionKind, args: string[]) => spawn(launcher.command,
    [...launcher.argsPrefix, scripts[kind], ...args], { cwd: analysisRoot, env: environment(), detached: true,
      stdio: ["ignore", "pipe", "pipe"] });
  async function dryRun(input: BoundedPostExecutionInput, summaryPath: string): Promise<Record<string, unknown>> {
    const child = invoke(input.kind, executionArgs(input, summaryPath, true));
    return await new Promise((resolvePromise, reject) => {
      let out = "";
      let errorBytes = 0;
      let settled = false;
      const finish = (error?: Error, value?: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolvePromise(value!);
      };
      const timer = setTimeout(() => { stopGroup(child); finish(new Error("Execution dry-run timed out")); }, DRY_RUN_TIMEOUT_MS);
      child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8");
        if (Buffer.byteLength(out) > MAX_DRY_RUN_BYTES) { stopGroup(child); finish(new Error("Execution dry-run output too large")); } });
      child.stderr?.on("data", (chunk: Buffer) => { errorBytes += chunk.length;
        if (errorBytes > MAX_DRY_RUN_BYTES) { stopGroup(child); finish(new Error("Execution dry-run error output too large")); } });
      child.on("error", (error) => finish(error));
      child.on("close", (code) => {
        if (code !== 0) { finish(new Error(`Execution dry-run failed (exit ${code ?? "unknown"})`)); return; }
        try { const row = record(JSON.parse(out)); assertSnapshot(input.kind, row, summaryPath); finish(undefined, row); }
        catch (error) { finish(error instanceof Error ? error : new Error("Invalid execution dry-run")); }
      });
    });
  }
  function status(id: string): BoundedPostExecutionReceipt | undefined {
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("Invalid execution id");
    const receipt = readReceipt(fileFor(id));
    if (receipt?.state === "running" && receipt.pid && !active.has(id) && !processAlive(receipt.pid)) {
      const interrupted = { ...receipt, state: "interrupted" as const, finishedAt: new Date().toISOString(),
        failure: "Execution process ended without a terminal receipt" };
      saveReceipt(fileFor(id), interrupted);
      return interrupted;
    }
    return receipt;
  }
  async function prepare(rawInput: BoundedPostExecutionInput): Promise<BoundedPostExecutionReceipt> {
    const input = assertInput(rawInput);
    const id = sha(`${input.scopeKey}\u0000${input.kind}`);
    const file = fileFor(id);
    const existing = status(id);
    if (existing) {
      if (stable(existing.input) !== stable(input)) throw new Error("Execution scope already prepared with different inputs");
      return existing;
    }
    const lock = `${file}.prepare.lock`;
    mkdirSync(options.receiptsDir, { recursive: true, mode: 0o700 });
    let fd: number | undefined;
    const waitUntil = Date.now() + DRY_RUN_TIMEOUT_MS + 10_000;
    while (fd === undefined) {
      try { fd = openSync(lock, "wx", 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const prepared = status(id);
        if (prepared) {
          if (stable(prepared.input) !== stable(input)) throw new Error("Execution scope already prepared with different inputs");
          return prepared;
        }
        if (Date.now() >= waitUntil) throw new Error("Execution prepare lock did not clear");
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    try {
      const lockedExisting = status(id);
      if (lockedExisting) {
        if (stable(lockedExisting.input) !== stable(input)) throw new Error("Execution scope already prepared with different inputs");
        return lockedExisting;
      }
    const summaryPath = join(options.receiptsDir, `${id}.summary.json`);
    if (existsSync(summaryPath)) throw new Error("Execution summary path already exists");
    const scriptSha256 = sha(readFileSync(scripts[input.kind]));
    const dependencySha256 = dependencyHashes();
    const snapshot = await dryRun(input, summaryPath);
    if (scriptSha256 !== sha(readFileSync(scripts[input.kind])) || stable(dependencySha256) !== stable(dependencyHashes())) {
      throw new Error("Execution files changed during prepare");
    }
    const receipt: BoundedPostExecutionReceipt = { id, input, state: "prepared", preparedAt: new Date().toISOString(),
      summaryPath, scriptSha256, dependencySha256, snapshotSha256: sha(stable(snapshot)), snapshot };
    saveReceipt(file, receipt);
    return receipt;
    } finally { closeSync(fd); rmSync(lock, { force: true }); }
  }
  async function start(id: string): Promise<BoundedPostExecutionReceipt> {
    const current = status(id);
    if (!current) throw new Error("Execution was not prepared");
    if (current.state !== "prepared") return current;
    const file = fileFor(id);
    const lock = `${file}.start.lock`;
    mkdirSync(options.receiptsDir, { recursive: true, mode: 0o700 });
    let fd: number | undefined;
    const waitUntil = Date.now() + DRY_RUN_TIMEOUT_MS + 10_000;
    while (fd === undefined) {
      try { fd = openSync(lock, "wx", 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const inFlight = status(id);
        if (inFlight && inFlight.state !== "prepared") return inFlight;
        if (Date.now() >= waitUntil) throw new Error("Execution start lock did not clear");
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    try {
      const latest = status(id)!;
      if (latest.state !== "prepared") return latest;
      if (sha(readFileSync(scripts[latest.input.kind])) !== latest.scriptSha256) throw new Error("Execution script changed after prepare");
      if (stable(dependencyHashes()) !== stable(latest.dependencySha256)) throw new Error("Execution SDK source changed after prepare");
      const snapshot = await dryRun(latest.input, latest.summaryPath);
      if (sha(stable(snapshot)) !== latest.snapshotSha256) throw new Error("Execution source or method snapshot changed after prepare");
      if (sha(readFileSync(scripts[latest.input.kind])) !== latest.scriptSha256
        || stable(dependencyHashes()) !== stable(latest.dependencySha256)) throw new Error("Execution files changed during revalidation");
      if (existsSync(latest.summaryPath)) throw new Error("Execution summary path already exists");
      const child = invoke(latest.input.kind, executionArgs(latest.input, latest.summaryPath, false));
      const running: BoundedPostExecutionReceipt = { ...latest, state: "running", startedAt: new Date().toISOString(), pid: child.pid };
      try { saveReceipt(file, running); } catch (error) { stopGroup(child); throw error; }
      active.add(id);
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; stopGroup(child); },
        latest.input.kind === "full" ? FULL_TIMEOUT_MS : REVIEWER_TIMEOUT_MS);
      timer.unref();
      // The scripts own workflow persistence. We only record process and summary outcome.
      child.stdout?.resume();
      child.stderr?.resume();
      const onHostExit = () => stopGroup(child);
      process.once("exit", onHostExit);
      const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
        clearTimeout(timer);
        process.removeListener("exit", onHostExit);
        active.delete(id);
        const previous = readReceipt(file);
        if (!previous || previous.state !== "running") return;
        let result: Record<string, unknown> | undefined;
        let failure: string | undefined;
        try { result = readSummary(latest.summaryPath); } catch { failure = "Execution summary is invalid"; }
        if (spawnError) failure = "Execution child process failed to start";
        else if (!result) failure ??= "Execution summary is missing";
        const state = timedOut ? "timed_out" : code === 0 && result ? "succeeded" : "failed";
        saveReceipt(file, { ...previous, state, finishedAt: new Date().toISOString(), exitCode: code,
          signal, ...(result ? { result } : {}), ...(failure ? { failure } : {}) });
      };
      child.once("error", (error) => finish(null, null, error));
      child.once("close", (code, signal) => finish(code, signal));
      return running;
    } finally { closeSync(fd); rmSync(lock, { force: true }); }
  }
  return { prepare, start, status };
}
