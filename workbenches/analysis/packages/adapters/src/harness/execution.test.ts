import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoundedPostExecutionProvider } from "./execution.js";

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(options?: { summaryStatus?: "completed" | "incomplete";
  onRunCreated?: (receipt: import("./execution.js").BoundedPostExecutionReceipt) =>
    Promise<import("./execution.js").BoundedPostSpaceBinding | void> }) {
  const root = mkdtempSync(join(tmpdir(), "bounded-post-execution-"));
  temporary.push(root);
  const script = join(root, "script.mjs");
  const source = join(root, "source.txt");
  writeFileSync(source, "a".repeat(64));
  writeFileSync(script, `
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const get = (key) => args[args.indexOf(key) + 1];
const reviewer = args.includes("--repeat");
const sourceSha = readFileSync(${JSON.stringify(source)}, "utf8");
if (reviewer && (get("--repeat") !== "1" || args.includes("--repair-on-findings") || args.includes("--report-path"))) process.exit(2);
if (process.env.SELF_MEDIA_BUILDER_MODEL !== "gpt-6-luna" ||
    process.env.SELF_MEDIA_EVALUATOR_REASONING_EFFORT !== "medium" ||
    process.env.SELF_MEDIA_BUILDER_REASONING_EFFORT !== "medium") process.exit(3);
const row = reviewer ? { mode: "dry-run", model: "gpt-6-luna", reasoningEffort: "medium",
  summaryPath: get("--output"), registrationEnabled: false, currentBatchMutation: false,
  sourceWorkspaceId: "synthetic-workspace", frozenInputSha256: "1".repeat(64), methodSnapshotSha256: "2".repeat(64),
  candidateArtifact: { sha256: sourceSha, reportSha256: "b".repeat(64) },
  currentPromptSha256: "c".repeat(64), repeat: 1, repairOnFindings: false, reportOverride: null,
  sourceWorkflowRunId: get("--source-workflow-run-id") ?? null }
  : { mode: "dry-run", model: "gpt-6-luna", reasoningEffort: "medium",
  summaryPath: get("--output"), registrationEnabled: false, currentBatchMutation: false,
  sourceWorkspaceId: "synthetic-workspace", frozenInputSha256: "1".repeat(64), methodSnapshotSha256: "2".repeat(64),
  sourceCandidateArtifact: { sha256: sourceSha, reportSha256: "b".repeat(64) },
  sdk: { sourceSha256: "c".repeat(64), packageSha256: "d".repeat(64) },
  promptHashes: [{ path: "prompt.md", sha256: "e".repeat(64) }], candidateMode: "rebuild", evaluationMode: "fresh",
  sourceWorkflowRunId: get("--source-workflow-run-id") };
if (args.includes("--dry-run")) console.log(JSON.stringify(row));
else {
  if (process.send) await new Promise((resolve, reject) => {
    const onMessage = (event) => { if (event?.type === "harness.bind-ack" && event.runId === "fresh-run") {
      process.off("message", onMessage); event.ok ? resolve() : reject(new Error("binding failed")); } };
    process.on("message", onMessage);
    process.send({ type: "harness.run-created", runId: "fresh-run", workflowId: reviewer ? "post.review" : "post.analyze",
      input: reviewer ? { candidate: { id: "candidate" }, evidence: { id: "evidence" } }
        : { creatorRunId: "creator", postExternalId: "post", evidence: { id: "evidence" } } });
  });
  const result = reviewer
    ? { ...row, status: ${JSON.stringify(options?.summaryStatus ?? "completed")}, completedRepeats: ${options?.summaryStatus === "incomplete" ? 0 : 1},
      results: [{ workflowRunId: "fresh-run", runState: "succeeded", completion: ${JSON.stringify(options?.summaryStatus === "incomplete" ? "incomplete-no-receipt" : "receipt-recorded")} }] }
    : { ...row, status: ${JSON.stringify(options?.summaryStatus ?? "completed")}, workflowRunId: "fresh-run", runState: "succeeded" };
  writeFileSync(get("--output"), JSON.stringify(result));
}
`);
  const provider = createBoundedPostExecutionProvider({ receiptsDir: join(root, "receipts"), analysisRoot: root,
    launcher: { command: process.execPath, argsPrefix: [] }, scripts: { full: script, reviewer: script }, frozenFiles: [],
    onRunCreated: options?.onRunCreated });
  return { root, script, source, provider };
}

