import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { artifactPath, artifactRef } from "../core/artifacts.js";
import { fileDigest } from "./research-inputs.js";
import { ResponsesResearchRunner } from "./responses-research-runner.js";

const roots: string[] = [];
const previousRuntime = process.env.SELF_MEDIA_RUNTIME_DIR;
afterEach(() => {
  if (previousRuntime === undefined) delete process.env.SELF_MEDIA_RUNTIME_DIR;
  else process.env.SELF_MEDIA_RUNTIME_DIR = previousRuntime;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "responses-creator-repair-"));
  roots.push(runtime);
  process.env.SELF_MEDIA_RUNTIME_DIR = runtime;
  const runId = crypto.randomUUID();
  const files: Array<{ ref: string; sha256: string }> = [];
  const put = (name: string, value: unknown) => {
    const ref = artifactRef(runId, name);
    const file = artifactPath(ref);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
    files.push({ ref, sha256: fileDigest(file) });
    return ref;
  };
  const read = async (ref: string) => JSON.parse(fs.readFileSync(artifactPath(ref), "utf8")) as unknown;
  const records = Array.from({ length: 21 }, (_, index) => ({ externalId: `post-${index + 1}`,
    url: `https://example.com/post-${index + 1}`, title: `标题${index + 1}`, visibleText: null,
    mediaType: "video", likesLabel: "1", likes: 1 }));
  const summary = { min: 1, p25: 1, median: 1, mean: 1, p75: 1, max: 1 };
  const corpusRef = put("corpus.json", { schemaVersion: "1.0.0", runId, generatedAt: "now", sourceArtifactRef: "source",
    denominator: { discoveredPosts: 21, likesKnown: 21, likesMissing: 0, likesCoverage: 1,
      stopReason: "explicit_end", corpusCompleteness: "observed_converged" },
    likes: summary, mediaTypes: { video: 21 }, records, unknowns: [] });
  const selectionItems = records.map((record, index) => ({ ...record,
    tier: index < 7 ? "high" : index < 14 ? "base" : "low", tierRank: index % 7 + 1,
    anchors: [], selectionReason: "样本", deepCandidate: index === 0,
    deepGroups: index === 0 ? ["high"] : [], deepState: "pending", confounds: [] }));
  const anchors = { median: 1, mean: 1, medianNearPostId: "post-1", meanNearPostId: "post-1",
    meanGap: false, meanGapReason: null };
  const selectionRef = put("selection.json", { schemaVersion: "1.0.0", runId, generatedAt: "now",
    sourceCorpusArtifactRef: corpusRef, ruleVersion: "ranked-7x3-v1",
    rules: { targetPerTier: 7, deepCandidatesPerTier: 3, high: "高", base: "中", low: "低",
      unknownMetricPolicy: "exclude_from_metric_tiering" },
    denominator: { discoveredPosts: 21, eligiblePosts: 21, selectedPosts: 21, excludedMissingLikes: 0 },
    anchors, tierCounts: { high: 7, base: 7, low: 7 }, items: selectionItems, limitations: [] });
  const portfolioRef = put("portfolio.json", { schemaVersion: "1.0.0", runId, generatedAt: "now",
    corpusArtifactRef: corpusRef, selectionArtifactRef: selectionRef,
    metricCoverage: { known: 21, missing: 0, rate: 1 }, likes: summary,
    tierCounts: { high: 7, base: 7, low: 7 }, anchors, interpretationBoundary: "边界", unknowns: [] });
  const detailRef = put("detail.json", { detail: "公开详情" });
  const deepRef = put("deep.json", { builderLenses: { contentRestoration: {}, directingLogic: {}, visualEditing: {} } });
  const batchRef = put("batch.json", { schemaVersion: "1.0.0", creatorRunId: runId, revision: 1, generatedAt: "now",
    requestedPosts: 1, builtPosts: 1, verifiedPosts: 0, readyPosts: 0, pendingPosts: 0, failedPosts: 0,
    limitations: [], items: [{ postExternalId: "post-1", tier: "high", tierRank: 1, state: "built_unevaluated",
      evaluationPolicy: "skip@builder-fast-path-v1", sourceMediaArtifactRef: null,
      reconstructionArtifactRef: deepRef, articleArtifactRef: null, evaluationArtifactRef: null,
      gateReportArtifactRef: null, threeLensEvaluationArtifactRef: null, threeLensGateReportArtifactRef: null,
      failedGateIds: [], message: "完成", updatedAt: "now" }] });
  const claim = { statement: "中文观察", factClass: "observed", confidence: "high", evidenceRefs: [deepRef], caveat: null };
  const sections = ["value", "knowledge", "patterns", "performance", "next_questions"].map((id, index) => ({
    id, title: "研究主题", findings: [{ id: `finding-${index}`, statement: "逐帖观察", factClass: "observed",
      confidence: "high", support: [{ postExternalId: "post-1", observation: "实际内容", evidenceRefs: [deepRef] }],
      counterexamples: [], boundary: "目前未发现反例", openQuestions: [] }] }));
  const postAnalyses = selectionItems.map(item => ({ postExternalId: item.externalId, tier: item.tier,
    tierRank: item.tierRank, title: item.title, evidenceStatus: item.externalId === "post-1" ? "deep_provisional" : "surface_only",
    contentRole: "内容角色", contentForm: ["视频"], performanceInterpretation: "公开表现",
    evidenceRefs: [item.externalId === "post-1" ? deepRef : corpusRef], unknowns: ["未知"] }));
  const priorReport = { schemaVersion: "1.0.0", creatorRunId: runId, generatedAt: "earlier",
    inputs: { portfolioArtifactRef: portfolioRef, portfolioAnnotationsArtifactRef: "",
      selectionArtifactRef: selectionRef, detailArtifactRef: detailRef, reconstructionBatchArtifactRef: batchRef },
    identity: { positioning: claim, audience: [claim], problemsAddressed: [claim], valueProvided: [claim],
      trustSources: [claim], lifecycleStage: claim, commercialPaths: [] },
    contentSystem: { topicClusters: [claim], formatClusters: [claim], visualLanguage: [claim],
      publishingRhythm: [], recurringStructure: [claim] },
    performance: { baseline: [claim], high: [claim], low: [claim], timing: [], confounds: ["未知"] },
    postAnalyses, portfolioClassification: { schemaVersion: "creator-portfolio-classification@1",
      sourceCorpusArtifactRef: corpusRef, observedPosts: 21, labelRegistry: [],
      rows: records.map(record => ({ postExternalId: record.externalId, memberships: [], unknowns: ["未知"] })),
      boundaries: ["分类未知"] },
    crossPostResearch: { sections }, boundaries: ["曝光未知"] };
  const priorRef = put("prior/creator-analysis.json", priorReport);
  const prior = { kind: "creator", reportArtifactRef: priorRef, reportSha256: fileDigest(artifactPath(priorRef)),
    report: priorReport, evidence: { id: "frozen", revision: "1", sha256: "frozen" }, relativeRoot: "prior",
    outcome: { state: "not_ready" } };
  const source = { creatorRunId: runId, portfolioArtifactRef: portfolioRef, portfolioAnnotationsArtifactRef: "",
    selectionArtifactRef: selectionRef, detailArtifactRef: detailRef, reconstructionBatchArtifactRef: batchRef };
  const reviewRef = { id: "review", revision: "1", sha256: "review" };
  const frozen = { id: "frozen", revision: "1", sha256: "frozen" };
  const reviewReceipt = { schemaVersion: "research-review@1", kind: "creator", candidate: { ...frozen },
    candidateReportSha256: prior.reportSha256, summary: "定位需要修订",
    findings: [{ id: "issue-1", location: "/identity/positioning", issue: "定位含糊",
      evidenceRefs: [deepRef], suggestedChange: "写明定位", priority: "major", kind: "content" }] };
  const store = { getArtifact: async () => reviewRef, getArtifactPayload: async () => reviewReceipt };
  const artifacts = { read, write: async (_runId: string, name: string, value: unknown) => put(name, value) };
  const runner = new ResponsesResearchRunner(store as never, artifacts as never) as unknown as {
    model: (...args: unknown[]) => Promise<unknown>;
    creatorBuilder: (...args: unknown[]) => Promise<{ artifact: { report: typeof priorReport; revisionResponse: unknown } }>;
  };
  const tools = { list: () => [], addGenerated: () => undefined, fullyRead: () => true };
  const request = { runId: "workflow", attemptId: "attempt", signal: new AbortController().signal };
  const pinned = { kind: "creator", source, files, methods: [] };
  const directory = path.join(runtime, "runs", runId, "workflow-responses/workflow/attempt");
  return { runner, request, frozen, pinned, prior, source, tools, directory, reviewRef, reviewReceipt, priorReport, read };
}

