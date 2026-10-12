import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { defineAgent, runWorkflow, workflow, type AgentRunner, type RunStore } from "@signal-room/workflow";
import { OpenAIAgentsSdkRunner, SiwcAuth } from "@signal-room/workflow-agent-sdk";
import {
  combineCreatorSynthesisGates, creatorCorpusSchema, creatorPortfolioAnalysisSchema,
  creatorSynthesisIndependentEvaluationSchema, creatorSynthesisSchema, validateCreatorSynthesis,
  videoReconstructionBatchSchema, videoReconstructionOutcomeSchema, runtimeThreeLensEvaluationSchema,
  deriveRuntimeThreeLensGateReport,
  type CreatorArtifactStore, type CreatorResearchRepository, type CreatorSynthesisExecutor,
  type CreatorSynthesisRequest, type VideoReconstructionExecutor, type VideoReconstructionRequest
} from "../../../research/index.js";
import { artifactPath } from "../core/artifacts.js";
import { projectRoot, runArtifactDir } from "../core/config.js";
import { prepareCreatorSynthesisBatch } from "../platform/synthesis/creator-synthesis-inputs.js";
import { hardEvaluationGateFailures, validateEvaluationArtifacts } from "../platform/video/video-evaluation-contract.js";
import { fileDigest, pinResearchInput, registerResearchInput } from "./research-inputs.js";
import { ResponsesResearchRunner } from "./responses-research-runner.js";
import { boundArtifact, ResponsesEvidenceTools } from "./responses-tools.js";

type PayloadStore = RunStore & { getArtifactPayload(id: string): Promise<unknown> };
type Candidate = { reportArtifactRef: string; reportSha256: string; report: unknown; outcome: unknown };
type BuilderReceipt = { artifact: Candidate; validation?: { passed?: boolean } };

export type ResponsesPipelineOptions = {
  /** Tests may supply a fake at the same AgentRunner boundary; production uses Responses. */
  builderRunner?: AgentRunner;
  evaluatorRunner?: AgentRunner;
  builderModel?: string;
  evaluatorModel?: string;
  /** Ingest the evaluator's isolated evidence and trace files into durable run storage. */
  persistArtifacts?: (creatorRunId: string, relativeDirectory: string) => Promise<void>;
};

function definition(id: string, model: string, role: string, prompt: string) {
  const reasoningEffort = id === "post-builder"
    ? process.env.SELF_MEDIA_BUILDER_REASONING_EFFORT ?? "medium"
    : id === "pipeline-post-evaluator"
      ? process.env.SELF_MEDIA_EVALUATOR_REASONING_EFFORT ?? "medium"
      : id === "creator-builder"
        ? process.env.SELF_MEDIA_CREATOR_SYNTHESIS_REASONING_EFFORT ?? "medium"
        : process.env.SELF_MEDIA_CREATOR_SYNTHESIS_EVALUATOR_REASONING_EFFORT ?? "medium";
  return defineAgent<unknown, unknown>({ id, revision: "responses-pipeline@1", model,
    reasoningEffort, promptRevision: role, skillsRevision: role,
    permissionsRevision: "bound-evidence-tools@1", config: { instructions: prompt, outputFormat: "json" } });
}

async function runAgent(store: PayloadStore, runner: AgentRunner, creatorRunId: string,
  id: string, model: string, input: unknown, prompt = "Execute the pinned Responses role."): Promise<unknown> {
  const agent = definition(id, model, id, prompt);
  const task = workflow<unknown, unknown>(`pipeline.${id}`, { revision: "responses-pipeline@1" },
    (ctx, source) => ctx.agent("execute", agent, source));
  const result = await runWorkflow({ workflow: task, input, store, agentRunner: runner,
    metadata: { creatorRunId, pipeline: "automatic" } });
  if (result.output === undefined) throw new Error(`RESPONSES_PIPELINE_NO_OUTPUT:${id}`);
  return result.output;
}

function candidate(value: unknown, kind: "post" | "creator"): Candidate {
  if (!value || typeof value !== "object" || !("artifact" in value)) throw new Error("RESPONSES_PIPELINE_CANDIDATE_MISSING");
  const result = value as BuilderReceipt;
  const artifact = result.artifact;
  if (!artifact || typeof artifact.reportArtifactRef !== "string" || typeof artifact.reportSha256 !== "string"
    || fileDigest(artifactPath(artifact.reportArtifactRef)) !== artifact.reportSha256) {
    throw new Error("RESPONSES_PIPELINE_CANDIDATE_REVISION_MISMATCH");
  }
  if (kind === "post" && result.validation?.passed !== true) throw new Error("RESPONSES_PIPELINE_BUILDER_VALIDATION_FAILED");
  return artifact;
}

