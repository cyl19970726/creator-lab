import { createHash } from "node:crypto";
import {
  createPostWorkflow, createPostWorkflowSuite, createPostWorkflowSuiteV3, createPostWorkflowSuiteV4, createCreatorSynthesisWorkflow, createCreatorSynthesisWorkflowSuite,
  createPostSourceCheckWorkflow,
  createCreatorSynthesisWorkflowSuiteV3, createCreatorAnalysisWorkflow, createCreatorAnalysisWorkflowV2, createCreatorAnalysisWorkflowV3, createCreatorAnalysisWorkflowV4,
  createPostWorkflowSuiteV5, createPostWorkflowSuiteV6, createPostWorkflowSuiteV7, createPostWorkflowSuiteV8, createPostWorkflowSuiteV9, createPostWorkflowSuiteV11,
  createCreatorSynthesisWorkflowSuiteV4, createCreatorSynthesisWorkflowSuiteV5, createCreatorSynthesisWorkflowSuiteV6, createCreatorSynthesisWorkflowSuiteV7, createCreatorSynthesisWorkflowSuiteV8,
  createCreatorAnalysisWorkflowV5, createCreatorAnalysisWorkflowV6, createCreatorAnalysisWorkflowV7, createCreatorAnalysisWorkflowV8, createCreatorAnalysisWorkflowV9, createCreatorAnalysisWorkflowV11,
  postWorkflowArtifacts, createResearchAgentDefinitions,
  CreatorResearchWorkflowScheduler, RepositoryResearchVersionRegistrar,
  videoReconstructionBatchSchema, videoReconstructionOutcomeSchema, creatorSynthesisSchema, creatorSynthesisGateSchema,
  type CreatorArtifactStore, type PostWorkflowStartInput, type CreatorSynthesisWorkflowStartInput,
  type PostWorkflowRegistrationInput,
  type CreatorWorkflowRegistrationInput, type ResearchAgentConfig,
  type VideoReconstructionOutcome, type CreatorSynthesisOutcome, type CreatorResearchRepository,
  type ResearchVersionRegistrationTransaction, type ResearchWorkflowExecutor, type ResearchWorkflowDefinitions,
} from "../../../research/index.js";
import type { AgentRunner, RunStore, WorkflowDefinition } from "@signal-room/workflow";
import { artifactPath } from "../core/artifacts.js";
import { type ResearchWorkflowInputFreezer, type WorkflowDefinitionRegistry, type WorkflowAdvanceScheduler } from "./research-workflow-executor.js";
import { assertPinnedResearchInput, fileDigest, methodSnapshot, pinResearchInput, registerResearchInput, type PinnedResearchInput } from "./research-inputs.js";
import { pinVerifiedCreatorReuseCandidate } from "./creator-candidate-reuse.js";
import { simpleReviewRegistration } from "./simple-review-registration.js";

export type ResearchRunStore = RunStore & { getArtifactPayload(id: string): Promise<unknown> };

type CandidatePayload = { kind: "post" | "creator"; outcome: unknown; report: unknown; reportArtifactRef: string; reportSha256: string };

function isBuilt(outcome: VideoReconstructionOutcome): outcome is Extract<VideoReconstructionOutcome, { state: "built_unevaluated" | "verified" | "ready" | "evaluated_with_findings" }> {
  return ["built_unevaluated", "verified", "ready", "evaluated_with_findings"].includes(outcome.state);
}

export interface ResearchWorkflowCompositionOptions {
  runner: AgentRunner;
  registrationTransaction: ResearchVersionRegistrationTransaction;
  executorFactory: (store: ResearchRunStore, runner: AgentRunner, definitions: ResearchWorkflowDefinitions,
    freezer: ResearchWorkflowInputFreezer, registry: WorkflowDefinitionRegistry, scheduler: WorkflowAdvanceScheduler) => ResearchWorkflowExecutor;
}

