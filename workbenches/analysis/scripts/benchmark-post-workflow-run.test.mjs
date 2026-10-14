import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import { classifyOutcome, collectWorkflowRunTree, parseWorkflowArgs, prepareFullWorkflowInput,
  requireDecisionsApiKey, createBenchmarkAgents } from "./benchmark-post-workflow-run.ts";

describe("full post workflow benchmark arguments", () => {
  it("requires a historical run and accepts an explicit candidate, case and output", () => {
    expect(() => parseWorkflowArgs([])).toThrow("--source-workflow-run-id is required");
    expect(parseWorkflowArgs(["--source-workflow-run-id", "historical-run", "--candidate-artifact-id", "candidate",
      "--case", "same-post-v1", "--output", "summary.json", "--dry-run"])).toMatchObject({
      sourceWorkflowRunId: "historical-run", candidateArtifactId: "candidate", caseLabel: "same-post-v1",
      outputPath: path.resolve("summary.json"), dryRun: true, evidenceMode: "agent", lensMode: "single",
    });
  });

  it("defaults modes and accepts explicit Decisions and parallel lenses", () => {
    expect(parseWorkflowArgs(["--source-workflow-run-id", "historical-run"]))
      .toMatchObject({ evidenceMode: "agent", lensMode: "single" });
    expect(parseWorkflowArgs(["--source-workflow-run-id", "historical-run", "--evidence-mode", "decisions",
      "--lens-mode", "parallel"])).toMatchObject({ evidenceMode: "decisions", lensMode: "parallel" });
  });

  it.each(["content-first-serial", "content-first-parallel"])("pins the optional restoration handoff mode %s", lensMode => {
    expect(parseWorkflowArgs(["--source-workflow-run-id", "historical-run", "--lens-mode", lensMode]))
      .toMatchObject({ evidenceMode: "agent", lensMode });
    expect(createBenchmarkAgents({ evidenceMode: "agent", lensMode }).agents.postBuilder.config)
      .toMatchObject({ builderOptimization: { evidenceMode: "agent", lensMode } });
  });

  it("rejects duplicate, unknown and unsafe options", () => {
    expect(() => parseWorkflowArgs(["--source-workflow-run-id", "a", "--source-workflow-run-id", "b"]))
      .toThrow("Duplicate option");
    expect(() => parseWorkflowArgs(["--source-workflow-run-id", "a", "--case", "unsafe label"]))
      .toThrow("short safe label");
    expect(() => parseWorkflowArgs(["--source-workflow-run-id", "a", "--surprise", "b"]))
      .toThrow("Unknown option");
    expect(() => parseWorkflowArgs(["--source-workflow-run-id", "a", "--evidence-mode", "codex"]))
      .toThrow("--evidence-mode must be agent or decisions");
    expect(() => parseWorkflowArgs(["--source-workflow-run-id", "a", "--lens-mode", "race"]))
      .toThrow("--lens-mode must be single, serial, parallel, content-first-serial or content-first-parallel");
    expect(() => parseWorkflowArgs(["--source-workflow-run-id", "a", "--lens-mode", "single",
      "--lens-mode", "parallel"])).toThrow("Duplicate option");
  });
});

describe("full post workflow Decisions credential gate", () => {
  it("requires an explicit key only in Decisions mode and never returns the key for agent mode", () => {
    expect(requireDecisionsApiKey("agent", undefined)).toBeUndefined();
    expect(requireDecisionsApiKey("agent", "secret-key")).toBeUndefined();
    expect(() => requireDecisionsApiKey("decisions", undefined)).toThrow("OPENAI_API_KEY is required");
    expect(() => requireDecisionsApiKey("decisions", "  ")).toThrow("OPENAI_API_KEY is required");
    expect(requireDecisionsApiKey("decisions", "explicit-key-value")).toBe("explicit-key-value");
  });

  it("binds both modes into agent config and the benchmark revision", () => {
    const agent = createBenchmarkAgents({ evidenceMode: "agent", lensMode: "single" });
    const decisionsParallel = createBenchmarkAgents({ evidenceMode: "decisions", lensMode: "parallel" });
    expect(agent.agents.postBuilder.config).toMatchObject({
      builderOptimization: { evidenceMode: "agent", lensMode: "single" },
    });
    expect(decisionsParallel.agents.postBuilder.config).toMatchObject({
      builderOptimization: { evidenceMode: "decisions", lensMode: "parallel" },
    });
    expect(agent.methodRevision).not.toBe(decisionsParallel.methodRevision);
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
      ["build", [{ type: "responses.method" }, { type: "siwc.request" }, { type: "siwc.request" },
        { type: "decision.inference.response", data: { elapsedMs: 125 } },
        { type: "decision.inference.completed", data: { answers: [] } },
        { type: "decision.recorded", data: { route: "deliver_supporting_pixels" } }]],
      ["review", [{ type: "responses.method" }, { type: "siwc.request" },
        { type: "decision.inference.response", data: { elapsedMs: 42 } },
        { type: "decision.inference.completed", data: { answers: [] } }]],
    ]);
    const store = {
      getRun: async (id) => runs.get(id),
      listRuns: async ({ parentRunId }) => (children.get(parentRunId) ?? []).map((id) => runs.get(id)),
      listEvents: async (id) => events.get(id) ?? [],
    };
    await expect(collectWorkflowRunTree(store, "root")).resolves.toMatchObject({
      requestCount: 4, methodEventCount: 2,
      childRunIds: { root: ["build", "review"] },
      decisionInferenceCompletedCount: 2, decisionInferenceDurationMs: 167,
      decisionProviderResponseCount: 2, decisionRecordedCount: 1,
      decisionRoutes: [{ runId: "build", workflowId: "post.build", route: "deliver_supporting_pixels" }],
      runs: [{ id: "root" }, { id: "build" }, { id: "review" }],
    });
  });
});
