import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import { classifyOutcome, collectWorkflowRunTree, parseWorkflowArgs, prepareFullWorkflowInput,
  createBenchmarkAgents } from "./benchmark-post-workflow-run.ts";

describe("full post workflow benchmark arguments", () => {
  it("requires a historical run and accepts an explicit candidate, case and output", () => {
    expect(() => parseWorkflowArgs([])).toThrow("--source-workflow-run-id is required");
    expect(parseWorkflowArgs(["--source-workflow-run-id", "historical-run", "--candidate-artifact-id", "candidate",
      "--case", "same-post-v1", "--output", "summary.json", "--dry-run"])).toMatchObject({
      sourceWorkflowRunId: "historical-run", candidateArtifactId: "candidate", caseLabel: "same-post-v1",
      outputPath: path.resolve("summary.json"), dryRun: true,
    });
  });

  it("rejects duplicate, unknown and unsafe options", () => {
    expect(() => parseWorkflowArgs(["--source-workflow-run-id", "a", "--source-workflow-run-id", "b"]))
      .toThrow("Duplicate option");
    expect(() => parseWorkflowArgs(["--source-workflow-run-id", "a", "--case", "unsafe label"]))
      .toThrow("short safe label");
    expect(() => parseWorkflowArgs(["--source-workflow-run-id", "a", "--surprise", "b"]))
      .toThrow("Unknown option");
    expect(() => parseWorkflowArgs(["--source-workflow-run-id", "a", "--lens-mode", "parallel"]))
      .toThrow("Unknown option");
    expect(() => parseWorkflowArgs(["--source-workflow-run-id", "a", "--evidence-mode", "decisions"]))
      .toThrow("Unknown option");
  });

  it("pins the single Builder v4.14 prompt", () => {
    const benchmark = createBenchmarkAgents();
    expect(benchmark.promptHashes).toContainEqual({ path: "prompts/responses-post-builder-v1.md",
      sha256: "fa2b5c53436d008d5dbcd07c1884dbe9364b0009059a9c43b5fd6078fd04ba5d" });
    expect(benchmark.agents.postBuilder.config).not.toHaveProperty("builderOptimization");
  });
});

describe("full post workflow frozen input", () => {
  it("rebuilds against the same frozen source while removing only historical reuse bindings", () => {
    const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "post-workflow-benchmark-"));
    const previousRuntime = process.env.SELF_MEDIA_RUNTIME_DIR;
    process.env.SELF_MEDIA_RUNTIME_DIR = runtime;
    const runId = "123e4567-e89b-12d3-a456-426614174000";
    const artifactDir = path.join(runtime, "runs", runId);
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(artifactDir, "source.mp4"), "frozen media bytes");
    fs.writeFileSync(path.join(artifactDir, "evidence.json"), "{}");
    fs.writeFileSync(path.join(artifactDir, "batch.json"), JSON.stringify({ items: [] }));
    const sourceRef = `/artifacts/${runId}/source.mp4`;
    const evidenceRef = `/artifacts/${runId}/evidence.json`;
    const batchRef = `/artifacts/${runId}/batch.json`;
    const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    const frozen = {
      kind: "post",
      source: {
        creatorRunId: "creator-run", postExternalId: "post-id", sourceMediaArtifactRef: sourceRef,
        reconstructionBatchArtifactRef: batchRef, evidenceArtifactRef: evidenceRef,
        candidateMode: "reuse", evaluationMode: "reuse",
        importedEvaluationArtifactRef: `/artifacts/${runId}/evaluation.json`,
      },
      files: [
        { ref: sourceRef, sha256: sha(path.join(artifactDir, "source.mp4")) },
        { ref: evidenceRef, sha256: sha(path.join(artifactDir, "evidence.json")) },
        { ref: batchRef, sha256: sha(path.join(artifactDir, "batch.json")) },
        { ref: `/artifacts/${runId}/old-candidate.json`, sha256: "candidate-sha" },
        { ref: `/artifacts/${runId}/old-evaluation.json`, sha256: "evaluation-sha" },
      ],
      reuseCandidate: { artifactRef: `/artifacts/${runId}/old-candidate.json`, sha256: "candidate-sha" },
      reuseEvaluation: { artifactRef: `/artifacts/${runId}/old-evaluation.json`, sha256: "evaluation-sha" },
      methods: [], skillPackages: [],
    };
    try {
      const prepared = prepareFullWorkflowInput(frozen);
      expect(prepared.source).toMatchObject({ candidateMode: "rebuild", evaluationMode: "fresh" });
      expect(prepared.source).not.toHaveProperty("importedEvaluationArtifactRef");
      expect(prepared.files.map(({ ref }) => ref)).toEqual(expect.arrayContaining([sourceRef, evidenceRef, batchRef]));
      expect(prepared.files.map(({ ref }) => ref)).not.toContain(`/artifacts/${runId}/old-candidate.json`);
      expect(prepared.files.map(({ ref }) => ref)).not.toContain(`/artifacts/${runId}/old-evaluation.json`);
      expect(prepared.methods.length).toBeGreaterThan(0);
      expect(prepared.skillPackages).toHaveLength(1);
    } finally {
      if (previousRuntime === undefined) delete process.env.SELF_MEDIA_RUNTIME_DIR;
      else process.env.SELF_MEDIA_RUNTIME_DIR = previousRuntime;
      fs.rmSync(runtime, { recursive: true, force: true });
    }
  });
});

