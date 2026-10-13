import type { AgentRunner, RunStore } from "@signal-room/workflow";
import type { ResearchWorkflowDefinitions } from "../../../research/index.js";
import { AnalysisPgContext } from "../platform/database/analysis-pg-context.js";
import { ResearchWorkflowExecutorBase, type ExecutionRecord, type ResearchExecutionPersistence,
  type ResearchWorkflowInputFreezer, type WorkflowAdvanceScheduler, type WorkflowDefinitionRegistry } from "./research-workflow-executor.js";

type Row = { document: ExecutionRecord };

export class PostgresResearchExecutionPersistence implements ResearchExecutionPersistence {
  constructor(private readonly context: AnalysisPgContext) {}

  async insert(record: ExecutionRecord): Promise<void> {
    await this.context.transaction(async () => {
      await this.context.assertLease(undefined,record.creatorRunId);
      await this.context.query(`INSERT INTO analysis_workflow_executions
        (id,creator_run_id,parent_workflow_run_id,parent_step_run_id,document)
        VALUES ($1,$2,$3,$4,$5::jsonb)`, [record.id,record.creatorRunId,
        record.parentWorkflowRunId ?? null,record.parentStepRunId ?? null,JSON.stringify(record)]);
    });
  }

  async read(id: string): Promise<ExecutionRecord | undefined> {
    const result = await this.context.query<Row>("SELECT document FROM analysis_workflow_executions WHERE id=$1",[id]);
    return result.rows[0]?.document;
  }

  async patch(record: ExecutionRecord, patch: Partial<ExecutionRecord>): Promise<ExecutionRecord> {
    return this.context.transaction(async () => {
      await this.context.assertLease(undefined,record.creatorRunId);
      const result = await this.context.query<Row>(
        "SELECT document FROM analysis_workflow_executions WHERE id=$1 FOR UPDATE",[record.id]);
      const current = result.rows[0]?.document;
      if (!current) throw new Error("Research workflow execution not found");
      if (current.generation !== record.generation) throw new Error("Stale workflow generation");
      if (["cancel_requested","canceled"].includes(current.state)
        && patch.state !== "cancel_requested" && patch.state !== "canceled") return current;
      const updated = { ...current,...patch };
      for (const [key,value] of Object.entries(updated)) if (value === undefined) delete (updated as Record<string,unknown>)[key];
      await this.context.query("UPDATE analysis_workflow_executions SET document=$2::jsonb WHERE id=$1",
        [record.id,JSON.stringify(updated)]);
      return updated;
    });
  }

  async children(parentRunId: string): Promise<ExecutionRecord[]> {
    const result = await this.context.query<Row>(
      "SELECT document FROM analysis_workflow_executions WHERE parent_workflow_run_id=$1 ORDER BY id",[parentRunId]);
    return result.rows.map((row) => row.document);
  }

  async byParentStep(parentStepRunId: string): Promise<ExecutionRecord | undefined> {
    const result = await this.context.query<Row>(
      "SELECT document FROM analysis_workflow_executions WHERE parent_step_run_id=$1 LIMIT 1",[parentStepRunId]);
    return result.rows[0]?.document;
  }

  async byRetryLink(parentRunId: string, workflowId: string, key: string, attempt: 1 | 2): Promise<ExecutionRecord[]> {
    const result = await this.context.query<Row>(`SELECT document FROM analysis_workflow_executions
      WHERE parent_workflow_run_id=$1 AND document->>'workflowId'=$2
        AND document #>> '{retryLink,key}'=$3 AND (document #>> '{retryLink,attempt}')::integer=$4`,
      [parentRunId,workflowId,key,attempt]);
    return result.rows.map((row) => row.document);
  }

  async byAutomaticKey(key: string): Promise<ExecutionRecord | undefined> {
    const result = await this.context.query<Row>(
      "SELECT document FROM analysis_workflow_executions WHERE document #>> '{automatic,operationKey}'=$1 LIMIT 1",[key]);
    return result.rows[0]?.document;
  }

  async withAutomaticKey<T>(key: string, operation: () => Promise<T>): Promise<T> {
    return this.context.transaction(async () => {
      await this.context.query("SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",["analysis-auto-workflow",key]);
      return operation();
    });
  }
}

/** Persists analysis workflow execution records in PostgreSQL. */
export class PostgresResearchWorkflowExecutor extends ResearchWorkflowExecutorBase {
  constructor(context: AnalysisPgContext, store: RunStore, runner: AgentRunner,
    definitions: ResearchWorkflowDefinitions, inputFreezer: ResearchWorkflowInputFreezer,
    registry?: WorkflowDefinitionRegistry, scheduler?: WorkflowAdvanceScheduler) {
    super(new PostgresResearchExecutionPersistence(context),store,runner,definitions,inputFreezer,registry,scheduler);
  }
}
