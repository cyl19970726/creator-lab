import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { MemoryRunStore, type AgentRunner } from "@signal-room/workflow";
import { artifactPath, artifactRef } from "../core/artifacts.js";
import { LocalCreatorArtifactStore } from "../platform/artifacts/local-creator-artifact-store.js";
import { ResponsesPipelineCreatorSynthesisExecutor, ResponsesPipelineVideoReconstructionExecutor } from "./responses-pipeline-executors.js";
import { ResponsesResearchRunner } from "./responses-research-runner.js";

const runId = "11111111-1111-4111-8111-111111111111";
let temporary: string | null = null;
const previousRuntime = process.env.SELF_MEDIA_RUNTIME_DIR;
const effortKeys = ["SELF_MEDIA_BUILDER_REASONING_EFFORT", "SELF_MEDIA_EVALUATOR_REASONING_EFFORT",
  "SELF_MEDIA_CREATOR_SYNTHESIS_REASONING_EFFORT", "SELF_MEDIA_CREATOR_SYNTHESIS_EVALUATOR_REASONING_EFFORT"] as const;
const previousEfforts = Object.fromEntries(effortKeys.map(key => [key, process.env[key]]));
afterEach(() => {
  if (previousRuntime === undefined) delete process.env.SELF_MEDIA_RUNTIME_DIR;
  else process.env.SELF_MEDIA_RUNTIME_DIR = previousRuntime;
  for (const key of effortKeys) {
    const previous = previousEfforts[key];
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  }
  if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  temporary = null;
});

function fixture() {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), "responses-pipeline-"));
  process.env.SELF_MEDIA_RUNTIME_DIR = temporary;
  const write = (name: string, value: unknown) => {
    const reference = artifactRef(runId, name);
    fs.mkdirSync(path.dirname(artifactPath(reference)), { recursive: true });
    fs.writeFileSync(artifactPath(reference), JSON.stringify(value));
    return reference;
  };
  const detail = write("detail.json", { posts: [] });
  const manifest = write("manifest.json", { items: [] });
  const selection = write("selection.json", { items: [] });
  const media = write("media.json", { source: true });
  const batch = write("batch.json", { schemaVersion: "1.0.0", creatorRunId: runId, revision: 1,
    generatedAt: "2026-10-10T00:00:00.000Z", requestedPosts: 1, builtPosts: 0, verifiedPosts: 0,
    readyPosts: 0, pendingPosts: 1, failedPosts: 0, limitations: [], items: [{ postExternalId: "post-1",
      tier: "high", tierRank: 1, state: "queued", evaluationPolicy: "skip@builder-fast-path-v1",
      sourceMediaArtifactRef: media, reconstructionArtifactRef: null, articleArtifactRef: null,
      builderValidationArtifactRef: null, evaluationArtifactRef: null, gateReportArtifactRef: null,
      threeLensEvaluationArtifactRef: null, threeLensGateReportArtifactRef: null, failedGateIds: [],
      message: "等待", updatedAt: "2026-10-10T00:00:00.000Z" }] });
  return { write, detail, manifest, selection, media, batch };
}

