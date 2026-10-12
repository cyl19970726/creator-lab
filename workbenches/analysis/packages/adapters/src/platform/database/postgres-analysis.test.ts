import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { workflow, type ArtifactRef } from "@signal-room/workflow";
import { migratePostgresWorkflowStore, PostgresWorkflowRunStore } from "@signal-room/workflow-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CreatorResearchService, type CreatorArtifactStore, type DeepMediaResolver,
  type VideoReconstructionExecutor, type CreatorSynthesisExecutor, type ResearchWorkflowDefinitions } from "../../../../research/index.js";
import { AnalysisPgContext } from "./analysis-pg-context.js";
import { PostgresCreatorResearchRepository } from "./postgres-creator-research-repository.js";
import { PostgresCreatorResearchBatchRepository } from "./postgres-creator-research-batch-repository.js";
import { PostgresCreatorArtifactStore } from "../artifacts/postgres-creator-artifact-store.js";
import { PostgresResearchExecutionPersistence, PostgresResearchWorkflowExecutor } from "../../workflow/postgres-research-workflow-executor.js";
import { PostgresResearchVersionRegistrationTransaction } from "../../workflow/postgres-research-version-transaction.js";

const url = process.env.ANALYSIS_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
let admin: Pool, pool: Pool, context: AnalysisPgContext, repository: PostgresCreatorResearchRepository;
let batches: PostgresCreatorResearchBatchRepository, artifacts: PostgresCreatorArtifactStore;
let schema: string, runtime: string;
const future = (ms: number): string => new Date(Date.now()+ms).toISOString();

