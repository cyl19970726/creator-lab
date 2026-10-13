import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentRunRequest, AgentRunner } from "@signal-room/workflow";
import { OpenAIAgentsSdkRunner, SiwcAuth, type SiwcRunnerOptions } from "@signal-room/workflow-agent-sdk";
import { imagePostReconstructionSchema, videoReconstructionLifecycleEventSchema,
  type CreatorArtifactStore, type ImagePostReconstructionExecutor } from "../../../research/index.js";
import { projectRoot, runArtifactDir } from "../core/config.js";
import { boundArtifact, ResponsesEvidenceTools } from "./responses-tools.js";

type ModelFactory = (options: SiwcRunnerOptions) => AgentRunner;
export interface ResponsesImagePostOptions {
  createModelRunner?: ModelFactory;
  auth?: Pick<SiwcAuth, "accessToken">;
  fetch?: typeof fetch;
  model?: string;
  reasoningEffort?: string;
  timeoutMs?: number;
}

/** Direct image/carousel adapter until image analysis is moved into the workflow graph. */
export class ResponsesImagePostReconstructionExecutor implements ImagePostReconstructionExecutor {
  constructor(private readonly artifacts: CreatorArtifactStore,
    private readonly options: ResponsesImagePostOptions = {}) {}

  async reconstruct(request: Parameters<ImagePostReconstructionExecutor["reconstruct"]>[0],
    observe?: Parameters<ImagePostReconstructionExecutor["reconstruct"]>[1]) {
    const childRunId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const inputRevision = crypto.createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const trace: Array<{ at: string; type: string; data: unknown }> = [];
    const safePostId = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.postExternalId) ? request.postExternalId : "invalid-post";
    const tracePath = `image-post-responses/${safePostId}/${childRunId}/trace.json`;
    const emit = (status: "started" | "progress" | "completed" | "failed", errorCode: string | null = null) => {
      try { observe?.(videoReconstructionLifecycleEventSchema.parse({ childRunId, role: "candidate", status,
        startedAt, lastProgressAt: new Date().toISOString(), inputRevision, outputArtifactRevisions: {}, errorCode })); }
      catch { /* Telemetry must not corrupt the candidate. */ }
    };
    emit("started");
    try {
      if (!request.imageArtifactRefs.length || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.postExternalId)) {
        throw new Error("RESPONSES_IMAGE_INPUT_INVALID");
      }
      const directory = path.join(runArtifactDir(request.creatorRunId), "image-post-responses", request.postExternalId, childRunId);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const files = [request.detailArtifactRef, ...request.imageArtifactRefs].map(ref => boundArtifact(ref));
      const tools = new ResponsesEvidenceTools(files, directory);
      const promptPath = path.join(projectRoot, "prompts/responses-image-post-builder-v1.md");
      const method = fs.readFileSync(promptPath, "utf8");
      const methodSha256 = crypto.createHash("sha256").update(method).digest("hex");
      const instructions = `${method}\n\nFrozen identity: ${JSON.stringify(request)}\nRead detail and inspect every ordered image with the bound tools. Return the candidate JSON only.`;
      const model = this.options.model ?? "gpt-6-luna";
      const reasoningEffort = this.options.reasoningEffort ?? "medium";
      const runnerOptions: SiwcRunnerOptions = { auth: this.options.auth ?? new SiwcAuth(),
        tools: () => tools.tools(), maxTurns: 60, maxToolCalls: Math.max(80, request.imageArtifactRefs.length + 20),
        timeoutMs: this.options.timeoutMs ?? 30 * 60_000,
        validateOutput: value => imagePostReconstructionSchema.parse(value),
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}) };
      const runner = this.options.createModelRunner?.(runnerOptions) ?? new OpenAIAgentsSdkRunner(runnerOptions);
      trace.push({ at: new Date().toISOString(), type: "responses.method", data: {
        model, reasoningEffort, timeoutMs: runnerOptions.timeoutMs, methodSha256,
        method, effectiveInstructions: instructions, inputRevision,
        frozenEvidence: files.map(file => ({ ref: file.ref, sha256: file.sha256 })),
        toolNames: tools.tools().map(tool => tool.name)
      } });
      const controller = new AbortController();
      const modelRequest: AgentRunRequest<unknown> = { runId: request.runId, stepRunId: childRunId, attemptId: childRunId,
        definition: { id: "image-post-builder", revision: "v1", model, reasoningEffort,
          promptRevision: methodSha256, skillsRevision: "none", permissionsRevision: "bound-image-evidence@1",
          config: { instructions, outputFormat: "json" } },
        input: { creatorRunId: request.creatorRunId, postExternalId: request.postExternalId,
          sourceUrl: request.sourceUrl, detailArtifactRef: request.detailArtifactRef, imageArtifactRefs: request.imageArtifactRefs },
        signal: controller.signal, emit: async (type, data) => {
          trace.push({ at: new Date().toISOString(), type, data }); emit("progress");
        } };
      const raw = (await runner.run(modelRequest)).output;
      const candidate = imagePostReconstructionSchema.parse(raw);
      if (!tools.fullyRead(request.detailArtifactRef)
        || request.imageArtifactRefs.some(ref => !tools.inspectedImages.has(ref))) throw new Error("RESPONSES_IMAGE_PAGES_UNREAD");
      const allowed = new Set(files.map(file => file.ref));
      const refs = [...candidate.inputs.imageArtifactRefs, ...candidate.visualSystem.pages.map(page => page.imageArtifactRef),
        ...candidate.claims.flatMap(claim => claim.evidenceRefs)];
      if (candidate.creatorRunId !== request.creatorRunId || candidate.postExternalId !== request.postExternalId
        || candidate.sourceUrl !== request.sourceUrl || candidate.inputs.detailArtifactRef !== request.detailArtifactRef
        || JSON.stringify(candidate.inputs.imageArtifactRefs) !== JSON.stringify(request.imageArtifactRefs)
        || candidate.visualSystem.pages.length !== request.imageArtifactRefs.length
        || candidate.visualSystem.pages.some((page, index) => page.imageArtifactRef !== request.imageArtifactRefs[index])
        || refs.some(ref => !allowed.has(ref))) throw new Error("RESPONSES_IMAGE_EVIDENCE_BINDING_FAILED");
      for (const file of files) if (crypto.createHash("sha256").update(fs.readFileSync(file.path)).digest("hex") !== file.sha256) {
        throw new Error("RESPONSES_IMAGE_INPUT_MUTATED");
      }
      const traceRef = await this.artifacts.write(request.creatorRunId, tracePath,
        { schemaVersion: "image-post-responses-trace@1", childRunId, events: trace }, [...allowed]);
      const reportRef = await this.artifacts.write(request.creatorRunId,
        `image-post-reconstruction-${request.postExternalId}.json`, candidate, [...allowed, traceRef]);
      const validationRef = await this.artifacts.write(request.creatorRunId,
        `image-post-builder-validation-${request.postExternalId}.json`, {
          schemaVersion: "image-post-builder-validation@1", postExternalId: request.postExternalId,
          valid: true, checkedAt: new Date().toISOString(), invalidRefs: [], executor: "siwc-responses",
          model, reasoningEffort, methodSha256
        }, [...allowed, traceRef, reportRef]);
      emit("completed");
      return { state: "built_unevaluated" as const, reconstructionArtifactRef: reportRef,
        articleArtifactRef: null, builderValidationArtifactRef: validationRef,
        evaluationMode: "skipped" as const, message: "图文主证据与页面顺序已验证，尚待独立审阅。" };
    } catch (error) {
      emit("failed", "image_post_responses_failed");
      trace.push({ at: new Date().toISOString(), type: "responses.failed", data: {
        code: error instanceof Error ? error.message : "unknown" } });
      try { await this.artifacts.write(request.creatorRunId, tracePath,
        { schemaVersion: "image-post-responses-trace@1", childRunId, events: trace },
        [request.detailArtifactRef, ...request.imageArtifactRefs]); } catch { /* Preserve the original failure. */ }
      return { state: "not_ready" as const, reconstructionArtifactRef: null,
        evaluationArtifactRef: null, gateReportArtifactRef: null, threeLensEvaluationArtifactRef: null,
        threeLensGateReportArtifactRef: null, failedGateIds: ["image_post_execution_failed"],
        message: error instanceof Error ? error.message : "图文 Responses Builder 失败" };
    }
  }
}
