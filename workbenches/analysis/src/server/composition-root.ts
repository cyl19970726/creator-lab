import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresWorkflowRunStore, migratePostgresWorkflowStore } from "@signal-room/workflow-postgres";
import type { AgentRunner } from "@signal-room/workflow";
import { AnalysisPgContext } from "../../packages/adapters/src/platform/database/analysis-pg-context.js";
import { PostgresCreatorResearchRepository } from "../../packages/adapters/src/platform/database/postgres-creator-research-repository.js";
import { PostgresCreatorResearchBatchRepository } from "../../packages/adapters/src/platform/database/postgres-creator-research-batch-repository.js";
import { PostgresCreatorArtifactStore } from "../../packages/adapters/src/platform/artifacts/postgres-creator-artifact-store.js";
import { PostgresResearchWorkflowExecutor } from "../../packages/adapters/src/workflow/postgres-research-workflow-executor.js";
import { PostgresResearchVersionRegistrationTransaction } from "../../packages/adapters/src/workflow/postgres-research-version-transaction.js";
import { ResponsesResearchRunner } from "../../packages/adapters/src/workflow/responses-research-runner.js";
import { withAttemptPersistence } from "../../packages/adapters/src/workflow/persist-agent-attempt.js";
import { ResponsesImagePostReconstructionExecutor } from "../../packages/adapters/src/workflow/responses-image-post-reconstruction-executor.js";
import { ResponsesPipelineVideoReconstructionExecutor, ResponsesPipelineCreatorSynthesisExecutor } from "../../packages/adapters/src/workflow/responses-pipeline-executors.js";
import { CreatorResearchBatchService, CreatorResearchService, CreatorResearchWorker, type DeepMediaResolver } from "../../packages/research/index.js";
import {
  createProductionResearchWorkflow,
  creatorWorkerConcurrency,
  videoConcurrency,
  EgoBrowserCreatorExecutor,
  RedFoxCreatorExecutor,
  CreatorProviderRouter,
  runtimeDir,
  LocalDeepMediaResolver,
} from "../../packages/adapters/index.js";
import { LocalEvidenceAccess } from "../../packages/adapters/index.js";
import { RedFoxCreatorDiscoveryService } from "../../packages/adapters/index.js";
import { createApp } from "./app.js";
import type { WorkflowHttpService } from "./routes/workflow-runs.js";
import { ManagedRuntime, type ManagedResource, type ManagedWorker } from "../../packages/runtime/index.js";
import { loadWorkflowArtifactReader } from "./workflow-artifact-reader.js";

export interface SignalRoomServices {
  workflows: WorkflowHttpService;
  creatorResearch: CreatorResearchService;
  creatorResearchBatches: CreatorResearchBatchService;
  creatorDiscovery: RedFoxCreatorDiscoveryService;
  evidence: LocalEvidenceAccess;
}

export class SignalRoomComposition {
  readonly app;
  private readonly runtime;

  constructor(
    readonly services: SignalRoomServices,
    workers: ManagedWorker[],
    resources: ManagedResource[]
  ) {
    this.app = createApp(services);
    this.runtime = new ManagedRuntime(workers, resources);
  }

  startWorkers(): void {
    if (process.env.SELF_MEDIA_READ_ONLY !== "true") this.runtime.startWorkers();
  }

  close(): Promise<void> { return this.runtime.close(); }
}

