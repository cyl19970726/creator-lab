import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { creatorResearchRunSchema } from "../../../contracts/index.js";
import { creatorSelectionSchema } from "../portfolio/contracts.js";
import { videoReconstructionBatchSchema } from "../video-analysis/batch-contracts.js";
import type { ResearchJob } from "../orchestration/contracts.js";
import type { ResearchWorkflowExecutor, WorkflowQueueReceipt } from "../workflows/contracts.js";
import { CreatorResearchJobProcessor } from "./job-processor.js";
import type { CreatorResearchRepository } from "./repository.js";
import type { CreatorArtifactStore } from "./artifact-store.js";

const runId = "11111111-1111-4111-8111-111111111111";
const at = "2026-10-10T00:00:00.000Z";
const groups = ["high", "median", "mean", "low"] as const;

function fixture(outcome: "verified" | "built_unevaluated" | "failed" | "start_failed") {
  const values = new Map<string, unknown>();
  let sequence = 0;
  const put = (ref: string, value: unknown) => { values.set(ref, value); return ref; };
  const selection = creatorSelectionSchema.parse({ schemaVersion: "1.0.0", runId, generatedAt: at,
    sourceCorpusArtifactRef: "corpus", ruleVersion: "four-groups-3-each-v2",
    rules: { targetPerTier: 7, deepCandidatesPerTier: 3, deepCandidatesPerGroup: 3, deepGroupContract: "test",
      high: "test", base: "test", low: "test", unknownMetricPolicy: "exclude_from_metric_tiering" },
    denominator: { discoveredPosts: 4, eligiblePosts: 4, selectedPosts: 4, excludedMissingLikes: 0 },
    anchors: { median: 2, mean: 2, medianNearPostId: "p0", meanNearPostId: "p1", meanGap: false, meanGapReason: null },
    tierCounts: { high: 1, base: 2, low: 1 },
    items: groups.map((group, index) => ({ externalId: `p${index}`, url: `https://example.com/p${index}`,
      title: group, visibleText: null, mediaType: "video", likesLabel: null, likes: index + 1,
      tier: index === 0 ? "high" : index === 3 ? "low" : "base", tierRank: 1, anchors: [],
      selectionReason: "test", deepCandidate: true, deepGroups: [group], deepState: "pending", confounds: [] })),
    limitations: [] });
  put("selection", selection);
  const batch = videoReconstructionBatchSchema.parse({ schemaVersion: "1.0.0", creatorRunId: runId, revision: 0,
    generatedAt: at, requestedPosts: 4, builtPosts: 3, verifiedPosts: outcome === "verified" ? 3 : 0,
    readyPosts: outcome === "verified" ? 3 : 0, pendingPosts: 1, failedPosts: 0, limitations: [],
    items: groups.map((_, index) => ({ postExternalId: `p${index}`, tier: index === 0 ? "high" : index === 3 ? "low" : "base",
      tierRank: 1, evidenceKind: "video", state: index === 3 ? "queued" : outcome === "verified" ? "verified" : "built_unevaluated",
      evaluationPolicy: "skip@builder-fast-path-v1", sourceMediaArtifactRef: `media-${index}`,
      reconstructionArtifactRef: index === 3 ? null : `candidate-${index}`, articleArtifactRef: null,
      evaluationArtifactRef: null, gateReportArtifactRef: null, threeLensEvaluationArtifactRef: null,
      threeLensGateReportArtifactRef: null, failedGateIds: [], message: "test", updatedAt: at })) });
  put("batch", batch);
  const run = creatorResearchRunSchema.parse({ schemaVersion: "1.3.0", id: runId, platform: "xiaohongshu",
    profileUrl: "https://www.xiaohongshu.com/user/profile/test", status: "collecting", currentStage: "deep_capture",
    createdAt: at, updatedAt: at, creatorId: "test", creatorName: "test", dashboardPath: null,
    stages: ["preflight", "inventory", "tiering", "deep_capture", "synthesis", "dashboard"].map((id) => ({ id,
      label: id, status: id === "deep_capture" ? "running" : "pending", message: null })),
    coverage: { discoveredPosts: 4, enrichedPosts: 4, comparisonPosts: 4, reconstructedPosts: 3 },
    collectionPolicy: { adapter: "redfox", browserProfile: null, readOnly: true, incremental: true,
      bypassChallenges: false, cacheTtlHours: 24, budgets: { maxScrollRounds: 1, maxDetailOpens: 4, maxMediaDownloads: 4 } },
    blockers: [], nextAction: "test", lastSnapshotAt: at, videoWork: { concurrencyLimit: 2,
      activePostExternalIds: [], queuedPosts: 1, analyzedPosts: 3, failedPosts: 0 },
    portfolioArtifactRef: "portfolio", portfolioAnnotationsArtifactRef: "annotations", selectionArtifactRef: "selection",
    detailArtifactRef: "details", mediaManifestArtifactRef: "manifest", reconstructionBatchArtifactRef: "batch",
    synthesisArtifactRef: null, synthesisGateArtifactRef: null });
  const jobs: ResearchJob[] = [{ id: randomUUID(), runId, nodeKey: "video.reconstruct", status: "queued",
    idempotencyKey: `${runId}:video.reconstruct:p3:media-3`, attempts: 0, maxAttempts: 2, availableAt: at,
    leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null,
    payload: { postExternalId: "p3", sourceMediaArtifactRef: "media-3", sourceItemUpdatedAt: at,
      evidenceKind: "video", automaticVersioned: true },
    lastError: null, createdAt: at, updatedAt: at }];
  const repository = { get: async () => run, save: async () => {},
    claimNext: async () => { const job = jobs.find((candidate) => candidate.status === "queued");
      if (!job) return null; job.status = "leased"; job.attempts += 1; return job; },
    enqueue: async (job: ResearchJob) => { const existing = jobs.find((candidate) => candidate.idempotencyKey === job.idempotencyKey);
      if (existing) return existing; jobs.push(job); return job; },
    updateJobStatus: async ({ jobId, status, lastError }: { jobId: string; status: ResearchJob["status"]; lastError?: string }) => {
      const job = jobs.find((candidate) => candidate.id === jobId)!; job.status = status;
      if (lastError) job.lastError = lastError;
      return true; },
    appendEvent: async (event: Record<string, unknown>) => ({ ...event, sequence: ++sequence }),
    withRunTransaction: async (_id: string, operation: () => Promise<unknown>) => operation(),
    heartbeat: async () => true } as unknown as CreatorResearchRepository;
  const artifacts = { read: async (ref: string) => values.get(ref),
    write: async (_id: string, _name: string, value: unknown) => put(`written-${++sequence}`, value) } as unknown as CreatorArtifactStore;
  const calls: string[] = [];
  let postReceipt: WorkflowQueueReceipt | undefined;
  let synthesisReceipt: WorkflowQueueReceipt | undefined;
  const workflow = { ensureAutomaticPost: async (_input: unknown, key: string) => {
    if (outcome === "start_failed") throw new Error("freezer unavailable");
    calls.push("post.analyze@v10");
    return postReceipt ??= { creatorRunId: runId, workflowRunId: randomUUID(), workflowId: "post.analyze",
      workflowRevision: "v10", generation: 1, state: "queued",
      automatic: { operationKey: key, kind: "post", postExternalId: "p3" } };
  }, ensureAutomaticSynthesis: async (_input: unknown, key: string) => {
    calls.push("creator.synthesize@v8");
    return synthesisReceipt ??= { creatorRunId: runId, workflowRunId: randomUUID(), workflowId: "creator.synthesize",
      workflowRevision: "v8", generation: 1, state: "queued",
      automatic: { operationKey: key, kind: "creator_synthesis" } };
  }, advance: async ({ workflowRunId }: { workflowRunId: string }) => {
    if (workflowRunId === postReceipt?.workflowRunId) {
      calls.push("post.terminal");
      if (outcome !== "failed" && outcome !== "start_failed") {
        const current = videoReconstructionBatchSchema.parse(values.get(run.reconstructionBatchArtifactRef!));
        current.items[3]!.state = outcome;
        current.items[3]!.reconstructionArtifactRef = "candidate-3";
        current.pendingPosts = 0; current.builtPosts = 4;
        current.verifiedPosts = outcome === "verified" ? 4 : 0;
        current.readyPosts = current.verifiedPosts;
        run.reconstructionBatchArtifactRef = put("registered-batch", current);
      }
      return { ...postReceipt, state: outcome === "failed" || outcome === "start_failed" ? "failed" : "succeeded" };
    }
    calls.push("creator.terminal");
    run.synthesisArtifactRef = "registered-synthesis";
    run.stages.find((entry) => entry.id === "synthesis")!.status = "complete";
    return { ...synthesisReceipt!, state: "succeeded" };
  }, snapshot: async () => null } as unknown as ResearchWorkflowExecutor;
  const processor = new CreatorResearchJobProcessor(repository, artifacts, {} as never, {} as never, {} as never,
    2, undefined, undefined, workflow, true);
  const drain = async () => { while (await processor.processNext("worker", {} as never)) { /* durable queue */ } };
  return { run, jobs, values, calls, drain, processor };
}

