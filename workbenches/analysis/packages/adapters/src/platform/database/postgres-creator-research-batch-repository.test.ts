import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CreatorResearchBatch } from "../../../../contracts/index.js";
import { CreatorResearchBatchService, CreatorResearchService, type CreatorArtifactStore,
  type DeepMediaResolver, type VideoReconstructionExecutor, type CreatorSynthesisExecutor } from "../../../../research/index.js";
import { PostgresCreatorResearchRepository } from "./postgres-creator-research-repository.js";
import { PostgresCreatorResearchBatchRepository } from "./postgres-creator-research-batch-repository.js";
import { createAnalysisPgTestDatabase, type AnalysisPgTestDatabase } from "./postgres-test-database.js";

let pgDatabase: AnalysisPgTestDatabase;
let runs: PostgresCreatorResearchRepository;
let batches: PostgresCreatorResearchBatchRepository;
const databaseUrl = process.env.ANALYSIS_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

function batch(overrides: Partial<CreatorResearchBatch> = {}): CreatorResearchBatch {
  return {
    schemaVersion: "creator-research-batch@1",
    id: randomUUID(),
    name: "20 位博主分析",
    runIds: [randomUUID(), randomUUID(), randomUUID()],
    createdAt: "2026-08-31T00:00:00.000Z",
    ...overrides
  };
}

suite("PostgresCreatorResearchBatchRepository", () => {
  beforeAll(async () => { pgDatabase = await createAnalysisPgTestDatabase(); });
  beforeEach(async () => {
    await pgDatabase.reset();
    runs = new PostgresCreatorResearchRepository(pgDatabase.context);
    batches = new PostgresCreatorResearchBatchRepository(pgDatabase.context);
  });
  afterAll(async () => { await pgDatabase.close(); });

  it("does not invoke intake again when concurrent callers submit the same operation", async () => {
    const original = batch();
    let calls = 0;
    const [first, second] = await Promise.all([
      batches.create(original, "race", "hash"),
      batches.create(async () => { calls++; return batch(); }, "race", "hash")
    ]);
    expect(first).toEqual(original);
    expect(second).toEqual(original);
    expect(calls).toBe(0);
  });

  it("rolls intake writes back with a failed batch and permits the same operation to retry", async () => {
    const intake = new CreatorResearchService(runs, {} as CreatorArtifactStore, {} as DeepMediaResolver,
      {} as VideoReconstructionExecutor, {} as CreatorSynthesisExecutor, 3);
    await expect(batches.create(async () => {
      await intake.create("https://www.xiaohongshu.com/user/profile/rollback", "redfox");
      throw new Error("intake interrupted");
    }, "retry", "hash")).rejects.toThrow("intake interrupted");
    expect(await batches.getByOperationKey("retry", "hash")).toBeNull();
    expect(await runs.list()).toEqual([]);
    expect(await pgDatabase.context.query("SELECT * FROM analysis_research_jobs")).toMatchObject({ rows: [] });
    expect(await pgDatabase.context.query("SELECT * FROM analysis_research_events")).toMatchObject({ rows: [] });
    const expected = batch();
    expect(await batches.create(() => expected, "retry", "hash")).toEqual(expected);
    await intake.close();
  });

  it("rolls back run, queue, event, and batch records if a later creator intake fails", async () => {
    const intake = new CreatorResearchService(runs, {} as CreatorArtifactStore, {} as DeepMediaResolver,
      {} as VideoReconstructionExecutor, {} as CreatorSynthesisExecutor, 3);
    let interrupted = true;
    const service = new CreatorResearchBatchService(batches, { create: async (url, adapter) => {
      if (interrupted && url.endsWith("second")) throw new Error("second intake failed");
      return intake.create(url, adapter);
    } }, runs);
    const input = { operationKey: "real-rollback", name: "隔离回归", creators: ["first", "second"].map(id => ({
      profileUrl: `https://www.xiaohongshu.com/user/profile/${id}`
    })) };
    await expect(service.create(input)).rejects.toThrow("second intake failed");
    expect(await runs.list()).toEqual([]);
    expect((await pgDatabase.context.query("SELECT * FROM analysis_research_jobs")).rows).toEqual([]);
    expect((await pgDatabase.context.query("SELECT * FROM analysis_research_events")).rows).toEqual([]);
    expect(await batches.list()).toEqual([]);
    interrupted = false;
    const result = await service.create(input);
    expect(result.totalRuns).toBe(2);
    expect((await service.create(input)).batch.id).toBe(result.batch.id);
    expect(await runs.list()).toHaveLength(2);
    await intake.close();
  });

  it("persists batches and stable item order across repository instances", async () => {
    const expected = batch();
    await batches.create(expected, "operation:create:one", "hash-one");
    const reopened = new PostgresCreatorResearchBatchRepository(pgDatabase.context);
    expect(await reopened.get(expected.id)).toEqual(expected);
    expect(await reopened.list()).toEqual([expected]);
    expect(await reopened.getByOperationKey("operation:create:one", "hash-one")).toEqual(expected);
  });

  it("returns the original batch for an identical operation without duplicating items", async () => {
    const original = batch();
    const duplicatePayload = batch({ name: "不会覆盖已有结果" });
    expect(await batches.create(original, "operation:idempotent", "same-hash")).toEqual(original);
    expect(await batches.create(duplicatePayload, "operation:idempotent", "same-hash")).toEqual(original);
    expect(await batches.list()).toHaveLength(1);
    expect((await batches.get(original.id))?.runIds).toEqual(original.runIds);
  });

  it("rejects reuse of an operation key for another command", async () => {
    await batches.create(batch(), "operation:conflict", "first-hash");
    await expect(batches.getByOperationKey("operation:conflict", "other-hash"))
      .rejects.toThrow("idempotency conflict for operation operation:conflict");
    await expect(batches.create(batch(), "operation:conflict", "other-hash"))
      .rejects.toThrow("idempotency conflict for operation operation:conflict");
  });

  it("lists newest batches first while preserving each batch's submitted order", async () => {
    const older = batch({ createdAt: "2026-08-30T00:00:00.000Z" });
    const newer = batch({ createdAt: "2026-08-31T00:00:00.000Z" });
    await batches.create(older, "operation:older", "older-hash");
    await batches.create(newer, "operation:newer", "newer-hash");
    expect(await batches.list(1)).toEqual([newer]);
    expect((await batches.get(older.id))?.runIds).toEqual(older.runIds);
  });
});