it("keeps creator classification and post rows from the same frozen prior during review repair", async () => {
  const item = fixture();
  const draft = { identity: { ...item.priorReport.identity,
    positioning: { ...item.priorReport.identity.positioning, statement: "修订后的定位" } },
    contentSystem: item.priorReport.contentSystem, performance: item.priorReport.performance,
    crossPostResearch: item.priorReport.crossPostResearch, boundaries: ["修订后的边界"] };
  vi.spyOn(item.runner, "model").mockResolvedValue({ candidate: draft,
    revisionResponse: [{ id: "issue-1", status: "changed", reason: "按冻结证据修订" }] });
  const result = await item.runner.creatorBuilder(item.request, item.frozen, item.pinned, item.prior,
    { candidate: item.frozen, review: item.reviewRef }, item.tools, item.directory, true);
  expect(result.artifact.report.identity.positioning.statement).toBe("修订后的定位");
  expect(result.artifact.report.portfolioClassification).toEqual(item.priorReport.portfolioClassification);
  expect(result.artifact.report.postAnalyses).toEqual(item.priorReport.postAnalyses);
  expect(result.artifact.report.inputs).toEqual(item.priorReport.inputs);
  expect(result.artifact.revisionResponse).toEqual([{ id: "issue-1", status: "changed", reason: "按冻结证据修订" }]);
});