function executor(evaluatorRunner?: AgentRunner, prepareCandidate?: (directory: string) => void,
  persistArtifacts?: (creatorRunId: string, relativeDirectory: string) => Promise<void>) {
  const sources = fixture();
  const store = new class extends MemoryRunStore {
    async getArtifactPayload(id: string): Promise<unknown> { return this.artifacts.find((item) => item.id === id)?.payload; }
  }();
  const artifacts = new LocalCreatorArtifactStore();
  const invoked: string[] = [];
  const efforts: string[] = [];
  const builderRunner: AgentRunner = { async run(request) {
    invoked.push(request.definition.id);
    efforts.push(`${request.definition.id}:${request.definition.reasoningEffort}`);
    const reconstructionArtifactRef = sources.write("candidate/reconstruction.json", { builderLenses: { contentRestoration: {} } });
    prepareCandidate?.(path.dirname(artifactPath(reconstructionArtifactRef)));
    const builderValidationArtifactRef = sources.write("candidate/builder-validation.json", { passed: true });
    const reportSha256 = crypto.createHash("sha256").update(fs.readFileSync(artifactPath(reconstructionArtifactRef))).digest("hex");
    return { output: { artifact: { reportArtifactRef: reconstructionArtifactRef, reportSha256, report: {},
      outcome: { state: "built_unevaluated", reconstructionArtifactRef, builderValidationArtifactRef,
        articleArtifactRef: null, evaluationMode: "skipped" } }, validation: { passed: true } } } as never;
  } };
  const repository = { get: async () => ({ reconstructionBatchArtifactRef: sources.batch,
    detailArtifactRef: sources.detail, mediaManifestArtifactRef: sources.manifest,
    selectionArtifactRef: sources.selection }) };
  return { instance: new ResponsesPipelineVideoReconstructionExecutor(store, artifacts, repository as never,
    { builderRunner, evaluatorRunner, persistArtifacts }), invoked, efforts, sources };
}

it("keeps the automatic video queue's default Builder-only state on Responses", async () => {
  const { instance, invoked, sources } = executor();
  const result = await instance.reconstruct({ runId: crypto.randomUUID(), creatorRunId: runId,
    postExternalId: "post-1", sourceUrl: "https://example.com/post-1", sourceMediaArtifactRef: sources.media,
    detailArtifactRef: sources.detail, mediaManifestArtifactRef: sources.manifest,
    selectionArtifactRef: sources.selection, evidencePackArtifactRef: null,
    evaluationPolicy: "skip", contractVersion: "video-content-reconstruction@2" });
  expect(invoked).toEqual(["post-builder"]);
  expect(result).toMatchObject({ state: "built_unevaluated", evaluationMode: "skipped" });
});

it("retains a finished Builder candidate when an explicit independent evaluation fails", async () => {
  const evaluatorRunner: AgentRunner = { async run() { throw new Error("independent evaluator unavailable"); } };
  const { instance, invoked, sources } = executor(evaluatorRunner);
  const result = await instance.reconstruct({ runId: crypto.randomUUID(), creatorRunId: runId,
    postExternalId: "post-1", sourceUrl: "https://example.com/post-1", sourceMediaArtifactRef: sources.media,
    detailArtifactRef: sources.detail, mediaManifestArtifactRef: sources.manifest,
    selectionArtifactRef: sources.selection, evidencePackArtifactRef: null,
    evaluationPolicy: "single_pass", contractVersion: "video-content-reconstruction@2" });
  expect(invoked).toEqual(["post-builder"]);
  expect(result).toMatchObject({ state: "built_unevaluated", evaluationMode: "failed",
    qualityWarningGateIds: ["independent_evaluation_failed"] });
  expect(result).toHaveProperty("reconstructionArtifactRef");
});

it("uses the original video Builder and evaluator reasoning-effort settings", async () => {
  process.env.SELF_MEDIA_BUILDER_REASONING_EFFORT = "high";
  process.env.SELF_MEDIA_EVALUATOR_REASONING_EFFORT = "low";
  const seen: string[] = [];
  const evaluatorRunner: AgentRunner = { async run(request) {
    seen.push(`${request.definition.id}:${request.definition.reasoningEffort}`);
    throw new Error("stop after role check");
  } };
  const { instance, efforts, sources } = executor(evaluatorRunner);
  await instance.reconstruct({ runId: crypto.randomUUID(), creatorRunId: runId,
    postExternalId: "post-1", sourceUrl: "https://example.com/post-1", sourceMediaArtifactRef: sources.media,
    detailArtifactRef: sources.detail, mediaManifestArtifactRef: sources.manifest,
    selectionArtifactRef: sources.selection, evidencePackArtifactRef: null,
    evaluationPolicy: "single_pass", contractVersion: "video-content-reconstruction@2" });
  expect(efforts).toEqual(["post-builder:high"]);
  expect(seen).toEqual(["pipeline-post-evaluator:low"]);
});

