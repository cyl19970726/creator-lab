import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoundedPostExecutionProvider } from "./execution.js";

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
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
  candidateArtifact: { sha256: sourceSha, reportSha256: "b".repeat(64) },
  currentPromptSha256: "c".repeat(64), repeat: 1, repairOnFindings: false, reportOverride: null,
  sourceWorkflowRunId: get("--source-workflow-run-id") ?? null }
  : { mode: "dry-run", model: "gpt-6-luna", reasoningEffort: "medium",
  summaryPath: get("--output"), registrationEnabled: false, currentBatchMutation: false,
  sourceCandidateArtifact: { sha256: sourceSha, reportSha256: "b".repeat(64) },
  sdk: { sourceSha256: "c".repeat(64), packageSha256: "d".repeat(64) },
  promptHashes: [{ path: "prompt.md", sha256: "e".repeat(64) }], candidateMode: "rebuild", evaluationMode: "fresh",
  sourceWorkflowRunId: get("--source-workflow-run-id") };
if (args.includes("--dry-run")) console.log(JSON.stringify(row));
else writeFileSync(get("--output"), JSON.stringify({ status: "completed", workflowRunId: "fresh-run", ...row }));
`);
  const provider = createBoundedPostExecutionProvider({ receiptsDir: join(root, "receipts"), analysisRoot: root,
    launcher: { command: process.execPath, argsPrefix: [] }, scripts: { full: script, reviewer: script }, frozenFiles: [] });
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
    expect(await provider.prepare(input)).toEqual(prepared);
    const running = await provider.start(prepared.id);
    expect(running.state).toBe("running");
    expect((await provider.start(prepared.id)).state).toMatch(/running|succeeded/);
    const done = await terminal(provider, prepared.id);
    expect(done.state).toBe("succeeded");
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
    expect((await terminal(provider, prepared.id)).state).toBe("succeeded");
  });
});