suite("analysis PostgreSQL persistence", () => {
  beforeAll(async () => {
    schema = `analysis_test_${randomUUID().replaceAll("-","")}`;
    admin = new Pool({connectionString:url});
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({connectionString:url,options:`-c search_path=${schema}`,max:8});
    context = new AnalysisPgContext(pool);
    await context.migrate();
    await migratePostgresWorkflowStore(pool);
    repository = new PostgresCreatorResearchRepository(context);
    batches = new PostgresCreatorResearchBatchRepository(context);
    artifacts = new PostgresCreatorArtifactStore(context);
    await artifacts.migrate();
    runtime = await fs.mkdtemp(path.join(os.tmpdir(),"analysis-pg-"));
    process.env.SELF_MEDIA_RUNTIME_DIR = runtime;
  });
  afterAll(async () => {
    delete process.env.SELF_MEDIA_RUNTIME_DIR;
    await pool?.end();
    if (admin && schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
    if (runtime) await fs.rm(runtime,{recursive:true,force:true});
  });

  async function creator() {
    const service = new CreatorResearchService(repository,
      {} as CreatorArtifactStore,{} as DeepMediaResolver,{} as VideoReconstructionExecutor,
      {} as CreatorSynthesisExecutor,3);
    return service.create(`https://www.xiaohongshu.com/user/profile/${randomUUID()}`,"redfox");
  }

  it("claims a job once and rejects a canceled or expired worker mutation", async () => {
    const run = await creator();
    const now = future(0), lease = future(60_000);
    const [a,b] = await Promise.all([
      repository.claimNext("worker-a",now,lease,"redfox",run.id),
      repository.claimNext("worker-b",now,lease,"redfox",run.id)
    ]);
    const claimed = a ?? b;
    expect(claimed).not.toBeNull();
    expect([a,b].filter(Boolean)).toHaveLength(1);
    const workerId = claimed!.leaseOwner!;
    expect(await repository.heartbeat(claimed!.id,"other-worker",future(0),future(60_000))).toBe(false);
    await repository.runWithJobLease(claimed!.id,workerId,claimed!.attempts,async () => {
      const current = await repository.get(run.id);
      await repository.save(current!);
      expect(await repository.updateJobStatus({jobId:claimed!.id,status:"canceled",updatedAt:future(0)})).toBe(true);
      await expect(repository.save(current!)).rejects.toThrow("STALE_RESEARCH_LEASE");
    });
    await expect(repository.updateJobStatus({jobId:claimed!.id,status:"succeeded",updatedAt:future(0),
      expectedLeaseOwner:workerId,expectedAttempts:claimed!.attempts})).rejects.toThrow("STALE_RESEARCH_LEASE");
  });

  it("keeps imported pending jobs visible but frozen from new worker claims", async () => {
    const run = await creator();
    const jobs = await context.query<{ id:string; status:string }>(
      "SELECT id,status FROM analysis_research_jobs WHERE run_id=$1",[run.id]);
    expect(jobs.rows).toHaveLength(1);
    const sourceId = randomUUID();
    await context.query(`INSERT INTO analysis_import_receipts
      (source_id,workspace_id,imported_at,source_hint,manifest,state)
      VALUES ($1,'test',$2,'fixture','{}'::jsonb,'completed')`,[sourceId,future(0)]);
    await context.query("INSERT INTO analysis_imported_jobs(job_id,source_id) VALUES ($1,$2)",
      [jobs.rows[0]!.id,sourceId]);
    expect(await repository.claimNext("new-worker",future(0),future(60_000),"redfox",run.id)).toBeNull();
    const retained = await context.query<{ status:string }>(
      "SELECT status FROM analysis_research_jobs WHERE id=$1",[jobs.rows[0]!.id]);
    expect(retained.rows[0]!.status).toBe(jobs.rows[0]!.status);
  });

  it.each(["v10", "v11"])("claims Responses %s post control and excludes v8 creator control from synthesis capacity", async (revision) => {
    const postRun = await creator();
    const synthesisRun = await creator();
    const regularRun = await creator();
    const enqueue = async (runId:string,workflowId:string,workflowRevision:string) => repository.enqueue({
      id:randomUUID(),runId,nodeKey:"workflow.advance",status:"queued",
      idempotencyKey:`${runId}:${workflowId}:${randomUUID()}`,attempts:0,maxAttempts:2,
      availableAt:future(-1000),leaseOwner:null,leaseExpiresAt:null,heartbeatAt:null,lastError:null,
      payload:{workflowRunId:randomUUID(),workflowId,workflowRevision,generation:1},
      createdAt:future(-1000),updatedAt:future(-1000)
    });
    const post = await enqueue(postRun.id,"post.analyze",revision);
    const creatorControl = await enqueue(synthesisRun.id,"creator.synthesize","v8");
    const regular = await repository.enqueue({id:randomUUID(),runId:regularRun.id,
      nodeKey:"creator.synthesize",status:"queued",idempotencyKey:randomUUID(),attempts:0,maxAttempts:2,
      availableAt:future(-1000),leaseOwner:null,leaseExpiresAt:null,heartbeatAt:null,lastError:null,
      payload:{},createdAt:future(-1000),updatedAt:future(-1000)});
    process.env.SELF_MEDIA_SYNTHESIS_CONCURRENCY = "1";
    try {
      expect((await repository.claimNext(`post-${revision}`,future(0),future(60_000),"synthesis",postRun.id))?.id).toBe(post.id);
      expect((await repository.claimNext("creator-v8",future(0),future(60_000),"synthesis",synthesisRun.id))?.id)
        .toBe(creatorControl.id);
      // Both active controls leave the single ordinary synthesis slot available.
      expect((await repository.claimNext("regular",future(0),future(60_000),"synthesis",regularRun.id))?.id)
        .toBe(regular.id);
    } finally {
      delete process.env.SELF_MEDIA_SYNTHESIS_CONCURRENCY;
      await context.query("UPDATE analysis_research_jobs SET status='succeeded' WHERE id=ANY($1::text[])",
        [[post.id,creatorControl.id,regular.id]]);
    }
  });

  it("preserves batch idempotency and rolls back a failing intake callback", async () => {
    const batch = {schemaVersion:"creator-research-batch@1" as const,id:randomUUID(),name:"PG batch",
      runIds:[randomUUID()],createdAt:future(0)};
    await expect(batches.create(async () => { await creator(); throw new Error("intake interrupted"); },
      "rollback","hash")).rejects.toThrow("intake interrupted");
    expect(await batches.getByOperationKey("rollback","hash")).toBeNull();
    expect(await batches.create(batch,"same","hash")).toEqual(batch);
    expect(await batches.create(() => { throw new Error("factory must not rerun"); },"same","hash")).toEqual(batch);
    await expect(batches.create(batch,"same","different")).rejects.toThrow("idempotency conflict");
  });

  it("keeps report bytes in PG and rematerializes exact legacy-style references", async () => {
    const runId = randomUUID();
    const reference = await artifacts.write(runId,"report.json",{builderLenses:{contentRestoration:"正文"}});
    const target = path.join(runtime,"runs",runId,path.basename(reference));
    await fs.rm(target);
    expect(await artifacts.read(reference)).toEqual({builderLenses:{contentRestoration:"正文"}});
    expect(await artifacts.materialize(reference)).toBe(target);
    expect(JSON.parse(await fs.readFile(target,"utf8"))).toEqual({builderLenses:{contentRestoration:"正文"}});
    const original = await fs.readFile(target);
    await expect(artifacts.ingest(reference,path.join(runtime,"wrong.json"))).rejects.toThrow();
    expect(await fs.readFile(target)).toEqual(original);
  });

  it("serializes two short updates to the same creator row", async () => {
    const run = await creator();
    await Promise.all([
      repository.withRunTransaction(run.id,async () => {
        const current = await repository.get(run.id);
        await new Promise((resolve) => setTimeout(resolve,20));
        await repository.save({...current!,nextAction:"first"});
      }),
      repository.withRunTransaction(run.id,async () => {
        const current = await repository.get(run.id);
        await repository.save({...current!,creatorName:"second"});
      })
    ]);
    expect(await repository.get(run.id)).toMatchObject({nextAction:"first",creatorName:"second"});
  });

  it("ingests new attempt media and accepts only its registered cache link", async () => {
    const runId = randomUUID();
    const attemptsRoot = path.join(runtime,"runs");
    const attempt = path.join("workflow-responses","attempt-1");
    const frame = path.join(attemptsRoot,runId,attempt,"frame.jpg");
    await fs.mkdir(path.dirname(frame),{recursive:true});
    await fs.writeFile(frame,Buffer.from("new frame"));
    process.env.SELF_MEDIA_MANAGED_MEDIA_DIR = path.join(runtime,"managed");
    try {
      expect((await artifacts.ingestRun(runId,attemptsRoot,attempt)).ingestedMedia).toBe(1);
      const reference = `/artifacts/${runId}/${attempt}/frame.jpg`;
      expect(await artifacts.verifyManagedMedia(reference)).toBe(true);
      await artifacts.materializeMediaAll();
      expect((await fs.lstat(frame)).isSymbolicLink()).toBe(true);
      expect(await artifacts.verifyManagedMediaLink(reference,frame)).toBe(true);
      expect(await artifacts.verifyManagedMediaLink(reference,path.join(path.dirname(frame),"other.jpg"))).toBe(false);
      expect(await artifacts.verifyManagedMediaLink(`/artifacts/${runId}/${attempt}/unknown.jpg`,frame)).toBe(false);
      expect((await artifacts.ingestRun(runId,attemptsRoot,attempt)).ingestedMedia).toBe(0);
    } finally { delete process.env.SELF_MEDIA_MANAGED_MEDIA_DIR; }
  });

  it("does not let a terminal cancellation get overwritten by a stale execution patch", async () => {
    const run = await creator();
    const persistence = new PostgresResearchExecutionPersistence(context);
    const record = {id:randomUUID(),creatorRunId:run.id,kind:"post" as const,definitionRevision:"v1",
      generation:1,state:"running" as const,frozenInput:{},workflowId:"post.build"};
    await persistence.insert(record);
    expect((await persistence.patch(record,{state:"cancel_requested"})).state).toBe("cancel_requested");
    expect((await persistence.patch(record,{state:"succeeded"})).state).toBe("cancel_requested");
  });

  it("creates only one durable automatic root for concurrent post and synthesis replays", async () => {
    const run = await creator();
    const store = new PostgresWorkflowRunStore(pool,{workspaceId:`analysis-test-${randomUUID()}`});
    const definitions = {
      post: workflow("post.analyze",{revision:"v10"},async () => ({ok:false,state:"blocked",details:null})),
      creatorSynthesis: workflow("creator.synthesize",{revision:"v8"},async () => ({ok:false,state:"blocked",details:null}))
    } as ResearchWorkflowDefinitions;
    const evidence = {id:"frozen",revision:"1",sha256:"a".repeat(64),type:"evidence",
      schemaVersion:"1",uri:"test://frozen",producedBy:{workflowRunId:"seed",stepRunId:"seed",attemptId:"seed"},
      dependsOn:[],validation:"valid",review:"not_applicable"} as ArtifactRef;
    const executor = new PostgresResearchWorkflowExecutor(context,store,{run:async () => {throw new Error("no model calls");}},
      definitions,{post:async (input) => ({creatorRunId:input.creatorRunId,postExternalId:input.postExternalId,
        evidenceKind:"video",evidence}),creator:async (input) => ({creatorRunId:input.creatorRunId,frozenInputs:evidence}),
      analysis:async (input) => ({creatorRunId:input.creatorRunId,source:evidence,posts:[]})});
    const postInput = {creatorRunId:run.id,postExternalId:"post-1",sourceUrl:"https://example.test/post-1",
      sourceMediaArtifactRef:"media-1",detailArtifactRef:"details",mediaManifestArtifactRef:"manifest",
      selectionArtifactRef:"selection",reconstructionBatchArtifactRef:"batch"};
    const key = `auto-post-${randomUUID()}`;
    const [first,second] = await Promise.all([
      executor.ensureAutomaticPost(postInput,key,"2026-10-10T00:00:00.000Z"),
      executor.ensureAutomaticPost(postInput,key,"2026-10-10T00:00:00.000Z")
    ]);
    expect(second.workflowRunId).toBe(first.workflowRunId);
    expect(first.automatic).toMatchObject({operationKey:key,sourceItemUpdatedAt:"2026-10-10T00:00:00.000Z"});
    const synthesisInput = {creatorRunId:run.id,portfolioArtifactRef:"portfolio",
      portfolioAnnotationsArtifactRef:"annotations",selectionArtifactRef:"selection",detailArtifactRef:"details",
      reconstructionBatchArtifactRef:"batch"};
    const synthesisKey = `auto-synthesis-${randomUUID()}`;
    const [one,two] = await Promise.all([
      executor.ensureAutomaticSynthesis(synthesisInput,synthesisKey,"source-job-1"),
      executor.ensureAutomaticSynthesis(synthesisInput,synthesisKey,"source-job-1")
    ]);
    expect(two.workflowRunId).toBe(one.workflowRunId);
    expect(one.automatic).toMatchObject({operationKey:synthesisKey,sourceBatchArtifactRef:"batch",sourceJobId:"source-job-1"});
    const roots = await context.query<{id:string}>("SELECT id FROM analysis_workflow_executions WHERE creator_run_id=$1",[run.id]);
    expect(roots.rows.map((row) => row.id).sort()).toEqual([first.workflowRunId,one.workflowRunId].sort());
  });

  it("rolls a version pointer update back with its exact creator row lock", async () => {
    const run = await creator();
    const transaction = new PostgresResearchVersionRegistrationTransaction(context);
    await expect(transaction.run(run.id,async () => {
      const current = await repository.get(run.id);
      await repository.save({...current!, nextAction:"uncommitted"});
      throw new Error("registration failed");
    })).rejects.toThrow("registration failed");
    expect((await repository.get(run.id))?.nextAction).not.toBe("uncommitted");
  });
});