it("binds targeted source frames and persists the isolated evaluator evidence after failure", async () => {
  let prompt = "";
  const persisted: string[] = [];
  const evaluatorRunner: AgentRunner = { async run(request) {
    prompt = String(request.definition.config?.instructions);
    throw new Error("evaluation interrupted");
  } };
  const { instance, sources } = executor(evaluatorRunner, (directory) => {
    const targeted = path.join(directory, "targeted-evidence");
    fs.mkdirSync(path.join(targeted, "frames"), { recursive: true });
    fs.writeFileSync(path.join(targeted, "frames/target.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    fs.writeFileSync(path.join(targeted, "targeted-evidence.json"), JSON.stringify({
      frames: [{ id: "TARGET-0001", frame: "frames/target.jpg" }] }));
  }, async (creatorRunId, relativeDirectory) => { persisted.push(`${creatorRunId}/${relativeDirectory}`); });
  const result = await instance.reconstruct({ runId: crypto.randomUUID(), creatorRunId: runId,
    postExternalId: "post-1", sourceUrl: "https://example.com/post-1", sourceMediaArtifactRef: sources.media,
    detailArtifactRef: sources.detail, mediaManifestArtifactRef: sources.manifest,
    selectionArtifactRef: sources.selection, evidencePackArtifactRef: null,
    evaluationPolicy: "single_pass", contractVersion: "video-content-reconstruction@2" });
  expect(result).toMatchObject({ state: "built_unevaluated", evaluationMode: "failed" });
  expect(prompt).toContain("TARGET-0001");
  expect(prompt).toContain("targeted-evidence/targeted-evidence.json");
  expect(persisted).toHaveLength(1);
  expect(persisted[0]).toMatch(/^11111111-1111-4111-8111-111111111111\/workflow-responses\/pipeline-evaluator\//);
});