it("reaches post v10 and creator v8 through the ordinary queue after formal four-group coverage", async () => {
  const value = fixture("verified");
  await value.drain();
  expect(value.calls).toEqual(["post.analyze@v10", "post.terminal", "creator.synthesize@v8", "creator.terminal"]);
  expect(value.jobs.filter((job) => job.nodeKey === "creator.synthesize")).toHaveLength(1);
  expect(value.jobs.find((job) => job.nodeKey === "creator.synthesize")?.payload.mode).toBe("formal");
  expect(value.run.synthesisArtifactRef).toBe("registered-synthesis");
});

it("preserves provisional coverage and drains pending work on a technical post failure", async () => {
  const provisional = fixture("built_unevaluated");
  await provisional.drain();
  expect(provisional.jobs.find((job) => job.nodeKey === "creator.synthesize")?.payload.mode).toBe("provisional");
  const failed = fixture("failed");
  await failed.drain();
  const batch = videoReconstructionBatchSchema.parse(failed.values.get(failed.run.reconstructionBatchArtifactRef!));
  expect(batch).toMatchObject({ pendingPosts: 0, builtPosts: 3, failedPosts: 1 });
  expect(batch.items[3]).toMatchObject({ state: "not_ready", failedGateIds: ["post_workflow_failed"] });
  expect(failed.jobs.filter((job) => job.nodeKey === "creator.synthesize")).toHaveLength(0);
  expect(failed.run.status).toBe("reviewable");
});