function responseEvaluator(tools: ResponsesEvidenceTools): AgentRunner {
  return new OpenAIAgentsSdkRunner({ auth: new SiwcAuth(), tools: () => tools.tools(), timeoutMs: 30 * 60_000,
    maxTurns: 100, maxToolCalls: 100,
    validateOutput: (value) => value && typeof value === "object" ? value : (() => { throw new Error("RESPONSES_EVALUATION_OUTPUT_INVALID"); })() });
}

function frozenTools(refs: string[], directory: string): ResponsesEvidenceTools {
  const unique = [...new Set(refs)];
  return new ResponsesEvidenceTools(unique.map((ref) => boundArtifact(ref, fileDigest(artifactPath(ref)))), directory);
}

/** Preserves the automatic research queue's video node and default Builder-only policy. */
export class ResponsesPipelineVideoReconstructionExecutor implements VideoReconstructionExecutor {
  constructor(private readonly store: PayloadStore, private readonly artifacts: CreatorArtifactStore,
    private readonly repository: CreatorResearchRepository, private readonly options: ResponsesPipelineOptions = {}) {}

  async reconstruct(request: VideoReconstructionRequest): Promise<ReturnType<VideoReconstructionExecutor["reconstruct"]> extends Promise<infer T> ? T : never> {
    let reconstructionRef: string | null = null;
    let validationRef: string | null = null;
    try {
      const run = await this.repository.get(request.creatorRunId);
      if (!run?.reconstructionBatchArtifactRef || !run.selectionArtifactRef || !run.detailArtifactRef || !run.mediaManifestArtifactRef) {
        throw new Error("RESPONSES_PIPELINE_FROZEN_POST_INPUT_MISSING");
      }
      const batch = videoReconstructionBatchSchema.parse(await this.artifacts.read(run.reconstructionBatchArtifactRef));
      const existing = batch.items.find((item) => item.postExternalId === request.postExternalId);
      const evaluateExisting = request.evaluationPolicy === "single_pass" && existing?.reconstructionArtifactRef
        && ["built_unevaluated", "evaluated_with_findings", "verified", "ready"].includes(existing.state);
      if (evaluateExisting) {
        reconstructionRef = existing.reconstructionArtifactRef!;
        validationRef = existing.builderValidationArtifactRef ?? null;
      } else {
        const source = { creatorRunId: request.creatorRunId, postExternalId: request.postExternalId,
          sourceUrl: request.sourceUrl, sourceMediaArtifactRef: request.sourceMediaArtifactRef,
          detailArtifactRef: run.detailArtifactRef, mediaManifestArtifactRef: run.mediaManifestArtifactRef,
          selectionArtifactRef: run.selectionArtifactRef, reconstructionBatchArtifactRef: run.reconstructionBatchArtifactRef,
          evidenceKind: "video" as const, candidateMode: "rebuild" as const };
        const evidence = await registerResearchInput(this.store, pinResearchInput("post", source));
        const produced = candidate(await runAgent(this.store,
          this.options.builderRunner ?? new ResponsesResearchRunner(this.store, this.artifacts), request.creatorRunId,
          "post-builder", this.options.builderModel ?? process.env.SELF_MEDIA_BUILDER_MODEL ?? "gpt-6-luna",
          { creatorRunId: request.creatorRunId, postExternalId: request.postExternalId, evidence }), "post");
        const outcome = videoReconstructionOutcomeSchema.parse(produced.outcome);
        if (outcome.state !== "built_unevaluated" || outcome.evaluationMode !== "skipped") {
          throw new Error("RESPONSES_PIPELINE_BUILDER_OUTCOME_INVALID");
        }
        reconstructionRef = outcome.reconstructionArtifactRef;
        validationRef = outcome.builderValidationArtifactRef;
      }
      if (!reconstructionRef || !validationRef) throw new Error("RESPONSES_PIPELINE_CANDIDATE_INCOMPLETE");
      if (request.evaluationPolicy === "skip") return videoReconstructionOutcomeSchema.parse({ state: "built_unevaluated",
        reconstructionArtifactRef: reconstructionRef, articleArtifactRef: null,
        builderValidationArtifactRef: validationRef, evaluationMode: "skipped" });
      return await this.evaluate(request, reconstructionRef, validationRef);
    } catch (error) {
      if (reconstructionRef && validationRef) return videoReconstructionOutcomeSchema.parse({ state: "built_unevaluated",
        reconstructionArtifactRef: reconstructionRef, articleArtifactRef: null,
        builderValidationArtifactRef: validationRef, evaluationMode: "failed",
        qualityWarningGateIds: ["independent_evaluation_failed"],
        message: error instanceof Error ? error.message : "Responses 独立评估失败" });
      return videoReconstructionOutcomeSchema.parse({ state: "not_ready", reconstructionArtifactRef: reconstructionRef,
        evaluationArtifactRef: null, gateReportArtifactRef: null, threeLensEvaluationArtifactRef: null,
        threeLensGateReportArtifactRef: null, failedGateIds: ["responses_builder_failed"],
        message: error instanceof Error ? error.message : "Responses Builder 失败" });
    }
  }