export function createProductionResearchWorkflow(store: ResearchRunStore, artifacts: CreatorArtifactStore,
  repository: CreatorResearchRepository, options: ResearchWorkflowCompositionOptions): ResearchWorkflowExecutor {
  const pin = (kind: "post" | "creator", source: PinnedResearchInput["source"]) => pinResearchInput(kind, source);
  const config = (kind: "post" | "creator", model: string) => {
    const methods = methodSnapshot(kind);
    const skillPackages: Array<{ path: string; sha256: string }> = [];
    const digest = createHash("sha256").update(JSON.stringify({ methods, skillPackages })).digest("hex");
    return { model, prompt: "Execute the pinned analysis role with explicit host-bound evidence tools and validated output.",
      promptRevision: digest, skillSnapshotsRevision: digest, permissionsRevision: "bound-evidence-tools@1",
      config: { delegate: "openai-agents-sdk", methods, skillPackages } };
  };
  const postBuilderModel = process.env.SELF_MEDIA_BUILDER_MODEL ?? "gpt-6-luna";
  const postEvaluatorModel = process.env.SELF_MEDIA_EVALUATOR_MODEL ?? "gpt-6-luna";
  const creatorBuilderModel = process.env.SELF_MEDIA_CREATOR_SYNTHESIS_MODEL ?? "gpt-6-luna";
  const creatorEvaluatorModel = process.env.SELF_MEDIA_CREATOR_SYNTHESIS_EVALUATOR_MODEL ?? "gpt-6-luna";
  const configs: ResearchAgentConfig = { postSourceChecker: config("post", postBuilderModel), postBuilder: config("post", postBuilderModel), postReviewer: config("post", postEvaluatorModel), postRepair: config("post", postBuilderModel),
    postEvaluationRepair: config("post", postBuilderModel),
    creatorBuilder: config("creator", creatorBuilderModel), creatorReviewer: config("creator", creatorEvaluatorModel), creatorRepair: config("creator", creatorBuilderModel) };
  for (const role of ["postSourceChecker", "postBuilder", "postRepair"] as const)
    configs[role].reasoningEffort = process.env.SELF_MEDIA_BUILDER_REASONING_EFFORT ?? "medium";
  for (const role of ["postReviewer", "postEvaluationRepair"] as const)
    configs[role].reasoningEffort = process.env.SELF_MEDIA_EVALUATOR_REASONING_EFFORT ?? "medium";
  for (const role of ["creatorBuilder", "creatorRepair"] as const)
    configs[role].reasoningEffort = process.env.SELF_MEDIA_CREATOR_SYNTHESIS_REASONING_EFFORT ?? "medium";
  configs.creatorReviewer.reasoningEffort = process.env.SELF_MEDIA_CREATOR_SYNTHESIS_EVALUATOR_REASONING_EFFORT ?? "medium";
  const agents = createResearchAgentDefinitions(configs);
  const candidate = (value: { artifact: unknown; validation?: unknown }) => {
    try {
      const payload = value.artifact as CandidatePayload;
      if (!payload || fileDigest(artifactPath(payload.reportArtifactRef)) !== payload.reportSha256) return { valid: false, details: "candidate_revision_mismatch" };
      if (payload.kind === "creator") return { valid: creatorSynthesisSchema.safeParse(payload.report).success };
      const outcome = videoReconstructionOutcomeSchema.parse(payload.outcome);
      const passed = Boolean(value.validation && typeof value.validation === "object" && "passed" in value.validation && value.validation.passed === true);
      return { valid: isBuilt(outcome) && passed, details: passed ? undefined : "builder_validation_not_passed" };
    } catch (error) { return { valid: false, details: error instanceof Error ? error.message : "candidate_contract_invalid" }; }
  };
  const evaluation = (value: { artifact: unknown }) => {
    if (!value.artifact || typeof value.artifact !== "object") return { valid: false };
    const artifact = value.artifact as { kind?: unknown; outcome?: unknown; gate?: unknown };
    if (artifact.kind === "creator") {
      return { valid: creatorSynthesisGateSchema.safeParse(artifact.gate).success,
        details: { kind: "creator_evaluation_contract" } };
    }
    if (artifact.kind !== "post") return { valid: false, details: { kind: "evaluation_kind_missing" } };
    const parsed = videoReconstructionOutcomeSchema.safeParse(artifact.outcome);
    if (!parsed.success) return { valid: false, details: parsed.error.flatten() };
    if (parsed.data.state === "built_unevaluated" && parsed.data.evaluationMode === "failed") {
      return { valid: false, details: { kind: "evaluation_contract", outcome: parsed.data } };
    }
    return { valid: parsed.data.state === "verified" || parsed.data.state === "ready"
      || parsed.data.state === "evaluated_with_findings",
      details: { kind: "evaluation_incomplete", outcome: parsed.data } };
  };
  const validators = { candidate, evaluation };
  const postV1 = createPostWorkflow(validators, agents);
  const creatorSynthesisV1 = createCreatorSynthesisWorkflow(validators, agents);
  const prepareSynthesisV1 = async (input: Parameters<Parameters<typeof createCreatorAnalysisWorkflow>[2]>[0],
    posts: Parameters<Parameters<typeof createCreatorAnalysisWorkflow>[2]>[1]) => {
    const original = await store.getArtifactPayload(input.source.id) as PinnedResearchInput;
    assertPinnedResearchInput(original);
    const source = original.source as CreatorSynthesisWorkflowStartInput;
    const batch = videoReconstructionBatchSchema.parse(await artifacts.read(source.reconstructionBatchArtifactRef));
    for (let index = 0; index < posts.length; index++) {
      const result = posts[index]!;
      const refs = postWorkflowArtifacts(result);
      if (!refs) throw new Error("SYNTHESIS_REQUIRES_REVIEWABLE_POST_OUTPUT");
      const produced = await store.getArtifactPayload(refs.candidate.id) as CandidatePayload;
      const review = refs.evaluation ? await store.getArtifactPayload(refs.evaluation.id) as { outcome: VideoReconstructionOutcome } : null;
      const outcome = (review?.outcome ?? produced.outcome) as VideoReconstructionOutcome;
      const item = batch.items.find((row) => row.postExternalId === input.posts[index]!.postExternalId);
      if (!item || !isBuilt(outcome)) throw new Error("SYNTHESIS_POST_BINDING_MISMATCH");
      Object.assign(item, outcome, { evaluationPolicy: review ? "single_pass@37a03aae" : "skip@builder-fast-path-v1", updatedAt: new Date().toISOString() });
    }
    batch.revision += 1;
    batch.generatedAt = new Date().toISOString();
    batch.builtPosts = batch.items.filter((row) => ["ready", "verified", "built_unevaluated", "evaluated_with_findings"].includes(row.state)).length;
    batch.verifiedPosts = batch.items.filter((row) => ["ready", "verified"].includes(row.state)).length;
    batch.readyPosts = batch.verifiedPosts;
    batch.pendingPosts = batch.items.filter((row) => ["pending", "running"].includes(row.state)).length;
    batch.failedPosts = batch.items.filter((row) => ["not_ready", "blocked"].includes(row.state)).length;
    const reconstructionBatchArtifactRef = await artifacts.write(source.creatorRunId, "workflow-reconstruction-batch.json",
      videoReconstructionBatchSchema.parse(batch), [source.reconstructionBatchArtifactRef]);
    return { creatorRunId: source.creatorRunId, frozenInputs: await registerResearchInput(store,
      pin("creator", { ...source, reconstructionBatchArtifactRef })) };
  };
  const creatorAnalysisV1 = createCreatorAnalysisWorkflow(postV1, creatorSynthesisV1, prepareSynthesisV1);
  const registrar = new RepositoryResearchVersionRegistrar(repository, artifacts,
    options.registrationTransaction);
  const postSuiteOptions = { registerPostVersion: async (input: PostWorkflowRegistrationInput) => {
    const pinned = await store.getArtifactPayload(input.source.evidence.id) as PinnedResearchInput;
    assertPinnedResearchInput(pinned);
    const source = pinned.source as PostWorkflowStartInput;
    const candidatePayload = input.candidateReceipt.artifact as CandidatePayload;
    const reviewPayload = input.reviewReceipt.artifact as CandidatePayload;
    return registrar.registerPostVersion({ creatorRunId: source.creatorRunId, postExternalId: source.postExternalId,
      source: { reconstructionBatchArtifactRef: source.reconstructionBatchArtifactRef, selectionArtifactRef: source.selectionArtifactRef,
        detailArtifactRef: source.detailArtifactRef, mediaManifestArtifactRef: source.mediaManifestArtifactRef,
        sourceMediaArtifactRef: source.sourceMediaArtifactRef },
      candidate: candidatePayload.outcome as VideoReconstructionOutcome,
      review: reviewPayload.outcome as VideoReconstructionOutcome, registeredBy: input.registeredBy });
  } };
  const postSuite = createPostWorkflowSuite(validators, agents, postSuiteOptions);
  const creatorSuiteOptions = { registerCreatorVersion: async (input: CreatorWorkflowRegistrationInput) => {
    const pinned = await store.getArtifactPayload(input.source.frozenInputs.id) as PinnedResearchInput;
    assertPinnedResearchInput(pinned);
    const source = pinned.source as CreatorSynthesisWorkflowStartInput;
    const candidatePayload = input.candidateReceipt.artifact as CandidatePayload;
    const reviewPayload = input.reviewReceipt.artifact as CandidatePayload;
    return registrar.registerCreatorVersion({ creatorRunId: source.creatorRunId,
      source: { reconstructionBatchArtifactRef: source.reconstructionBatchArtifactRef,
        portfolioArtifactRef: source.portfolioArtifactRef, portfolioAnnotationsArtifactRef: source.portfolioAnnotationsArtifactRef,
        selectionArtifactRef: source.selectionArtifactRef,
        detailArtifactRef: source.detailArtifactRef, previousSynthesisArtifactRef: source.previousSynthesisArtifactRef ?? null,
        previousSynthesisGateArtifactRef: source.previousSynthesisGateArtifactRef ?? null },
      candidate: candidatePayload.outcome as CreatorSynthesisOutcome,
      review: reviewPayload.outcome as CreatorSynthesisOutcome, registeredBy: input.registeredBy });
  } };
  const creatorSuite = createCreatorSynthesisWorkflowSuite(validators, agents, creatorSuiteOptions);
  const prepareSynthesisV2: Parameters<typeof createCreatorAnalysisWorkflowV2>[2] = async (input) => {
    const original = await store.getArtifactPayload(input.source.id) as PinnedResearchInput;
    assertPinnedResearchInput(original);
    const initial = original.source as CreatorSynthesisWorkflowStartInput;
    const current = await repository.get(input.creatorRunId);
    if (!current?.reconstructionBatchArtifactRef) throw new Error("CREATOR_SYNTHESIS_LATEST_BATCH_MISSING");
    const source: CreatorSynthesisWorkflowStartInput = { ...initial,
      reconstructionBatchArtifactRef: current.reconstructionBatchArtifactRef,
      previousSynthesisArtifactRef: current.synthesisArtifactRef, previousSynthesisGateArtifactRef: current.synthesisGateArtifactRef };
    return { creatorRunId: input.creatorRunId, frozenInputs: await registerResearchInput(store, pin("creator", source)) };
  };
  const creatorAnalysisV2 = createCreatorAnalysisWorkflowV2(postSuite.analyze, creatorSuite.analyze, prepareSynthesisV2);
  const postSuiteV3 = createPostWorkflowSuiteV3(validators, agents, postSuiteOptions);
  const postSuiteV4 = createPostWorkflowSuiteV4(validators, agents, postSuiteOptions);
  const creatorSuiteV3 = createCreatorSynthesisWorkflowSuiteV3(validators, agents, creatorSuiteOptions);
  const creatorAnalysisV3 = createCreatorAnalysisWorkflowV3(postSuiteV3.analyze, creatorSuiteV3.analyze, prepareSynthesisV2);
  const creatorAnalysisV4 = createCreatorAnalysisWorkflowV4(postSuiteV4.analyze, creatorSuiteV3.analyze, prepareSynthesisV2);
  const simpleConfig = (kind: "post" | "creator", model: string) => {
    const value = config(kind, model);
    return { ...value, promptRevision: `${value.promptRevision}:reviewer-v1`, config: { ...value.config, simpleReview: true } };
  };
  const simpleAgents = createResearchAgentDefinitions({ ...configs, postReviewer: simpleConfig("post", postEvaluatorModel),
    postRepair: simpleConfig("post", postBuilderModel), creatorReviewer: simpleConfig("creator", creatorEvaluatorModel),
    creatorRepair: simpleConfig("creator", creatorBuilderModel) });
  const registerCandidate = simpleReviewRegistration(store, artifacts, registrar, repository);
  const sourceCheck = postSuiteV4.definitions.find((definition) => definition.id === "post.source-check");
  const postSuiteV5 = createPostWorkflowSuiteV5(validators, simpleAgents, { registerCandidate,
    sourceCheck: sourceCheck as NonNullable<Parameters<typeof createPostWorkflowSuiteV5>[2]>["sourceCheck"] });
  const postSuiteV6 = createPostWorkflowSuiteV6(validators, simpleAgents, { registerCandidate,
    sourceCheck: sourceCheck as NonNullable<Parameters<typeof createPostWorkflowSuiteV6>[2]>["sourceCheck"] });
  const postSuiteV7 = createPostWorkflowSuiteV7(validators, simpleAgents, { registerCandidate,
    sourceCheck: sourceCheck as NonNullable<Parameters<typeof createPostWorkflowSuiteV7>[2]>["sourceCheck"] });
  const sourceCheckV3 = createPostSourceCheckWorkflow("v3", simpleAgents);
  const postSuiteV8 = createPostWorkflowSuiteV8(validators, simpleAgents, { registerCandidate,
    sourceCheck: sourceCheckV3 });
  const postSuiteV9 = createPostWorkflowSuiteV9(validators, simpleAgents, { registerCandidate,
    sourceCheck: sourceCheckV3 });
  const creatorSuiteV4 = createCreatorSynthesisWorkflowSuiteV4(validators, simpleAgents, { registerCandidate });
  const creatorSuiteV5 = createCreatorSynthesisWorkflowSuiteV5(validators, simpleAgents, { registerCandidate });
  const creatorSuiteV6 = createCreatorSynthesisWorkflowSuiteV6(validators, simpleAgents, { registerCandidate });
  const creatorSuiteV7 = createCreatorSynthesisWorkflowSuiteV7(validators, simpleAgents, { registerCandidate });
  const prepareSynthesisV5: Parameters<typeof createCreatorAnalysisWorkflowV5>[2] = async (input, posts) => {
    const original = await store.getArtifactPayload(input.source.id) as PinnedResearchInput;
    assertPinnedResearchInput(original);
    const initial = original.source as CreatorSynthesisWorkflowStartInput;
    const current = await repository.get(input.creatorRunId);
    if (!current?.reconstructionBatchArtifactRef) throw new Error("CREATOR_SYNTHESIS_LATEST_BATCH_MISSING");
    const scope = posts.map((post, index) => {
      const refs = postWorkflowArtifacts(post);
      if (!refs) throw new Error("SYNTHESIS_REQUIRES_REVIEWABLE_POST_OUTPUT");
      const state = (post.ok ? post : post.details) as { reviewStatus?: string; candidateStatus?: string };
      return { postExternalId: input.posts[index]!.postExternalId, candidate: refs.candidate,
        review: refs.evaluation, reviewStatus: state.reviewStatus ?? "failed",
        candidateStatus: state.candidateStatus ?? "review_incomplete" };
    });
    const pinned = pin("creator", { ...initial, reconstructionBatchArtifactRef: current.reconstructionBatchArtifactRef,
      previousSynthesisArtifactRef: current.synthesisArtifactRef, previousSynthesisGateArtifactRef: current.synthesisGateArtifactRef });
    pinned.researchScope = { complete: scope.every((post) => post.reviewStatus === "completed_no_findings"), posts: scope };
    return { creatorRunId: input.creatorRunId, frozenInputs: await registerResearchInput(store, pinned) };
  };
  const creatorAnalysisV5 = createCreatorAnalysisWorkflowV5(postSuiteV5.analyze, creatorSuiteV4.analyze, prepareSynthesisV5);
  const creatorAnalysisV6 = createCreatorAnalysisWorkflowV6(postSuiteV6.analyze, creatorSuiteV5.analyze, prepareSynthesisV5);
  const creatorAnalysisV7 = createCreatorAnalysisWorkflowV7(postSuiteV7.analyze, creatorSuiteV6.analyze, prepareSynthesisV5);
  const creatorAnalysisV8 = createCreatorAnalysisWorkflowV8(postSuiteV8.analyze, creatorSuiteV7.analyze, prepareSynthesisV5);
  const creatorAnalysisV9 = createCreatorAnalysisWorkflowV9(postSuiteV9.analyze, creatorSuiteV7.analyze, prepareSynthesisV5);
  const sourceCheckV4 = createPostSourceCheckWorkflow("v4", simpleAgents);
  const postSuiteV11 = createPostWorkflowSuiteV11(validators, simpleAgents, { registerCandidate, sourceCheck: sourceCheckV4 });
  const creatorSuiteV8 = createCreatorSynthesisWorkflowSuiteV8(validators, simpleAgents, { registerCandidate });
  const creatorAnalysisV11 = createCreatorAnalysisWorkflowV11(postSuiteV11.analyze, creatorSuiteV8.analyze, prepareSynthesisV5);
  const definitions = { post: postSuiteV11.analyze, creatorSynthesis: creatorSuiteV8.analyze, creatorAnalysis: creatorAnalysisV11 };
  const registeredDefinitions = [postV1, creatorSynthesisV1, creatorAnalysisV1,
    ...postSuite.definitions, ...creatorSuite.definitions, creatorAnalysisV2,
    ...postSuiteV3.definitions, ...postSuiteV4.definitions, ...creatorSuiteV3.definitions, creatorAnalysisV3, creatorAnalysisV4,
    ...postSuiteV5.definitions, ...postSuiteV6.definitions, ...postSuiteV7.definitions, sourceCheckV3,
    ...postSuiteV8.definitions, ...postSuiteV9.definitions,
    ...creatorSuiteV4.definitions, ...creatorSuiteV5.definitions, ...creatorSuiteV6.definitions, ...creatorSuiteV7.definitions,
    creatorAnalysisV5, creatorAnalysisV6, creatorAnalysisV7, creatorAnalysisV8, creatorAnalysisV9,
    sourceCheckV4, ...postSuiteV11.definitions, ...creatorSuiteV8.definitions, creatorAnalysisV11];
  const registry = { resolve: (id: string, revision: string) => registeredDefinitions
    .find((definition) => definition.id === id && definition.revision === revision) as WorkflowDefinition<unknown, unknown> | undefined };
  const scheduler = new CreatorResearchWorkflowScheduler(repository);
  const freezePost = async (source: PostWorkflowStartInput) => ({ creatorRunId: source.creatorRunId, postExternalId: source.postExternalId,
    evidenceKind: source.evidenceKind, evaluationMode: source.evaluationMode,
    importedEvaluationArtifactRef: source.importedEvaluationArtifactRef,
    evidence: await registerResearchInput(store, pin("post", source)) });
  const freezer: ResearchWorkflowInputFreezer = {
    post: freezePost,
    creator: async (source) => {
      const pinned = pin("creator", source);
      return { creatorRunId: source.creatorRunId,
        frozenInputs: await registerResearchInput(store, source.candidateMode === "reuse"
          ? await pinVerifiedCreatorReuseCandidate(store, pinned) : pinned) };
    },
    analysis: async (source) => ({ creatorRunId: source.creatorRunId,
      posts: await Promise.all(source.posts.map(freezePost)),
      source: await registerResearchInput(store, pin("creator", source)) }),
  };
  const advance = { enqueue: async (input: Parameters<WorkflowAdvanceScheduler["enqueue"]>[0]) => scheduler.enqueue(input) };
  return options.executorFactory(store, options.runner, definitions, freezer, registry, advance);
}