it("does not let older post or synthesis failures overwrite newer queued revisions", async () => {
  const value = fixture("failed");
  const complete = (value.processor as unknown as { completeAutomaticWorkflow: (id: string, receipt: WorkflowQueueReceipt) => Promise<void> })
    .completeAutomaticWorkflow.bind(value.processor);
  const batch = videoReconstructionBatchSchema.parse(value.values.get("batch"));
  batch.items[3]!.updatedAt = "2026-10-10T01:00:00.000Z"; // a newer retry of the same media
  value.values.set("batch", batch);
  await complete(runId, { creatorRunId: runId, workflowRunId: randomUUID(), workflowId: "post.analyze",
    workflowRevision: "v10", generation: 1, state: "failed",
    automatic: { operationKey: "older-post", kind: "post", postExternalId: "p3",
      sourceMediaArtifactRef: "media-3", sourceItemUpdatedAt: at } });
  expect(videoReconstructionBatchSchema.parse(value.values.get("batch")).items[3]!.state).toBe("queued");
  expect(value.run.reconstructionBatchArtifactRef).toBe("batch");

  value.run.currentStage = "synthesis";
  value.run.worker.jobId = randomUUID(); // a newer synthesis job owns the projection
  await complete(runId, { creatorRunId: runId, workflowRunId: randomUUID(), workflowId: "creator.synthesize",
    workflowRevision: "v8", generation: 1, state: "failed",
    automatic: { operationKey: "older-creator", kind: "creator_synthesis",
      sourceBatchArtifactRef: "batch", sourceJobId: randomUUID() } });
  expect(value.run.stages.find((entry) => entry.id === "synthesis")!.status).toBe("pending");
  expect(value.run.status).toBe("collecting");
});

it("records a freezer or automatic-start error as a terminal batch failure", async () => {
  const value = fixture("start_failed");
  await value.drain();
  const batch = videoReconstructionBatchSchema.parse(value.values.get(value.run.reconstructionBatchArtifactRef!));
  expect(batch).toMatchObject({ pendingPosts: 0, failedPosts: 1 });
  expect(batch.items[3]).toMatchObject({ state: "not_ready", failedGateIds: ["post_workflow_failed"] });
  expect(value.jobs[0]).toMatchObject({ status: "failed", lastError: expect.anything() });
  expect(value.jobs.filter((job) => job.nodeKey === "creator.synthesize")).toHaveLength(0);
});