  private async evaluate(request: VideoReconstructionRequest, reconstructionRef: string, validationRef: string) {
    const directory = path.dirname(artifactPath(reconstructionRef));
    const evaluationDir = path.join(runArtifactDir(request.creatorRunId), "workflow-responses", "pipeline-evaluator", crypto.randomUUID());
    fs.mkdirSync(evaluationDir, { recursive: true });
    try {
    const fingerprint = fileDigest(artifactPath(reconstructionRef));
    const refs = [reconstructionRef, validationRef, request.sourceMediaArtifactRef,
      request.detailArtifactRef, request.evidencePackArtifactRef].filter((ref): ref is string => Boolean(ref));
    const bound = refs.map((ref) => boundArtifact(ref, fileDigest(artifactPath(ref))));
    const local: Array<{ ref: string; path: string; sha256: string }> = [];
    for (const relative of ["post-source-input.json", "media-preparation.json", "evidence/evidence-pack.json",
      "probe.json", "capture-protocol.json", "targeted-evidence/targeted-evidence.json",
      "targeted-evidence/ocr-evidence.json", "evidence/opening-contact.jpg",
      "targeted-evidence/contact-sheet.jpg"]) {
      const file = path.join(directory, relative);
      if (fs.existsSync(file)) local.push({ ref: relative, path: file, sha256: fileDigest(file) });
    }
    const targetedPath = path.join(directory, "targeted-evidence/targeted-evidence.json");
    const targetIds: string[] = [];
    if (fs.existsSync(targetedPath)) {
      const targeted = JSON.parse(fs.readFileSync(targetedPath, "utf8")) as { frames?: Array<{ id: string; frame: string }> };
      for (const frame of targeted.frames ?? []) {
        if (!/^TARGET-\d{4}$/.test(frame.id) || !frame.frame.startsWith("frames/")) throw new Error("RESPONSES_EVALUATOR_TARGETED_MANIFEST_INVALID");
        const framePath = path.join(directory, "targeted-evidence", frame.frame);
        local.push({ ref: frame.id, path: framePath, sha256: fileDigest(framePath) });
        targetIds.push(frame.id);
      }
    }
    const tools = new ResponsesEvidenceTools([...bound, ...local], evaluationDir, artifactPath(request.sourceMediaArtifactRef));
    const schemaDir = path.join(projectRoot, ".agents/skills/video-content-reconstruction/schemas");
    const prompt = fs.readFileSync(path.join(projectRoot, "prompts/responses-pipeline-post-evaluator-v1.md"), "utf8")
      + `\nCandidate: ${reconstructionRef}\nCandidate SHA-256: ${fingerprint}\nPost: ${request.postExternalId}\nBound refs: ${tools.list().join(", ")}`
      + `\nEvaluation JSON schema:\n${fs.readFileSync(path.join(schemaDir, "evaluation.schema.json"), "utf8")}`
      + `\nRuntime 19-rule contract source:\n${fs.readFileSync(path.join(projectRoot, "packages/research/src/video-analysis/runtime-three-lens-contracts.ts"), "utf8")}`;
    const raw = await runAgent(this.store, this.options.evaluatorRunner ?? responseEvaluator(tools), request.creatorRunId,
      "pipeline-post-evaluator", this.options.evaluatorModel ?? process.env.SELF_MEDIA_EVALUATOR_MODEL ?? "gpt-6-luna",
      { reconstructionRef, fingerprint, postExternalId: request.postExternalId }, prompt) as Record<string, unknown>;
    if (!this.options.evaluatorRunner && (!tools.fullyRead(reconstructionRef)
      || ["media-preparation.json", "evidence/evidence-pack.json", "probe.json", "capture-protocol.json",
        "targeted-evidence/targeted-evidence.json"].some((ref) => !tools.list().includes(ref) || !tools.fullyRead(ref))
      || !targetIds.some((id) => tools.inspectedImages.has(id)))) {
      throw new Error("RESPONSES_POST_EVALUATOR_EVIDENCE_UNREAD");
    }
    if (fileDigest(artifactPath(reconstructionRef)) !== fingerprint) throw new Error("RESPONSES_POST_EVALUATOR_MUTATED_CANDIDATE");
    fs.writeFileSync(path.join(evaluationDir, "evaluation.json"), JSON.stringify(raw.evaluation, null, 2));
    const gate = await validateEvaluationArtifacts(directory, evaluationDir);
    const evaluationRef = await this.artifacts.write(request.creatorRunId,
      `pipeline-evaluation-${request.postExternalId}.json`, raw.evaluation, [reconstructionRef]);
    const gateRef = await this.artifacts.write(request.creatorRunId,
      `pipeline-gate-${request.postExternalId}.json`, gate, [evaluationRef]);
    const lenses = runtimeThreeLensEvaluationSchema.parse(raw.runtimeThreeLensEvaluation);
    if (lenses.postExternalId !== request.postExternalId || lenses.candidateRevision.fingerprint !== fingerprint
      || lenses.candidateRevision.reconstructionArtifactRef !== reconstructionRef) throw new Error("RESPONSES_POST_LENS_REVISION_MISMATCH");
    const lensesRef = await this.artifacts.write(request.creatorRunId,
      `pipeline-three-lens-evaluation-${request.postExternalId}.json`, lenses, [reconstructionRef, evaluationRef]);
    const lensGate = deriveRuntimeThreeLensGateReport(lenses, lensesRef);
    const lensGateRef = await this.artifacts.write(request.creatorRunId,
      `pipeline-three-lens-gate-${request.postExternalId}.json`, lensGate, [lensesRef]);
    const warnings = hardEvaluationGateFailures(gate, lensGate);
    return videoReconstructionOutcomeSchema.parse({ state: warnings.length ? "evaluated_with_findings" : "verified",
      reconstructionArtifactRef: reconstructionRef, articleArtifactRef: null, builderValidationArtifactRef: validationRef,
      evaluationArtifactRef: evaluationRef, gateReportArtifactRef: gateRef,
      threeLensEvaluationArtifactRef: lensesRef, threeLensGateReportArtifactRef: lensGateRef,
      threeLensGateCount: 19, gateCount: gate.gates?.length ?? 1,
      failedGateIds: [], qualityWarningGateIds: warnings, evaluationMode: "single_pass" });
    } finally {
      await this.options.persistArtifacts?.(request.creatorRunId,
        path.relative(runArtifactDir(request.creatorRunId), evaluationDir));
    }
  }
}

