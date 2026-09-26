import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CreatorResearchBatchService, CreatorResearchService, CreatorResearchWorker } from "../../packages/research/index.js";
import {
  SQLiteWorkflowRunStore,
  createProductionResearchWorkflow,
  databasePath,
  creatorWorkerConcurrency,
  videoConcurrency,
  EgoBrowserCreatorExecutor,
  RedFoxCreatorExecutor,
  CreatorProviderRouter,
  SQLiteCreatorResearchRepository,
  SQLiteCreatorResearchBatchRepository,
  LocalCreatorArtifactStore,
  LocalDeepMediaResolver,
  CodexVideoReconstructionExecutor,
  CodexImagePostReconstructionExecutor,
  CodexCreatorSynthesisExecutor
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

export function createSignalRoomComposition(): SignalRoomComposition {
  const artifacts = new LocalCreatorArtifactStore();
  const researchDatabasePath = databasePath();
  fs.mkdirSync(path.dirname(researchDatabasePath), { recursive: true });
  const creatorDatabase = new DatabaseSync(researchDatabasePath);
  const creatorResearchRepository = new SQLiteCreatorResearchRepository(creatorDatabase);
  const workflowStore = new SQLiteWorkflowRunStore(creatorDatabase);
  const researchWorkflow = createProductionResearchWorkflow(creatorDatabase, workflowStore, artifacts, creatorResearchRepository);
  const creatorResearch = new CreatorResearchService(
    creatorResearchRepository,
    artifacts,
    new LocalDeepMediaResolver(),
    new CodexVideoReconstructionExecutor(),
    new CodexCreatorSynthesisExecutor(artifacts),
    videoConcurrency(),
    undefined,
    new CodexImagePostReconstructionExecutor(artifacts),
    researchWorkflow
  );
  const workflows: WorkflowHttpService = {
    store: workflowStore,
    registeredReview: (creatorRunId) => {
      const review = creatorResearch.get(creatorRunId)?.researchReview;
      return review ? { reviewStatus: review.reviewStatus, candidateStatus: review.candidateStatus } : null;
    },
    registeredPostReviews: (creatorRunId) => {
      const items = creatorResearch.portfolio(creatorRunId)?.reconstructionBatch?.items ?? [];
      return (postId) => {
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
    startSynthesis: (creatorRunId) => creatorResearch.startCreatorSynthesisWorkflow(creatorRunId)
  };
  const creatorResearchBatchRepository = new SQLiteCreatorResearchBatchRepository(creatorDatabase);
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
    [{ close: () => creatorDatabase.close() }, creatorResearch, creatorResearchBatchRepository]
  );
}
