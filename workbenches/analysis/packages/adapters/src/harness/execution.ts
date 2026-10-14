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
export type BoundedPostSpaceBinding = {
  spaceId: string;
  caseId: string;
  /** Optional pre-existing Space run; never substitute the prepared execution id for a native run id. */
  runId?: string;
  workflowVersionId: string;
  inputManifestId: string;
  methodHash?: string;
};
export type BoundedPostExecutionReceipt = {
  id: string;
  input: BoundedPostExecutionInput;
  state: "prepared" | "launching" | "running" | "succeeded" | "incomplete" | "failed" | "timed_out" | "interrupted";
  /** Process termination and business completion are independent; quality requires a separate audit. */
  processOutcome: "not_started" | "running" | "exited" | "failed_to_start" | "timed_out" | "interrupted";
  businessOutcome: "not_started" | "running" | "completed" | "incomplete";
  qualityAcceptance: "unknown";
  spaceBinding?: BoundedPostSpaceBinding;
  /** Preserved so a repeated start with the original prepared binding remains idempotent after manifest refreeze. */
  initialSpaceBinding?: BoundedPostSpaceBinding;
  launcherPid?: number;
  workflowRunIds?: string[];
  nativeWorkflowRunId?: string;
  nativeWorkflowId?: string;
  /** Exact input passed to native runWorkflow, retained only in the private 0600 receipt. */
  nativeWorkflowInput?: unknown;
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
  frozenInputSha256: string;
  methodSnapshotSha256: string;
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
  /** Must link the native run to the prepared Space run before the child can enter a model step. */
  onRunCreated?: (receipt: BoundedPostExecutionReceipt) => Promise<BoundedPostSpaceBinding | void>;
};

const FULL_TIMEOUT_MS = 60 * 60_000;
const REVIEWER_TIMEOUT_MS = 15 * 60_000;
const DRY_RUN_TIMEOUT_MS = 2 * 60_000;
const MAX_DRY_RUN_BYTES = 2_000_000;
const MAX_SUMMARY_BYTES = 8_000_000;
const RUN_BIND_TIMEOUT_MS = 60_000;
let hostDisconnectGuardInstalled = false;