describe("full post workflow outcome", () => {
  it("requires manual report audit even when the independent reviewer returns no findings", () => {
    expect(classifyOutcome({ ok: true, state: "completed", reviewStatus: "completed_no_findings",
      candidateStatus: "original_reviewed" })).toEqual({ workflowOutcome: "completed", reviewStatus: "completed_no_findings",
      candidateStatus: "original_reviewed", qualityAccepted: false,
      qualityDisposition: "empty-findings-require-full-report-quality-audit" });
  });

  it("keeps repaired candidates explicitly unverified", () => {
    expect(classifyOutcome({ ok: true, state: "completed", reviewStatus: "completed_with_findings",
      candidateStatus: "revised_unverified" })).toMatchObject({ qualityAccepted: false,
      qualityDisposition: "revised-candidate-remains-unverified" });
  });

  it("does not treat a succeeded workflow row with a failed business output as complete", () => {
    expect(classifyOutcome({ ok: false, state: "needs_review" })).toMatchObject({ workflowOutcome: "needs_review",
      qualityAccepted: false, qualityDisposition: "workflow-incomplete" });
    expect(classifyOutcome({ state: "blocked" })).toMatchObject({ workflowOutcome: "blocked",
      qualityAccepted: false, qualityDisposition: "blocked-needs-investigation" });
  });
});

describe("full post workflow trace accounting", () => {
  it("counts request and method events across the root and every child workflow exactly once", async () => {
    const runs = new Map([
      ["root", { id: "root", workflowId: "post.analyze" }],
      ["build", { id: "build", workflowId: "post.build", parentRunId: "root" }],
      ["review", { id: "review", workflowId: "post.review", parentRunId: "root" }],
    ]);
    const children = new Map([["root", ["build", "review"]], ["build", []], ["review", []]]);
    const events = new Map([
      ["root", [{ type: "workflow.started" }, { type: "siwc.request" }]],
      ["build", [{ type: "responses.method" }, { type: "siwc.request" }, { type: "siwc.request" }]],
      ["review", [{ type: "responses.method" }, { type: "siwc.request" }]],
    ]);
    const store = {
      getRun: async (id) => runs.get(id),
      listRuns: async ({ parentRunId }) => (children.get(parentRunId) ?? []).map((id) => runs.get(id)),
      listEvents: async (id) => events.get(id) ?? [],
    };
    await expect(collectWorkflowRunTree(store, "root")).resolves.toMatchObject({
      requestCount: 4, methodEventCount: 2,
      childRunIds: { root: ["build", "review"] },
      runs: [{ id: "root" }, { id: "build" }, { id: "review" }],
    });
  });
});