const fixedLocations = ["/portfolioClassification/rows/0", "/postAnalyses/0", "/schemaVersion",
  "/creatorRunId", "/generatedAt", "/inputs/selectionArtifactRef"];

it.each(fixedLocations)("rejects a changed claim on frozen creator field %s in draft and final checks", async (location) => {
  const item = fixture();
  item.reviewReceipt.findings[0]!.location = location;
  const draft = { identity: item.priorReport.identity, contentSystem: item.priorReport.contentSystem,
    performance: item.priorReport.performance, crossPostResearch: item.priorReport.crossPostResearch,
    boundaries: item.priorReport.boundaries };
  const output = { candidate: draft, revisionResponse: [{ id: "issue-1", status: "changed", reason: "已修改" }] };
  vi.spyOn(item.runner, "model").mockImplementation(async (...args: unknown[]) => {
    const validate = args[4] as (value: unknown) => unknown;
    const extraTools = args[5] as Array<{ name: string; execute: (value: unknown) => Promise<unknown> }>;
    const feedback = args[6] as (error: unknown) => string | null;
    expect(await extraTools.find(tool => tool.name === "validate_creator_draft")!.execute(output))
      .toMatchObject({ pass: false, errors: [expect.stringContaining("RESPONSES_CREATOR_FIXED_FIELD_CLAIM_CHANGED")] });
    let error: unknown;
    try { await validate(output); } catch (caught) { error = caught; }
    expect(String(error)).toContain("RESPONSES_CREATOR_FIXED_FIELD_CLAIM_CHANGED");
    expect(feedback(error)).toContain("Technical validation rejected");
    return output; // A fake runner may bypass output validation; the final host check must still reject it.
  });
  await expect(item.runner.creatorBuilder(item.request, item.frozen, item.pinned, item.prior,
    { candidate: item.frozen, review: item.reviewRef }, item.tools, item.directory, true))
    .rejects.toThrow("RESPONSES_CREATOR_FIXED_FIELD_CLAIM_CHANGED");
  expect(fs.existsSync(path.join(item.directory, "creator-analysis.json"))).toBe(false);
});

it.each(["disputed", "missing_evidence"])("preserves a %s disposition for an unresolved frozen classification finding", async (status) => {
  const item = fixture();
  item.reviewReceipt.findings[0]!.location = "/portfolioClassification/rows/0";
  const draft = { identity: item.priorReport.identity, contentSystem: item.priorReport.contentSystem,
    performance: item.priorReport.performance, crossPostResearch: item.priorReport.crossPostResearch,
    boundaries: item.priorReport.boundaries };
  vi.spyOn(item.runner, "model").mockResolvedValue({ candidate: draft,
    revisionResponse: [{ id: "issue-1", status, reason: "该分类字段本轮冻结，意见尚未解决" }] });
  const result = await item.runner.creatorBuilder(item.request, item.frozen, item.pinned, item.prior,
    { candidate: item.frozen, review: item.reviewRef }, item.tools, item.directory, true);
  expect(result.artifact.report.portfolioClassification).toEqual(item.priorReport.portfolioClassification);
  expect(result.artifact.revisionResponse).toEqual([{ id: "issue-1", status, reason: "该分类字段本轮冻结，意见尚未解决" }]);
});

