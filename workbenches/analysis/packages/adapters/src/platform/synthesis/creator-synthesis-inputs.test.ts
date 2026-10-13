import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { artifactPath, artifactRef } from "../../core/artifacts.js";
import { LocalCreatorArtifactStore } from "../artifacts/local-creator-artifact-store.js";
import { sourceDigest } from "../artifacts/report-source-revision.js";
import { prepareCreatorSynthesisBatch } from "./creator-synthesis-inputs.js";

let temporaryRoot: string | null = null;
const previousRuntime = process.env.SELF_MEDIA_RUNTIME_DIR;
const previousRevisions = process.env.SELF_MEDIA_REPORT_REVISIONS_DIR;

afterEach(() => {
  if (previousRuntime === undefined) delete process.env.SELF_MEDIA_RUNTIME_DIR;
  else process.env.SELF_MEDIA_RUNTIME_DIR = previousRuntime;
  if (previousRevisions === undefined) delete process.env.SELF_MEDIA_REPORT_REVISIONS_DIR;
  else process.env.SELF_MEDIA_REPORT_REVISIONS_DIR = previousRevisions;
  if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true });
  temporaryRoot = null;
});

function fixture(withRevision: boolean) {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "creator-synthesis-inputs-"));
  process.env.SELF_MEDIA_RUNTIME_DIR = path.join(temporaryRoot, "runtime");
  process.env.SELF_MEDIA_REPORT_REVISIONS_DIR = path.join(temporaryRoot, "revisions");
  const creatorRunId = "11111111-1111-4111-8111-111111111111";
  const reconstructionArtifactRef = artifactRef(creatorRunId, "video-reconstructions/post-1/reconstruction.json");
  const reconstructionPath = artifactPath(reconstructionArtifactRef);
  fs.mkdirSync(path.dirname(reconstructionPath), { recursive: true });
  const originalText = JSON.stringify({ builderLenses: { contentRestoration: { summary: "原始结论" } } });
  fs.writeFileSync(reconstructionPath, originalText);

  if (withRevision) {
    const originalSha256 = sourceDigest(originalText);
    const revisedText = JSON.stringify({ builderLenses: { contentRestoration: { summary: "修订结论" } } });
    const revisedSha256 = sourceDigest(revisedText);
    const directory = path.join(process.env.SELF_MEDIA_REPORT_REVISIONS_DIR!, originalSha256);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "revised-source"), revisedText);
    fs.writeFileSync(path.join(directory, "revision.json"), JSON.stringify({ schemaVersion: "report-source-revision@1",
      originalSha256, revisedSha256, revisionId: "r1", reason: "核对冻结来源" }));
  }

  const originalBatchRef = artifactRef(creatorRunId, "reconstruction-batch.json");
  const batch = { schemaVersion: "1.0.0", creatorRunId, revision: 1,
    generatedAt: "2026-10-10T00:00:00.000Z", requestedPosts: 2, builtPosts: 2,
    verifiedPosts: 2, readyPosts: 2, pendingPosts: 0, failedPosts: 0, limitations: [], items: [
      { postExternalId: "post-1", tier: "high", tierRank: 1, state: "verified",
        evaluationPolicy: "single_pass@37a03aae", sourceMediaArtifactRef: null,
        reconstructionArtifactRef, articleArtifactRef: null, builderValidationArtifactRef: null,
        evaluationArtifactRef: artifactRef(creatorRunId, "evaluation.json"),
        gateReportArtifactRef: artifactRef(creatorRunId, "gate.json"),
        threeLensEvaluationArtifactRef: artifactRef(creatorRunId, "lenses.json"),
        threeLensGateReportArtifactRef: artifactRef(creatorRunId, "lens-gate.json"),
        failedGateIds: ["old-failure"], researchReview: { schemaVersion: "research-review-state@1",
          reviewStatus: "completed_with_findings", candidateStatus: "original_reviewed",
          reviewArtifactRef: artifactRef(creatorRunId, "review.json"), revisionRecordArtifactRef: null,
          candidateReportSha256: "a".repeat(64) },
        message: "old evaluation", updatedAt: "2026-10-10T00:00:00.000Z" },
      { postExternalId: "post-2", tier: "base", tierRank: 1, state: "ready",
        evaluationPolicy: "single_pass@37a03aae", sourceMediaArtifactRef: null,
        reconstructionArtifactRef: null, articleArtifactRef: null, builderValidationArtifactRef: null,
        evaluationArtifactRef: null, gateReportArtifactRef: null,
        threeLensEvaluationArtifactRef: null, threeLensGateReportArtifactRef: null,
        failedGateIds: [], message: "ready", updatedAt: "2026-10-10T00:00:00.000Z" }
    ] };
  fs.writeFileSync(artifactPath(originalBatchRef), JSON.stringify(batch));
  const request = { creatorRunId, creatorName: "fixture", portfolioArtifactRef: artifactRef(creatorRunId, "portfolio.json"),
    portfolioAnnotationsArtifactRef: null, selectionArtifactRef: artifactRef(creatorRunId, "selection.json"),
    detailArtifactRef: artifactRef(creatorRunId, "detail.json"), reconstructionBatchArtifactRef: originalBatchRef, mode: "formal" as const };
  return { creatorRunId, request, originalBatchRef, reconstructionArtifactRef, store: new LocalCreatorArtifactStore() };
}

it("binds revised source bytes into synthesis and clears evaluator results for that revision", async () => {
  const data = fixture(true);
  const effectiveRef = await prepareCreatorSynthesisBatch(data.store, data.request);
  expect(effectiveRef).not.toBe(data.originalBatchRef);

  const batch = await data.store.read(effectiveRef) as { builtPosts: number; verifiedPosts: number; readyPosts: number;
    limitations: string[]; items: Array<Record<string, unknown>> };
  const revised = batch.items[0]!;
  expect(revised).toMatchObject({ state: "built_unevaluated", evaluationArtifactRef: null,
    gateReportArtifactRef: null, threeLensEvaluationArtifactRef: null, threeLensGateReportArtifactRef: null,
    failedGateIds: [], researchReview: null });
  expect(revised.reconstructionArtifactRef).not.toBe(data.reconstructionArtifactRef);
  expect(batch).toMatchObject({ builtPosts: 2, verifiedPosts: 1, readyPosts: 1,
    limitations: ["综合输入绑定 1 份报告源修订；其既有单帖评估不沿用。"] });
  const revisedReport = await data.store.read(revised.reconstructionArtifactRef as string) as {
    builderLenses: { contentRestoration: { summary: string } } };
  expect(revisedReport.builderLenses.contentRestoration.summary).toBe("修订结论");
  const registry = JSON.parse(fs.readFileSync(path.join(path.dirname(artifactPath(effectiveRef)), "artifact-registry.json"), "utf8")) as {
    artifacts: Array<{ ref: string; logicalName?: string; dependencies: string[] }> };
  expect(registry.artifacts.find((entry) => entry.ref === effectiveRef)?.dependencies).toEqual(expect.arrayContaining([
    data.originalBatchRef, revised.reconstructionArtifactRef as string
  ]));
  expect(registry.artifacts.some((entry) => entry.logicalName === "creator-synthesis-source-revision-post-1.json")).toBe(true);
});

it("uses the existing batch unchanged when no report-source revision is present", async () => {
  const data = fixture(false);
  expect(await prepareCreatorSynthesisBatch(data.store, data.request)).toBe(data.originalBatchRef);
  expect(fs.existsSync(path.join(path.dirname(artifactPath(data.originalBatchRef)), "artifact-registry.json"))).toBe(false);
});
