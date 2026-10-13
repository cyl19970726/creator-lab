import type { ResearchVersionRegistrationTransaction } from "../../../research/index.js";
import { AnalysisPgContext } from "../platform/database/analysis-pg-context.js";

/** Locks the creator pointer and shares one PG client with repository get/save. */
export class PostgresResearchVersionRegistrationTransaction implements ResearchVersionRegistrationTransaction {
  constructor(private readonly context: AnalysisPgContext) {}

  run<T>(creatorRunId: string, operation: () => T | Promise<T>): Promise<T> {
    return this.context.transaction(async () => {
      await this.context.assertLease(undefined,creatorRunId);
      const row = await this.context.query<{ id: string }>(
        "SELECT id FROM analysis_creator_runs WHERE id=$1 FOR UPDATE", [creatorRunId]);
      if (!row.rows[0]) throw new Error(`Creator run not found: ${creatorRunId}`);
      return operation();
    });
  }
}
