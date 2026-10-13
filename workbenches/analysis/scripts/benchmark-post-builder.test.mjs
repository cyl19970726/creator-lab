import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import { assertHistoricalCandidateIntegrity, assertHistoricalEvidenceUnchanged, classifyBuilderResult,
  failureSummary, parseBuilderArgs } from "./benchmark-post-builder.ts";

describe("post Builder benchmark arguments", () => {
  it("requires a historical workflow and accepts dry-run metadata", () => {
    expect(() => parseBuilderArgs([])).toThrow("--source-workflow-run-id is required");
    expect(parseBuilderArgs(["--source-workflow-run-id", "workflow-id", "--case", "quality-v4", "--dry-run"]))
      .toMatchObject({ sourceWorkflowRunId: "workflow-id", caseLabel: "quality-v4", dryRun: true });
  });

  it("accepts a candidate selector and resolves an explicit summary path", () => {
    expect(parseBuilderArgs(["--source-workflow-run-id", "workflow-id", "--candidate-artifact-id", "candidate-id",
      "--output", "summary.json"])).toMatchObject({ candidateArtifactId: "candidate-id", outputPath: path.resolve("summary.json") });
  });

  it("rejects ambiguous or unsafe arguments", () => {
    expect(() => parseBuilderArgs(["--source-workflow-run-id", "a", "--source-workflow-run-id", "b"]))
      .toThrow("Duplicate option");
    expect(() => parseBuilderArgs(["--source-workflow-run-id", "a", "--case", "unsafe label"]))
      .toThrow("short safe label");
    expect(() => parseBuilderArgs(["--source-workflow-run-id", "a", "--unknown", "b"]))
      .toThrow("Unknown option");
  });
});

describe("post Builder historical evidence binding", () => {
  it("requires every source evidence ref and SHA to match the historical pin", () => {
    const historical = { files: [{ ref: "/artifacts/source.json", sha256: "old-sha" },
      { ref: "/artifacts/reused-candidate.json", sha256: "candidate-sha" }],
      reuseCandidate: { artifactRef: "/artifacts/reused-candidate.json", sha256: "candidate-sha" } };
    expect(() => assertHistoricalEvidenceUnchanged(historical, { files: [{ ref: "/artifacts/source.json", sha256: "old-sha" }] }))
      .not.toThrow();
    expect(() => assertHistoricalEvidenceUnchanged(historical, { files: [{ ref: "/artifacts/source.json", sha256: "changed-sha" }] }))
      .toThrow("FROZEN_SOURCE_BINDING_MISMATCH");
    expect(() => assertHistoricalEvidenceUnchanged(historical, { files: [{ ref: "/artifacts/other.json", sha256: "new-sha" }] }))
      .toThrow("FROZEN_SOURCE_BINDING_MISMATCH");
  });
});

describe("post Builder result classification", () => {
  it("does not treat a succeeded workflow with a needs-review business result as complete", () => {
    expect(classifyBuilderResult("succeeded", { ok: false, state: "needs_review" }, undefined, undefined)).toEqual({
      status: "incomplete", completion: "missing-or-rejected-candidate", businessState: "needs_review",
    });
  });

  it("requires the persisted candidate receipt validation for completion", () => {
    const candidate = { id: "candidate", type: "post-candidate", revision: "r1", sha256: "s1" };
    const payload = { kind: "post", reportArtifactRef: "/artifacts/report.json", reportSha256: "s1" };
    expect(classifyBuilderResult("succeeded", { ok: true, receipt: { validation: { passed: true } } }, candidate, payload))
      .toMatchObject({ status: "completed", completion: "validated-candidate" });
    expect(classifyBuilderResult("succeeded", { ok: true }, candidate, payload).status).toBe("incomplete");
  });

  it("persists useful failure metadata when a durable workflow throws", () => {
    expect(failureSummary({ caseLabel: "case-a", summaryPath: "/tmp/summary.json" }, {
      workflowRunId: "run-id", runState: "failed", stage: "builder", error: "terminated",
      durationMs: 1000, requestCount: 7, methodEventCount: 2,
    })).toMatchObject({ status: "failed", completion: "runner-threw", workflowRunId: "run-id",
      stage: "builder", error: "terminated", requestCount: 7, methodEventCount: 2 });
  });
});

describe("post Builder historical candidate integrity", () => {
  it("checks both report bytes and the canonical outcome schema", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "builder-benchmark-"));
    const priorRuntimeDir = process.env.SELF_MEDIA_RUNTIME_DIR;
    process.env.SELF_MEDIA_RUNTIME_DIR = directory;
    const report = path.join(directory, "runs", "123e4567-e89b-12d3-a456-426614174000", "report.json");
    try {
      fs.mkdirSync(path.dirname(report), { recursive: true });
      fs.writeFileSync(report, "immutable report bytes");
      const valid = { kind: "post", reportArtifactRef: "/artifacts/123e4567-e89b-12d3-a456-426614174000/report.json", reportSha256: "", outcome: {
        state: "built_unevaluated", reconstructionArtifactRef: "/artifacts/reconstruction.json",
        articleArtifactRef: null, builderValidationArtifactRef: "/artifacts/builder-validation.json", evaluationMode: "skipped",
      } };
      valid.reportSha256 = createHash("sha256").update("immutable report bytes").digest("hex");
      expect(() => assertHistoricalCandidateIntegrity(valid)).not.toThrow();
      expect(() => assertHistoricalCandidateIntegrity({ ...valid, reportSha256: "wrong" }))
        .toThrow("report bytes do not match");
      expect(() => assertHistoricalCandidateIntegrity({ ...valid, outcome: { state: "invalid" } })).toThrow();
    } finally {
      if (priorRuntimeDir === undefined) delete process.env.SELF_MEDIA_RUNTIME_DIR;
      else process.env.SELF_MEDIA_RUNTIME_DIR = priorRuntimeDir;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
