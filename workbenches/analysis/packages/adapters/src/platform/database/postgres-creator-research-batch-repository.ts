import { creatorResearchBatchSchema, type CreatorResearchBatch } from "../../../../contracts/index.js";
import type { CreatorResearchBatchRepository } from "../../../../research/index.js";
import { AnalysisPgContext } from "./analysis-pg-context.js";

type BatchRow = { id: string; schema_version: string; name: string; created_at: string; operation_key: string; command_hash: string };

export class PostgresCreatorResearchBatchRepository implements CreatorResearchBatchRepository {
  constructor(private readonly context: AnalysisPgContext) {}

  async create(batch: CreatorResearchBatch | (() => CreatorResearchBatch | Promise<CreatorResearchBatch>),
    operationKey: string, commandHash: string): Promise<CreatorResearchBatch> {
    return this.context.transaction(async () => {
      await this.context.assertLease();
      await this.context.query("SELECT pg_advisory_xact_lock(4832941, hashtext($1))", [operationKey]);
      const existing = await this.operation(operationKey, true);
      if (existing) {
        if (existing.command_hash !== commandHash) throw new Error(`idempotency conflict for operation ${operationKey}`);
        return this.read(existing);
      }
      const parsed = creatorResearchBatchSchema.parse(typeof batch === "function" ? await batch() : batch);
      await this.context.query(`INSERT INTO analysis_creator_batches
        (id,schema_version,name,created_at,operation_key,command_hash) VALUES ($1,$2,$3,$4,$5,$6)`,
      [parsed.id, parsed.schemaVersion, parsed.name, parsed.createdAt, operationKey, commandHash]);
      for (let position = 0; position < parsed.runIds.length; position++) {
        await this.context.query("INSERT INTO analysis_creator_batch_items(batch_id,position,run_id) VALUES ($1,$2,$3)",
          [parsed.id, position, parsed.runIds[position]]);
      }
      return parsed;
    });
  }

  async getByOperationKey(operationKey: string, commandHash: string): Promise<CreatorResearchBatch | null> {
    const row = await this.operation(operationKey);
    if (!row) return null;
    if (row.command_hash !== commandHash) throw new Error(`idempotency conflict for operation ${operationKey}`);
    return this.read(row);
  }

  async get(id: string): Promise<CreatorResearchBatch | null> {
    const result = await this.context.query<BatchRow>("SELECT * FROM analysis_creator_batches WHERE id=$1", [id]);
    return result.rows[0] ? this.read(result.rows[0]) : null;
  }

  async list(limit = 50): Promise<CreatorResearchBatch[]> {
    const bounded = Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.trunc(limit))) : 50;
    const result = await this.context.query<BatchRow>(
      "SELECT * FROM analysis_creator_batches ORDER BY created_at DESC,id DESC LIMIT $1", [bounded]);
    return Promise.all(result.rows.map((row) => this.read(row)));
  }

  close(): void { /* The composition root owns the shared pool. */ }

  private async operation(operationKey: string, lock = false): Promise<BatchRow | null> {
    const result = await this.context.query<BatchRow>(
      `SELECT * FROM analysis_creator_batches WHERE operation_key=$1${lock ? " FOR UPDATE" : ""}`, [operationKey]);
    return result.rows[0] ?? null;
  }

  private async read(row: BatchRow): Promise<CreatorResearchBatch> {
    const result = await this.context.query<{ run_id: string }>(
      "SELECT run_id FROM analysis_creator_batch_items WHERE batch_id=$1 ORDER BY position", [row.id]);
    return creatorResearchBatchSchema.parse({ schemaVersion: row.schema_version, id: row.id,
      name: row.name, runIds: result.rows.map((item) => item.run_id), createdAt: row.created_at });
  }
}