it.each([
  { ready: false, mode: "provisional" as const, expectedState: "provisional" },
  { ready: false, mode: "formal" as const, expectedState: "not_ready" },
  { ready: true, mode: "formal" as const, expectedState: "ready" }
])("runs independent creator gates and returns $expectedState", async ({ ready, mode, expectedState }) => {
  process.env.SELF_MEDIA_CREATOR_SYNTHESIS_REASONING_EFFORT = "high";
  process.env.SELF_MEDIA_CREATOR_SYNTHESIS_EVALUATOR_REASONING_EFFORT = "low";
  const sources = fixture();
  const write = sources.write;
  const corpusRef = write("corpus.json", { schemaVersion: "1.0.0", runId, generatedAt: "2026-10-10T00:00:00.000Z",
    sourceArtifactRef: sources.detail, denominator: { discoveredPosts: 0, likesKnown: 0, likesMissing: 0,
      likesCoverage: 0, stopReason: "explicit_end", corpusCompleteness: "observed_converged" },
    likes: { min: null, p25: null, median: null, mean: null, p75: null, max: null }, mediaTypes: {}, records: [], unknowns: [] });
  const portfolioRef = write("portfolio.json", { schemaVersion: "1.0.0", runId, generatedAt: "2026-10-10T00:00:00.000Z",
    corpusArtifactRef: corpusRef, selectionArtifactRef: sources.selection, metricCoverage: { known: 0, missing: 0, rate: 0 },
    likes: { min: null, p25: null, median: null, mean: null, p75: null, max: null },
    tierCounts: { high: 0, base: 0, low: 0 }, anchors: { median: null, mean: null, medianNearPostId: null,
      meanNearPostId: null, meanGap: false, meanGapReason: null }, interpretationBoundary: "公开样本为空", unknowns: [] });
  const selected = ready ? Array.from({ length: 21 }, (_, index) => ({ externalId: `post-${index + 1}`,
    url: `https://example.com/post-${index + 1}`, title: `帖${index + 1}`, visibleText: null,
    mediaType: "video", likesLabel: "1", likes: 1, tier: index < 7 ? "high" : index < 14 ? "base" : "low",
    tierRank: index % 7 + 1, anchors: [], selectionReason: "公开样本", deepCandidate: index % 7 < 3,
    deepGroups: [], deepState: "pending", confounds: [] })) : [];
  const selection = { schemaVersion: "1.0.0", runId, generatedAt: "2026-10-10T00:00:00.000Z",
    sourceCorpusArtifactRef: corpusRef, ruleVersion: "ranked-7x3-v1",
    rules: { targetPerTier: 7, deepCandidatesPerTier: 3, high: "高表现", base: "基本盘", low: "低表现",
      unknownMetricPolicy: "exclude_from_metric_tiering" },
    denominator: { discoveredPosts: selected.length, eligiblePosts: selected.length,
      selectedPosts: selected.length, excludedMissingLikes: 0 },
    anchors: { median: null, mean: null, medianNearPostId: null, meanNearPostId: null,
    meanGap: false, meanGapReason: null }, tierCounts: { high: ready ? 7 : 0, base: ready ? 7 : 0,
      low: ready ? 7 : 0 }, items: selected, limitations: ready ? [] : ["无公开样本"] };
  write("selection.json", selection);
  const deepRefs = new Map(selected.filter(item => item.deepCandidate).map(item => [item.externalId,
    write(`deep/${item.externalId}.json`, { postExternalId: item.externalId, builderLenses: {} })]));
  const batchItems = selected.map(item => ({ postExternalId: item.externalId, tier: item.tier,
    tierRank: item.tierRank, state: item.deepCandidate ? "ready" : "queued",
    evaluationPolicy: "skip@builder-fast-path-v1", sourceMediaArtifactRef: sources.media,
    reconstructionArtifactRef: deepRefs.get(item.externalId) ?? null, articleArtifactRef: null,
    builderValidationArtifactRef: null, evaluationArtifactRef: null, gateReportArtifactRef: null,
    threeLensEvaluationArtifactRef: null, threeLensGateReportArtifactRef: null, failedGateIds: [],
    message: "", updatedAt: "2026-10-10T00:00:00.000Z" }));
  const emptyBatch = { schemaVersion: "1.0.0", creatorRunId: runId, revision: 1,
    generatedAt: "2026-10-10T00:00:00.000Z", requestedPosts: batchItems.length, builtPosts: deepRefs.size,
    verifiedPosts: deepRefs.size, readyPosts: deepRefs.size, pendingPosts: batchItems.length - deepRefs.size,
    failedPosts: 0, limitations: [], items: batchItems };
  write("batch.json", emptyBatch);
  const annotationRef = write("annotations.json", { rows: [] });
  const claim = { statement: "公开样本不足", factClass: "inference", confidence: "low", evidenceRefs: [corpusRef], caveat: "无样本" };
  const report = { schemaVersion: "1.0.0", creatorRunId: runId, generatedAt: "2026-10-10T00:00:00.000Z",
    inputs: { portfolioArtifactRef: portfolioRef, portfolioAnnotationsArtifactRef: annotationRef,
      selectionArtifactRef: sources.selection, detailArtifactRef: sources.detail, reconstructionBatchArtifactRef: sources.batch },
    identity: { positioning: claim, audience: [claim], problemsAddressed: [claim], valueProvided: [claim],
      trustSources: [claim], lifecycleStage: claim, commercialPaths: [] },
    contentSystem: { topicClusters: [claim], formatClusters: [claim], visualLanguage: [claim],
      publishingRhythm: [], recurringStructure: [claim] },
    performance: { baseline: [claim], high: [claim], low: [claim], timing: [], confounds: ["样本不足"] },
    postAnalyses: Array.from({ length: 21 }, (_, index) => ({ postExternalId: `post-${index + 1}`,
      tier: index < 7 ? "high" : index < 14 ? "base" : "low", tierRank: index % 7 + 1,
      title: `帖${index + 1}`, evidenceStatus: ready && deepRefs.has(`post-${index + 1}`) ? "deep_validated" : "surface_only",
      contentRole: "未知", contentForm: ["视频"], performanceInterpretation: "未知",
      evidenceRefs: [deepRefs.get(`post-${index + 1}`) ?? sources.detail], unknowns: ["未知"] })),
    boundaries: ["公开样本不足，曝光、完播、转粉、投流、成交不可见"] };
  const called: string[] = [];
  let candidateRef = "";
  const builderRunner: AgentRunner = { async run(request) {
    called.push(`${request.definition.id}:${request.definition.reasoningEffort}`);
    // Exercise the actual production allowlist with the pipeline's definition.
    // An empty input stops before model execution, after role dispatch.
    await expect(new ResponsesResearchRunner({} as never, {} as never).run({ ...request, input: {} as never }))
      .rejects.toThrow("RESPONSES_FROZEN_INPUT_REQUIRED");
    candidateRef = write("creator-analysis.json", report);
    const reportSha256 = crypto.createHash("sha256").update(fs.readFileSync(artifactPath(candidateRef))).digest("hex");
    return { output: { artifact: { reportArtifactRef: candidateRef, reportSha256, report,
      outcome: { state: "not_ready", synthesisArtifactRef: candidateRef, gateArtifactRef: null } } } } as never;
  } };
  const evaluatorRunner: AgentRunner = { async run(request) {
    called.push(`${request.definition.id}:${request.definition.reasoningEffort}`);
    const fingerprint = crypto.createHash("sha256").update(fs.readFileSync(artifactPath(candidateRef))).digest("hex");
    return { output: { schemaVersion: "creator-synthesis-independent-evaluation@1", creatorRunId: runId,
      candidateRevisionFingerprint: fingerprint, evaluatorRunId: crypto.randomUUID(), independentOfCandidate: true,
      evaluatedAt: "2026-10-10T00:00:00.000Z", gates: ["canonical_21_coverage", "deep_9_ready",
        "deep_evidence_binding", "three_tiers_present", "evidence_classification",
        "research_creation_separation", "backend_metrics_unknown"].map(id => ({ id, pass: ready,
          message: ready ? "证据闭合" : "公开样本不足", evidenceRefs: [candidateRef] })) } } as never;
  } };
  const store = new class extends MemoryRunStore {
    async getArtifactPayload(id: string): Promise<unknown> { return this.artifacts.find(item => item.id === id)?.payload; }
  }();
  const executor = new ResponsesPipelineCreatorSynthesisExecutor(store, new LocalCreatorArtifactStore(),
    { get: async () => ({ synthesisArtifactRef: null, synthesisGateArtifactRef: null }) } as never,
    { builderRunner, evaluatorRunner });
  const result = await executor.synthesize({ creatorRunId: runId, creatorName: "fixture", portfolioArtifactRef: portfolioRef,
    portfolioAnnotationsArtifactRef: annotationRef, selectionArtifactRef: sources.selection, detailArtifactRef: sources.detail,
    reconstructionBatchArtifactRef: sources.batch, mode });
  expect(result).toMatchObject({ state: expectedState, synthesisArtifactRef: candidateRef });
  if (!ready) expect(result).toHaveProperty("failedGateIds", expect.arrayContaining(["canonical_21_coverage"]));
  if (ready) expect(result).toHaveProperty("gateArtifactRef", expect.any(String));
  expect(called).toEqual(["creator-builder:high", "pipeline-creator-evaluator:low"]);
});