async function terminal(provider: ReturnType<typeof createBoundedPostExecutionProvider>, id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = provider.status(id)!;
    if (result.state !== "running") return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("Execution did not reach terminal status");
}

describe("bounded post execution provider", () => {
  it("freezes full dry-run, starts once, and persists a private terminal receipt", async () => {
    const { root, provider } = fixture();
    const input = { scopeKey: "release-1", kind: "full" as const, sourceWorkflowRunId: "old-run" };
    const prepared = await provider.prepare(input);
    expect(prepared.state).toBe("prepared");
    expect(prepared.snapshot.sourceWorkflowRunId).toBe("old-run");
    expect(prepared.frozenInputSha256).toBe("1".repeat(64));
    expect(prepared.methodSnapshotSha256).toBe("2".repeat(64));
    expect(await provider.prepare(input)).toEqual(prepared);
    const running = await provider.start(prepared.id);
    expect(running.state).toBe("running");
    expect((await provider.start(prepared.id)).state).toMatch(/running|succeeded/);
    const done = await terminal(provider, prepared.id);
    expect(done.state).toBe("succeeded");
    expect(done.processOutcome).toBe("exited");
    expect(done.businessOutcome).toBe("completed");
    expect(done.qualityAcceptance).toBe("unknown");
    expect(done.result?.workflowRunId).toBe("fresh-run");
    expect((await provider.start(prepared.id)).state).toBe("succeeded");
    const receiptPath = join(root, "receipts", `${prepared.id}.json`);
    expect(JSON.parse(readFileSync(receiptPath, "utf8")).snapshot.mode).toBe("dry-run");
    expect(statSync(receiptPath).mode & 0o777).toBe(0o600);
  });

  it("rejects changed inputs and changed script before any paid execution", async () => {
    const { script, provider } = fixture();
    const prepared = await provider.prepare({ scopeKey: "release-2", kind: "full", sourceWorkflowRunId: "old-run" });
    await expect(provider.prepare({ scopeKey: "release-2", kind: "full", sourceWorkflowRunId: "other-run" }))
      .rejects.toThrow("different inputs");
    writeFileSync(script, `${readFileSync(script, "utf8")}\n// changed`);
    await expect(provider.start(prepared.id)).rejects.toThrow("script changed");
    expect(provider.status(prepared.id)?.state).toBe("prepared");
  });

  it("rejects a changed candidate source when the script stays identical", async () => {
    const { provider, source } = fixture();
    const prepared = await provider.prepare({ scopeKey: "release-drift", kind: "full", sourceWorkflowRunId: "old-run" });
    writeFileSync(source, "f".repeat(64));
    await expect(provider.start(prepared.id)).rejects.toThrow("source or method snapshot changed");
    expect(provider.status(prepared.id)?.state).toBe("prepared");
  });

  it("constrains reviewer to one initial review without repair or report override", async () => {
    const { provider } = fixture();
    const prepared = await provider.prepare({ scopeKey: "release-3", kind: "reviewer", candidateArtifactId: "old-candidate" });
    expect(prepared.snapshot).toMatchObject({ repeat: 1, repairOnFindings: false, reportOverride: null,
      model: "gpt-6-luna", reasoningEffort: "medium" });
    await provider.start(prepared.id);
    const done = await terminal(provider, prepared.id);
    expect(done.state).toBe("succeeded");
    expect(done.nativeWorkflowInput).toEqual({ candidate: { id: "candidate" }, evidence: { id: "evidence" } });
  });

  it("normal exit with an incomplete benchmark remains incomplete and never quality-accepted", async () => {
    const { provider } = fixture({ summaryStatus: "incomplete" });
    const prepared = await provider.prepare({ scopeKey: "release-incomplete", kind: "reviewer", candidateArtifactId: "old-candidate" });
    await provider.start(prepared.id);
    const done = await terminal(provider, prepared.id);
    expect(done).toMatchObject({ state: "incomplete", processOutcome: "exited", businessOutcome: "incomplete",
      qualityAcceptance: "unknown", workflowRunIds: ["fresh-run"] });
    expect((await provider.start(prepared.id)).state).toBe("incomplete");
  });

  it("persists Space binding and native run before releasing the child", async () => {
    const seen: string[] = [];
    const { provider } = fixture({ onRunCreated: async receipt => {
      expect(receipt.state).toBe("running");
      expect(receipt.nativeWorkflowRunId).toBe("fresh-run");
      expect(receipt.nativeWorkflowInput).toEqual({ creatorRunId: "creator", postExternalId: "post",
        evidence: { id: "evidence" } });
      expect(receipt.spaceBinding?.inputManifestId).toBe("manifest");
      expect(receipt.spaceBinding?.runId).toBeUndefined();
      seen.push(receipt.nativeWorkflowRunId!);
    } });
    const prepared = await provider.prepare({ scopeKey: "release-linked", kind: "full", sourceWorkflowRunId: "old-run" });
    const binding = { spaceId: "space", caseId: "case", workflowVersionId: "version",
      inputManifestId: "manifest", methodHash: "a".repeat(64) };
    const running = await provider.start(prepared.id, binding);
    expect(running.spaceBinding).toEqual(binding);
    const done = await terminal(provider, prepared.id);
    expect(done.state).toBe("succeeded");
    expect(seen).toEqual(["fresh-run"]);
    await expect(provider.start(prepared.id, { ...binding, inputManifestId: "other-manifest" }))
      .rejects.toThrow("another Space run");
  });

  it("does not release a paid root when Space linking fails and never retries that launch", async () => {
    const { provider } = fixture({ onRunCreated: async () => { throw new Error("Space unavailable"); } });
    const prepared = await provider.prepare({ scopeKey: "release-link-failed", kind: "full", sourceWorkflowRunId: "old-run" });
    const binding = { spaceId: "space", caseId: "case", workflowVersionId: "version", inputManifestId: "manifest" };
    await provider.start(prepared.id, binding);
    const done = await terminal(provider, prepared.id);
    expect(done).toMatchObject({ state: "failed", nativeWorkflowRunId: "fresh-run",
      businessOutcome: "incomplete", qualityAcceptance: "unknown" });
    expect(done.failure).toContain("could not be linked");
    expect((await provider.start(prepared.id, binding)).state).toBe("failed");
  });

  it("persists the real native run and revised frozen manifest before releasing the model", async () => {
    const { provider } = fixture({ onRunCreated: async receipt => {
      expect(receipt.spaceBinding?.inputManifestId).toBe("initial-manifest");
      return { ...receipt.spaceBinding!, inputManifestId: "native-input-manifest", runId: receipt.nativeWorkflowRunId! };
    } });
    const prepared = await provider.prepare({ scopeKey: "release-refrozen", kind: "full", sourceWorkflowRunId: "old-run" });
    const initial = { spaceId: "space", caseId: "case", workflowVersionId: "version",
      inputManifestId: "initial-manifest", methodHash: "a".repeat(64) };
    await provider.start(prepared.id, initial);
    const done = await terminal(provider, prepared.id);
    expect(done.state).toBe("succeeded");
    expect(done.spaceBinding).toMatchObject({ inputManifestId: "native-input-manifest", runId: "fresh-run",
      methodHash: "a".repeat(64) });
    expect(done.nativeWorkflowInput).toEqual({ creatorRunId: "creator", postExternalId: "post",
      evidence: { id: "evidence" } });
    expect((await provider.start(prepared.id, initial)).state).toBe("succeeded");
  });

  it("rejects a callback that changes the frozen Space identity", async () => {
    const { provider } = fixture({ onRunCreated: async receipt => ({ ...receipt.spaceBinding!, caseId: "wrong-case",
      inputManifestId: "native-input-manifest", runId: receipt.nativeWorkflowRunId! }) });
    const prepared = await provider.prepare({ scopeKey: "release-binding-drift", kind: "full", sourceWorkflowRunId: "old-run" });
    await provider.start(prepared.id, { spaceId: "space", caseId: "case", workflowVersionId: "version",
      inputManifestId: "initial-manifest" });
    const done = await terminal(provider, prepared.id);
    expect(done.state).toBe("failed");
    expect(done.spaceBinding?.caseId).toBe("case");
    expect(done.spaceBinding?.inputManifestId).toBe("initial-manifest");
  });

  it.each(["before-ack", "after-ack"])("ends the execution child when the host IPC disconnects %s", async mode => {
    const root = mkdtempSync(join(tmpdir(), "harness-disconnect-"));
    temporary.push(root);
    const script = join(root, "child.mjs");
    writeFileSync(script, `
import { awaitHarnessRunBinding } from ${JSON.stringify(new URL("./execution.ts", import.meta.url).href)};
await awaitHarnessRunBinding("run-1", "post.analyze", { evidence: "synthetic" });
process.send?.({ type: "bound" });
setInterval(() => {}, 1000);
`);
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    child.stderr?.on("data", chunk => { stderr += String(chunk); });
    const exit = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => resolve(code));
    });
    const handshake = new Promise<void>((resolve, reject) => {
      child.on("message", (message: unknown) => {
        if (!message || typeof message !== "object") return;
        const event = message as Record<string, unknown>;
        if (event.type === "harness.run-created") {
          if (mode === "before-ack") { child.disconnect(); resolve(); }
          else child.send({ type: "harness.bind-ack", runId: "run-1", ok: true });
        } else if (event.type === "bound" && mode === "after-ack") {
          child.disconnect(); resolve();
        }
      });
      child.once("error", reject);
    });
    try {
      await Promise.race([handshake, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`IPC handshake timed out: ${stderr}`)), 3000))]);
      expect(await Promise.race([exit, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Child survived host disconnect: ${stderr}`)), 3000))])).toBe(1);
    } finally { child.kill("SIGKILL"); }
  });

  it("lets a normally bound child finish while IPC remains connected and leaves non-IPC execution unchanged", async () => {
    const root = mkdtempSync(join(tmpdir(), "harness-natural-exit-"));
    temporary.push(root);
    const script = join(root, "child.mjs");
    writeFileSync(script, `
import { awaitHarnessRunBinding } from ${JSON.stringify(new URL("./execution.ts", import.meta.url).href)};
await awaitHarnessRunBinding("run-1", "post.analyze", { evidence: "synthetic" });
`);
    const ipc = spawn(process.execPath, [script], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    ipc.stderr?.on("data", chunk => { stderr += String(chunk); });
    ipc.on("message", (message: unknown) => {
      if (message && typeof message === "object" && (message as Record<string, unknown>).type === "harness.run-created")
        ipc.send({ type: "harness.bind-ack", runId: "run-1", ok: true });
    });
    try {
      const exit = await Promise.race([
        new Promise<number | null>((resolve, reject) => { ipc.once("error", reject); ipc.once("exit", resolve); }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Bound child did not exit: ${stderr}`)), 3000)),
      ]);
      expect(exit).toBe(0);
    } finally { ipc.kill("SIGKILL"); }
    const ordinary = spawn(process.execPath, [script], { stdio: ["ignore", "ignore", "pipe"] });
    try {
      const exit = await Promise.race([
        new Promise<number | null>((resolve, reject) => { ordinary.once("error", reject); ordinary.once("exit", resolve); }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Non-IPC child did not exit")), 3000)),
      ]);
      expect(exit).toBe(0);
    } finally { ordinary.kill("SIGKILL"); }
  });
});