it("rejects creator repair when its prior candidate belongs to different frozen inputs", async () => {
  const item = fixture();
  const model = vi.spyOn(item.runner, "model");
  const changed = { ...item.pinned, source: { ...item.source, detailArtifactRef: artifactRef(item.source.creatorRunId, "other-detail.json") } };
  await expect(item.runner.creatorBuilder(item.request, item.frozen, changed, item.prior,
    { candidate: item.frozen, review: item.reviewRef }, item.tools, item.directory, true))
    .rejects.toThrow("CREATOR_SYNTHESIS_REUSE_INPUT_MISMATCH");
  expect(model).not.toHaveBeenCalled();
});

it("rejects a reviewer receipt bound to a different candidate revision before calling the model", async () => {
  const item = fixture();
  item.reviewReceipt.candidate.sha256 = "different-candidate";
  const model = vi.spyOn(item.runner, "model");
  await expect(item.runner.creatorBuilder(item.request, item.frozen, item.pinned, item.prior,
    { candidate: item.frozen, review: item.reviewRef }, item.tools, item.directory, true))
    .rejects.toThrow("RESPONSES_CREATOR_REPAIR_REVIEW_CANDIDATE_MISMATCH");
  expect(model).not.toHaveBeenCalled();
});

it("gives creator repair bounded technical feedback for an incomplete output before publishing", async () => {
  const item = fixture();
  const draft = { identity: item.priorReport.identity, contentSystem: item.priorReport.contentSystem,
    performance: item.priorReport.performance, crossPostResearch: item.priorReport.crossPostResearch,
    boundaries: item.priorReport.boundaries };
  const model = vi.spyOn(item.runner, "model").mockImplementation(async (...args: unknown[]) => {
    const validate = args[4] as (value: unknown) => unknown;
    const extraTools = args[5] as Array<{ name: string }>;
    const feedback = args[6] as (error: unknown) => string | null;
    expect(extraTools.map(tool => tool.name)).toEqual(["check_creator_evidence_readiness", "validate_creator_draft"]);
    let failure: unknown;
    try { await validate({ status: "incomplete", reason: "未读完" }); } catch (error) { failure = error; }
    expect(String(failure)).toContain("RESPONSES_CREATOR_INCOMPLETE");
    expect(feedback(failure)).toContain("complete candidate");
    return { candidate: draft, revisionResponse: [{ id: "issue-1", status: "changed", reason: "已修" }] };
  });
  await item.runner.creatorBuilder(item.request, item.frozen, item.pinned, item.prior,
    { candidate: item.frozen, review: item.reviewRef }, item.tools, item.directory, true);
  expect(model).toHaveBeenCalledOnce();
});

it("keeps the ordinary creator Builder as one complete candidate over the frozen views", async () => {
  const item = fixture();
  const model = vi.spyOn(item.runner, "model").mockResolvedValue({ candidate: item.priorReport });
  const result = await item.runner.creatorBuilder(item.request, item.frozen, item.pinned, undefined,
    {}, item.tools, item.directory, false);
  expect(model).toHaveBeenCalledOnce();
  expect((model.mock.calls[0] as unknown[])[1]).toBe("creator-builder");
  const instructions = (model.mock.calls[0] as unknown[])[3] as string;
  const metadata = JSON.parse(instructions.match(/refs: (.+?)\. The output inputs/u)?.[1] ?? "null");
  expect(metadata.creatorRunId).toBe(item.source.creatorRunId);
  expect(metadata.outputInputs).toEqual(item.priorReport.inputs);
  expect(metadata.classificationSourceCorpusArtifactRef)
    .toBe(item.priorReport.portfolioClassification.sourceCorpusArtifactRef);
  expect(metadata.commonReadViewToOriginalRef).toMatchObject({
    "creator-input/portfolio.json": item.source.portfolioArtifactRef,
    "creator-input/corpus.json": item.priorReport.portfolioClassification.sourceCorpusArtifactRef,
    "creator-input/selection.json": item.source.selectionArtifactRef,
    "creator-input/detail.json": item.source.detailArtifactRef,
    "creator-input/batch.json": item.source.reconstructionBatchArtifactRef
  });
  expect(result.artifact.report.postAnalyses).toEqual(item.priorReport.postAnalyses);
  expect(result.artifact.report.portfolioClassification).toEqual(item.priorReport.portfolioClassification);
});
