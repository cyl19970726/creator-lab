import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { migratePostgresWorkflowStore } from "@signal-room/workflow-postgres";
import { AnalysisPgContext } from "./analysis-pg-context.js";

export type AnalysisPgTestDatabase = {
  context: AnalysisPgContext;
  close(): Promise<void>;
  reset(): Promise<void>;
};

/** Creates a disposable schema inside the explicitly configured test database. */
export async function createAnalysisPgTestDatabase(options: { workflowStore?: boolean } = {}): Promise<AnalysisPgTestDatabase> {
  const url = process.env.ANALYSIS_TEST_DATABASE_URL;
  if (!url) throw new Error("ANALYSIS_TEST_DATABASE_URL is required for PostgreSQL integration tests");
  const admin = new Pool({ connectionString: url });
  const schema = `analysis_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 12 });
  const context = new AnalysisPgContext(pool);
  try {
    await context.migrate();
    if (options.workflowStore) await migratePostgresWorkflowStore(pool);
  } catch (error) {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
    throw error;
  }
  return {
    context,
    async reset() {
      await context.query(`TRUNCATE analysis_creator_batch_items, analysis_creator_batches,
        analysis_research_events, analysis_research_jobs, analysis_creator_runs,
        analysis_imported_jobs, analysis_import_receipts RESTART IDENTITY CASCADE`);
      if (options.workflowStore) {
        await context.query(`TRUNCATE workflow_artifacts, workflow_events, workflow_attempts,
          workflow_steps, workflow_runs RESTART IDENTITY CASCADE`);
      }
    },
    async close() {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  };
}