/** Every automatic creator synthesis still receives an independent seven-gate evaluation. */
export class ResponsesPipelineCreatorSynthesisExecutor implements CreatorSynthesisExecutor {
  constructor(private readonly store: PayloadStore, private readonly artifacts: CreatorArtifactStore,
    private readonly repository: CreatorResearchRepository, private readonly options: ResponsesPipelineOptions = {}) {}

  async synthesize(request: CreatorSynthesisRequest) {
    let synthesisRef: string | null = null;
    try {
      const current = await this.repository.get(request.creatorRunId);
      const effectiveBatchRef = await prepareCreatorSynthesisBatch(this.artifacts, request);
      const effectiveRequest = { ...request, reconstructionBatchArtifactRef: effectiveBatchRef };
      const source = { ...effectiveRequest, portfolioAnnotationsArtifactRef: request.portfolioAnnotationsArtifactRef ?? "",
        previousSynthesisArtifactRef: current?.synthesisArtifactRef ?? null,
        previousSynthesisGateArtifactRef: current?.synthesisGateArtifactRef ?? null };
      const frozen = await registerResearchInput(this.store, pinResearchInput("creator", source));
      const built = candidate(await runAgent(this.store,
        this.options.builderRunner ?? new ResponsesResearchRunner(this.store, this.artifacts), request.creatorRunId,
        "creator-builder", this.options.builderModel ?? process.env.SELF_MEDIA_CREATOR_SYNTHESIS_MODEL ?? "gpt-6-luna",
        { creatorRunId: request.creatorRunId, frozenInputs: frozen }), "creator");
      synthesisRef = built.reportArtifactRef;
      const synthesis = creatorSynthesisSchema.parse(built.report);
      const selection = await this.artifacts.read(request.selectionArtifactRef);
      const batch = await this.artifacts.read(effectiveBatchRef);
      const deterministicGate = validateCreatorSynthesis({ creatorRunId: request.creatorRunId, selection, batch,
        synthesis, checkedAt: new Date().toISOString() });
      const portfolio = creatorPortfolioAnalysisSchema.parse(await this.artifacts.read(request.portfolioArtifactRef));
      const corpus = creatorCorpusSchema.parse(await this.artifacts.read(portfolio.corpusArtifactRef));
      void corpus; // The frozen corpus is included in evaluator tools and independently inspected.
      const refs = [synthesisRef, request.portfolioArtifactRef, portfolio.corpusArtifactRef,
        request.selectionArtifactRef, request.detailArtifactRef, effectiveBatchRef,
        request.portfolioAnnotationsArtifactRef,
        ...videoReconstructionBatchSchema.parse(batch).items.flatMap(item => item.reconstructionArtifactRef ? [item.reconstructionArtifactRef] : [])]
        .filter((ref): ref is string => Boolean(ref));
      const directory = path.join(runArtifactDir(request.creatorRunId), "workflow-responses", "pipeline-evaluator", crypto.randomUUID());
      fs.mkdirSync(directory, { recursive: true });
      try {
      const tools = frozenTools(refs, directory);
      const fingerprint = fileDigest(artifactPath(synthesisRef));
      const prompt = fs.readFileSync(path.join(projectRoot, "prompts/responses-pipeline-creator-evaluator-v1.md"), "utf8")
        + `\nCandidate: ${synthesisRef}\nCandidate SHA-256: ${fingerprint}\nCreator run: ${request.creatorRunId}\nBound refs: ${tools.list().join(", ")}`
        + `\nCreator independent seven-gate schema and definitions:\n${fs.readFileSync(path.join(projectRoot, "packages/research/src/creator-synthesis/contracts.ts"), "utf8")}`
        + `\nDeterministic gate semantics:\n${fs.readFileSync(path.join(projectRoot, "packages/research/src/creator-synthesis/validate.ts"), "utf8")}`;
      const raw = await runAgent(this.store, this.options.evaluatorRunner ?? responseEvaluator(tools), request.creatorRunId,
        "pipeline-creator-evaluator", this.options.evaluatorModel ?? process.env.SELF_MEDIA_CREATOR_SYNTHESIS_EVALUATOR_MODEL ?? "gpt-6-luna",
        { synthesisRef, fingerprint }, prompt);
      const independent = creatorSynthesisIndependentEvaluationSchema.parse(raw);
      if (independent.creatorRunId !== request.creatorRunId || independent.candidateRevisionFingerprint !== fingerprint
        || fileDigest(artifactPath(synthesisRef)) !== fingerprint) throw new Error("RESPONSES_CREATOR_EVALUATOR_REVISION_MISMATCH");
      if (!this.options.evaluatorRunner && refs.some((ref) => !tools.fullyRead(ref))) {
        throw new Error("RESPONSES_CREATOR_EVALUATOR_EVIDENCE_UNREAD");
      }
      const evaluationRef = await this.artifacts.write(request.creatorRunId, "pipeline-creator-synthesis-evaluation.json",
        independent, [synthesisRef]);
      const gate = combineCreatorSynthesisGates({ deterministicGate, independentEvaluation: independent,
        candidateRevisionFingerprint: fingerprint, independentEvaluationArtifactRef: evaluationRef,
        checkedAt: new Date().toISOString() });
      const gateRef = await this.artifacts.write(request.creatorRunId, "pipeline-creator-synthesis-gate.json",
        gate, [synthesisRef, evaluationRef]);
      if (request.mode === "provisional") return { state: "provisional" as const, synthesisArtifactRef: synthesisRef,
        gateArtifactRef: gateRef, failedGateIds: gate.failedGateIds };
      return gate.ready ? { state: "ready" as const, synthesisArtifactRef: synthesisRef, gateArtifactRef: gateRef }
        : { state: "not_ready" as const, synthesisArtifactRef: synthesisRef, gateArtifactRef: gateRef,
          failedGateIds: gate.failedGateIds, message: "博主归纳未通过研究边界或证据闭合硬闸。" };
      } finally {
        await this.options.persistArtifacts?.(request.creatorRunId,
          path.relative(runArtifactDir(request.creatorRunId), directory));
      }
    } catch (error) {
      return { state: "not_ready" as const, synthesisArtifactRef: synthesisRef, gateArtifactRef: null,
        failedGateIds: [synthesisRef ? "independent_synthesis_evaluation_failed" : "responses_synthesis_builder_failed"],
        message: error instanceof Error ? error.message : "Responses 博主综合失败" };
    }
  }
}