export async function createSignalRoomComposition(): Promise<SignalRoomComposition> {
  if (process.env.SELF_MEDIA_STORAGE && process.env.SELF_MEDIA_STORAGE !== "postgres") {
    throw new Error("The SQLite execution backend has been retired; configure SELF_MEDIA_DATABASE_URL for PostgreSQL");
  }
  const connectionString = process.env.SELF_MEDIA_DATABASE_URL;
  if (!connectionString) throw new Error("SELF_MEDIA_DATABASE_URL is required for the PostgreSQL analysis workspace");
  const pool = new Pool({ connectionString, max: 12, connectionTimeoutMillis: 5000 });
  const context = new AnalysisPgContext(pool);
  try {
  await migratePostgresWorkflowStore(pool);
  await context.migrate();
  const artifacts = new PostgresCreatorArtifactStore(context);
  await artifacts.migrate();
  await artifacts.materializeAll();
  await artifacts.materializeMediaAll();
  const creatorResearchRepository = new PostgresCreatorResearchRepository(context);
  const creatorResearchBatchRepository = new PostgresCreatorResearchBatchRepository(context);
  const workflowStore = new PostgresWorkflowRunStore(pool, { workspaceId: process.env.SELF_MEDIA_WORKSPACE_ID ?? "creator-lab-analysis" });
  const responses = new ResponsesResearchRunner(workflowStore, artifacts);
  const runner: AgentRunner = withAttemptPersistence(responses, async (request) => {
    const source = (request.input as { creatorRunId?: string }).creatorRunId;
    const run = await workflowStore.getRun(request.runId);
    const creatorRunId = source ?? (run?.metadata?.creatorRunId as string | undefined);
    if (creatorRunId) {
      const relativeDirectory = path.join("workflow-responses", request.runId, request.attemptId);
      // Dispatch and frozen-input failures can happen before an attempt creates files.
      if (fs.existsSync(path.join(runtimeDir(), "runs", creatorRunId, relativeDirectory))) {
        await artifacts.ingestRun(creatorRunId, path.join(runtimeDir(), "runs"), relativeDirectory);
      }
    }
  });
  const researchWorkflow = createProductionResearchWorkflow(workflowStore, artifacts, creatorResearchRepository,
    { runner,
      registrationTransaction: new PostgresResearchVersionRegistrationTransaction(context),
      executorFactory: (store, agentRunner, definitions, freezer, registry, scheduler) =>
        new PostgresResearchWorkflowExecutor(context, store, agentRunner, definitions, freezer, registry, scheduler) });
  const mediaResolver: DeepMediaResolver = {
    async resolve(input) {
      const relativeRoot = `deep-media/${randomUUID()}`;
      const manifest = await new LocalDeepMediaResolver(relativeRoot).resolve(input);
      await artifacts.ingestRun(input.runId, path.join(runtimeDir(), "runs"), relativeRoot);
      return manifest;
    }
  };
  const persistArtifacts = async (creatorRunId: string, relativeDirectory: string) => {
      await artifacts.ingestRun(creatorRunId, path.join(runtimeDir(), "runs"), relativeDirectory);
    };
  const creatorResearch = new CreatorResearchService(
    creatorResearchRepository,
    artifacts,
    mediaResolver,
    new ResponsesPipelineVideoReconstructionExecutor(workflowStore, artifacts, creatorResearchRepository,
      { builderRunner: runner, persistArtifacts }),
    new ResponsesPipelineCreatorSynthesisExecutor(workflowStore, artifacts, creatorResearchRepository,
      { builderRunner: runner, persistArtifacts }),
    videoConcurrency(),
    undefined,
    new ResponsesImagePostReconstructionExecutor(artifacts, {
      model: process.env.SELF_MEDIA_IMAGE_POST_MODEL ?? process.env.SELF_MEDIA_BUILDER_MODEL ?? "gpt-6-luna",
      reasoningEffort: process.env.SELF_MEDIA_IMAGE_POST_REASONING_EFFORT ?? "medium"
    }),
    researchWorkflow,
    true
  );
  if (process.env.SELF_MEDIA_READ_ONLY !== "true") await creatorResearch.initialize();
  const workflows: WorkflowHttpService = {
    store: workflowStore,
    registeredReview: async (creatorRunId) => {
      const review = (await creatorResearch.get(creatorRunId))?.researchReview;
      return review ? { reviewStatus: review.reviewStatus, candidateStatus: review.candidateStatus } : null;
    },
    registeredPostReviews: async (creatorRunId) => {
      const items = (await creatorResearch.portfolio(creatorRunId))?.reconstructionBatch?.items ?? [];
      return (postId: string) => {
        const review = items.find((item) => item.postExternalId === postId)?.researchReview;
        return review ? { reviewStatus: review.reviewStatus, candidateStatus: review.candidateStatus } : null;
      };
    },
    artifactPayload: (id) => workflowStore.getArtifactPayload(id),
    artifactReader: (runId, artifactId) => loadWorkflowArtifactReader(workflowStore,
      (id) => workflowStore.getArtifactPayload(id), creatorResearch, runId, artifactId),
    retry: (creatorRunId, workflowRunId, stepKey) => creatorResearch.retryWorkflowStep(creatorRunId, workflowRunId, stepKey),
    cancel: (creatorRunId, workflowRunId) => creatorResearch.cancelWorkflow(creatorRunId, workflowRunId),
    startPost: (creatorRunId, input) => {
      if (!input || typeof input !== "object" || !("postExternalId" in input) || typeof input.postExternalId !== "string") {
        throw new Error("请指定研究样本 postExternalId");
      }
      const evaluationMode = "evaluationMode" in input ? input.evaluationMode : undefined;
      if (evaluationMode !== undefined && evaluationMode !== "fresh" && evaluationMode !== "repair_existing_invalid") {
        throw new Error("evaluationMode 必须是 fresh 或 repair_existing_invalid");
      }
      const importedEvaluationArtifactRef = "importedEvaluationArtifactRef" in input ? input.importedEvaluationArtifactRef : undefined;
      if (importedEvaluationArtifactRef !== undefined && typeof importedEvaluationArtifactRef !== "string") {
        throw new Error("importedEvaluationArtifactRef 必须是 artifact reference 字符串");
      }
      if (importedEvaluationArtifactRef && evaluationMode !== "repair_existing_invalid") {
        throw new Error("importedEvaluationArtifactRef 仅能与 repair_existing_invalid 一起使用");
      }
      const candidateMode = "candidateMode" in input ? input.candidateMode : undefined;
      if (candidateMode !== undefined && candidateMode !== "rebuild" && candidateMode !== "reuse") {
        throw new Error("candidateMode 必须是 rebuild 或 reuse");
      }
      return creatorResearch.startPostWorkflow(creatorRunId, input.postExternalId, { evaluationMode, importedEvaluationArtifactRef, candidateMode });
    },
    startCreatorAnalysis: (creatorRunId, input) => {
      if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) {
        throw new Error("creator-analyze 请求体必须是对象");
      }
      const options = (input ?? {}) as Record<string, unknown>;
      const candidateMode = options.candidateMode;
      if (candidateMode !== undefined && candidateMode !== "rebuild" && candidateMode !== "reuse") {
        throw new Error("candidateMode 必须是 rebuild 或 reuse");
      }
      const scope = options.scope;
      if (scope !== undefined && scope !== "selected" && scope !== "available_deep") {
        throw new Error("scope 必须是 selected 或 available_deep");
      }
      return creatorResearch.startCreatorAnalysisWorkflow(creatorRunId, { candidateMode, scope });
    },
    startSynthesis: (creatorRunId, input) => {
      const options = (input ?? {}) as Record<string, unknown>;
      const candidateMode = options.candidateMode;
      const reuseCandidateArtifactId = options.reuseCandidateArtifactId;
      if (candidateMode !== undefined && candidateMode !== "rebuild" && candidateMode !== "reuse") {
        throw new Error("candidateMode 必须是 rebuild 或 reuse");
      }
      if (candidateMode === "reuse" && (typeof reuseCandidateArtifactId !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(reuseCandidateArtifactId))) {
        throw new Error("reuseCandidateArtifactId 必须是已登记的候选 ID");
      }
      if (candidateMode !== "reuse" && reuseCandidateArtifactId !== undefined) {
        throw new Error("reuseCandidateArtifactId 仅能与 candidateMode=reuse 一起使用");
      }
      return creatorResearch.startCreatorSynthesisWorkflow(creatorRunId, {
        ...(candidateMode ? { candidateMode } : {}),
        ...(typeof reuseCandidateArtifactId === "string" ? { reuseCandidateArtifactId } : {}) });
    }
  };
  const creatorResearchBatches = new CreatorResearchBatchService(
    creatorResearchBatchRepository,
    creatorResearch,
    creatorResearch
  );
  const creatorDiscovery = new RedFoxCreatorDiscoveryService();
  const evidence = new LocalEvidenceAccess();
  const creatorExecutor = new CreatorProviderRouter({
    "ego-browser": new EgoBrowserCreatorExecutor(),
    redfox: new RedFoxCreatorExecutor()
  });
  const workers: ManagedWorker[] = [
    new CreatorResearchWorker(creatorResearch, creatorExecutor, undefined, creatorWorkerConcurrency())
  ];


  return new SignalRoomComposition(
    { workflows, creatorResearch, creatorResearchBatches, creatorDiscovery, evidence },
    workers,
    [{ close: () => pool.end() }, creatorResearch, creatorResearchBatchRepository]
  );
  } catch (error) {
    await pool.end();
    throw error;
  }
}
