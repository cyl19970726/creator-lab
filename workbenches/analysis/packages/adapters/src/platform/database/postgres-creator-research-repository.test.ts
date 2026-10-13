import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CreatorResearchService,
  type CreatorBrowserExecutor,
  type CreatorArtifactStore,
  type CreatorResearchRepository,
  type DeepMediaResolver,
  type ResearchJob,
  type VideoReconstructionExecutor,
  type CreatorSynthesisExecutor
} from "../../../../research/index.js";
import { PostgresCreatorResearchRepository } from "./postgres-creator-research-repository.js";
import { createAnalysisPgTestDatabase, type AnalysisPgTestDatabase } from "./postgres-test-database.js";

let pgDatabase: AnalysisPgTestDatabase;
let repository: PostgresCreatorResearchRepository;
let service: CreatorResearchService;
let jobCreationOrder = 0;
let jobCreatedAtBase = Date.now();
const databaseUrl = process.env.ANALYSIS_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

function timestamp(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

async function enqueue(runId: string, nodeKey: ResearchJob["nodeKey"], suffix: string = randomUUID()): Promise<ResearchJob> {
  const createdAt = new Date(jobCreatedAtBase + jobCreationOrder++).toISOString();
  return repository.enqueue({
    id: randomUUID(), runId, nodeKey, status: "queued", idempotencyKey: `${runId}:${nodeKey}:${suffix}`,
    attempts: 0, maxAttempts: 3, availableAt: createdAt, leaseOwner: null, leaseExpiresAt: null,
    heartbeatAt: null, payload: {}, lastError: null, createdAt, updatedAt: createdAt
  });
}

async function enqueueWorkflow(runId: string, workflowId: string,
  suffix: string = randomUUID(), workflowRevision: string | null = "v2"): Promise<ResearchJob> {
  const createdAt = new Date(jobCreatedAtBase + jobCreationOrder++).toISOString();
  return repository.enqueue({ id: randomUUID(), runId, nodeKey: "workflow.advance", status: "queued",
    idempotencyKey: `${runId}:workflow.advance:${suffix}`, attempts: 0, maxAttempts: 2,
    availableAt: createdAt, leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null,
    payload: { workflowRunId: randomUUID(), workflowId, ...(workflowRevision ? { workflowRevision } : {}), generation: 1 }, lastError: null,
    createdAt, updatedAt: createdAt });
}

function createRun(adapter: "redfox" | "ego-browser", slug: string = randomUUID()) {
  return service.create(`https://www.xiaohongshu.com/user/profile/${slug}`, adapter);
}

async function completeAcquisition(runId: string, lane: "redfox" | "ego-browser"): Promise<void> {
  const job = await repository.claimNext("setup", timestamp(), timestamp(90_000), lane);
  expect(job?.runId).toBe(runId);
  await repository.updateJobStatus({ jobId: job!.id, status: "succeeded", updatedAt: timestamp() });
}

suite("PostgresCreatorResearchRepository Pipeline V2 claims", () => {
  beforeAll(async () => { pgDatabase = await createAnalysisPgTestDatabase(); });
  beforeEach(async () => {
    await pgDatabase.reset();
    jobCreationOrder = 0;
    jobCreatedAtBase = Date.now();
    repository = new PostgresCreatorResearchRepository(pgDatabase.context);
    service = new CreatorResearchService(repository as CreatorResearchRepository,
      {} as CreatorArtifactStore, {} as DeepMediaResolver, {} as VideoReconstructionExecutor,
      {} as CreatorSynthesisExecutor, 3);
  });
  afterAll(async () => { await pgDatabase.close(); });
  afterEach(() => {
    delete process.env.SELF_MEDIA_REDFOX_CONCURRENCY;
    delete process.env.SELF_MEDIA_VIDEO_CONCURRENCY;
  });
  it("constrains an optional run scope before selecting work in any lane", async () => {
    const unrelated = await createRun("redfox", "run-scope-unrelated");
    const target = await createRun("redfox", "run-scope-target");

    expect((await repository.claimNext("scoped-redfox", timestamp(), timestamp(90_000), "redfox", target.id))?.runId)
      .toBe(target.id);
    expect(await repository.claimNext("scoped-any", timestamp(), timestamp(90_000), "any", target.id)).toBeNull();
    expect((await repository.claimNext("unscoped", timestamp(), timestamp(90_000), "redfox"))?.runId).toBe(unrelated.id);
  });

  it("forwards a run scope through the service and job processor", async () => {
    const unrelated = await createRun("redfox", "service-scope-unrelated");
    const target = await createRun("redfox", "service-scope-target");
    const acquiredRunIds: string[] = [];
    const executor = {
      async acquire(input) {
        acquiredRunIds.push(input.runId);
        return { state: "blocked" as const, finalUrl: input.profileUrl, taskSpaceId: null,
          code: "provider_unavailable" as const, message: "stop after scoped claim", retryable: false };
      },
      async enrich() { throw new Error("unexpected enrich"); }
    } satisfies CreatorBrowserExecutor;

    expect(await service.processNext("scoped-service", executor, "redfox", target.id)).toBe(true);
    expect(acquiredRunIds).toEqual([target.id]);
    expect((await repository.claimNext("unscoped-after-service", timestamp(), timestamp(90_000), "redfox"))?.runId)
      .toBe(unrelated.id);
  });

  it("leaves an unrelated exhausted lease untouched during a scoped claim", async () => {
    const unrelated = await createRun("redfox", "scope-exhausted-unrelated");
    const target = await createRun("redfox", "scope-exhausted-target");
    await pgDatabase.context.query("UPDATE analysis_research_jobs SET max_attempts = 1 WHERE id = $1",
      [unrelated.worker.jobId!]);
    const leasedAt = timestamp();
    const expiresAt = new Date(Date.parse(leasedAt) + 1).toISOString();
    const afterExpiry = new Date(Date.parse(leasedAt) + 2).toISOString();
    const unrelatedJob = await repository.claimNext("unrelated-worker", leasedAt, expiresAt, "redfox", unrelated.id);
    expect(unrelatedJob?.runId).toBe(unrelated.id);

    expect((await repository.claimNext("target-worker", afterExpiry, timestamp(90_000), "redfox", target.id))?.runId)
      .toBe(target.id);
    const storedJob = await pgDatabase.context.query<{ status: string }>(
      "SELECT status FROM analysis_research_jobs WHERE id = $1", [unrelatedJob!.id]);
    expect(storedJob.rows[0]?.status).toBe("leased");
    expect((await repository.get(unrelated.id))?.status).toBe("queued");
  });

  it("routes acquisition and enrichment by provider, and compute jobs by node", async () => {
    const redfox = await createRun("redfox", "redfox-route");
    const ego = await createRun("ego-browser", "ego-route");

    expect((await repository.claimNext("redfox-1", timestamp(), timestamp(90_000), "redfox"))?.runId).toBe(redfox.id);
    expect(await repository.claimNext("redfox-2", timestamp(), timestamp(90_000), "redfox")).toBeNull();
    expect((await repository.claimNext("ego-1", timestamp(), timestamp(90_000), "ego-browser"))?.runId).toBe(ego.id);

    const portfolio = await enqueue(redfox.id, "creator.portfolio");
    expect(await repository.claimNext("portfolio-1", timestamp(), timestamp(90_000), "portfolio")).toBeNull();
    await repository.updateJobStatus({ jobId: redfox.worker.jobId!, status: "succeeded", updatedAt: timestamp() });
    expect((await repository.claimNext("portfolio-1", timestamp(), timestamp(90_000), "portfolio"))?.id).toBe(portfolio.id);
  });

  it("allows only one active non-video job for the same run", async () => {
    const run = await createRun("redfox", "nonvideo-mutex");
    await enqueue(run.id, "creator.portfolio");

    expect((await repository.claimNext("redfox", timestamp(), timestamp(90_000), "redfox"))?.nodeKey).toBe("creator.acquire");
    expect(await repository.claimNext("portfolio", timestamp(), timestamp(90_000), "portfolio")).toBeNull();
  });

  it("claims two v2 post worker workflows concurrently and caps the third", async () => {
    const run = await createRun("redfox", "post-workflow-concurrency");
    await completeAcquisition(run.id, "redfox");
    await enqueueWorkflow(run.id, "post.build", "post-1");
    await enqueueWorkflow(run.id, "post.review", "post-2");
    await enqueueWorkflow(run.id, "post.repair-evaluation", "post-3");
    const first = await repository.claimNext("post-1", timestamp(), timestamp(90_000), "video");
    const second = await repository.claimNext("post-2", timestamp(), timestamp(90_000), "video");
    expect([first?.payload.workflowId, second?.payload.workflowId]).toEqual(["post.review", "post.repair-evaluation"]);
    expect(await repository.claimNext("post-3", timestamp(), timestamp(90_000), "video")).toBeNull();
  });

  it("a waiting parent releases its queue job before child work is claimed", async () => {
    const run = await createRun("redfox", "waiting-parent-release");
    await completeAcquisition(run.id, "redfox");
    const parent = await enqueueWorkflow(run.id, "creator.analyze", "parent");
    expect((await repository.claimNext("parent", timestamp(), timestamp(90_000), "synthesis"))?.id).toBe(parent.id);
    await repository.updateJobStatus({ jobId: parent.id, status: "succeeded", updatedAt: timestamp() });
    const child = await enqueueWorkflow(run.id, "post.build", "child");
    expect((await repository.claimNext("child", timestamp(), timestamp(90_000), "video"))?.id).toBe(child.id);
  });

  it("claims orchestration advances beside active post model work without consuming a model slot", async () => {
    process.env.SELF_MEDIA_VIDEO_CONCURRENCY = "1";
    const run = await createRun("redfox", "control-beside-model");
    await completeAcquisition(run.id, "redfox");
    const model = await enqueueWorkflow(run.id, "post.build", "model");
    expect((await repository.claimNext("post-model", timestamp(), timestamp(90_000), "video"))?.id).toBe(model.id);

    const creatorControl = await enqueueWorkflow(run.id, "creator.analyze", "creator-control");
    expect((await repository.claimNext("creator-control", timestamp(), timestamp(90_000), "synthesis"))?.id).toBe(creatorControl.id);

    const postControl = await enqueueWorkflow(run.id, "post.analyze", "post-control", "v2");
    expect((await repository.claimNext("post-control", timestamp(), timestamp(90_000), "synthesis"))?.id).toBe(postControl.id);
    expect(await repository.claimNext("another-model", timestamp(), timestamp(90_000), "video")).toBeNull();
  });

  it("treats v3 post and creator suite roots as slot-free orchestration advances", async () => {
    process.env.SELF_MEDIA_VIDEO_CONCURRENCY = "1";
    const run = await createRun("redfox", "v3-control-beside-model");
    await completeAcquisition(run.id, "redfox");
    const model = await enqueueWorkflow(run.id, "post.build", "model");
    expect((await repository.claimNext("post-model", timestamp(), timestamp(90_000), "video"))?.id).toBe(model.id);

    for (const workflowId of ["post.analyze", "creator.synthesize", "creator.analyze"]) {
      const control = await enqueueWorkflow(run.id, workflowId, `v3-${workflowId}`, "v3");
      expect((await repository.claimNext(`v3-${workflowId}`, timestamp(), timestamp(90_000), "synthesis"))?.id)
        .toBe(control.id);
    }
    expect(await repository.claimNext("another-model", timestamp(), timestamp(90_000), "video")).toBeNull();
  });

  it.each(["v4", "v5"])("routes %s orchestration to control and source checking to the video model slot", async (revision) => {
    process.env.SELF_MEDIA_VIDEO_CONCURRENCY = "1";
    const run = await createRun("redfox", "v4-source-check-lanes");
    await completeAcquisition(run.id, "redfox");
    const control = await enqueueWorkflow(run.id, "post.analyze", "v4-control", revision);
    expect((await repository.claimNext("v4-control", timestamp(), timestamp(90_000), "synthesis"))?.id).toBe(control.id);
    const sourceCheck = await enqueueWorkflow(run.id, "post.source-check", "source-check", "v1");
    expect((await repository.claimNext("source-check", timestamp(), timestamp(90_000), "video"))?.id).toBe(sourceCheck.id);
    const build = await enqueueWorkflow(run.id, "post.build", "blocked-by-source-check", "v1");
    expect(await repository.claimNext("second-video", timestamp(), timestamp(90_000), "video")).toBeNull();
    await repository.updateJobStatus({ jobId: sourceCheck.id, status: "succeeded", updatedAt: timestamp() });
    expect((await repository.claimNext("second-video", timestamp(), timestamp(90_000), "video"))?.id).toBe(build.id);
  });

  it.each([
    ["post.analyze", "v7"],
    ["post.analyze", "v8"],
    ["post.analyze", "v9"],
    ["post.analyze", "v11"],
    ["creator.synthesize", "v6"],
    ["creator.synthesize", "v7"],
  ])("claims current %s@%s control while two post models remain active", async (workflowId, revision) => {
    process.env.SELF_MEDIA_VIDEO_CONCURRENCY = "2";
    const run = await createRun("redfox", `current-control-${workflowId}-${revision}`);
    await completeAcquisition(run.id, "redfox");
    const first = await enqueueWorkflow(run.id, "post.build", "model-1", "v1");
    const second = await enqueueWorkflow(run.id, "post.build", "model-2", "v1");
    expect((await repository.claimNext("model-1", timestamp(), timestamp(90_000), "video"))?.id).toBe(first.id);
    expect((await repository.claimNext("model-2", timestamp(), timestamp(90_000), "video"))?.id).toBe(second.id);
    expect(await repository.claimNext("model-limit", timestamp(), timestamp(90_000), "video")).toBeNull();

    const control = await enqueueWorkflow(run.id, workflowId, "current-control", revision);
    expect((await repository.claimNext("current-control", timestamp(), timestamp(90_000), "synthesis"))?.id).toBe(control.id);
  });

  it("reviews an existing candidate before an older queued build without widening model concurrency", async () => {
    process.env.SELF_MEDIA_VIDEO_CONCURRENCY = "2";
    const run = await createRun("redfox", "review-before-build");
    await completeAcquisition(run.id, "redfox");
    const olderBuild = await enqueueWorkflow(run.id, "post.build", "older-build", "v1");
    const newerReview = await enqueueWorkflow(run.id, "post.review", "newer-review", "v1");
    const secondBuild = await enqueueWorkflow(run.id, "post.build", "second-build", "v1");

    expect((await repository.claimNext("review-first", timestamp(), timestamp(90_000), "video"))?.id).toBe(newerReview.id);
    expect((await repository.claimNext("build-second", timestamp(), timestamp(90_000), "video"))?.id).toBe(olderBuild.id);
    expect(await repository.claimNext("model-limit", timestamp(), timestamp(90_000), "video")).toBeNull();
    expect(secondBuild.status).toBe("queued");
  });

  it("claims a newer workflow control before an older synthesis model job", async () => {
    const run = await createRun("redfox", "control-priority");
    await completeAcquisition(run.id, "redfox");
    const olderModel = await enqueueWorkflow(run.id, "creator.build", "older-model", "v1");
    const newerControl = await enqueueWorkflow(run.id, "creator.synthesize", "newer-control", "v6");

    expect((await repository.claimNext("control-first", timestamp(), timestamp(90_000), "synthesis"))?.id).toBe(newerControl.id);
    await repository.updateJobStatus({ jobId: newerControl.id, status: "succeeded", updatedAt: timestamp() });
    expect((await repository.claimNext("model-second", timestamp(), timestamp(90_000), "synthesis"))?.id).toBe(olderModel.id);
  });

  it("does not claim future work early and keeps ordinary queued jobs in availability order", async () => {
    const run = await createRun("redfox", "stable-ordinary-order");
    await completeAcquisition(run.id, "redfox");
    const first = await enqueue(run.id, "creator.portfolio", "ordinary-first");
    const createdAt = timestamp();
    const future = await repository.enqueue({ id: randomUUID(), runId: run.id, nodeKey: "creator.portfolio", status: "queued",
      idempotencyKey: `${run.id}:future`, attempts: 0, maxAttempts: 3, availableAt: timestamp(60_000),
      leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null, payload: {}, lastError: null, createdAt, updatedAt: createdAt });

    expect((await repository.claimNext("ordinary", timestamp(), timestamp(90_000), "portfolio"))?.id).toBe(first.id);
    await repository.updateJobStatus({ jobId: first.id, status: "succeeded", updatedAt: timestamp() });
    expect(await repository.claimNext("future-too-early", timestamp(), timestamp(90_000), "portfolio")).toBeNull();
    expect(future.status).toBe("queued");
  });

  it("does not let control advances consume or block the synthesis model slot", async () => {
    const run = await createRun("redfox", "control-before-synthesis-model");
    await completeAcquisition(run.id, "redfox");
    const control = await enqueueWorkflow(run.id, "creator.synthesize", "suite-control", "v2");
    expect((await repository.claimNext("suite-control", timestamp(), timestamp(90_000), "synthesis"))?.id).toBe(control.id);
    const model = await enqueueWorkflow(run.id, "creator.build", "creator-model");
    expect((await repository.claimNext("creator-model", timestamp(), timestamp(90_000), "synthesis"))?.id).toBe(model.id);
  });

  it("routes every v2 workflow node to its executable lane", async () => {
    const synthesisIds = ["post.analyze", "creator.analyze", "creator.synthesize", "creator.build", "creator.review", "creator.repair"];
    for (const workflowId of synthesisIds) {
      const run = await createRun("redfox", `synthesis-${workflowId}`);
      await completeAcquisition(run.id, "redfox");
      const job = await enqueueWorkflow(run.id, workflowId);
      const claimed = await repository.claimNext(`worker-${workflowId}`, timestamp(), timestamp(90_000), "synthesis");
      expect(claimed?.id, workflowId).toBe(job.id);
      await repository.updateJobStatus({ jobId: job.id, status: "succeeded", updatedAt: timestamp() });
    }
    const videoIds = ["post.source-check", "post.build", "post.review", "post.repair", "post.repair-evaluation"];
    for (const workflowId of videoIds) {
      const run = await createRun("redfox", `video-${workflowId}`);
      await completeAcquisition(run.id, "redfox");
      const job = await enqueueWorkflow(run.id, workflowId);
      const claimed = await repository.claimNext(`worker-${workflowId}`, timestamp(), timestamp(90_000), "video");
      expect(claimed?.id, workflowId).toBe(job.id);
      await repository.updateJobStatus({ jobId: job.id, status: "succeeded", updatedAt: timestamp() });
    }
  });

  it("keeps v1 and revisionless post orchestrators on the video lane", async () => {
    for (const revision of ["v1", undefined]) {
      const run = await createRun("redfox", `legacy-post-${revision ?? "missing"}`);
      await completeAcquisition(run.id, "redfox");
      const job = await enqueueWorkflow(run.id, "post.analyze", revision ?? "missing", revision ?? null);
      expect(await repository.claimNext("synthesis", timestamp(), timestamp(90_000), "synthesis")).toBeNull();
      expect((await repository.claimNext("video", timestamp(), timestamp(90_000), "video"))?.id).toBe(job.id);
      await repository.updateJobStatus({ jobId: job.id, status: "succeeded", updatedAt: timestamp() });
    }
  });

  it("prevents video and synthesis from overlapping in either claim order", async () => {
    const videoFirst = await createRun("redfox", "video-first");
    await completeAcquisition(videoFirst.id, "redfox");
    await enqueue(videoFirst.id, "video.reconstruct");
    await enqueue(videoFirst.id, "creator.synthesize");
    expect((await repository.claimNext("video", timestamp(), timestamp(90_000), "video"))?.runId).toBe(videoFirst.id);
    expect(await repository.claimNext("synthesis", timestamp(), timestamp(90_000), "synthesis")).toBeNull();

    const synthesisFirst = await createRun("redfox", "synthesis-first");
    await completeAcquisition(synthesisFirst.id, "redfox");
    await enqueue(synthesisFirst.id, "creator.synthesize");
    await enqueue(synthesisFirst.id, "video.reconstruct");
    expect((await repository.claimNext("synthesis", timestamp(), timestamp(90_000), "synthesis"))?.runId).toBe(synthesisFirst.id);
    expect(await repository.claimNext("video", timestamp(), timestamp(90_000), "video")).toBeNull();
  });

  it("does not start video beside active acquisition, or non-video beside active video", async () => {
    const acquisitionFirst = await createRun("redfox", "acquisition-first");
    await enqueue(acquisitionFirst.id, "video.reconstruct");
    expect((await repository.claimNext("redfox", timestamp(), timestamp(90_000), "redfox"))?.runId).toBe(acquisitionFirst.id);
    expect(await repository.claimNext("video", timestamp(), timestamp(90_000), "video")).toBeNull();

    const videoFirst = await createRun("redfox", "video-before-portfolio");
    await completeAcquisition(videoFirst.id, "redfox");
    await enqueue(videoFirst.id, "video.reconstruct");
    await enqueue(videoFirst.id, "creator.portfolio");
    expect((await repository.claimNext("video", timestamp(), timestamp(90_000), "video"))?.runId).toBe(videoFirst.id);
    expect(await repository.claimNext("portfolio", timestamp(), timestamp(90_000), "portfolio")).toBeNull();
  });

  it("does not claim stale queued work from a completed run", async () => {
    const run = await createRun("redfox", "already-ready");
    run.status = "ready";
    await repository.save(run);
    expect(await repository.claimNext("redfox", timestamp(), timestamp(90_000), "redfox")).toBeNull();
  });

  it("finds the latest run for the exact profile and acquisition adapter", async () => {
    const profileUrl = "https://www.xiaohongshu.com/user/profile/same-profile";
    const redfox = await service.create(profileUrl, "redfox");
    const ego = await service.create(profileUrl, "ego-browser");
    expect((await repository.findLatestByProfileUrlAndAdapter(profileUrl, "redfox"))?.id).toBe(redfox.id);
    expect((await repository.findLatestByProfileUrlAndAdapter(profileUrl, "ego-browser"))?.id).toBe(ego.id);
  });

  it("enforces the configured global video lease limit transactionally", async () => {
    process.env.SELF_MEDIA_VIDEO_CONCURRENCY = "1";
    const first = await createRun("redfox", "video-limit-one");
    await completeAcquisition(first.id, "redfox");
    const second = await createRun("redfox", "video-limit-two");
    await completeAcquisition(second.id, "redfox");
    await enqueue(first.id, "video.reconstruct");
    await enqueue(second.id, "video.reconstruct");

    expect((await repository.claimNext("video-1", timestamp(), timestamp(90_000), "video"))?.nodeKey).toBe("video.reconstruct");
    expect(await repository.claimNext("video-2", timestamp(), timestamp(90_000), "video")).toBeNull();
  });

  it("resumes expired video leases before starting untouched queued videos", async () => {
    const staleRun = await createRun("redfox", "expired-video");
    await completeAcquisition(staleRun.id, "redfox");
    const stale = await enqueue(staleRun.id, "video.reconstruct");
    const leasedAt = timestamp();
    expect((await repository.claimNext("old-video-worker", leasedAt, timestamp(1_000), "video"))?.id).toBe(stale.id);
    await repository.updateJobStatus({ jobId: stale.id, status: "running", updatedAt: leasedAt });

    const queuedRun = await createRun("redfox", "untouched-video");
    await completeAcquisition(queuedRun.id, "redfox");
    const oldAvailableAt = new Date(Date.now() - 86_400_000).toISOString();
    await repository.enqueue({
      id: randomUUID(), runId: queuedRun.id, nodeKey: "video.reconstruct", status: "queued",
      idempotencyKey: `${queuedRun.id}:video.reconstruct:older-queue`, attempts: 0, maxAttempts: 3,
      availableAt: oldAvailableAt, leaseOwner: null, leaseExpiresAt: null, heartbeatAt: null,
      payload: {}, lastError: null, createdAt: timestamp(), updatedAt: timestamp()
    });

    const recovered = await repository.claimNext("new-video-worker", timestamp(2_000), timestamp(92_000), "video");
    expect(recovered?.id).toBe(stale.id);
    expect(recovered?.attempts).toBe(2);
  });

  it("stops reclaiming an expired job at its retry limit, records an actionable run failure, and keeps the lane moving", async () => {
    const exhaustedRun = await createRun("redfox", "retry-limit-exhausted");
    const first = await repository.claimNext("expired-worker-1", timestamp(), timestamp(1_000), "redfox");
    expect(first?.runId).toBe(exhaustedRun.id);
    const second = await repository.claimNext("expired-worker-2", timestamp(2_000), timestamp(3_000), "redfox");
    expect(second?.id).toBe(first?.id);
    const third = await repository.claimNext("expired-worker-3", timestamp(4_000), timestamp(5_000), "redfox");
    expect(third?.id).toBe(first?.id);
    expect(third?.attempts).toBe(third?.maxAttempts);

    const unaffectedRun = await createRun("redfox", "retry-limit-unaffected");
    const replacement = await repository.claimNext("replacement-worker", timestamp(6_000), timestamp(96_000), "redfox");
    expect(replacement?.runId).toBe(unaffectedRun.id);

    const exhausted = (await repository.get(exhaustedRun.id))!;
    expect(exhausted.status).toBe("failed");
    expect(exhausted.blockers).toMatchObject([{ code: "retry_limit_exhausted", userActionRequired: false }]);
    expect(exhausted.nextAction).toContain("Dashboard");
    expect(await repository.listEvents(exhaustedRun.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "run.failed", payload: expect.objectContaining({
        code: "retry_limit_exhausted", attempts: 3, maxAttempts: 3
      }) })
    ]));

    await repository.updateJobStatus({ jobId: replacement!.id, status: "succeeded", updatedAt: timestamp(6_100) });
    const resumed = await service.resume(exhaustedRun.id);
    expect(resumed.status).toBe("queued");
    expect((await repository.claimNext("manual-retry", timestamp(7_000), timestamp(97_000), "redfox"))?.id).toBe(first?.id);
  });

  it("normalizes every expired lease before filling the available worker slots", async () => {
    const runs = [await createRun("redfox", "expired-many-1"), await createRun("redfox", "expired-many-2")];
    for (const run of runs) await completeAcquisition(run.id, "redfox");
    const jobs = await Promise.all(runs.map((run) => enqueue(run.id, "video.reconstruct")));
    const leasedAt = timestamp();
    for (let index = 0; index < jobs.length; index += 1) {
      const claimed = await repository.claimNext(`old-video-${index}`, leasedAt, timestamp(1_000), "video");
      expect(claimed?.id).toBe(jobs[index]?.id);
      await repository.updateJobStatus({ jobId: claimed!.id, status: "running", updatedAt: leasedAt });
    }

    const recovered = await repository.claimNext("new-video", timestamp(2_000), timestamp(92_000), "video");
    expect(jobs.map((job) => job.id)).toContain(recovered?.id);
    const waitingId = jobs.find((job) => job.id !== recovered?.id)!.id;
    const inspection = await pgDatabase.context.query<{status:string;lease_owner:string|null;lease_expires_at:string|null;heartbeat_at:string|null;last_error:string|null}>(`
      SELECT status, lease_owner, lease_expires_at, heartbeat_at, last_error
      FROM analysis_research_jobs WHERE id = $1
    `,[waitingId]);
    expect(inspection.rows[0]).toMatchObject({
      status: "backoff", lease_owner: null, lease_expires_at: null,
      heartbeat_at: null, last_error: "lease_expired"
    });
  });

  it("advances a twenty-creator RedFox queue four at a time without head-of-line blocking", async () => {
    process.env.SELF_MEDIA_REDFOX_CONCURRENCY = "4";
    const runs = [];
    for (let index = 0; index < 20; index += 1) runs.push(await createRun("redfox", `batch-20-${index + 1}`));
    const claimed = await Promise.all(Array.from({ length: 4 }, async (_, index) =>
      repository.claimNext(`redfox-${index + 1}`, timestamp(), timestamp(90_000), "redfox")));

    expect(claimed.every(Boolean)).toBe(true);
    expect(new Set(claimed.map((job) => job?.runId)).size).toBe(4);
    expect(await repository.claimNext("redfox-over-limit", timestamp(), timestamp(90_000), "redfox")).toBeNull();

    const failedJob = claimed[0]!;
    const failedRun = runs.find((run) => run.id === failedJob.runId)!;
    failedRun.status = "failed";
    await repository.save(failedRun);
    await repository.updateJobStatus({ jobId: failedJob.id, status: "failed", updatedAt: timestamp(), lastError: "fixture failure" });

    const replacement = await repository.claimNext("redfox-replacement", timestamp(), timestamp(90_000), "redfox");
    expect(replacement).not.toBeNull();
    expect(replacement?.runId).not.toBe(failedRun.id);
  });

  it("serializes short updates to one run across repository instances", async () => {
    const run = await createRun("redfox","serialized-run");
    const other = new PostgresCreatorResearchRepository(pgDatabase.context);
    try {
      await Promise.all([
        repository.withRunTransaction(run.id,async () => {
          const current = (await repository.get(run.id))!;
          await new Promise((resolve) => setTimeout(resolve,20));
          await repository.save({...current,nextAction:"first"});
        }),
        other.withRunTransaction(run.id,async () => {
          const current = (await other.get(run.id))!;
          await other.save({...current,creatorName:"second"});
        })
      ]);
      expect(await repository.get(run.id)).toMatchObject({nextAction:"first",creatorName:"second"});
    } finally { other.close(); }
  });
});