/** Called by benchmark scripts immediately after their paid root run is persisted. */
export async function awaitHarnessRunBinding(runId: string, workflowId: string, input: unknown): Promise<void> {
  if (!process.send) return;
  // The host owns the wall-clock limit. A detached child must never continue to a paid step.
  if (!hostDisconnectGuardInstalled) {
    process.once("disconnect", () => process.exit(1));
    hostDisconnectGuardInstalled = true;
  }
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => finish(new Error("Harness run binding timed out")), RUN_BIND_TIMEOUT_MS);
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const row = message as Record<string, unknown>;
      if (row.type !== "harness.bind-ack" || row.runId !== runId) return;
      finish(row.ok === true ? undefined : new Error("Harness run binding failed"));
    };
    const finish = (error?: Error) => {
      clearTimeout(timer); process.off("message", onMessage);
      if (error) reject(error); else { process.channel?.unref(); resolvePromise(); }
    };
    process.on("message", onMessage);
    process.send!({ type: "harness.run-created", runId, workflowId, input });
  });
}

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
    || row.reasoningEffort !== "medium" || row.registrationEnabled !== false || row.currentBatchMutation !== false
    || typeof row.sourceWorkspaceId !== "string"
    || ![row.frozenInputSha256, row.methodSnapshotSha256].every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))) {
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
function workflowRunIds(result: Record<string, unknown> | undefined): string[] {
  if (!result) return [];
  const ids = new Set<string>();
  const add = (value: unknown) => { if (typeof value === "string" && value) ids.add(value); };
  add(result.workflowRunId);
  if (Array.isArray(result.results)) for (const item of result.results) {
    if (item && typeof item === "object") {
      const row = item as Record<string, unknown>;
      add(row.workflowRunId);
      if (row.repair && typeof row.repair === "object") add((row.repair as Record<string, unknown>).workflowRunId);
    }
  }
  return [...ids];
}
function businessCompleted(kind: BoundedPostExecutionKind, result: Record<string, unknown> | undefined): boolean {
  if (!result || result.status !== "completed") return false;
  if (kind === "full") return result.runState === "succeeded" && typeof result.workflowRunId === "string";
  if (result.repeat !== 1 || result.completedRepeats !== 1 || !Array.isArray(result.results) || result.results.length !== 1) return false;
  const review = result.results[0] as Record<string, unknown> | undefined;
  return review?.runState === "succeeded" && review.completion === "receipt-recorded"
    && typeof review.workflowRunId === "string";
}
function checkedBinding(binding: BoundedPostSpaceBinding): BoundedPostSpaceBinding {
  if (!binding || [binding.spaceId, binding.caseId, binding.workflowVersionId, binding.inputManifestId,
    ...(binding.runId === undefined ? [] : [binding.runId])]
    .some(value => typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))) {
    throw new Error("Invalid Space execution binding");
  }
  if (binding.methodHash !== undefined && !/^[a-f0-9]{64}$/.test(binding.methodHash)) {
    throw new Error("Invalid Space method hash");
  }
  return { ...binding };
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
      stdio: ["ignore", "pipe", "pipe", "ipc"] });
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
    let receipt = readReceipt(fileFor(id));
    if (receipt?.state === "launching" && receipt.launcherPid && !processAlive(receipt.launcherPid)) {
      receipt = { ...receipt, state: "interrupted", processOutcome: "interrupted", businessOutcome: "incomplete",
        finishedAt: new Date().toISOString(), failure: "Execution host ended after reserving the only launch" };
      saveReceipt(fileFor(id), receipt);
    }
    if (receipt?.state === "running" && receipt.pid && !active.has(id) && !processAlive(receipt.pid)) {
      const interrupted = { ...receipt, state: "interrupted" as const, finishedAt: new Date().toISOString(),
        processOutcome: "interrupted" as const, businessOutcome: "incomplete" as const,
        failure: "Execution process ended without a terminal receipt" };
      saveReceipt(fileFor(id), interrupted);
      return interrupted;
    }
    if (receipt?.state === "running") {
      try {
        const result = readSummary(receipt.summaryPath);
        if (result && stable(result) !== stable(receipt.result)) {
          const latest = readReceipt(fileFor(id));
          if (latest?.state === "running" && stable(result) !== stable(latest.result)) {
            receipt = { ...latest, result, workflowRunIds: [...new Set([
              ...(latest.workflowRunIds ?? []), ...workflowRunIds(result)])] };
            saveReceipt(fileFor(id), receipt);
          } else receipt = latest;
        }
      } catch { /* A partial progress summary is not a terminal business result. */ }
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
    const receipt: BoundedPostExecutionReceipt = { id, input, state: "prepared", processOutcome: "not_started",
      businessOutcome: "not_started", qualityAcceptance: "unknown", preparedAt: new Date().toISOString(),
      summaryPath, scriptSha256, dependencySha256, snapshotSha256: sha(stable(snapshot)), snapshot,
      frozenInputSha256: snapshot.frozenInputSha256 as string, methodSnapshotSha256: snapshot.methodSnapshotSha256 as string };
    saveReceipt(file, receipt);
    return receipt;
    } finally { closeSync(fd); rmSync(lock, { force: true }); }
  }
  async function start(id: string, binding?: BoundedPostSpaceBinding): Promise<BoundedPostExecutionReceipt> {
    const current = status(id);
    if (!current) throw new Error("Execution was not prepared");
    const normalizedBinding = binding && checkedBinding(binding);
    if (normalizedBinding && !options.onRunCreated) throw new Error("Space binding requires onRunCreated");
    const assertSameBinding = (receipt: BoundedPostExecutionReceipt) => {
      if (normalizedBinding && receipt.spaceBinding && stable(normalizedBinding) !== stable(receipt.spaceBinding)
        && stable(normalizedBinding) !== stable(receipt.initialSpaceBinding)) {
        throw new Error("Execution already bound to another Space run");
      }
    };
    assertSameBinding(current);
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
        if (inFlight && inFlight.state !== "prepared") { assertSameBinding(inFlight); return inFlight; }
        if (Date.now() >= waitUntil) throw new Error("Execution start lock did not clear");
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    try {
      const latest = status(id)!;
      assertSameBinding(latest);
      if (latest.state !== "prepared") return latest;
      if (sha(readFileSync(scripts[latest.input.kind])) !== latest.scriptSha256) throw new Error("Execution script changed after prepare");
      if (stable(dependencyHashes()) !== stable(latest.dependencySha256)) throw new Error("Execution SDK source changed after prepare");
      const snapshot = await dryRun(latest.input, latest.summaryPath);
      if (sha(stable(snapshot)) !== latest.snapshotSha256) throw new Error("Execution source or method snapshot changed after prepare");
      if (sha(readFileSync(scripts[latest.input.kind])) !== latest.scriptSha256
        || stable(dependencyHashes()) !== stable(latest.dependencySha256)) throw new Error("Execution files changed during revalidation");
      if (existsSync(latest.summaryPath)) throw new Error("Execution summary path already exists");
      // Persist the Space link and consume the one launch before a child can start.
      const launching: BoundedPostExecutionReceipt = { ...latest, state: "launching", processOutcome: "running",
        businessOutcome: "running", launcherPid: process.pid,
        ...(normalizedBinding ? { spaceBinding: normalizedBinding, initialSpaceBinding: normalizedBinding } : {}) };
      saveReceipt(file, launching);
      const child = invoke(latest.input.kind, executionArgs(latest.input, latest.summaryPath, false));
      const running: BoundedPostExecutionReceipt = { ...launching, state: "running", startedAt: new Date().toISOString(), pid: child.pid };
      try { saveReceipt(file, running); } catch (error) { stopGroup(child); throw error; }
      active.add(id);
      let bindingFailed = false;
      child.on("message", (message: unknown) => {
        if (!message || typeof message !== "object") return;
        const event = message as Record<string, unknown>;
        if (event.type !== "harness.run-created" || typeof event.runId !== "string" || !Object.hasOwn(event, "input")
          || typeof event.workflowId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(event.runId)) {
          stopGroup(child); return;
        }
        void (async () => {
          const previous = readReceipt(file);
          if (!previous || previous.state !== "running" || previous.nativeWorkflowRunId) throw new Error("Duplicate or late native run identity");
          const linked: BoundedPostExecutionReceipt = { ...previous, nativeWorkflowRunId: event.runId as string,
            nativeWorkflowId: event.workflowId as string, nativeWorkflowInput: event.input,
            workflowRunIds: [event.runId as string] };
          saveReceipt(file, linked);
          if (linked.spaceBinding) {
            const updated = await options.onRunCreated!(linked);
            if (updated) {
              const next = checkedBinding(updated);
              const original = linked.spaceBinding;
              if (next.spaceId !== original.spaceId || next.caseId !== original.caseId
                || next.workflowVersionId !== original.workflowVersionId || next.methodHash !== original.methodHash
                || next.runId !== linked.nativeWorkflowRunId
                || (original.runId !== undefined && original.runId !== next.runId)) {
                throw new Error("Space callback changed frozen binding identity or native run ID");
              }
              saveReceipt(file, { ...linked, spaceBinding: next });
            }
          }
          child.send({ type: "harness.bind-ack", runId: event.runId, ok: true });
        })().catch(() => { bindingFailed = true;
          try { child.send({ type: "harness.bind-ack", runId: event.runId, ok: false }); } catch { /* child exited */ }
          stopGroup(child); });
      });
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
        else if (bindingFailed) failure = "Native run could not be linked to the Space before model execution";
        else if (!result) failure ??= "Execution summary is missing";
        const complete = !timedOut && !bindingFailed && code === 0 && businessCompleted(latest.input.kind, result);
        const state = timedOut ? "timed_out" : code !== 0 || spawnError || bindingFailed || !result ? "failed" : complete ? "succeeded" : "incomplete";
        saveReceipt(file, { ...previous, state, processOutcome: timedOut ? "timed_out" : spawnError ? "failed_to_start" : "exited",
          businessOutcome: complete ? "completed" : "incomplete", qualityAcceptance: "unknown",
          finishedAt: new Date().toISOString(), exitCode: code, signal,
          ...(result ? { result, workflowRunIds: workflowRunIds(result) } : {}), ...(failure ? { failure } : {}) });
      };
      child.once("error", (error) => finish(null, null, error));
      child.once("close", (code, signal) => finish(code, signal));
      return running;
    } finally { closeSync(fd); rmSync(lock, { force: true }); }
  }
  return { prepare, start, status };
}
