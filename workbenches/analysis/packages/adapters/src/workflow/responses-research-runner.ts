import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentRunRequest, AgentRunResult, AgentRunner, ArtifactPayloadReader, ArtifactRef, RunStore } from "@signal-room/workflow";
import { OpenAIAgentsSdkRunner, SiwcAuth, type SiwcRunnerOptions, type SiwcTool, type SiwcVisualToolResult } from "@signal-room/workflow-agent-sdk";
import {
  assertValidCrossPostResearch, creatorCorpusSchema, creatorPortfolioAnalysisSchema, creatorSynthesisSchema,
  researchReviewReceiptSchema, sourceConsistencyCheckV2Schema, validateAdaptivePortfolioClassification,
  validateCreatorSynthesis, videoReconstructionBatchSchema,
  type CreatorArtifactStore, type CreatorSynthesisRequest, type CreatorSynthesisWorkflowStartInput,
  type PostWorkflowStartInput
} from "../../../research/index.js";
import type { ResearchReviewReceipt } from "../../../research/src/workflows/simple-review-contract.js";
import { artifactPath, artifactRef } from "../core/artifacts.js";
import { postSourceFactsSchema } from "../../../contracts/index.js";
import { projectRoot, runArtifactDir } from "../core/config.js";
import { runFile } from "../core/process.js";
import { prepareBuilderInputs } from "../platform/video/video-reconstruction-media-preparer.js";
import { assertCompleteOcrResult, preflightOcrInputUnion, writeOcrInputManifest } from "../platform/video/video-ocr-input-manifest.js";
import { contentBlockTemporalDiagnostics, contentBlockVisualDiagnostics, validateBuilderIntegrity } from "../platform/video/video-builder-integrity.js";
import { depthPackagingSourceDiagnostics } from "../platform/video/video-depth-integrity.js";
import { assertFinalSummaryPerformance } from "../platform/video/video-final-summary.js";
import { assembleHostOwnedReconstruction, frozenReconstructionTranscriptFromEvidencePack } from "../platform/video/video-reconstruction-host-assembler.js";
import { freezePostSourceInput } from "../platform/video/video-post-source-input.js";
import { assembleReuseCandidateFromFixed, assertReuseBaseBindings, creatorSynthesisResearchDraftSchema,
  loadReuseBase, prepareReuseFixedFields } from "../platform/synthesis/creator-synthesis-reuse.js";
import { materializeCreatorReuseCandidate } from "./creator-candidate-reuse.js";
import { ValidatedDraftStore, type ValidatedDraftRef } from "./validated-draft-store.js";
import { applyReconstructionPatch, RECONSTRUCTION_PATCH_ALLOWED_ROOTS } from "./reconstruction-patch.js";
import { collectOpeningFrameDiagnostics } from "./opening-frame-diagnostics.js";
import { assertPinnedResearchInput, fileDigest, type PinnedResearchInput } from "./research-inputs.js";
import { boundArtifact, ResponsesEvidenceTools } from "./responses-tools.js";
import { bindCreatorEvidenceViews, creatorEvidenceReadiness } from "./creator-evidence.js";
import { createReviewFindingComparisonTool, reviewFindingHash } from "./review-finding-comparison.js";
import { BuilderLensDrafts, builderLensDraftToolParameters, builderLensIndexSchema, builderLensSchema, builderLensSlots, type BuilderLensSlot } from "./builder-lens-drafts.js";
import { createEvidenceWindowTool, indexedEvidenceFrames } from "./evidence-window.js";

type Store = RunStore & ArtifactPayloadReader;
type CandidatePayload = { kind: "post" | "creator"; evidence: ArtifactRef; report: unknown;
  reportArtifactRef: string; reportSha256: string; relativeRoot: string; outcome: unknown; revisionResponse?: unknown;
  reusedFrom?: { candidate: ArtifactRef; reportArtifactRef: string; reportSha256: string } };
type ReviewInput = { candidate: ArtifactRef; review?: ArtifactRef; findings?: unknown; evidence?: ArtifactRef;
  frozenInputs?: ArtifactRef; retryFeedback?: string };
type ModelFactory = (options: SiwcRunnerOptions) => AgentRunner;
type Role = "source-check" | "post-builder" | "post-reviewer" | "post-repair" |
  "creator-builder" | "creator-reviewer" | "creator-repair";
const roleByAgentId: Record<string, Role> = {
  "post-source-checker": "source-check", "post-builder": "post-builder",
  "post-reviewer": "post-reviewer", "post-repair": "post-repair",
  "creator-synthesis-builder": "creator-builder", "creator-synthesis-reviewer": "creator-reviewer",
  "creator-synthesis-repair": "creator-repair",
  "creator-builder": "creator-builder", "creator-reviewer": "creator-reviewer", "creator-repair": "creator-repair"
};

export interface ResponsesResearchRunnerOptions {
  /** Fake factory in tests, official Agents SDK adapter in production. */
  createModelRunner?: ModelFactory;
  auth?: Pick<SiwcAuth, "accessToken">;
  fetch?: typeof fetch;
  timeoutMs?: Partial<Record<Role, number>>;
  /** Host may supply an already verified media-preparation fixture. */
  prepareMedia?: typeof prepareBuilderInputs;
  /** Test seam for the deterministic integrity gate; production always uses the canonical gate. */
  validateIntegrity?: typeof validateBuilderIntegrity;
}

const promptNames: Record<Role, string> = {
  "source-check": "responses-source-check-v1.md", "post-builder": "responses-post-builder-v1.md",
  "post-reviewer": "responses-reviewer-v1.md", "post-repair": "responses-post-repair-v1.md",
  "creator-builder": "responses-creator-builder-v1.md", "creator-reviewer": "responses-creator-reviewer-v1.md",
  "creator-repair": "responses-creator-builder-v1.md"
};
const defaultTimeout: Record<Role, number> = {
  "source-check": 6 * 60_000, "post-builder": 90 * 60_000, "post-reviewer": 10 * 60_000,
  "post-repair": 60 * 60_000, "creator-builder": 90 * 60_000,
  "creator-reviewer": 15 * 60_000, "creator-repair": 60 * 60_000
};
const shaText = (text: string) => createHash("sha256").update(text).digest("hex");
const execFileAsync = promisify(execFile);
const reconstructionPatchRootList = RECONSTRUCTION_PATCH_ALLOWED_ROOTS.join(", ");
const stable = (value: unknown): string => value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(stable).join(",")}]`
    : `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
const safe = (value: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error("RESPONSES_UNSAFE_SEGMENT");
  return value;
};
function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

/** Replaces the Codex production operator at the same AgentRunner seam; never falls back to Codex. */
export class ResponsesResearchRunner implements AgentRunner {
  constructor(private readonly store: Store, private readonly artifacts: CreatorArtifactStore,
    private readonly options: ResponsesResearchRunnerOptions = {}) {}

  async run<Input, Output>(request: AgentRunRequest<Input>): Promise<AgentRunResult<Output>> {
    const id = request.definition.id;
    const role = roleByAgentId[id];
    if (!role) throw new Error("RESPONSES_ROLE_NOT_SUPPORTED");
    const reviewer = role.endsWith("reviewer");
    const repair = role.endsWith("repair");
    const post = role === "source-check" || role.startsWith("post-");
    const controller = new AbortController();
    const onAbort = () => controller.abort(request.signal.reason ?? new Error("RESPONSES_CANCELED"));
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) onAbort();
    const timer = setTimeout(() => controller.abort(new Error("RESPONSES_HOST_TOTAL_TIMEOUT")),
      this.options.timeoutMs?.[role] ?? defaultTimeout[role]);
    const activeRequest = { ...request, signal: controller.signal };
    try {
    const input = request.input as ReviewInput & { evidence?: ArtifactRef; frozenInputs?: ArtifactRef };
    const prior = reviewer || repair ? await this.candidate(input.candidate) : undefined;
    if (prior && prior.kind !== (post ? "post" : "creator")) throw new Error("RESPONSES_CANDIDATE_KIND_MISMATCH");
    const frozen = prior?.evidence ?? (post ? input.evidence : input.frozenInputs);
    if (!frozen) throw new Error("RESPONSES_FROZEN_INPUT_REQUIRED");
    const pinned = await this.payload<PinnedResearchInput>(frozen);
    assertPinnedResearchInput(pinned);
    if (pinned.kind !== (post ? "post" : "creator")) throw new Error("RESPONSES_INPUT_KIND_MISMATCH");
    const directory = path.join(runArtifactDir(pinned.source.creatorRunId), "workflow-responses",
      safe(request.runId), safe(request.attemptId));
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const bound = pinned.files.map(file => boundArtifact(file.ref, file.sha256));
    if (prior && !bound.some(item => item.ref === prior.reportArtifactRef)) bound.push(boundArtifact(prior.reportArtifactRef, prior.reportSha256));
    if (prior?.kind === "post") bindPostCandidateFiles(bound, prior, pinned.source.creatorRunId);
    const media = post ? artifactPath((pinned.source as PostWorkflowStartInput).sourceMediaArtifactRef) : undefined;
    const tools = new ResponsesEvidenceTools(bound, directory, repair || reviewer ? undefined : media);
    let result: unknown;
    if (id === "post-source-checker") result = await this.sourceCheck(activeRequest, frozen, pinned, directory);
    else if (reviewer) result = await this.review(activeRequest, pinned, prior!, input.candidate, tools, post);
    else if (role === "post-builder" && pinned.reuseCandidate) result = await this.postReuse(activeRequest, frozen, pinned, directory);
    else if (role === "creator-builder" && pinned.reuseCandidate) result = await this.creatorReuse(activeRequest, frozen, pinned, directory);
    else if (post) result = await this.postBuilder(activeRequest, frozen, pinned, prior, input, tools, directory, repair);
    else result = await this.creatorBuilder(activeRequest, frozen, pinned, prior, input, tools, directory, repair);
    if (controller.signal.aborted) throw controller.signal.reason ?? new Error("RESPONSES_CANCELED");
    return { output: result as Output };
    } finally { clearTimeout(timer); request.signal.removeEventListener("abort", onAbort); }
  }

  private async payload<T>(ref: ArtifactRef): Promise<T> {
    const actual = await this.store.getArtifact(ref.id);
    if (!actual || actual.revision !== ref.revision || actual.sha256 !== ref.sha256) throw new Error("RESPONSES_ARTIFACT_REVISION_MISMATCH");
    return await this.store.getArtifactPayload(ref.id) as T;
  }

  private async candidate(ref: ArtifactRef | undefined): Promise<CandidatePayload> {
    if (!ref) throw new Error("RESPONSES_CANDIDATE_REQUIRED");
    const value = await this.payload<CandidatePayload>(ref);
    if (value.reportSha256 !== fileDigest(artifactPath(value.reportArtifactRef))) throw new Error("RESPONSES_CANDIDATE_MUTATED");
    return value;
  }

  private async model<I>(request: AgentRunRequest<I>, role: Role, tools: ResponsesEvidenceTools,
    extra: string, validate: (value: unknown) => unknown | Promise<unknown>, extraTools: readonly SiwcTool[] = [],
    outputValidationFeedback?: (error: unknown) => string | null,
    finishOnPassingDraftTools?: readonly string[]): Promise<unknown> {
    const promptFile = path.join(projectRoot, "prompts", promptNames[role]);
    const method = fs.readFileSync(promptFile, "utf8");
    const instructions = `${method}\n\n${extra}\n\nBound evidence refs: ${JSON.stringify(tools.list())}. Only use the bound tools. Return one JSON object, no Markdown.`;
    const toolSet = [...tools.tools(), ...extraTools];
    await request.emit("responses.method", { role, methodRevision: request.definition.revision,
      promptPath: promptFile, promptSha256: shaText(method),
      effectiveInstructionsSha256: shaText(instructions), toolNames: toolSet.map(tool => tool.name),
      frozenEvidenceRefs: tools.list(), model: request.definition.model, reasoningEffort: request.definition.reasoningEffort });
    const runnerOptions: SiwcRunnerOptions = { auth: this.options.auth ?? new SiwcAuth(),
      tools: () => toolSet, timeoutMs: this.options.timeoutMs?.[role] ?? defaultTimeout[role],
      maxTurns: 100, maxToolCalls: 100, enforceJsonObject: true,
      validateOutput: validate,
      ...(finishOnPassingDraftTools?.length ? { finishOnPassingDraftTools } : {}),
      ...(outputValidationFeedback ? { maxOutputValidationCorrections: 2,
        outputValidationFeedback: (error: unknown) => outputValidationFeedback(error) } : {}),
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}) };
    const runner = this.options.createModelRunner?.(runnerOptions) ?? new OpenAIAgentsSdkRunner(runnerOptions);
    const child: AgentRunRequest<unknown> = { ...request, input: request.input, definition: {
      ...request.definition, config: { ...request.definition.config, instructions, outputFormat: "json" }
    } };
    const output = (await runner.run(child)).output;
    // SIWC already returns validateOutput's transformed value. Validating it again can charge
    // a fifth draft-tool call after an accepted handle. Injected fake runners still fail closed.
    return runner instanceof OpenAIAgentsSdkRunner ? output : await validate(output);
  }

  private async sourceCheck<I>(request: AgentRunRequest<I>, _frozen: ArtifactRef, pinned: PinnedResearchInput,
    directory: string): Promise<unknown> {
    const source = pinned.source as PostWorkflowStartInput;
    const local = freezePostSourceInput(source, directory);
    const media = artifactPath(source.sourceMediaArtifactRef);
    const mediaSha256 = fileDigest(media);
    const relativeRoot = `workflow-responses/${safe(request.runId)}/${safe(request.attemptId)}`;
    let durationText = "";
    try { durationText = (await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1", media], { timeout: 60_000, signal: request.signal })).stdout; }
    catch (error) { if (request.signal.aborted) throw error; }
    const seconds = Number(durationText.trim());
    const duration = Number.isFinite(seconds) && seconds > 0 ? seconds : null;
    const entries: Array<{ ref: string; sha256: string; timeSeconds?: number; label?: string }> = [
      { ref: "post-source-input.json", sha256: fileDigest(path.join(directory, "post-source-input.json")) }];
    if (local.cover?.path) entries.push({ ref: local.cover.path, sha256: fileDigest(path.join(directory, local.cover.path)) });
    const sampleTimes: number[] = [];
    if (duration !== null) for (const [index, ratio] of [0.05, 0.3, 0.55, 0.8].entries()) {
      const time = Math.min(duration - 0.01, Math.max(0, duration * ratio));
      const ref = `frames/sample-${index + 1}.jpg`;
      if (await extractSourceFrame(media, path.join(directory, ref), time, request.signal)) {
        sampleTimes.push(time); entries.push({ ref, sha256: fileDigest(path.join(directory, ref)), timeSeconds: time });
      }
    }
    const methodSha256 = shaText(fs.readFileSync(path.join(projectRoot, "prompts", promptNames["source-check"]), "utf8"));
    if (!sampleTimes.length) {
      const inputSha256 = shaText(stable({ sourceMediaSha256: mediaSha256, evidence: entries }));
      const artifact = sourceConsistencyCheckV2Schema.parse({ schemaVersion: "post-source-consistency@2", inputSha256,
        verdict: "uncertain", summary: "源视频未能生成可读抽帧，无法确认来源一致性。",
        comparisons: [{ postClaim: "原帖标题与正文", bearing: "identity", relation: "insufficient",
          evidenceRefs: [artifactRef(source.creatorRunId, `${relativeRoot}/post-source-input.json`)], reason: "缺少可直接核对的视频帧。" }],
        provenance: { model: "not_invoked", reasoningEffort: "medium", methodSha256, threadId: null } });
      writeJson(directory, "source-consistency-check.json", artifact);
      return { artifact };
    }
    const runRound = async (round: 1 | 2, items: typeof entries, images: string[]) => {
      const base = { schemaVersion: "post-source-consistency-input@2", round,
        postExternalId: source.postExternalId, sourceMediaSha256: mediaSha256, evidence: items };
      const inputSha256 = shaText(stable(base));
      const inputName = `source-consistency-input-round-${round}.json`;
      writeJson(directory, inputName, { ...base, inputSha256 });
      const inputFileSha256 = fileDigest(path.join(directory, inputName));
      const roundTools = new ResponsesEvidenceTools([], directory);
      for (const item of items) roundTools.addGenerated(item.ref, path.join(directory, item.ref));
      roundTools.addGenerated(inputName, path.join(directory, inputName));
      const allowed = new Set(items.map(item => item.ref));
      const imageRefs = new Set(images);
      const validateRoundOutput = (value: unknown) => {
        ensure(value && typeof value === "object", "RESPONSES_SOURCE_CHECK_INVALID");
        const missingAccess: string[] = [];
        if (!roundTools.fullyRead(inputName)) {
          const progress = roundTools.readProgress(inputName);
          missingAccess.push(`read_evidence ${inputName} offset=${progress.nextOffset} total=${progress.totalCharacters}`);
        }
        if (!roundTools.fullyRead("post-source-input.json")) {
          const progress = roundTools.readProgress("post-source-input.json");
          missingAccess.push(`read_evidence post-source-input.json offset=${progress.nextOffset} total=${progress.totalCharacters}`);
        }
        for (const ref of images) if (!roundTools.inspectedImages.has(ref)) missingAccess.push(`inspect_image ${ref}`);
        if (missingAccess.length) throw new Error(`RESPONSES_SOURCE_ROUND_EVIDENCE_UNREAD: ${missingAccess.join("; ")}`);
        const check = sourceConsistencyCheckV2Schema.parse({ ...(value as Record<string, unknown>), inputSha256,
          provenance: { model: request.definition.model, reasoningEffort: request.definition.reasoningEffort,
            methodSha256, threadId: null } });
        const missingRefs = check.comparisons.flatMap((comparison, index) => comparison.evidenceRefs.map(ref => {
          if (!allowed.has(ref)) return `comparison[${index}] ref=${ref} is not bound; allowed=${[...allowed].join(",")}`;
          const read = imageRefs.has(ref) ? roundTools.inspectedImages.has(ref) : roundTools.fullyRead(ref);
          return read ? null : `comparison[${index}] ref=${ref} was not fully read; use ${imageRefs.has(ref) ? "inspect_image" : "read_evidence"} on that exact ref`;
        })).filter((problem): problem is string => problem !== null);
        if (missingRefs.length) throw new Error(`RESPONSES_SOURCE_EVIDENCE_NOT_INSPECTED: ${missingRefs.join("; ")}`);
        if (check.verdict !== "uncertain" && !check.comparisons.flatMap(item => item.evidenceRefs)
          .some(ref => /^(?:frames\/|context\/|contact-sheets\/)/u.test(ref)
            && imageRefs.has(ref) && roundTools.inspectedImages.has(ref))) {
          throw new Error("RESPONSES_SOURCE_IMAGE_REFERENCE_MISSING: cite at least one inspected video frame or context sheet; cover alone is insufficient");
        }
        return check;
      };
      const output = await this.model(request, "source-check", roundTools,
        `ROUND ${round}/2. Read ${inputName} and post-source-input.json; inspect each image in ${JSON.stringify(images)}. Cite only exact refs from the evidence array in ${inputName}; that input JSON is an index, not an independent source to cite. ${round === 1
          ? "Classify identity separately from claim_detail using these four coverage frames and the independent cover."
          : "Make a fresh independent judgment from only the newly sampled timestamped context and cover. You are not given the first-round verdict. A detail disagreement alone is not an identity conflict."} Return semantic fields only; host binds the immutable input hash.`,
      validateRoundOutput, [], error => {
        if (error instanceof Error && /^RESPONSES_SOURCE_(?:ROUND_EVIDENCE_UNREAD|EVIDENCE_NOT_INSPECTED|IMAGE_REFERENCE_MISSING)/u.test(error.message)) {
          return `The source-check output failed a technical evidence-access check: ${error.message}. Correct only the missing reads, pixel inspections, or exact bound evidenceRefs listed above, then return the same semantic assessment. Do not change your verdict to bypass this check; the host binds input hashes and keeps the semantic fields yours.`;
        }
        return null;
      }) as Record<string, unknown>;
      if (fileDigest(media) !== mediaSha256 || fileDigest(path.join(directory, inputName)) !== inputFileSha256
        || items.some(item => fileDigest(path.join(directory, item.ref)) !== item.sha256)) {
        throw new Error("RESPONSES_SOURCE_INPUT_MUTATED");
      }
      const check = validateRoundOutput(output);
      writeJson(directory, `source-consistency-round-${round}.json`, check);
      return check;
    };
    const first = await runRound(1, entries, entries.filter(item => item.ref === local.cover?.path || item.ref.startsWith("frames/"))
      .map(item => item.ref));
    let final = first;
    const needsContext = first.verdict !== "consistent" || first.comparisons.some(item =>
      item.bearing === "claim_detail" && item.relation === "contradicts");
    if (needsContext && duration !== null) {
      const opening = Array.from({ length: 7 }, (_, index) => Math.min(duration - 0.01, index * 2));
      const nearby = sampleTimes.map(time => Math.min(duration - 0.01, Math.max(0,
        time + (time + 2 < duration ? 2 : -2))));
      const times = [...new Set([...opening, ...nearby].filter(value => value >= 0).map(value => value.toFixed(2)))]
        .slice(0, 12).map(Number);
      const contexts: typeof entries = [];
      for (const [index, time] of times.entries()) {
        const label = `CTX-${String(index + 1).padStart(2, "0")}`;
        const ref = `context/${label.toLowerCase()}.jpg`;
        if (await extractSourceFrame(media, path.join(directory, ref), time, request.signal)) {
          contexts.push({ ref, sha256: fileDigest(path.join(directory, ref)), timeSeconds: time, label });
        }
      }
      const sheets: typeof entries = [];
      for (let index = 0; index < contexts.length; index += 6) {
        const ref = `contact-sheets/sheet-${Math.floor(index / 6) + 1}.jpg`;
        if (await sourceContactSheet(contexts.slice(index, index + 6), directory, path.join(directory, ref), request.signal)) {
          sheets.push({ ref, sha256: fileDigest(path.join(directory, ref)) });
        }
      }
      if (sheets.length) final = await runRound(2,
        entries.filter(item => item.ref === "post-source-input.json" || item.ref === local.cover?.path)
          .concat(contexts, sheets), [...(local.cover?.path ? [local.cover.path] : []), ...sheets.map(item => item.ref)]);
      else final = sourceConsistencyCheckV2Schema.parse({ schemaVersion: "post-source-consistency@2",
        inputSha256: first.inputSha256, verdict: "uncertain", summary: "补充上下文证据生成失败，无法确认来源一致性。",
        comparisons: [{ postClaim: "原帖标题与正文", bearing: "identity", relation: "insufficient",
          evidenceRefs: ["post-source-input.json"], reason: "需要补充上下文，但未能生成可供核对的联系表。" }],
        provenance: first.provenance });
    }
    const publicCheck = { ...final, comparisons: final.comparisons.map(item => ({ ...item,
      evidenceRefs: item.evidenceRefs.map(ref => artifactRef(source.creatorRunId, `${relativeRoot}/${ref}`)) })) };
    writeJson(directory, "source-consistency-check.json", publicCheck);
    return { artifact: sourceConsistencyCheckV2Schema.parse(publicCheck) };
  }

  private async review<I>(request: AgentRunRequest<I>, _pinned: PinnedResearchInput, prior: CandidatePayload,
    ref: ArtifactRef, tools: ResponsesEvidenceTools, post: boolean): Promise<unknown> {
    const kind = post ? "post" : "creator";
    const before = prior.reportSha256;
    const checkedFindingHashes = new Set<string>();
    const retryFeedback = (request.input as ReviewInput).retryFeedback;
    const postRequiredTextRefs = post
      ? ["post-source-input.json", "probe.json", "capture-protocol.json", "evidence/evidence-pack.json", "targeted-evidence/targeted-evidence.json",
        "targeted-evidence/ocr-evidence.json"]
        .filter(evidenceRef => tools.list().includes(evidenceRef))
      : [];
    const coverRef = post ? candidateCoverSource(path.dirname(artifactPath(prior.reportArtifactRef)))?.path : null;
    if (coverRef && !tools.list().includes(coverRef)) throw new Error("RESPONSES_CANDIDATE_COVER_NOT_BOUND");
    const readiness = () => {
      const missingText = tools.fullyRead(prior.reportArtifactRef) ? []
        : [{ ref: prior.reportArtifactRef, ...tools.readProgress(prior.reportArtifactRef) }];
      for (const evidenceRef of postRequiredTextRefs) {
        if (!tools.fullyRead(evidenceRef)) missingText.push({ ref: evidenceRef, ...tools.readProgress(evidenceRef) });
      }
      const missingImages = post && !tools.inspectedImages.size ? ["inspect_image at least one bound source image or target frame"] : [];
      if (post && tools.list().includes("evidence/opening-contact.jpg") && !tools.inspectedImages.has("evidence/opening-contact.jpg")) {
        missingImages.push("inspect_image evidence/opening-contact.jpg; test onset claims against the opening sequence");
      }
      if (coverRef && !tools.inspectedImages.has(coverRef)) {
        missingImages.push(`inspect_image ${coverRef}; check the frozen independent post cover`);
      }
      return { ready: missingText.length === 0 && missingImages.length === 0, missingText, missingImages };
    };
    const readinessTool: SiwcTool = { name: "check_review_evidence_readiness",
      description: `Check whether the entire candidate and bound frozen source material have been read; returns exact missing refs and offsets. For post review, read these bound refs when present: ${postRequiredTextRefs.join(", ") || "none"}; inspect bound image pixels.`,
      parameters: { type: "object", additionalProperties: false, properties: {} },
      execute: async () => readiness() };
    const reviewerContextTool: SiwcTool | undefined = post ? {
      name: "read_reviewer_context",
      description: "Read the exact full candidate, frozen post source, probe, protocol, evidence pack, TARGET manifest and OCR when bound, plus overview pixels in one SHA-verified batch. JSON whitespace alone is compacted; no field or model conclusion is removed. On size overflow nothing is marked read: follow the returned readiness offsets with read_evidence and inspect_image.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      execute: async () => {
        const textRefs = [prior.reportArtifactRef, ...postRequiredTextRefs];
        const imageRefs = ["evidence/opening-contact.jpg", "targeted-evidence/contact-sheet.jpg",
          ...(coverRef ? [coverRef] : [])].filter(ref => tools.list().includes(ref));
        const bundle = tools.readBundle(textRefs, imageRefs);
        return postReviewerContextResponse(bundle, readiness());
      }
    } : undefined;
    const comparisonTool = post ? createReviewFindingComparisonTool(prior.report, tools, checkedFindingHashes) : undefined;
    const reviewFrameIndex = post ? frozenFrameIndex(path.dirname(artifactPath(prior.reportArtifactRef))) : undefined;
    const windowTool = reviewFrameIndex?.frames.length ? createEvidenceWindowTool(tools, reviewFrameIndex.frames) : undefined;
    const reviewContract = fs.readFileSync(path.join(projectRoot,
      "packages/research/src/workflows/simple-review-contract.ts"), "utf8");
    const candidateContracts = post
      ? [".agents/skills/video-content-reconstruction/schemas/reconstruction.schema.json",
        ".agents/skills/video-content-reconstruction/schemas/capture-protocol.schema.json"]
      : ["packages/research/src/creator-synthesis/contracts.ts",
        "packages/contracts/src/cross-post-research.ts"];
    const output = await this.model(request, post ? "post-reviewer" : "creator-reviewer", tools,
      `Candidate report reference: ${prior.reportArtifactRef}. Candidate binding: ${JSON.stringify(ref)}. Candidate file SHA-256: ${before}. Review kind: ${kind}. ${post ? `Call read_reviewer_context with {} once to receive complete SHA-verified candidate/source/probe/protocol/pack/TARGET/OCR text and overview pixels. If it reports overflow, read every missing exact ref with read_evidence from nextOffset until totalCharacters and inspect required images; no partial batch reads are credited. Use inspect_evidence_window when available to check visual unknowns and onset claims against all indexed frames in their short time window; the original source video filename is not itself a citable ref.` : "Read the candidate report in full, following every read_evidence nextOffset until totalCharacters."} Before final output, call check_review_evidence_readiness and read any missing offset; RESPONSES_REVIEW_CANDIDATE_UNREAD means the host will reject an incomplete read. Read relevant frozen evidence via tools. ${retryFeedback ? `The previous Reviewer attempt failed with technical feedback ${JSON.stringify(retryFeedback)}; this is a fresh attempt over the same frozen candidate.` : ""} Return a research-review@1 receipt, not a new candidate. Every finding evidenceRefs entry must name an exact bound ref you read or inspected; for an individual cue or JSON field use bound-file-ref#/path/to/field, not an unbound cue ID.
Canonical review output contract (use researchReviewReceiptSchema):
${reviewContract}
Candidate contracts for checking actual fields:
${candidateContracts.map(file => `${file}:\n${fs.readFileSync(path.join(projectRoot, file), "utf8")}`).join("\n")}`,
      value => {
        const state = readiness();
        if (state.missingText.length) throw new Error(`RESPONSES_REVIEW_CANDIDATE_UNREAD: ${state.missingText.map(item =>
          `${item.ref} read_evidence offset=${item.nextOffset} total=${item.totalCharacters}`).join("; ")}`);
        if (state.missingImages.length) throw new Error(`RESPONSES_POST_REVIEW_VISUAL_REQUIRED: ${state.missingImages.join("; ")}`);
        const review = researchReviewReceiptSchema.parse(value);
        const bindingProblems: string[] = [];
        if (review.kind !== kind) bindingProblems.push(`receipt.kind expected=${kind} actual=${review.kind}`);
        if (review.candidate.id !== ref.id || review.candidate.revision !== ref.revision || review.candidate.sha256 !== ref.sha256) {
          bindingProblems.push(`receipt.candidate expected=${JSON.stringify(ref)} actual=${JSON.stringify(review.candidate)}`);
        }
        if (review.candidateReportSha256 !== before) bindingProblems.push(`receipt.candidateReportSha256 expected=${before} actual=${review.candidateReportSha256}`);
        if (bindingProblems.length) throw new Error(`RESPONSES_REVIEW_CANDIDATE_MISMATCH: ${bindingProblems.join("; ")}`);

        const allowedRefs = new Set(tools.list());
        const evidenceProblems: string[] = [];
        for (const finding of review.findings) {
          if (!jsonPointerExists(prior.report, finding.location)) {
            evidenceProblems.push(`finding=${finding.id} location=${finding.location} (not an existing candidate JSON pointer)`);
          }
          for (const evidenceRef of finding.evidenceRefs) {
            const delimiter = evidenceRef.indexOf("#");
            const baseRef = delimiter < 0 ? evidenceRef : evidenceRef.slice(0, delimiter);
            if (!baseRef || !allowedRefs.has(baseRef)) {
              evidenceProblems.push(`finding=${finding.id} location=${finding.location} ref=${evidenceRef} (not bound; use an exact ref from Bound evidence refs)`);
              continue;
            }
            if (delimiter >= 0) {
              const pointer = evidenceRef.slice(delimiter + 1);
              const problem = tools.jsonPointerProblem(baseRef, pointer);
              if (problem) {
                evidenceProblems.push(`finding=${finding.id} location=${finding.location} ref=${evidenceRef} (${problem})`);
                continue;
              }
            }
            if (!tools.readRefs.has(baseRef)) {
              evidenceProblems.push(`finding=${finding.id} location=${finding.location} ref=${evidenceRef} (this exact bound ref has not been read or inspected)`);
              continue;
            }
          }
        }
        if (evidenceProblems.length) throw new Error(`RESPONSES_REVIEW_EVIDENCE_INVALID: ${evidenceProblems.join("; ")}`);
        const uncheckedFindings = post ? review.findings.filter(finding => !checkedFindingHashes.has(reviewFindingHash(finding))) : [];
        if (uncheckedFindings.length) throw new Error(`RESPONSES_REVIEW_COMPARISON_REQUIRED: ${uncheckedFindings.map(finding => finding.id).join(",")}`);
        return review;
      }, [readinessTool, ...(reviewerContextTool ? [reviewerContextTool] : []),
        ...(comparisonTool ? [comparisonTool] : []), ...(windowTool ? [windowTool] : [])], error => {
        if (error instanceof SyntaxError) return `The prior Reviewer output was invalid JSON: ${error.message}. Keep the evidence-backed review and return one complete research-review@1 JSON receipt.`;
        if (error instanceof Error && /^(?:RESPONSES_REVIEW_CANDIDATE_UNREAD|RESPONSES_POST_REVIEW_VISUAL_REQUIRED)/u.test(error.message)) {
          return `Technical review readiness correction: ${error.message}. Use read_evidence at each listed exact offset, inspect required bound images with inspect_image, and call check_review_evidence_readiness again before returning the complete receipt.`;
        }
        if (error instanceof Error && error.message.startsWith("RESPONSES_REVIEW_EVIDENCE_INVALID:")) {
          return `Technical evidence-reference correction: ${error.message}. Use only exact refs listed in Bound evidence refs above. Choose read_evidence for text refs and inspect_image for image or frame refs, and cite a ref only after that exact tool returned its contents/pixels. A ref with # must point to an existing value in a bound JSON file, use valid RFC 6901 escaping, and the complete JSON file must have been read. The original source-video filename may be unbound and cannot be read with read_evidence; use a bound frozen text ref or inspect a bound frame instead. Recheck each finding against the candidate and frozen evidence: keep findings that remain supported, but withdraw a finding if the issue cannot be verified or the candidate already contains the correction. Never remove a finding just to bypass this technical check.`;
        }
        if (error instanceof Error && error.message.startsWith("RESPONSES_REVIEW_COMPARISON_REQUIRED:")) {
          return `Technical finding comparison correction: ${error.message}. Keep every finding that remains supported and withdraw only a finding that rechecking shows is unsupported or already corrected. For each remaining complete finding, call compare_review_finding with that exact finding object, inspect the returned candidate value beside the returned reference values or ordered image pixels, then return the complete receipt. The tool does not decide the semantic verdict; make that judgment yourself. Do not change a finding merely to reuse an earlier comparison.`;
        }
        if (error instanceof Error && error.message.startsWith("RESPONSES_REVIEW_CANDIDATE_MISMATCH:")) {
          return `Technical candidate-binding correction: ${error.message}. Preserve all findings and set kind, candidate id/revision/sha256, and candidateReportSha256 to the exact frozen values supplied above.`;
        }
        if (error instanceof Error && error.name === "ZodError") {
          return `Technical review-schema correction: ${error.message.slice(0, 4000)}. Keep every evidence-backed finding and return a complete canonical receipt.`;
        }
        return null;
      });
    const review = output as ResearchReviewReceipt;
    if (fileDigest(artifactPath(prior.reportArtifactRef)) !== before) throw new Error("RESPONSES_REVIEW_MUTATED_CANDIDATE");
    return { artifact: review, route: review.findings.length ? post ? "repair_post" : "repair" : "deliver",
      findings: review.findings, candidateRevisionSha256: before, candidate: ref };
  }

  private async postBuilder<I>(request: AgentRunRequest<I>, frozen: ArtifactRef, pinned: PinnedResearchInput,
    prior: CandidatePayload | undefined, input: ReviewInput, tools: ResponsesEvidenceTools,
    directory: string, repair: boolean): Promise<unknown> {
    if (repair) return this.postRepair(request, frozen, pinned, prior, input, tools, directory);
    const source = pinned.source as PostWorkflowStartInput;
    const media = artifactPath(source.sourceMediaArtifactRef);
    const skillDir = path.join(projectRoot, ".agents/skills/video-content-reconstruction");
    if (!fs.existsSync(path.join(directory, "post-source-input.json"))) freezePostSourceInput(source, directory);
    await (this.options.prepareMedia ?? prepareBuilderInputs)({ videoPath: media, outputDir: directory, skillDir,
      executeFile: (file, args, options) => execFileAsync(file, args, { cwd: options?.cwd, timeout: options?.timeout,
        env: options?.env, signal: request.signal, maxBuffer: 20 * 1024 * 1024 }) });
    const evidencePackPath = path.join(directory, "evidence/evidence-pack.json");
    const evidencePackDigest = fileDigest(evidencePackPath);
    const preparation = JSON.parse(fs.readFileSync(path.join(directory, "media-preparation.json"), "utf8")) as {
      evidencePack?: { path?: string; fingerprint?: string };
    };
    if (preparation.evidencePack?.fingerprint !== evidencePackDigest
      || (preparation.evidencePack.path && path.resolve(preparation.evidencePack.path) !== path.resolve(evidencePackPath))) {
      throw new Error("RESPONSES_FROZEN_TRANSCRIPT_UNVERIFIED");
    }
    const frozenTranscript = frozenReconstructionTranscriptFromEvidencePack(
      JSON.parse(fs.readFileSync(evidencePackPath, "utf8")) as unknown);
    const injectFrozenTranscript = (value: unknown): Record<string, unknown> => {
      if (fileDigest(evidencePackPath) !== evidencePackDigest) throw new Error("RESPONSES_FROZEN_TRANSCRIPT_CHANGED");
      ensure(value && typeof value === "object" && !Array.isArray(value), "RESPONSES_POST_RECONSTRUCTION_INVALID");
      return { ...(value as Record<string, unknown>), transcript: frozenTranscript };
    };
    tools.addGenerated("post-source-input", path.join(directory, "post-source-input.json"));
    tools.addGenerated("media-preparation", path.join(directory, "media-preparation.json"));
    tools.addGenerated("evidence-pack", path.join(directory, "evidence/evidence-pack.json"));
    bindPreparedPackFrames(tools, directory);
    const opening = path.join(directory, "evidence/opening-contact.jpg");
    if (fs.existsSync(opening)) tools.addGenerated("opening-contact", opening);
    const cover = JSON.parse(fs.readFileSync(path.join(directory, "post-source-input.json"), "utf8")) as { cover?: { path?: string } };
    if (cover.cover?.path) tools.addGenerated("post-cover", path.join(directory, cover.cover.path));
    const review = repair ? await this.payload<Record<string, unknown>>(input.review!) : undefined;
    if (repair) { writeJson(directory, "repair-review.json", review); tools.addGenerated("repair-review", path.join(directory, "repair-review.json")); }
    if (repair && !prior) throw new Error("RESPONSES_REPAIR_PRIOR_REQUIRED");
    const schemasDir = path.join(skillDir, "schemas");
    const schema = (name: string) => fs.readFileSync(path.join(schemasDir, name), "utf8");
    const probeDrafts = new ValidatedDraftStore<{ probe: unknown; captureProtocol: unknown }>(directory, "post-probe");
    const rawProbeValidator = createProbeProtocolDraftValidator(directory, schemasDir,
      JSON.parse(fs.readFileSync(path.join(directory, "evidence/evidence-pack.json"), "utf8")) as unknown,
      async (value, validation) => {
        const receipt = probeDrafts.stage(value, validation);
        await emitDraftEvent(request, "responses.draft_staged", "post-probe", receipt, value);
        return receipt;
      });
    const probeValidator: SiwcTool = { ...rawProbeValidator, execute: async (args, signal) => {
      assertPinnedResearchInput(pinned);
      const result = await rawProbeValidator.execute(args, signal);
      assertPinnedResearchInput(pinned);
      return result;
    } };
    const reviseProbe: SiwcTool = { name: "revise_validated_draft",
      description: `${repair ? "Replace existing fields" : "Replace existing fields, or add a missing property under an existing object"} at wrapper-relative /probe/... or /captureProtocol/... paths in a staged draft, then rerun the exact Phase 1 validator. Arrays must be replaced whole. Use its new passing draftId and sha256 for final acceptance.`,
      parameters: repair ? draftPatchParameters : builderDraftPatchParameters,
      execute: async (args, signal) => {
        assertPinnedResearchInput(pinned);
        try {
          const base = probeDrafts.resolve(draftReference(args), { requireValid: false });
          const patched = applyReconstructionPatch(base, (args as { patches?: unknown }).patches,
            ["probe", "captureProtocol"], { allowAddMissingObjectProperty: !repair }) as { probe: unknown; captureProtocol: unknown };
          const receipt = await probeValidator.execute(patched as never, signal);
          await request.emit("responses.draft_patched", { phase: "post-probe",
            sourceDraftId: (args as { draftId: string }).draftId,
            draftId: (receipt as { draftId?: string }).draftId, sha256: (receipt as { sha256?: string }).sha256,
            byteSize: Buffer.byteLength(JSON.stringify(patched), "utf8") });
          return receipt;
        } catch (error) { return patchErrorResult(error); }
      } };
    const phase1Readiness = () => {
      const required = ["post-source-input", "media-preparation", "evidence-pack"];
      const missingText = required.filter(ref => !tools.fullyRead(ref)).map(ref => ({ ref, ...tools.readProgress(ref) }));
      const missingImages: string[] = [];
      for (const ref of ["opening-contact", "post-cover", ...tools.list().filter(value => /^editing-cuts-\d+$/u.test(value))]) {
        if (tools.list().includes(ref) && !tools.inspectedImages.has(ref)) missingImages.push(`inspect_image ${ref}`);
      }
      if (!tools.inspectedImages.size) missingImages.push("inspect_image at least one bound image");
      return { ready: missingText.length === 0 && missingImages.length === 0, missingText, missingImages };
    };
    const assertPhase1Ready = () => {
      const state = phase1Readiness();
      if (state.missingText.length) throw new Error(`RESPONSES_PHASE1_UNREAD: ${state.missingText.map(item =>
        `${item.ref} read_evidence offset=${item.nextOffset} total=${item.totalCharacters}`).join("; ")}`);
      if (state.missingImages.length) throw new Error(`RESPONSES_PHASE1_VISUAL_UNREAD: ${state.missingImages.join("; ")}`);
    };
    const phase1ReadinessTool: SiwcTool = { name: "check_probe_evidence_readiness",
      description: "Before finalizing the probe, check exact read_evidence offsets for post-source-input, media-preparation and evidence-pack, plus required source images. This is advisory; the host checks again before accepting the passing draft.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      execute: async () => phase1Readiness() };
    const phase1ContextTool: SiwcTool = { name: "read_builder_context",
      description: "Read all required phase-one bound text and overview image pixels in one verified batch. Returns compact full-field JSON, source SHA-256, ordered image refs and readiness after the reads. On overflow use precise read_evidence/inspect_image calls.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      execute: async () => {
        assertPinnedResearchInput(pinned);
        const imageRefs = ["opening-contact", "post-cover", ...tools.list().filter(ref => /^editing-cuts-\d+$/u.test(ref))]
          .filter(ref => tools.list().includes(ref));
        const result = tools.readBundle(["post-source-input", "media-preparation", "evidence-pack"], imageRefs);
        if ("error" in result) return result;
        return { ...result, value: { ...(result.value as Record<string, unknown>), readiness: phase1Readiness() } };
      } };
    let acceptedProbe: ValidatedDraftRef | undefined;
    const first = await this.model(request, repair ? "post-repair" : "post-builder", tools,
      `PHASE 1/2: Call read_builder_context with {} once to receive complete compact phase-one JSON/text and overview pixels, including editing-cut contact pages when present. Inspect additional individual source frames when needed. Its readiness reports remaining requirements; use read_evidence/inspect_image for any overflow or missing refs. Derive capture actions from the actual probe, targeting unresolved questions only. captureProtocol.schemaVersion must be "capture-protocol-2.0" and captureProtocol.probe must be exactly "probe.json" (a file reference, not a sweep ID). Call validate_probe_protocol with your complete draft. For small errors use revise_validated_draft with its draftId and sha256; ${repair ? "replace existing fields only" : "replace existing fields, or add a missing property under an existing object (never into an array)"}. After a passing receipt, return only {"acceptedDraft":{"draftId":"...","sha256":"..."}}; the host resolves and rechecks the exact draft without asking you to output it again. Returning complete {"probe":...,"captureProtocol":...} remains valid. Do not supply targetedEvidence or reconstruction yet. Post: ${source.postExternalId}. ${repair ? `Revise this candidate ${prior?.reportArtifactRef} using review ${JSON.stringify(review ?? input.findings)}.` : ""}\nCanonical probe schema:\n${schema("probe.schema.json")}\nCanonical captureProtocol schema:\n${schema("capture-protocol.schema.json")}`,
      async value => {
        ensure(value && typeof value === "object", "RESPONSES_POST_PROBE_INVALID");
        assertPhase1Ready();
        const row = value as Record<string, unknown>;
        if ("acceptedDraft" in row) {
          acceptedProbe = draftReference(row.acceptedDraft);
          try { return probeDrafts.resolve(acceptedProbe); }
          catch (error) { throw new Error(`RESPONSES_POST_DRAFT_REFERENCE_INVALID:${String(error)}`); }
        }
        ensure(row.probe && typeof row.probe === "object" && row.captureProtocol && typeof row.captureProtocol === "object", "RESPONSES_POST_PROTOCOL_MISSING");
        const checked = await probeValidator.execute({ probe: row.probe, captureProtocol: row.captureProtocol } as never,
          request.signal) as { pass: boolean; errors: DraftError[] };
        if (!checked.pass) throw new Error(`RESPONSES_POST_PROTOCOL_INVALID:${JSON.stringify(checked.errors)}`);
        return row;
      }, [phase1ContextTool, phase1ReadinessTool, probeValidator, reviseProbe], error => {
        if (error instanceof Error && /^RESPONSES_PHASE1_(?:UNREAD|VISUAL_UNREAD)/u.test(error.message)) {
          return `Phase 1 evidence readiness failed: ${error.message}. Read each listed text ref at the exact offset and inspect each listed image, call check_probe_evidence_readiness again, then resubmit the same passing acceptedDraft receipt. Do not rerun validate_probe_protocol just to repeat an unchanged draft. If the newly read evidence changes the probe, use revise_validated_draft and submit its new passing receipt.`;
        }
        return error instanceof Error && /^RESPONSES_POST_(?:DRAFT_REFERENCE_INVALID|PROBE_INVALID|PROTOCOL_MISSING|PROTOCOL_INVALID)/u.test(error.message)
          ? `Technical Phase 1 output rejected: ${error.message}. Use a valid draftId and sha256 from a passing validate_probe_protocol receipt, or return complete probe and captureProtocol JSON.` : null;
      }, !repair ? ["validate_probe_protocol", "revise_validated_draft"] : undefined) as { probe: unknown; captureProtocol: unknown };
    assertPinnedResearchInput(pinned);
    if (!tools.fullyRead("post-source-input") || !tools.fullyRead("media-preparation") || !tools.fullyRead("evidence-pack")) {
      throw new Error("RESPONSES_BUILDER_INPUTS_UNREAD");
    }
    if (!tools.inspectedImages.size || (tools.list().includes("opening-contact") && !tools.inspectedImages.has("opening-contact"))) {
      throw new Error("RESPONSES_BUILDER_VISUAL_REQUIRED");
    }
    if (repair && (!tools.fullyRead(prior!.reportArtifactRef) || !tools.fullyRead("repair-review"))) {
      throw new Error("RESPONSES_REPAIR_CONTEXT_UNREAD");
    }
    if (tools.list().includes("post-cover") && !tools.inspectedImages.has("post-cover")) throw new Error("RESPONSES_COVER_UNINSPECTED");
    writeJson(directory, "probe.json", first.probe);
    writeJson(directory, "capture-protocol.json", first.captureProtocol);
    await validateJsonSchema(path.join(schemasDir, "probe.schema.json"), path.join(directory, "probe.json"));
    await validateJsonSchema(path.join(schemasDir, "capture-protocol.schema.json"), path.join(directory, "capture-protocol.json"));
    validateProbeProtocolLinkage(first.probe, first.captureProtocol,
      JSON.parse(fs.readFileSync(path.join(directory, "evidence/evidence-pack.json"), "utf8")) as unknown);
    if (acceptedProbe) await emitDraftEvent(request, "responses.draft_accepted", "post-probe", acceptedProbe, first);
    tools.addGenerated("probe", path.join(directory, "probe.json"));
    tools.addGenerated("capture-protocol", path.join(directory, "capture-protocol.json"));
    const protocol = first.captureProtocol as { captureActions?: Phase2CaptureAction[] };
    if (protocol.captureActions?.length) {
      await execFileAsync("node", [path.join(skillDir, "scripts/capture-protocol-evidence.mjs"), "--video", media,
        "--protocol", path.join(directory, "capture-protocol.json"), "--out", path.join(directory, "targeted-evidence")],
      { cwd: directory, timeout: 20 * 60_000, signal: request.signal, maxBuffer: 20 * 1024 * 1024 });
    } else throw new Error("RESPONSES_EMPTY_CAPTURE_PROTOCOL");
    const targetedFile = path.join(directory, "targeted-evidence/targeted-evidence.json");
    const targeted = JSON.parse(fs.readFileSync(targetedFile, "utf8")) as {
      frames?: Array<{ id: string; frame: string; time: number; actionId?: string }>;
      actions?: Array<{ id: string; frameIds: string[] }>;
    };
    if (!targeted.frames?.length || targeted.actions?.some(action => !action.frameIds.length)) throw new Error("RESPONSES_TARGETED_CAPTURE_EMPTY");
    const targetIds = new Set(targeted.frames.map(frame => frame.id));
    for (const frame of targeted.frames) {
      if (!/^TARGET-\d{4}$/.test(frame.id) || !frame.frame.startsWith("frames/")) throw new Error("RESPONSES_TARGETED_MANIFEST_INVALID");
      tools.addGenerated(frame.id, path.join(directory, "targeted-evidence", frame.frame));
    }
    if (targeted.actions?.some(action => action.frameIds.some(id => !targetIds.has(id)))) throw new Error("RESPONSES_TARGETED_ACTION_INVALID");
    tools.addGenerated("targeted-evidence", targetedFile);
    tools.addGenerated("targeted-contact", path.join(directory, "targeted-evidence/contact-sheet.jpg"));
    const needsOcr = protocol.captureActions.some(action => action.mode === "ocr_review" || action.mode === "ui_state_review");
    if (needsOcr) {
      const ocrInput = writeOcrInputManifest(directory);
      const ocrOutput = path.join(directory, "targeted-evidence/ocr-evidence.json");
      await execFileAsync("node", [path.join(skillDir, "scripts/run-ocr.mjs"), "--manifest", ocrInput.path,
        "--out", ocrOutput], { cwd: directory,
        timeout: 20 * 60_000, signal: request.signal, maxBuffer: 20 * 1024 * 1024 });
      assertCompleteOcrResult(JSON.parse(fs.readFileSync(ocrOutput, "utf8")), ocrInput.manifest);
      tools.addGenerated("ocr-evidence", ocrOutput);
    }
    // The reconstruction is a fresh model call; only refs, not prior tool observations, carry across.
    tools.resetObservationTracking();
    const frameIndex = frozenFrameIndex(directory);
    const frameTimes = new Map(frameIndex.frames.map(frame => [frame.ref, frame.timeSeconds]));
    const lensReceipts = new Map<BuilderLensSlot, { draftId: string; sha256: string; pass: boolean; errors: string[] }>();
    const lensState = () => Object.fromEntries(lensReceipts);
    const phase2Evidence = { protocolActions: protocol.captureActions ?? [], manifestActions: targeted.actions ?? [], frames: targeted.frames! };
    const readiness = () => phase2Readiness(tools, phase2Evidence, needsOcr, repair ? prior!.reportArtifactRef : undefined);
    const readinessTool: SiwcTool = {
      name: "check_evidence_readiness",
      description: "Before drafting, check minimum required text/image access and review the per-capture-action question, expected observation, target IDs/timestamps, and this-call inspected/uninspected refs. ready means minimum input access only; image inspection does not establish semantic coverage or resolve an action.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      execute: async () => readiness()
    };
    const phase2ContextTool: SiwcTool = { name: "read_builder_context",
      description: "Read all required phase-two bound text and overview image pixels in one verified batch. Returns compact full-field JSON, source hashes, ordered image refs, three canonical lens schemas, the finalSummary schema, reconstruction index schema, and readiness after the reads. Use inspect_evidence_window for unresolved claims or boundaries to inspect all indexed original frames in a short interval; individual inspect_image remains available. On overflow narrow the window or use precise read_evidence/inspect_image calls.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      execute: async () => {
        assertPinnedResearchInput(pinned);
        const refs = ["post-source-input", "media-preparation", "evidence-pack", "probe", "capture-protocol",
          "targeted-evidence", ...(needsOcr ? ["ocr-evidence"] : []),
          ...(repair ? [prior!.reportArtifactRef, "repair-review"] : [])];
        const imageRefs = ["opening-contact", "post-cover", "targeted-contact",
          ...tools.list().filter(ref => /^editing-cuts-\d+$/u.test(ref))]
          .filter(ref => tools.list().includes(ref));
        const result = tools.readBundle(refs, imageRefs);
        const response = phase2BuilderContextResponse(result, path.join(schemasDir, "reconstruction.schema.json"), readiness());
        if ("kind" in response && response.kind === "siwc_visual_tool_result") {
          return { ...response, value: { ...(response.value as object), existingLensDrafts: lensState(),
            existingDraftPolicy: "Preserve staged prose across corrections. Patch only reported fields; do not restart completed lenses." } } as never;
        }
        return { ...response, existingLensDrafts: lensState() } as never;
      } };
    const draftCheck = async (value: unknown, signal: AbortSignal) => {
      assertPinnedResearchInput(pinned);
      const preparedValue = injectFrozenTranscript(value);
      const summaryErrors = finalSummaryContractErrors(preparedValue, directory, true);
      const result = await validateReconstructionDraft({ value: preparedValue, directory, skillDir, media, signal,
        integrity: this.options.validateIntegrity ?? validateBuilderIntegrity });
      assertPinnedResearchInput(pinned);
      return { ...result, pass: result.pass && summaryErrors.length === 0,
        errors: [...result.errors, ...summaryErrors], value: preparedValue };
    };
    const reconstructionDrafts = new ValidatedDraftStore<unknown>(directory, "post-reconstruction");
    const builderLensDrafts = new BuilderLensDrafts(directory, async (slot, value) => {
      const schemaPath = path.join(directory, `.builder-lens-${slot}.schema.json`);
      writeJson(directory, `.builder-lens-${slot}.schema.json`, builderLensSchema(path.join(schemasDir, "reconstruction.schema.json"), slot));
      const errors = await validateDraftJsonSchema(schemaPath, value, directory, request.signal);
      const postSource = slot === "directingLogic"
        ? JSON.parse(fs.readFileSync(path.join(directory, "post-source-input.json"), "utf8")) as {
          facts: { title: string | null; coverHref: string | null }; cover?: unknown }
        : null;
      const localErrors = slot === "contentRestoration"
        ? [...contentBlockVisualDiagnostics(value), ...contentBlockTemporalDiagnostics(value, frameTimes, frameIndex.duration)]
        : slot === "visualEditing"
          ? openingFrameDiagnostics({ builderLenses: { visualEditing: value } }, directory)
          : depthPackagingSourceDiagnostics(value, postSource);
      const allErrors = [...errors.map(error => `SCHEMA ${error.path} ${error.message}`), ...localErrors];
      return { pass: allErrors.length === 0, errors: allErrors };
    });
    let draftChecks = 0;
    const stageReconstruction = async (value: unknown, validation: { pass: boolean; errors: string[] }) => {
      const receipt = reconstructionDrafts.stage(value, validation);
      await emitDraftEvent(request, "responses.draft_staged", "post-reconstruction", receipt, value);
      return { ...receipt, errors: receipt.errors.map(String) };
    };
    const draftTool: SiwcTool = {
      name: "validate_reconstruction_draft",
      description: "Validate a reconstruction draft using canonical assembly, JSON Schema and evidence integrity. For a section index set useLatestBuilderLenses:true and supply finalSummary from the Builder as a separate top-level argument; the host selects the current three exact staged revisions without copying IDs/hashes. Each selected latest revision must pass and its stored hash is verified; failed or missing lenses are never replaced with an older passing version. Do not also provide builderLensDrafts. This never edits the production candidate or evidence.",
      parameters: builderLensDraftToolParameters(path.join(schemasDir, "reconstruction.schema.json")),
      execute: async (args, signal): ReturnType<SiwcTool["execute"]> => {
        const input = args as { reconstruction?: unknown; builderLensDrafts?: unknown; useLatestBuilderLenses?: unknown;
          finalSummary?: unknown };
        let value = input.reconstruction;
        let selectedHandles = input.builderLensDrafts;
        if (input.builderLensDrafts !== undefined || input.useLatestBuilderLenses !== undefined) {
          try {
            if (input.useLatestBuilderLenses !== undefined) {
              if (input.useLatestBuilderLenses !== true || input.builderLensDrafts !== undefined) {
                throw new Error("BUILDER_LENS_HANDLE_SELECTION_AMBIGUOUS");
              }
              selectedHandles = Object.fromEntries(builderLensSlots.map(slot => {
                const latest = builderLensDrafts.latestRef(slot);
                if (!latest) throw new Error(`BUILDER_LENS_HANDLES_INCOMPLETE:${slot}`);
                return [slot, latest];
              }));
            }
            value = builderLensDrafts.compose(input.reconstruction, selectedHandles, input.finalSummary);
          }
          catch (error) {
            if (error instanceof Error && /^(?:BUILDER_LENS_|VALIDATED_DRAFT_(?:REFERENCE|UNKNOWN_OR_SHA_MISMATCH|NOT_VALID|EXPIRED|MANIFEST_CHANGED))/u.test(error.message)) {
              return { pass: false, errors: [`RESPONSES_BUILDER_LENS_DRAFT_INVALID:${error.message}`],
                latestBuilderLensDrafts: Object.fromEntries(builderLensSlots.map(slot => [slot, builderLensDrafts.latestRef(slot) ?? null])),
                recovery: "Keep all staged prose. Correct the failed lens locally, or use useLatestBuilderLenses:true to select current receipts without retyping hashes." };
            }
            throw error;
          }
        }
        if (++draftChecks > 4) return { pass: false, errors: ["Draft validation call limit (4) reached"] };
        const validation = await draftCheck(value, signal);
        return { ...await stageReconstruction(validation.value, validation),
          ...(selectedHandles !== undefined ? { builderLensDraftsUsed: selectedHandles as Record<BuilderLensSlot, ValidatedDraftRef> } : {}) };
      }
    };
    const reviseReconstruction: SiwcTool = { name: "revise_validated_draft",
      description: `Apply bounded ${repair ? "replace-only" : "replace or missing object-property add"} JSON Pointer patches relative to a staged reconstruction and rerun canonical schema and integrity checks. Arrays must be replaced whole. Allowed report roots: ${reconstructionPatchRootList}. derivedSources is Builder-owned source registration; use it for sources such as POST-TITLE when the frozen local file exists. Host-owned probe, protocol, transcript and evidencePack roots are forbidden. A passing receipt can be accepted directly.`,
      parameters: repair ? draftPatchParameters : builderDraftPatchParameters,
      execute: async (args, signal) => {
        assertPinnedResearchInput(pinned);
        if (++draftChecks > 4) return { pass: false, errors: ["Draft validation call limit (4) reached"] };
        try {
          const base = reconstructionDrafts.resolve(draftReference(args), { requireValid: false });
          const patched = applyReconstructionPatch(base, (args as { patches?: unknown }).patches,
            RECONSTRUCTION_PATCH_ALLOWED_ROOTS, { allowAddMissingObjectProperty: !repair });
          const validation = await draftCheck(patched, signal);
          const receipt = await stageReconstruction(validation.value, validation);
          await request.emit("responses.draft_patched", { phase: "post-reconstruction",
            sourceDraftId: (args as { draftId: string }).draftId, draftId: receipt.draftId,
            sha256: receipt.sha256, byteSize: Buffer.byteLength(JSON.stringify(validation.value), "utf8") });
          return receipt;
        } catch (error) { return patchErrorResult(error); }
      } };
    const stageLensTool: SiwcTool = { name: "stage_builder_lens",
      description: "Validate one complete lens against its canonical schema, then store it unchanged in this phase-two attempt. Returns only its slot, draftId, sha256, pass and errors; it does not judge content quality or semantic coverage.",
      parameters: { type: "object", additionalProperties: false, required: ["slot", "value"], properties: {
        slot: { type: "string", enum: [...builderLensSlots] }, value: { type: "object" }
      } },
      execute: async args => {
        assertPinnedResearchInput(pinned);
        const input = args as { slot?: BuilderLensSlot; value?: unknown };
        ensure(input.slot && (builderLensSlots as readonly string[]).includes(input.slot), "BUILDER_LENS_SLOT_INVALID");
        if (!input.value || typeof input.value !== "object" || Array.isArray(input.value)) {
          throw new Error("BUILDER_LENS_VALUE_INVALID");
        }
        const receipt = await builderLensDrafts.stage(input.slot, input.value);
        lensReceipts.set(input.slot, { draftId: receipt.draftId, sha256: receipt.sha256, pass: receipt.pass, errors: receipt.errors.map(String) });
        assertPinnedResearchInput(pinned);
        const handle = { slot: input.slot, draftId: receipt.draftId, sha256: receipt.sha256 };
        await request.emit("responses.draft_staged", { phase: `builder-lens-${input.slot}`, ...handle,
          pass: receipt.pass, errors: receipt.errors });
        return { ...handle, pass: receipt.pass, errors: receipt.errors };
      } };
    const reviseLensTool: SiwcTool = { name: "revise_builder_lens",
      description: "Apply bounded replace or missing object-property add to one latest staged Builder lens. Prefer useLatest:true with slot and patches to select the exact current revision without copying its ID/hash; do not also supply draftId/sha256. Explicit exact handles remain accepted. Paths start /<slot>/. Add requires an existing object parent, never overwrites or inserts into arrays. Preserves every unpatched field; failed latest receipts remain repairable.",
      parameters: { type: "object", additionalProperties: false, required: ["slot", "patches"], properties: {
        slot: { type: "string", enum: [...builderLensSlots] }, draftId: { type: "string" }, sha256: { type: "string" },
        useLatest: { type: "boolean", enum: [true] },
        patches: { type: "array", maxItems: 64, items: { type: "object", additionalProperties: false,
          required: ["op", "path", "value"], properties: {
            op: { type: "string", enum: ["replace", "add"] }, path: { type: "string" }, value: {}
          } } }
      } },
      execute: async args => {
        assertPinnedResearchInput(pinned);
        const input = args as { slot?: BuilderLensSlot; draftId?: string; sha256?: string; patches?: unknown; useLatest?: unknown };
        ensure(input.slot && (builderLensSlots as readonly string[]).includes(input.slot), "BUILDER_LENS_SLOT_INVALID");
        try {
          if (input.useLatest !== undefined && (input.useLatest !== true || input.draftId !== undefined || input.sha256 !== undefined)) {
            throw new Error("BUILDER_LENS_HANDLE_SELECTION_AMBIGUOUS");
          }
          const selected = input.useLatest === true ? builderLensDrafts.latestRef(input.slot) : draftReference(input);
          if (!selected) throw new Error(`BUILDER_LENS_HANDLE_NOT_LATEST:${input.slot}`);
          const receipt = await builderLensDrafts.revise(input.slot, selected, input.patches);
          lensReceipts.set(input.slot, { draftId: receipt.draftId, sha256: receipt.sha256, pass: receipt.pass, errors: receipt.errors.map(String) });
          assertPinnedResearchInput(pinned);
          const handle = { slot: input.slot, draftId: receipt.draftId, sha256: receipt.sha256 };
          await request.emit("responses.draft_patched", { phase: `builder-lens-${input.slot}`, ...handle,
            pass: receipt.pass, errors: receipt.errors });
          return { ...handle, pass: receipt.pass, errors: receipt.errors };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (error instanceof Error && error.name === "AbortError") throw error;
          if (!/^(?:BUILDER_LENS_(?:HANDLE_NOT_LATEST|HANDLE_SELECTION_AMBIGUOUS|SLOT_INVALID)|RESPONSES_POST_DRAFT_REFERENCE_INVALID|RECONSTRUCTION_PATCH_)/u.test(message)) throw error;
          const latest = builderLensDrafts.latestRef(input.slot);
          return { slot: input.slot, ...(latest ?? {}), pass: false, errors: [message] };
        }
      } };
    let acceptedReconstruction: ValidatedDraftRef | undefined;
    const resolveReconstruction = (value: unknown): { reconstruction: unknown; revisionResponse?: unknown } => {
      ensure(value && typeof value === "object" && !Array.isArray(value), "RESPONSES_POST_RECONSTRUCTION_INVALID");
      const row = value as Record<string, unknown>;
      if ("acceptedDraft" in row) {
        acceptedReconstruction = draftReference(row.acceptedDraft);
        try { return { reconstruction: reconstructionDrafts.resolve(acceptedReconstruction), revisionResponse: [] }; }
        catch (error) { throw new Error(`RESPONSES_POST_DRAFT_REFERENCE_INVALID:${String(error)}`); }
      }
      if ("builderLensDrafts" in row) {
        try { return { reconstruction: builderLensDrafts.compose(row.reconstruction, row.builderLensDrafts, row.finalSummary),
          revisionResponse: [] }; }
        catch (error) { throw new Error(`RESPONSES_BUILDER_LENS_DRAFT_INVALID:${String(error)}`); }
      }
      ensure(row.reconstruction && typeof row.reconstruction === "object", "RESPONSES_POST_RECONSTRUCTION_MISSING");
      return row as { reconstruction: unknown; revisionResponse?: unknown };
    };
    const second = await this.model(request, repair ? "post-repair" : "post-builder", tools,
      `PHASE 2/2: This is a fresh model call with no PHASE 1 memory. Call read_builder_context with {} once to receive complete compact phase-two JSON/text, ordered overview pixels, all three Builder lens schemas, the finalSummary schema and the reconstruction index schema. Phase 1 observations do not carry over. Use inspect_evidence_window to resolve local visual/text uncertainties from original DENSE/CUE/CUT/OPEN plus TARGET pixels; TARGET sampling alone may miss a short caption. ${repair ? `Read prior candidate ${prior?.reportArtifactRef} and repair-review in full. ` : ""}Before drafting, resolve any missing refs reported by context readiness; check_evidence_readiness remains available. Ready means minimum input access only. ${repair ? "Use the existing complete reconstruction draft or bounded repair tools; do not use section handles." : "Write and stage all three complete lenses in this same session: for each slot use its schema from read_builder_context, draft that whole lens, then call stage_builder_lens. If a lens receipt fails, fix only the reported fields with revise_builder_lens, with slot, useLatest:true and patches. Replace existing fields or add a missing object property under an existing parent, using /<slot>/... paths; arrays are replaced whole. A failed revised receipt remains the latest and can be revised again. Preserve all unpatched lens content exactly; do not re-draft or re-stage the full lens to fix local errors. Obtain one passing latest receipt for each slot. Then write finalSummary from the model using the schema and frozen post-source facts; distinguish observed metrics from video claims, preserve null when unknown, and do not invent a comparison cohort. Create the reconstruction index without builderLenses, set summaryContractVersion to single-post-summary@1, and call validate_reconstruction_draft with {reconstruction:<index>,useLatestBuilderLenses:true,finalSummary:<your complete summary>}. The host selects and hash-verifies the exact current receipts; never retype IDs or SHA values just to compose these lenses. After a passing receipt, return only its acceptedDraft handle. The host composes stored values unchanged and validates the full report. Staging validates structure only, not content quality or semantic coverage."} Call validate_reconstruction_draft with the appropriate full report or handle index; for small whole-report validation errors call revise_validated_draft with the failed receipt's draftId and sha256; ${repair ? "replace existing fields only" : "replace existing fields, or add a missing property under an existing object (never into an array)"}. After a passing receipt, return only {"acceptedDraft":{"draftId":"...","sha256":"..."}}; the host resolves and rechecks the exact report. This is scratch validation, not approval or permission to invent evidence. The host executed the validated capture protocol. targetedEvidence is host-owned; never invent frame, OCR, path, time or hash. Match actual evidence IDs and use all three full Builder lenses. ${repair ? `Address review ${JSON.stringify(review ?? input.findings)}.` : ""}${repair ? `\nCanonical reconstruction schema:\n${schema("reconstruction.schema.json")}` : ""}`,
      async value => {
        const row = resolveReconstruction(value);
        const state = readiness();
        if (state.missingText.length) throw new Error(`RESPONSES_PHASE2_UNREAD: ${state.missingText.map(item =>
          `${item.ref} read_evidence offset=${item.nextOffset} total=${item.totalCharacters}`).join("; ")}`);
        if (state.missingImages.length) throw new Error(`RESPONSES_PHASE2_VISUAL_UNREAD: ${state.missingImages.join("; ")}`);
        const draft = await draftCheck(row.reconstruction, request.signal);
        if (!draft.pass) throw new Error(`RESPONSES_PHASE2_INTEGRITY: ${draft.errors.join("; ")}`);
        return { ...row, reconstruction: draft.value };
      }, [phase2ContextTool, readinessTool, createEvidenceWindowTool(tools, frameIndex.frames), openingFrameTool(directory, pinned), draftTool, reviseReconstruction,
        ...(repair ? [] : [stageLensTool, reviseLensTool])], error => {
        if (error instanceof SyntaxError) return `Your prior final output was invalid JSON: ${error.message}. Return a valid acceptedDraft with the exact draftId and sha256 from a passing receipt, or a complete reconstruction JSON. Do not omit fields or invent evidence.`;
        if (error instanceof Error && /^(RESPONSES_PHASE2_UNREAD|RESPONSES_PHASE2_VISUAL_UNREAD|RESPONSES_PHASE2_INTEGRITY|RESPONSES_POST_(?:RECONSTRUCTION|DRAFT_REFERENCE)|RESPONSES_BUILDER_LENS_DRAFT_INVALID)/.test(error.message)) {
          return `The host rejected the draft for a technical reason: ${error.message}. Fix unread evidence or use a passing validate_reconstruction_draft receipt's exact draftId and sha256; for small report errors use revise_validated_draft. A full corrected reconstruction remains valid. Current staged lens receipts (preserve their prose; do not restart completed lenses): ${JSON.stringify(lensState())}. Use useLatest:true for a lens patch and useLatestBuilderLenses:true for index composition to avoid copying hashes. Do not invent evidence or let the host rewrite your conclusions.`;
        }
        return null;
      }, !repair ? ["validate_reconstruction_draft", "revise_validated_draft"] : undefined) as { reconstruction: unknown; revisionResponse?: unknown };
    assertPinnedResearchInput(pinned);
    const checkedSecond = resolveReconstruction(second);
    const candidate = checkedSecond.reconstruction as { schemaVersion?: unknown; depthContractVersion?: unknown; builderLenses?: unknown };
    if (candidate.schemaVersion !== "video-reconstruction-2.0" || candidate.depthContractVersion !== "single-post-depth@1"
      || !candidate.builderLenses || typeof candidate.builderLenses !== "object") throw new Error("RESPONSES_BUILDER_THREE_LENS_DEPTH_REQUIRED");
    if (["post-source-input", "media-preparation", "evidence-pack", "probe", "capture-protocol", "targeted-evidence"]
      .some(ref => !tools.fullyRead(ref)) || !tools.inspectedImages.has("targeted-contact")
      || !targeted.frames.some(frame => tools.inspectedImages.has(frame.id))) throw new Error("RESPONSES_TARGETED_EVIDENCE_UNREAD");
    if (["opening-contact", "post-cover", ...tools.list().filter(ref => /^editing-cuts-\d+$/u.test(ref))]
      .some(ref => tools.list().includes(ref) && !tools.inspectedImages.has(ref))) {
      throw new Error("RESPONSES_PHASE2_SOURCE_IMAGES_UNREAD");
    }
    if (needsOcr && !tools.fullyRead("ocr-evidence")) throw new Error("RESPONSES_OCR_EVIDENCE_UNREAD");
    if (repair && (!tools.fullyRead(prior!.reportArtifactRef) || !tools.fullyRead("repair-review"))) {
      throw new Error("RESPONSES_REPAIR_CONTEXT_UNREAD");
    }
    writeJson(directory, "reconstruction.json", checkedSecond.reconstruction);
    const hostAssembly = assembleHostOwnedReconstruction(directory);
    const assembled = JSON.parse(fs.readFileSync(path.join(directory, "reconstruction.json"), "utf8")) as unknown;
    const schemaResult = await runFile("python3", [path.join(skillDir, "scripts/validate-schemas.py"),
      "--probe", path.join(directory, "probe.json"), "--protocol", path.join(directory, "capture-protocol.json"),
      "--reconstruction", path.join(directory, "reconstruction.json")], { cwd: directory, timeout: 10 * 60_000 });
    const schemas = JSON.parse(schemaResult.stdout) as { pass?: boolean };
    if (schemas.pass !== true) throw new Error("RESPONSES_BUILDER_SCHEMA_FAILED");
    const integrity = (this.options.validateIntegrity ?? validateBuilderIntegrity)(directory, media);
    if (acceptedReconstruction) await emitDraftEvent(request, "responses.draft_accepted", "post-reconstruction",
      acceptedReconstruction, checkedSecond.reconstruction);
    const relativeRoot = `workflow-responses/${safe(request.runId)}/${safe(request.attemptId)}`;
    const reportArtifactRef = await this.artifacts.write(source.creatorRunId, `${relativeRoot}/reconstruction.json`, assembled,
      [source.sourceMediaArtifactRef, source.detailArtifactRef]);
    const validation = { schemaVersion: "video-builder-validation@1", passed: true,
      validatedAt: new Date().toISOString(), schemaValidation: schemas, integrityValidation: integrity, hostAssembly };
    const validationRef = await this.artifacts.write(source.creatorRunId, `${relativeRoot}/builder-validation.json`, validation,
      [reportArtifactRef]);
    const outcome = { state: "built_unevaluated", reconstructionArtifactRef: reportArtifactRef,
      articleArtifactRef: null, builderValidationArtifactRef: validationRef, evaluationMode: "skipped" };
    const artifact: CandidatePayload = { kind: "post", evidence: frozen, report: assembled,
      reportArtifactRef, reportSha256: fileDigest(artifactPath(reportArtifactRef)), relativeRoot, outcome };
    if (repair) artifact.revisionResponse = validateRevisionResponse(second.revisionResponse, review);
    return { artifact, validation };
  }

  private async postReuse<I>(request: AgentRunRequest<I>, frozen: ArtifactRef, pinned: PinnedResearchInput,
    directory: string): Promise<unknown> {
    const reuse = pinned.reuseCandidate;
    if (!reuse) throw new Error("RESPONSES_REUSE_CANDIDATE_REQUIRED");
    const source = pinned.source as PostWorkflowStartInput;
    const media = artifactPath(source.sourceMediaArtifactRef);
    const frozenHashes = await copyFrozenPostCandidate(reuse.artifactRef, reuse.sha256, directory, media, this.artifacts);
    await request.emit("responses.candidate_reused", { sourceArtifactRef: reuse.artifactRef, sourceSha256: reuse.sha256 });
    const skillDir = path.join(projectRoot, ".agents/skills/video-content-reconstruction");
    const schemaResult = await runFile("python3", [path.join(skillDir, "scripts/validate-schemas.py"),
      "--probe", path.join(directory, "probe.json"), "--protocol", path.join(directory, "capture-protocol.json"),
      "--reconstruction", path.join(directory, "reconstruction.json")], { cwd: directory, timeout: 10 * 60_000 });
    const schemas = JSON.parse(schemaResult.stdout) as { pass?: boolean };
    if (schemas.pass !== true) throw new Error("RESPONSES_REUSE_SCHEMA_FAILED");
    const integrity = (this.options.validateIntegrity ?? validateBuilderIntegrity)(directory, media);
    assertFrozenPostCandidateFiles(directory, frozenHashes);
    if (fileDigest(artifactPath(reuse.artifactRef)) !== reuse.sha256) throw new Error("RESPONSES_REUSE_MUTATED_SOURCE");
    const relativeRoot = `workflow-responses/${safe(request.runId)}/${safe(request.attemptId)}`;
    const report = JSON.parse(fs.readFileSync(path.join(directory, "reconstruction.json"), "utf8")) as unknown;
    const reportArtifactRef = await this.artifacts.write(source.creatorRunId, `${relativeRoot}/reconstruction.json`, report,
      [source.sourceMediaArtifactRef, source.detailArtifactRef]);
    const validation = { schemaVersion: "video-builder-validation@1", passed: true,
      validatedAt: new Date().toISOString(), schemaValidation: schemas, integrityValidation: integrity,
      hostAssembly: { preservedFromCandidate: true, reuseSourceSha256: reuse.sha256 } };
    const validationRef = await this.artifacts.write(source.creatorRunId, `${relativeRoot}/builder-validation.json`, validation,
      [reportArtifactRef]);
    const outcome = { state: "built_unevaluated", reconstructionArtifactRef: reportArtifactRef,
      articleArtifactRef: null, builderValidationArtifactRef: validationRef, evaluationMode: "skipped" };
    const artifact: CandidatePayload = { kind: "post", evidence: frozen, report, reportArtifactRef,
      reportSha256: fileDigest(artifactPath(reportArtifactRef)), relativeRoot, outcome };
    return { artifact, validation };
  }

  private async postRepair<I>(request: AgentRunRequest<I>, frozen: ArtifactRef, pinned: PinnedResearchInput,
    prior: CandidatePayload | undefined, input: ReviewInput, tools: ResponsesEvidenceTools,
    directory: string): Promise<unknown> {
    if (!prior || prior.kind !== "post" || !input.review || !input.candidate) throw new Error("RESPONSES_REPAIR_PRIOR_REQUIRED");
    const source = pinned.source as PostWorkflowStartInput;
    const media = artifactPath(source.sourceMediaArtifactRef);
    const review = researchReviewReceiptSchema.parse(await this.payload(input.review));
    if (review.kind !== "post" || review.candidate.id !== input.candidate.id
      || review.candidate.sha256 !== input.candidate.sha256 || review.candidateReportSha256 !== prior.reportSha256) {
      throw new Error("RESPONSES_REPAIR_REVIEW_CANDIDATE_MISMATCH");
    }
    const frozenHashes = await copyFrozenPostCandidate(prior.reportArtifactRef, prior.reportSha256, directory, media, this.artifacts);
    await request.emit("responses.candidate_copied", { sourceArtifactRef: prior.reportArtifactRef,
      sourceSha256: prior.reportSha256, reason: "bounded_repair" });
    writeJson(directory, "repair-review.json", review);
    for (const [ref, relative] of [["post-source-input", "post-source-input.json"],
      ["media-preparation", "media-preparation.json"], ["evidence-pack", "evidence/evidence-pack.json"],
      ["probe", "probe.json"], ["capture-protocol", "capture-protocol.json"],
      ["targeted-evidence", "targeted-evidence/targeted-evidence.json"],
      ["targeted-contact", "targeted-evidence/contact-sheet.jpg"], ["repair-review", "repair-review.json"]] as const) {
      tools.addGenerated(ref, path.join(directory, relative));
    }
    bindPreparedPackFrames(tools, directory);
    const cover = JSON.parse(fs.readFileSync(path.join(directory, "post-source-input.json"), "utf8")) as {
      cover?: { path?: string };
    };
    if (cover.cover?.path) tools.addGenerated("post-cover", path.join(directory, cover.cover.path));
    const opening = path.join(directory, "evidence/opening-contact.jpg");
    if (fs.existsSync(opening)) tools.addGenerated("opening-contact", opening);
    const targeted = JSON.parse(fs.readFileSync(path.join(directory, "targeted-evidence/targeted-evidence.json"), "utf8")) as {
      frames?: Array<{ id: string; frame: string; time: number; actionId?: string }>;
      actions?: Array<{ id: string; frameIds: string[] }>;
    };
    if (!targeted.frames?.length) throw new Error("RESPONSES_REPAIR_TARGETED_EVIDENCE_MISSING");
    for (const frame of targeted.frames) {
      if (!/^TARGET-\d{4}$/.test(frame.id) || !/^frames\/[A-Za-z0-9._-]+\.jpg$/.test(frame.frame)) {
        throw new Error("RESPONSES_REPAIR_TARGET_PATH_INVALID");
      }
      tools.addGenerated(frame.id, path.join(directory, "targeted-evidence", frame.frame));
    }
    const protocol = JSON.parse(fs.readFileSync(path.join(directory, "capture-protocol.json"), "utf8")) as {
      captureActions?: Phase2CaptureAction[];
    };
    const needsOcr = protocol.captureActions?.some(action => action.mode === "ocr_review" || action.mode === "ui_state_review") ?? false;
    if (needsOcr) tools.addGenerated("ocr-evidence", path.join(directory, "targeted-evidence/ocr-evidence.json"));
    const phase2Evidence = { protocolActions: protocol.captureActions ?? [], manifestActions: targeted.actions ?? [], frames: targeted.frames };
    const skillDir = path.join(projectRoot, ".agents/skills/video-content-reconstruction");
    const schema = fs.readFileSync(path.join(skillDir, "schemas/reconstruction.schema.json"), "utf8");
    const readiness = () => phase2Readiness(tools, phase2Evidence, needsOcr, prior.reportArtifactRef);
    const readinessTool: SiwcTool = { name: "check_evidence_readiness",
      description: "Check minimum frozen text/image access and review each capture action's question, expected observation, target IDs/timestamps, and this-call inspected/uninspected refs. ready means minimum input access only; image inspection does not establish semantic coverage or resolve an action.",
      parameters: { type: "object", additionalProperties: false, properties: {} }, execute: async () => readiness() };
    const repairContextTool: SiwcTool = { name: "read_repair_context",
      description: "Read the exact frozen prior report, repair review, post source, media preparation, evidence pack, probe, capture protocol, TARGET manifest and OCR when required, plus bound overview pixels in one SHA-verified batch. Only JSON whitespace is compacted. On overflow no observations are recorded; follow exact readiness offsets and inspect missing images.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      execute: async () => {
        const textRefs = [prior.reportArtifactRef, "repair-review", "post-source-input", "media-preparation",
          "evidence-pack", "probe", "capture-protocol", "targeted-evidence", ...(needsOcr ? ["ocr-evidence"] : [])];
        const imageRefs = ["opening-contact", "post-cover", "targeted-contact",
          ...tools.list().filter(ref => /^editing-cuts-\d+$/u.test(ref))].filter(ref => tools.list().includes(ref));
        return postRepairContextResponse(tools.readBundle(textRefs, imageRefs), readiness());
      } };
    const repairAccessGate = () => {
      const state = readiness();
      if (state.ready) return undefined;
      return { pass: false, errors: [
        ...state.missingText.map(item => `RESPONSES_REPAIR_UNREAD: ${item.ref} read_evidence offset=${item.nextOffset} total=${item.totalCharacters}`),
        ...state.missingImages.map(item => `RESPONSES_REPAIR_VISUAL_UNREAD: ${item}`),
        "Call read_repair_context or finish the exact missing reads and inspections, then check_evidence_readiness before validating a repair."
      ], readiness: state };
    };
    const draftCheck = async (value: unknown, signal: AbortSignal) => {
      assertPinnedResearchInput(pinned);
      const result = await validateReconstructionDraft({ value, directory,
        skillDir, media, signal, integrity: this.options.validateIntegrity ?? validateBuilderIntegrity, assemble: false });
      assertPinnedResearchInput(pinned);
      const summaryErrors = finalSummaryContractErrors(value, directory,
        (prior.report as { summaryContractVersion?: unknown }).summaryContractVersion === "single-post-summary@1");
      return { ...result, pass: result.pass && summaryErrors.length === 0,
        errors: [...result.errors, ...summaryErrors] };
    };
    const repairDrafts = new ValidatedDraftStore<{ reconstruction: unknown; revisionResponse?: unknown }>(directory, "post-repair");
    let draftChecks = 0;
    const stageRepair = async (value: { reconstruction: unknown; revisionResponse?: unknown }, signal: AbortSignal) => {
      assertFrozenPostCandidateFiles(directory, frozenHashes);
      const validation = await draftCheck(value.reconstruction, signal);
      assertFrozenPostCandidateFiles(directory, frozenHashes);
      if (fileDigest(artifactPath(prior.reportArtifactRef)) !== prior.reportSha256) throw new Error("RESPONSES_REPAIR_MUTATED_PRIOR");
      const errors = [...validation.errors];
      try { validateRevisionResponse(value.revisionResponse, review); }
      catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
      const receipt = repairDrafts.stage(value, { pass: errors.length === 0, errors });
      await emitDraftEvent(request, "responses.draft_staged", "post-repair", receipt, value);
      return { ...receipt, errors: receipt.errors.map(String) };
    };
    const draftTool: SiwcTool = { name: "validate_reconstruction_draft",
      description: "Validate the repaired report in isolated scratch files against canonical schemas and integrity without changing the prior or frozen evidence.",
      parameters: { type: "object", additionalProperties: false, required: ["reconstruction"],
        properties: { reconstruction: { type: "object" }, revisionResponse: { type: "array" } } },
      execute: async (args, signal) => {
        assertPinnedResearchInput(pinned);
        assertFrozenPostCandidateFiles(directory, frozenHashes);
        if (fileDigest(artifactPath(prior.reportArtifactRef)) !== prior.reportSha256) throw new Error("RESPONSES_REPAIR_MUTATED_PRIOR");
        const unread = repairAccessGate();
        if (unread) return unread;
        return ++draftChecks > 4 ? { pass: false, errors: ["Draft validation call limit (4) reached"] }
          : stageRepair(args as { reconstruction: unknown; revisionResponse?: unknown }, signal);
      } };
    const patchTool: SiwcTool = { name: "validate_reconstruction_patch",
      description: `Apply bounded replace-only patches to the frozen prior reconstruction, validate the complete repaired report and revisionResponse, then stage an exact receipt without rewriting the whole report. Allowed report roots: ${reconstructionPatchRootList}. derivedSources is Builder-owned source registration; use it for sources such as POST-TITLE only when the frozen local file exists. Host-owned probe, protocol, transcript and evidencePack roots remain forbidden.`,
      parameters: { type: "object", additionalProperties: false, required: ["patches", "revisionResponse"],
        properties: { patches: { type: "array" }, revisionResponse: { type: "array" } } },
      execute: async (args, signal) => {
        assertPinnedResearchInput(pinned);
        assertFrozenPostCandidateFiles(directory, frozenHashes);
        if (fileDigest(artifactPath(prior.reportArtifactRef)) !== prior.reportSha256) throw new Error("RESPONSES_REPAIR_MUTATED_PRIOR");
        const unread = repairAccessGate();
        if (unread) return unread;
        if (++draftChecks > 4) return { pass: false, errors: ["Draft validation call limit (4) reached"] };
        try {
          const reconstruction = applyReconstructionPatch(prior.report, (args as { patches?: unknown }).patches);
          const value = { reconstruction, revisionResponse: (args as { revisionResponse?: unknown }).revisionResponse };
          const receipt = await stageRepair(value, signal);
          await request.emit("responses.draft_patched", { phase: "post-repair", sourceSha256: prior.reportSha256,
            draftId: receipt.draftId, sha256: receipt.sha256,
            byteSize: Buffer.byteLength(JSON.stringify(value), "utf8") });
          return receipt;
        } catch (error) { return patchErrorResult(error); }
      } };
    const reviseRepair: SiwcTool = { name: "revise_validated_draft",
      description: `Patch an existing staged repair wrapper: use /reconstruction/<allowed report field>/... or /revisionResponse/... existing paths. Allowed report roots under /reconstruction: ${reconstructionPatchRootList}. This permits repairing Builder-owned derivedSources (including a missing POST-TITLE registration when its local file exists) and correcting receipt IDs without resending the full report; host-owned probe, protocol, transcript and evidencePack roots remain forbidden.`,
      parameters: draftPatchParameters,
      execute: async (args, signal) => {
        assertPinnedResearchInput(pinned);
        assertFrozenPostCandidateFiles(directory, frozenHashes);
        if (fileDigest(artifactPath(prior.reportArtifactRef)) !== prior.reportSha256) throw new Error("RESPONSES_REPAIR_MUTATED_PRIOR");
        const unread = repairAccessGate();
        if (unread) return unread;
        if (++draftChecks > 4) return { pass: false, errors: ["Draft validation call limit (4) reached"] };
        try {
          const base = repairDrafts.resolve(draftReference(args), { requireValid: false });
          const value = applyRepairDraftPatches(base, (args as { patches?: unknown }).patches);
          const receipt = await stageRepair(value, signal);
          await request.emit("responses.draft_patched", { phase: "post-repair",
            sourceDraftId: (args as { draftId: string }).draftId, draftId: receipt.draftId,
            sha256: receipt.sha256, byteSize: Buffer.byteLength(JSON.stringify(value), "utf8") });
          return receipt;
        } catch (error) { return patchErrorResult(error); }
      } };
    let acceptedRepair: ValidatedDraftRef | undefined;
    const resolveRepair = (value: unknown): { reconstruction: unknown; revisionResponse?: unknown } => {
      ensure(value && typeof value === "object" && !Array.isArray(value), "RESPONSES_POST_REPAIR_OUTPUT_INVALID");
      const row = value as Record<string, unknown>;
      if ("acceptedDraft" in row) {
        acceptedRepair = draftReference(row.acceptedDraft);
        try { return repairDrafts.resolve(acceptedRepair); }
        catch (error) { throw new Error(`RESPONSES_POST_DRAFT_REFERENCE_INVALID:${String(error)}`); }
      }
      ensure(row.reconstruction && typeof row.reconstruction === "object", "RESPONSES_POST_REPAIR_RECONSTRUCTION_MISSING");
      return row as { reconstruction: unknown; revisionResponse?: unknown };
    };
    const findingIds = review.findings.map(finding => finding.id);
    const revisionResponseSchema = { type: "array", minItems: findingIds.length, maxItems: findingIds.length,
      items: { type: "object", required: ["id", "status", "reason"],
        properties: { id: { type: "string", enum: findingIds },
          status: { type: "string", enum: ["changed", "disputed", "missing_evidence"] },
          reason: { type: "string", minLength: 1 } } } };
    const revised = await this.model(request, "post-repair", tools,
      `Bounded repair of ${prior.reportArtifactRef}; review ${JSON.stringify(review)}. The original probe, capture protocol, TARGET frames, OCR, source and media preparation are frozen. This is one model call, not a new probe/capture round. Call read_repair_context with {} once for the full SHA-verified prior report, repair review, frozen required text and overview pixels. If it overflows, no partial reads count: use the returned exact refs and offsets with read_evidence and inspect_image until check_evidence_readiness is ready. Inspect the needed original TARGET images as well; the overview batch does not replace that inspection. Earlier image inspections do not carry over. Repair draft and patch tools check this readiness before schema validation; unread evidence yields precise corrective offsets and does not use a validation call. Prefer validate_reconstruction_patch with replace-only patches against the frozen prior plus the complete revisionResponse; it validates the full resulting report. For small corrections to a staged draft use revise_validated_draft. After a passing receipt return only {"acceptedDraft":{"draftId":"...","sha256":"..."}}; the host resolves and rechecks the exact report. Full {"reconstruction":...,"revisionResponse":[...]} remains valid. Revise only reported findings and preserve supported content, all unaffected Builder lenses, evidence IDs and explicit unknowns. Never claim a finding changed unless the report actually changed.\nCanonical revisionResponse required fields (one entry per finding ID; prefer only these three fields):\n${JSON.stringify(revisionResponseSchema)}\nCorrect example for the first finding: ${JSON.stringify({ id: findingIds[0], status: "changed", reason: "The report was revised at the cited location using frozen evidence." })}. The required field is id; findingId cannot substitute for it.\nCanonical reconstruction schema:\n${schema}`,
      async value => {
        const row = resolveRepair(value);
        const state = readiness();
        if (state.missingText.length) throw new Error(`RESPONSES_REPAIR_UNREAD: ${state.missingText.map(item =>
          `${item.ref} read_evidence offset=${item.nextOffset} total=${item.totalCharacters}`).join("; ")}`);
        if (state.missingImages.length) throw new Error(`RESPONSES_REPAIR_VISUAL_UNREAD: ${state.missingImages.join("; ")}`);
        const draft = await draftCheck(row.reconstruction, request.signal);
        if (!draft.pass) throw new Error(`RESPONSES_REPAIR_INTEGRITY: ${draft.errors.join("; ")}`);
        validateRevisionResponse(row.revisionResponse, review);
        return row;
      }, [readinessTool, repairContextTool, openingFrameTool(directory, pinned), draftTool, patchTool, reviseRepair], error => {
        if (error instanceof SyntaxError) return `The prior output was invalid JSON: ${error.message}. Return the exact acceptedDraft from a passing repair receipt, or a complete corrected JSON object.`;
        if (error instanceof Error && /^RESPONSES_(?:REPAIR|POST_REPAIR|POST_DRAFT_REFERENCE|REVISION_RESPONSE)/.test(error.message)) {
          return `The host rejected the repair draft: ${error.message}. Use frozen evidence and correct only reported findings. For patch tools, only these report roots are Builder-owned and patchable: ${reconstructionPatchRootList}; host-owned probe, protocol, transcript and evidencePack roots are frozen. Preserve supported content and unknowns. A passing validate_reconstruction_patch or validate_reconstruction_draft receipt may be accepted by exact draftId and sha256; a complete report remains valid.`;
        }
        return null;
      }) as { reconstruction: unknown; revisionResponse?: unknown };
    assertPinnedResearchInput(pinned);
    const checkedRepair = resolveRepair(revised);
    assertFrozenPostCandidateFiles(directory, frozenHashes);
    writeJson(directory, "reconstruction.json", checkedRepair.reconstruction);
    const schemaResult = await runFile("python3", [path.join(skillDir, "scripts/validate-schemas.py"),
      "--probe", path.join(directory, "probe.json"), "--protocol", path.join(directory, "capture-protocol.json"),
      "--reconstruction", path.join(directory, "reconstruction.json")], { cwd: directory, timeout: 10 * 60_000 });
    const schemas = JSON.parse(schemaResult.stdout) as { pass?: boolean };
    if (schemas.pass !== true) throw new Error("RESPONSES_REPAIR_SCHEMA_FAILED");
    const integrity = (this.options.validateIntegrity ?? validateBuilderIntegrity)(directory, media);
    assertFrozenPostCandidateFiles(directory, frozenHashes);
    if (fileDigest(artifactPath(prior.reportArtifactRef)) !== prior.reportSha256) throw new Error("RESPONSES_REPAIR_MUTATED_PRIOR");
    if (acceptedRepair) await emitDraftEvent(request, "responses.draft_accepted", "post-repair", acceptedRepair, checkedRepair);
    const relativeRoot = `workflow-responses/${safe(request.runId)}/${safe(request.attemptId)}`;
    const report = JSON.parse(fs.readFileSync(path.join(directory, "reconstruction.json"), "utf8")) as unknown;
    const reportArtifactRef = await this.artifacts.write(source.creatorRunId, `${relativeRoot}/reconstruction.json`, report,
      [source.sourceMediaArtifactRef, source.detailArtifactRef]);
    const validation = { schemaVersion: "video-builder-validation@1", passed: true,
      validatedAt: new Date().toISOString(), schemaValidation: schemas, integrityValidation: integrity,
      hostAssembly: { preservedFromCandidate: true } };
    const validationRef = await this.artifacts.write(source.creatorRunId, `${relativeRoot}/builder-validation.json`, validation,
      [reportArtifactRef]);
    const outcome = { state: "built_unevaluated", reconstructionArtifactRef: reportArtifactRef,
      articleArtifactRef: null, builderValidationArtifactRef: validationRef, evaluationMode: "skipped" };
    const artifact: CandidatePayload = { kind: "post", evidence: frozen, report,
      reportArtifactRef, reportSha256: fileDigest(artifactPath(reportArtifactRef)), relativeRoot, outcome,
      revisionResponse: validateRevisionResponse(checkedRepair.revisionResponse, review) };
    return { artifact, validation };
  }

  private async creatorReuse<I>(request: AgentRunRequest<I>, frozen: ArtifactRef, pinned: PinnedResearchInput,
    directory: string): Promise<unknown> {
    const reused = await materializeCreatorReuseCandidate(this.store, this.artifacts, pinned, directory);
    await request.emit("responses.candidate_reused", { sourceCandidate: reused.reusedFrom.candidate,
      sourceArtifactRef: reused.reusedFrom.reportArtifactRef,
      sourceSha256: reused.reusedFrom.reportSha256, reportArtifactRef: reused.reportArtifactRef,
      reportSha256: reused.reportSha256 });
    const outcome = { state: "not_ready" as const, synthesisArtifactRef: reused.reportArtifactRef,
      gateArtifactRef: null, failedGateIds: [], message: "candidate reused for independent review" };
    const artifact: CandidatePayload = { kind: "creator", evidence: frozen, report: reused.report,
      reportArtifactRef: reused.reportArtifactRef, reportSha256: reused.reportSha256,
      relativeRoot: reused.relativeRoot, outcome, reusedFrom: reused.reusedFrom };
    return { artifact };
  }

  private async creatorBuilder<I>(request: AgentRunRequest<I>, frozen: ArtifactRef, pinned: PinnedResearchInput,
    prior: CandidatePayload | undefined, input: ReviewInput, tools: ResponsesEvidenceTools,
    directory: string, repair: boolean): Promise<unknown> {
    const source = pinned.source as CreatorSynthesisWorkflowStartInput;
    const portfolio = creatorPortfolioAnalysisSchema.parse(await this.artifacts.read(source.portfolioArtifactRef));
    const corpus = creatorCorpusSchema.parse(await this.artifacts.read(portfolio.corpusArtifactRef));
    const selection = await this.artifacts.read(source.selectionArtifactRef);
    const batch = videoReconstructionBatchSchema.parse(await this.artifacts.read(source.reconstructionBatchArtifactRef));
    if (repair && (!prior || prior.kind !== "creator" || fileDigest(artifactPath(prior.reportArtifactRef)) !== prior.reportSha256)) {
      throw new Error("RESPONSES_CREATOR_REPAIR_PRIOR_MISMATCH");
    }
    const review = repair ? researchReviewReceiptSchema.parse(await this.payload(input.review!)) : undefined;
    if (repair && (review!.kind !== "creator" || !input.candidate
      || review!.candidate.id !== input.candidate.id || review!.candidate.revision !== input.candidate.revision
      || review!.candidate.sha256 !== input.candidate.sha256
      || review!.candidateReportSha256 !== prior!.reportSha256)) {
      throw new Error("RESPONSES_CREATOR_REPAIR_REVIEW_CANDIDATE_MISMATCH");
    }
    if (repair) { writeJson(directory, "repair-review.json", review); tools.addGenerated("repair-review", path.join(directory, "repair-review.json")); }
    const reuseRequest: CreatorSynthesisRequest = { ...source, creatorName: null, mode: "provisional" };
    const reuseBase = repair ? loadReuseBase(artifactPath(prior!.reportArtifactRef), reuseRequest) : null;
    if (reuseBase) await assertReuseBaseBindings({ base: reuseBase, request: reuseRequest,
      readArtifact: reference => this.artifacts.read(reference) });
    const fixed = reuseBase ? prepareReuseFixedFields(reuseBase.candidate, batch) : null;
    const commonViews = [
      { name: "portfolio", ref: source.portfolioArtifactRef },
      { name: "corpus", ref: portfolio.corpusArtifactRef },
      { name: "selection", ref: source.selectionArtifactRef },
      { name: "detail", ref: source.detailArtifactRef },
      { name: "batch", ref: source.reconstructionBatchArtifactRef },
      ...(source.portfolioAnnotationsArtifactRef
        ? [{ name: "annotations", ref: source.portfolioAnnotationsArtifactRef }] : [])
    ];
    const material = bindCreatorEvidenceViews({ tools, directory, pinned, batchRef: source.reconstructionBatchArtifactRef,
      batchItems: batch.items, sourceRefs: commonViews });
    const frozenCreatorRefs = {
      creatorRunId: source.creatorRunId,
      outputInputs: { portfolioArtifactRef: source.portfolioArtifactRef,
        portfolioAnnotationsArtifactRef: source.portfolioAnnotationsArtifactRef ?? null,
        selectionArtifactRef: source.selectionArtifactRef, detailArtifactRef: source.detailArtifactRef,
        reconstructionBatchArtifactRef: source.reconstructionBatchArtifactRef },
      classificationSourceCorpusArtifactRef: portfolio.corpusArtifactRef,
      commonReadViewToOriginalRef: Object.fromEntries(commonViews.map(({ name, ref }) =>
        [`creator-input/${name}.json`, ref]))
    };
    const mandatory = [...material.requiredRefs,
      ...(repair ? [prior!.reportArtifactRef, "repair-review"] : [])];
    const readiness = () => creatorEvidenceReadiness(tools, mandatory);
    const assertReady = () => {
      const state = readiness();
      if (!state.ready) throw new Error(`RESPONSES_CREATOR_UNREAD: ${state.missingText.map(item =>
        `${item.ref} read_evidence offset=${item.nextOffset} total=${item.totalCharacters}`).join("; ")}`);
      material.verifySources();
    };
    const parseDraft = (value: unknown) => {
      ensure(value && typeof value === "object" && !Array.isArray(value), "RESPONSES_CREATOR_OUTPUT_INVALID");
      const fields = value as Record<string, unknown>;
      if (fields.status === "incomplete") throw new Error("RESPONSES_CREATOR_INCOMPLETE");
      try {
      const candidate = repair ? creatorSynthesisResearchDraftSchema.parse(fields.candidate)
        : creatorSynthesisSchema.parse(fields.candidate ?? value);
      const synthesis = fixed ? assembleReuseCandidateFromFixed({ request: reuseRequest, fixed, draft: candidate })
        : creatorSynthesisSchema.parse(candidate);
      if (synthesis.creatorRunId !== source.creatorRunId
        || synthesis.inputs.portfolioArtifactRef !== source.portfolioArtifactRef
        || (synthesis.inputs.portfolioAnnotationsArtifactRef ?? null) !== (source.portfolioAnnotationsArtifactRef ?? null)
        || synthesis.inputs.selectionArtifactRef !== source.selectionArtifactRef
        || synthesis.inputs.detailArtifactRef !== source.detailArtifactRef
        || synthesis.inputs.reconstructionBatchArtifactRef !== source.reconstructionBatchArtifactRef) {
        throw new Error("RESPONSES_CREATOR_INPUT_BINDING_INVALID");
      }
      if (!synthesis.portfolioClassification) throw new Error("RESPONSES_CREATOR_CLASSIFICATION_MISSING");
      validateAdaptivePortfolioClassification({ classification: synthesis.portfolioClassification, corpus,
        corpusArtifactRef: portfolio.corpusArtifactRef, reconstructionBatch: batch });
      assertValidCrossPostResearch({ selection, batch, synthesis });
      const draftGate = validateCreatorSynthesis({ creatorRunId: source.creatorRunId, selection, batch,
        synthesis, checkedAt: new Date().toISOString() });
      if (repair) validateCreatorRevisionResponse(fields.revisionResponse, review);
      return { candidate, revisionResponse: repair ? fields.revisionResponse : undefined,
        draftGate: { ready: draftGate.ready, failedGateIds: draftGate.failedGateIds } };
      } catch (error) {
        throw new Error(`RESPONSES_CREATOR_DRAFT_INVALID: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error });
      }
    };
    const readinessTool: SiwcTool = { name: "check_creator_evidence_readiness",
      description: "Locate exact unread offsets for every complete frozen creator input and exact per-post Builder three-lens view; this does not approve the report.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      execute: async () => readiness() };
    let draftChecks = 0;
    const draftTool: SiwcTool = { name: "validate_creator_draft",
      description: "Check a complete candidate in scratch memory against canonical schema, frozen sources, classification, cross-post bindings and deterministic gate. Never writes or registers a candidate.",
      parameters: { type: "object", additionalProperties: false, required: ["candidate"], properties: {
        candidate: { type: "object" }, revisionResponse: { type: "array" }
      } },
      execute: async args => {
        if (++draftChecks > 4) return { pass: false, errors: ["Draft validation call limit (4) reached"],
          missingText: [], deterministicGate: null };
        const state = readiness();
        if (!state.ready) return { pass: false, errors: [], missingText: state.missingText,
          deterministicGate: null };
        material.verifySources();
        try { const draft = parseDraft(args);
          return { pass: true, errors: [], missingText: [], deterministicGate: draft.draftGate }; }
        catch (error) { return { pass: false,
          errors: [error instanceof Error ? error.message.slice(0, 6000) : String(error)],
          missingText: [], deterministicGate: null }; }
      } };
    const output = await this.model(request, repair ? "creator-repair" : "creator-builder", tools,
      `Frozen creator source identity and exact original refs: ${JSON.stringify(frozenCreatorRefs)}. The output inputs and classification source must use these exact originals; the common read aliases are for reading only and must not be cited. Read these compact full-field JSON refs in full: ${material.requiredRefs.join(", ")}. Each material-NN view exactly copies all three builderLenses from its pinned original reconstruction and includes batch, review findings/status and evaluation boundaries. Never cite a generated creator-input view; cite only its source.reconstructionArtifactRef and valid original JSON pointer. The common JSON inputs have only formatting whitespace removed; no domain field is omitted. Call check_creator_evidence_readiness and resolve every missing offset before drafting. Call validate_creator_draft with the full candidate and correct technical errors before final output. If you cannot complete, continue reading rather than returning {"status":"incomplete"}. ${repair ? `Repair exact candidate ${prior!.reportArtifactRef} against ${JSON.stringify(review ?? input.findings)}. Return {"candidate": {"identity": ..., "contentSystem": ..., "performance": ..., "crossPostResearch": ..., "boundaries": ...}, "revisionResponse": [...]}. The candidate is a research draft only: omit schemaVersion, creatorRunId, generatedAt, inputs, portfolioClassification, and postAnalyses. The host retains those fixed fields from the verified prior candidate and current frozen batch. Do not rewrite them or regenerate the synthesis. Read the prior candidate and repair-review in full.` : "Return candidate as a complete creator-analysis JSON."}`,
      value => { assertReady(); return parseDraft(value); }, [readinessTool, draftTool], error => {
        if (error instanceof SyntaxError) return `The final response was invalid JSON: ${error.message}. Return the complete creator candidate JSON after checking the frozen evidence.`;
        if (error instanceof Error && /^RESPONSES_CREATOR_(?:SOURCE_CHANGED|VIEW_CHANGED)/.test(error.message)) return null;
        if (error instanceof Error && (error.message.startsWith("RESPONSES_CREATOR_") || error.name === "ZodError")) {
          const state = readiness();
          const missing = state.missingText.map(item => `${item.ref} offset=${item.nextOffset} total=${item.totalCharacters}`).join("; ");
          return `Technical validation rejected the output: ${error.message.slice(0, 6000)}. ${missing ? `Read these remaining frozen pages: ${missing}.` : "All required pages have been read; return the complete candidate with canonical fields."} Do not let the host author missing conclusions.`;
        }
        return null;
      }) as { candidate: unknown; revisionResponse?: unknown };
    if (reuseBase && fileDigest(reuseBase.sourcePath) !== reuseBase.sourceSha256) {
      throw new Error("RESPONSES_CREATOR_REPAIR_MUTATED_PRIOR");
    }
    const revisionResponse = repair ? validateCreatorRevisionResponse(output.revisionResponse, review) : undefined;
    const synthesis = fixed ? assembleReuseCandidateFromFixed({ request: reuseRequest, fixed, draft: output.candidate })
      : creatorSynthesisSchema.parse(output.candidate);
    assertReady();
    if (!synthesis.portfolioClassification) throw new Error("RESPONSES_CREATOR_CLASSIFICATION_MISSING");
    validateAdaptivePortfolioClassification({ classification: synthesis.portfolioClassification, corpus,
      corpusArtifactRef: portfolio.corpusArtifactRef, reconstructionBatch: batch });
    assertValidCrossPostResearch({ selection, batch, synthesis });
    const gate = validateCreatorSynthesis({ creatorRunId: source.creatorRunId, selection, batch,
      synthesis, checkedAt: new Date().toISOString() });
    const relativeRoot = `workflow-responses/${safe(request.runId)}/${safe(request.attemptId)}`;
    const reportArtifactRef = await this.artifacts.write(source.creatorRunId, `${relativeRoot}/creator-analysis.json`, synthesis,
      [source.portfolioArtifactRef, source.selectionArtifactRef, source.reconstructionBatchArtifactRef]);
    const outcome = { state: "not_ready" as const, synthesisArtifactRef: reportArtifactRef, gateArtifactRef: null,
      failedGateIds: gate.ready ? ["independent_evaluation_pending"] : gate.failedGateIds,
      message: "Builder candidate is awaiting independent evaluation and a persisted synthesis gate." };
    const artifact: CandidatePayload = { kind: "creator", evidence: frozen, report: synthesis,
      reportArtifactRef, reportSha256: fileDigest(artifactPath(reportArtifactRef)), relativeRoot, outcome };
    if (repair) artifact.revisionResponse = revisionResponse;
    return { artifact };
  }
}

function writeJson(root: string, relative: string, value: unknown): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function extractSourceFrame(video: string, target: string, time: number, signal: AbortSignal): Promise<boolean> {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try { await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", time.toFixed(3),
    "-i", video, "-frames:v", "1", "-q:v", "2", target], { timeout: 60_000, signal }); }
  catch (error) { if (signal.aborted) throw error; return false; }
  return fs.existsSync(target) && fs.statSync(target).size > 0;
}

async function sourceContactSheet(items: Array<{ ref: string; label?: string; timeSeconds?: number }>,
  directory: string, output: string, signal: AbortSignal): Promise<boolean> {
  if (!items.length) return false;
  const script = `from PIL import Image,ImageDraw\nimport sys\nout=sys.argv[1]; rows=[]\nfor i in range(2,len(sys.argv),3):\n im=Image.open(sys.argv[i]).convert("RGB"); im.thumbnail((360,610)); canvas=Image.new("RGB",(360,640),"black"); canvas.paste(im,((360-im.width)//2,30)); ImageDraw.Draw(canvas).text((8,6),sys.argv[i+1]+"  "+sys.argv[i+2]+"s",fill="white",stroke_width=2,stroke_fill="black"); rows.append(canvas)\nwhile len(rows)<6: rows.append(rows[-1].copy())\nsheet=Image.new("RGB",(1080,1280),"black")\nfor j,im in enumerate(rows[:6]): sheet.paste(im,((j%3)*360,(j//3)*640))\nsheet.save(out,quality=88)`;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  try { await execFileAsync("python3", ["-c", script, output, ...items.flatMap(item =>
    [path.join(directory, item.ref), item.label ?? item.ref, String(item.timeSeconds ?? 0)])],
  { timeout: 60_000, signal }); }
  catch (error) { if (signal.aborted) throw error; return false; }
  return fs.existsSync(output) && fs.statSync(output).size > 0;
}

function bindPreparedPackFrames(tools: ResponsesEvidenceTools, directory: string): void {
  const packFile = path.join(directory, "evidence/evidence-pack.json");
  const pack = JSON.parse(fs.readFileSync(packFile, "utf8")) as { frameIndex?: Array<{ id: string; frame: string }>;
    editingCuts?: { contactSheets?: Array<{ id: string; frame: string }> } };
  const seen = new Set<string>();
  for (const frame of pack.frameIndex ?? []) {
    if (!/^[A-Za-z0-9_-]+$/.test(frame.id) || !/^frames\/[A-Za-z0-9._/-]+\.(?:jpg|jpeg|png)$/.test(frame.frame)
      || frame.frame.split("/").includes("..") || seen.has(frame.id)) {
      throw new Error("RESPONSES_PREPARED_FRAME_PATH_INVALID");
    }
    seen.add(frame.id);
    tools.addGenerated(frame.id, path.join(directory, "evidence", frame.frame));
  }
  for (const sheet of pack.editingCuts?.contactSheets ?? []) {
    if (!/^editing-cuts-\d+$/u.test(sheet.id) || !/^contact\/cuts-\d+\.(?:jpg|jpeg|png)$/u.test(sheet.frame)
      || seen.has(sheet.id)) throw new Error("RESPONSES_PREPARED_CUT_CONTACT_PATH_INVALID");
    seen.add(sheet.id);
    tools.addGenerated(sheet.id, path.join(directory, "evidence", sheet.frame));
  }
}

function postCandidateFileHashes(directory: string, allowedLinks: ReadonlySet<string> = new Set()): Record<string, string> {
  const required = ["post-source-input.json", "media-preparation.json", "probe.json", "capture-protocol.json",
    "reconstruction.json", "evidence/evidence-pack.json", "targeted-evidence/targeted-evidence.json",
    "targeted-evidence/contact-sheet.jpg"];
  const ocrInput = path.join(directory, "ocr-input-manifest.json");
  const ocrEvidence = path.join(directory, "targeted-evidence/ocr-evidence.json");
  const candidateRootOcr = fs.existsSync(ocrEvidence)
    && (JSON.parse(fs.readFileSync(ocrEvidence, "utf8")) as { sourceFrameBase?: string }).sourceFrameBase === "candidate-root";
  if (candidateRootOcr || fs.existsSync(ocrInput)) required.push("ocr-input-manifest.json");
  if (!fs.existsSync(path.join(directory, "post-source-input.json"))) {
    throw new Error("RESPONSES_PRESERVED_CANDIDATE_INCOMPLETE:post-source-input.json");
  }
  const cover = JSON.parse(fs.readFileSync(path.join(directory, "post-source-input.json"), "utf8")) as { cover?: { path?: string } };
  if (cover.cover?.path) required.push(cover.cover.path);
  for (const relative of ["evidence", "targeted-evidence"]) {
    const folder = path.join(directory, relative);
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error("RESPONSES_PRESERVED_CANDIDATE_INCOMPLETE");
    const walk = (current: string) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const file = path.join(current, entry.name);
        if (entry.isSymbolicLink() && !allowedLinks.has(file)) throw new Error("RESPONSES_PRESERVED_CANDIDATE_SYMLINK");
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile() || entry.isSymbolicLink()) required.push(path.relative(directory, file));
      }
    };
    walk(folder);
  }
  const hashes: Record<string, string> = {};
  for (const relative of new Set(required)) {
    const file = path.resolve(directory, relative);
    if (!file.startsWith(`${path.resolve(directory)}${path.sep}`) || !fs.existsSync(file)
      || (fs.lstatSync(file).isSymbolicLink() && !allowedLinks.has(file))
      || !fs.statSync(file).isFile()) throw new Error(`RESPONSES_PRESERVED_CANDIDATE_INCOMPLETE:${relative}`);
    hashes[relative] = fileDigest(file);
  }
  return hashes;
}

async function verifiedCandidateMediaLinks(predecessor: string, reportArtifactRef: string,
  artifacts: CreatorArtifactStore): Promise<Set<string>> {
  const match = /^\/artifacts\/([0-9a-f-]+)\//i.exec(reportArtifactRef);
  if (!match?.[1]) throw new Error("RESPONSES_PRESERVED_CANDIDATE_REFERENCE_INVALID");
  const runId = match[1];
  const runRoot = path.resolve(runArtifactDir(runId));
  if (path.resolve(predecessor) !== runRoot && !path.resolve(predecessor).startsWith(`${runRoot}${path.sep}`))
    throw new Error("RESPONSES_PRESERVED_CANDIDATE_DIRECTORY_INVALID");
  for (let parent = path.resolve(predecessor); parent.startsWith(runRoot); parent = path.dirname(parent)) {
    if (fs.lstatSync(parent).isSymbolicLink()) throw new Error("RESPONSES_PRESERVED_CANDIDATE_DIRECTORY_SYMLINK");
    if (parent === runRoot) break;
  }
  const verifier = (artifacts as CreatorArtifactStore & {
    verifyManagedMediaLink?: (reference: string, filename: string) => Promise<boolean>;
  }).verifyManagedMediaLink?.bind(artifacts);
  const links = new Set<string>();
  const visit = async (folder: string): Promise<void> => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const filename = path.join(folder, entry.name);
      const candidateRelative = path.relative(predecessor, filename);
      if (["phase2-validation", "draft-validation", ".agents"].some(name =>
        candidateRelative === name || candidateRelative.startsWith(`${name}${path.sep}`))) continue;
      if (entry.isDirectory()) { await visit(filename); continue; }
      if (!entry.isSymbolicLink()) continue;
      const relative = path.relative(runRoot, filename).split(path.sep).join("/");
      if (!relative || relative.startsWith("../") || !fs.existsSync(filename)
        || !fs.statSync(filename).isFile() || !verifier
        || !(await verifier(artifactRef(runId, relative), filename))) {
        throw new Error(`RESPONSES_PRESERVED_CANDIDATE_UNVERIFIED_MEDIA:${relative}`);
      }
      links.add(filename);
    }
  };
  await visit(predecessor);
  return links;
}

async function copyFrozenPostCandidate(reportArtifactRef: string, expectedSha256: string,
  directory: string, media: string, artifacts: CreatorArtifactStore): Promise<Record<string, string>> {
  const reportFile = artifactPath(reportArtifactRef);
  const predecessor = path.dirname(reportFile);
  if (path.resolve(predecessor) === path.resolve(directory)) throw new Error("RESPONSES_PRESERVED_CANDIDATE_SAME_ATTEMPT");
  const verifiedLinks = await verifiedCandidateMediaLinks(predecessor, reportArtifactRef, artifacts);
  if (verifiedLinks.has(reportFile) || fs.lstatSync(reportFile).isSymbolicLink())
    throw new Error("RESPONSES_PRESERVED_CANDIDATE_REPORT_LINK");
  if (fileDigest(reportFile) !== expectedSha256) throw new Error("RESPONSES_PRESERVED_CANDIDATE_CHANGED");
  const before = postCandidateFileHashes(predecessor, verifiedLinks);
  fs.cpSync(predecessor, directory, { recursive: true, filter: source => {
    const relative = path.relative(predecessor, source);
    return !["phase2-validation", "draft-validation", ".agents"].some(name =>
      relative === name || relative.startsWith(`${name}${path.sep}`)) && !fs.lstatSync(source).isSymbolicLink();
  } });
  for (const source of verifiedLinks) {
    const destination = path.join(directory, path.relative(predecessor, source));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  const copied = postCandidateFileHashes(directory);
  if (stable(before) !== stable(copied)) throw new Error("RESPONSES_PRESERVED_CANDIDATE_COPY_MISMATCH");
  const manifestPath = path.join(directory, "media-preparation.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    sourceMedia?: { fingerprint?: string }; evidencePack?: { path?: string; fingerprint?: string };
    transcript?: { path?: string | null; fingerprint?: string | null };
  };
  const packFile = path.join(directory, "evidence/evidence-pack.json");
  if (manifest.sourceMedia?.fingerprint !== fileDigest(media)
    || manifest.evidencePack?.fingerprint !== fileDigest(packFile)
    || (manifest.transcript?.path && manifest.transcript.fingerprint !== fileDigest(manifest.transcript.path))) {
    throw new Error("RESPONSES_PRESERVED_CANDIDATE_PREPARATION_MISMATCH");
  }
  manifest.evidencePack!.path = packFile;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const frozen = postCandidateFileHashes(directory);
  delete frozen["reconstruction.json"];
  return frozen;
}

function assertFrozenPostCandidateFiles(directory: string, expected: Record<string, string>): void {
  const current = postCandidateFileHashes(directory);
  delete current["reconstruction.json"];
  if (stable(current) !== stable(expected)) throw new Error("RESPONSES_PRESERVED_EVIDENCE_MUTATED");
}

function candidateCoverSource(reportDir: string): { path: string; sha256: string } | null {
  const sourcePath = path.join(reportDir, "post-source-input.json");
  if (!fs.existsSync(sourcePath)) return null; // Historical candidate without frozen post-source input.
  if (!fs.lstatSync(sourcePath).isFile()) throw new Error("RESPONSES_CANDIDATE_COVER_SOURCE_INVALID");
  const source = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as { cover?: unknown };
  if (source.cover == null) return null;
  const cover = source.cover as { path?: unknown; sha256?: unknown };
  if (typeof cover.path !== "string" || !/^[A-Za-z0-9._/-]+\.(?:jpe?g|png|webp|gif)$/iu.test(cover.path)
    || cover.path.split("/").some(segment => !segment || segment === "." || segment === "..")
    || typeof cover.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(cover.sha256)) {
    throw new Error("RESPONSES_CANDIDATE_COVER_SOURCE_INVALID");
  }
  return { path: cover.path, sha256: cover.sha256 };
}

export function bindPostCandidateFiles(bound: Array<{ ref: string; path: string; sha256: string }>,
  candidate: Pick<CandidatePayload, "reportArtifactRef" | "relativeRoot">, creatorRunId: string): void {
  const root = runArtifactDir(creatorRunId);
  const reportDir = path.dirname(artifactPath(candidate.reportArtifactRef));
  if (path.relative(root, reportDir) !== candidate.relativeRoot || candidate.relativeRoot.split(path.sep).includes("..")) {
    throw new Error("RESPONSES_CANDIDATE_DIRECTORY_MISMATCH");
  }
  const add = (ref: string, relative: string) => {
    const file = path.join(reportDir, relative);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return;
    if (!bound.some(item => item.ref === ref)) bound.push({ ref, path: file, sha256: fileDigest(file) });
  };
  for (const relative of ["post-source-input.json", "media-preparation.json", "probe.json", "capture-protocol.json",
    "evidence/evidence-pack.json", "evidence/opening-contact.jpg", "targeted-evidence/targeted-evidence.json",
    "targeted-evidence/contact-sheet.jpg", "targeted-evidence/ocr-evidence.json"] ) {
    add(relative, relative);
  }
  const cover = candidateCoverSource(reportDir);
  if (cover) {
    const file = path.resolve(reportDir, cover.path);
    const relative = path.relative(reportDir, file);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("RESPONSES_CANDIDATE_COVER_PATH_INVALID");
    }
    let component = reportDir;
    for (const segment of relative.split(path.sep)) {
      component = path.join(component, segment);
      if (!fs.existsSync(component) || fs.lstatSync(component).isSymbolicLink()) {
        throw new Error("RESPONSES_CANDIDATE_COVER_PATH_INVALID");
      }
    }
    if (!fs.statSync(file).isFile() || fileDigest(file) !== cover.sha256) {
      throw new Error("RESPONSES_CANDIDATE_COVER_FINGERPRINT_INVALID");
    }
    const existing = bound.find(item => item.ref === cover.path);
    if (existing && (path.resolve(existing.path) !== file || existing.sha256 !== cover.sha256)) {
      throw new Error("RESPONSES_CANDIDATE_COVER_BINDING_CONFLICT");
    }
    if (!existing) bound.push({ ref: cover.path, path: file, sha256: cover.sha256 });
  }
  const targetedFile = path.join(reportDir, "targeted-evidence/targeted-evidence.json");
  if (fs.existsSync(targetedFile)) {
    const targeted = JSON.parse(fs.readFileSync(targetedFile, "utf8")) as { frames?: Array<{ id: string; frame: string }> };
    for (const frame of targeted.frames ?? []) {
      if (!/^TARGET-\d{4}$/.test(frame.id) || !/^frames\/[A-Za-z0-9._-]+\.jpg$/.test(frame.frame)) {
        throw new Error("RESPONSES_CANDIDATE_TARGET_PATH_INVALID");
      }
      add(frame.id, `targeted-evidence/${frame.frame}`);
    }
  }
  const packFile = path.join(reportDir, "evidence/evidence-pack.json");
  if (fs.existsSync(packFile)) {
    const pack = JSON.parse(fs.readFileSync(packFile, "utf8")) as { frameIndex?: Array<{ id: string; frame: string }>;
      editingCuts?: { contactSheets?: Array<{ id: string; frame: string }> } };
    for (const frame of pack.frameIndex ?? []) {
      if (!/^[A-Za-z0-9_-]+$/.test(frame.id) || !/^[A-Za-z0-9._/-]+\.(?:jpg|jpeg|png)$/.test(frame.frame)
        || frame.frame.split("/").includes("..")) throw new Error("RESPONSES_CANDIDATE_FRAME_PATH_INVALID");
      add(frame.id, `evidence/${frame.frame}`);
    }
    for (const sheet of pack.editingCuts?.contactSheets ?? []) {
      if (!/^editing-cuts-\d+$/u.test(sheet.id) || !/^contact\/cuts-\d+\.(?:jpg|jpeg|png)$/u.test(sheet.frame)) {
        throw new Error("RESPONSES_CANDIDATE_CUT_CONTACT_PATH_INVALID");
      }
      add(sheet.id, `evidence/${sheet.frame}`);
    }
  }
}

function frozenFrameIndex(directory: string) {
  const readOptional = (relative: string) => {
    const file = path.join(directory, relative);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) as unknown : null;
  };
  const pack = readOptional("evidence/evidence-pack.json") as { media?: { duration?: number } } | null;
  return { frames: indexedEvidenceFrames(pack, readOptional("targeted-evidence/targeted-evidence.json")),
    duration: Number(pack?.media?.duration ?? 0) };
}

type DraftError = { document: string; path: string; message: string };
const draftPatchParameters = { type: "object", additionalProperties: false,
  required: ["draftId", "sha256", "patches"], properties: {
    draftId: { type: "string" }, sha256: { type: "string" }, patches: { type: "array" }
  } };
const builderDraftPatchParameters = { ...draftPatchParameters, properties: { ...draftPatchParameters.properties,
  patches: { type: "array", maxItems: 64, items: { type: "object", additionalProperties: false,
    required: ["op", "path", "value"], properties: {
      op: { type: "string", enum: ["replace", "add"] }, path: { type: "string" }, value: {} } } } } };

function patchErrorResult(error: unknown): { pass: false; errors: string[] } {
  const message = error instanceof Error ? error.message : String(error);
  if (/^(?:FROZEN_SOURCE_CHANGED|FROZEN_METHOD_CHANGED|RESPONSES_(?:PRESERVED_EVIDENCE_MUTATED|REPAIR_MUTATED_PRIOR)|VALIDATED_DRAFT_(?:FILE_CHANGED|MANIFEST_CHANGED))/u.test(message)) throw error;
  return { pass: false, errors: [message] };
}

function applyRepairDraftPatches(base: { reconstruction: unknown; revisionResponse?: unknown }, patches: unknown):
{ reconstruction: unknown; revisionResponse?: unknown } {
  if (!Array.isArray(patches) || patches.length > 64) throw new Error("RECONSTRUCTION_PATCH_EDIT_COUNT_INVALID");
  const reportPatches: unknown[] = [];
  const responsePatches: unknown[] = [];
  for (const edit of patches) {
    const pointer = edit && typeof edit === "object" ? (edit as { path?: unknown }).path : undefined;
    if (typeof pointer !== "string") throw new Error("RECONSTRUCTION_PATCH_EDIT_INVALID");
    if (pointer.startsWith("/reconstruction/")) reportPatches.push({ ...edit, path: pointer.slice("/reconstruction".length) });
    else if (pointer === "/revisionResponse" || pointer.startsWith("/revisionResponse/")) responsePatches.push(edit);
    else throw new Error("RECONSTRUCTION_PATCH_ROOT_NOT_ALLOWED");
  }
  const reconstruction = reportPatches.length ? applyReconstructionPatch(base.reconstruction, reportPatches)
    : base.reconstruction;
  const revisionResponse = responsePatches.length
    ? (applyReconstructionPatch({ revisionResponse: base.revisionResponse }, responsePatches,
      ["revisionResponse"]) as { revisionResponse: unknown }).revisionResponse
    : base.revisionResponse;
  return { reconstruction, revisionResponse };
}

function draftReference(value: unknown): ValidatedDraftRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RESPONSES_POST_DRAFT_REFERENCE_INVALID");
  const row = value as Record<string, unknown>;
  if (typeof row.draftId !== "string" || typeof row.sha256 !== "string") {
    throw new Error("RESPONSES_POST_DRAFT_REFERENCE_INVALID");
  }
  return { draftId: row.draftId, sha256: row.sha256 };
}

async function emitDraftEvent<I>(request: AgentRunRequest<I>, type: string, phase: string,
  ref: ValidatedDraftRef & { pass?: boolean }, value: unknown): Promise<void> {
  await request.emit(type, { phase, draftId: ref.draftId, sha256: ref.sha256,
    ...(typeof ref.pass === "boolean" ? { pass: ref.pass } : {}),
    byteSize: Buffer.byteLength(JSON.stringify(value), "utf8") });
}

/** Validates an in-memory draft against the same schema/linkage gates used after phase 1. */
export function createProbeProtocolDraftValidator(directory: string, schemasDir: string, pack: unknown,
  stage?: (value: { probe: unknown; captureProtocol: unknown }, validation: { pass: boolean; errors: DraftError[] }) => Promise<unknown>): SiwcTool {
  let calls = 0;
  return {
    name: "validate_probe_protocol",
    description: "Check a proposed probe and captureProtocol against canonical schemas, host linkage, and the exact capture time budget. Returns action counts and exact errors for correction; never writes final reports or captures media.",
    parameters: { type: "object", additionalProperties: false, required: ["probe", "captureProtocol"], properties: {
      probe: { type: "object" }, captureProtocol: { type: "object" }
    } },
    execute: async (args, signal) => {
      if (++calls > 4) return { pass: false, errors: [{ document: "draft", path: "/", message: "Draft validation call limit (4) reached" }] };
      const fields = args as { probe?: unknown; captureProtocol?: unknown };
      if (!fields.probe || typeof fields.probe !== "object" || Array.isArray(fields.probe)
        || !fields.captureProtocol || typeof fields.captureProtocol !== "object" || Array.isArray(fields.captureProtocol)) {
        return { pass: false, errors: [{ document: "draft", path: "/", message: "probe and captureProtocol must be objects" }] };
      }
      const probeText = JSON.stringify(fields.probe);
      const protocolText = JSON.stringify(fields.captureProtocol);
      if (probeText.length > 2_000_000 || protocolText.length > 2_000_000) {
        return { pass: false, errors: [{ document: "draft", path: "/", message: "Draft exceeds 2 MB per document" }] };
      }
      const draftDir = path.join(directory, "draft-validation");
      fs.mkdirSync(draftDir, { recursive: true, mode: 0o700 });
      const probeFile = path.join(draftDir, "probe.json");
      const protocolFile = path.join(draftDir, "capture-protocol.json");
      fs.writeFileSync(probeFile, probeText);
      fs.writeFileSync(protocolFile, protocolText);
      const code = `import json,sys\nfrom jsonschema import Draft202012Validator\nout=[]\nfor name,schema_file,document_file in (("probe",sys.argv[1],sys.argv[2]),("captureProtocol",sys.argv[3],sys.argv[4])):\n schema=json.load(open(schema_file)); document=json.load(open(document_file))\n for error in list(Draft202012Validator(schema).iter_errors(document))[:20]:\n  out.append({"document":name,"path":"/"+"/".join(str(part) for part in error.path),"message":error.message})\nprint(json.dumps(out,ensure_ascii=False))`;
      const result = await execFileAsync("python3", ["-c", code,
        path.join(schemasDir, "probe.schema.json"), probeFile,
        path.join(schemasDir, "capture-protocol.schema.json"), protocolFile],
      { cwd: draftDir, timeout: 60_000, signal, maxBuffer: 1_000_000 });
      const errors = JSON.parse(result.stdout) as DraftError[];
      if (!errors.length) {
        try { validateProbeProtocolLinkage(fields.probe, fields.captureProtocol, pack); }
        catch (error) { errors.push(...explainLinkageError(error, fields.probe, fields.captureProtocol)); }
      }
      if (!errors.length) {
        const duration = Number((pack as { media?: { duration?: number } }).media?.duration);
        const preview = await execFileAsync("node", [path.join(path.dirname(schemasDir), "scripts/capture-plan-preview.mjs"),
          "--protocol", protocolFile, "--duration", String(duration)],
        { cwd: draftDir, timeout: 60_000, signal, maxBuffer: 1_000_000 });
        const plan = JSON.parse(preview.stdout) as { errors: Array<{ path: string; message: string }>;
          actions: Array<{ id: string; selectedTimes: number[] }> };
        errors.push(...plan.errors.map(error => ({ document: "captureProtocol", ...error })));
        if (!errors.length) {
          const ocrPlan = preflightOcrInputUnion(pack, fields.captureProtocol, plan.actions);
          errors.push(...ocrPlan.errors.map(error => ({ document: "captureProtocol", path: error.path,
            message: `${error.message} Actions: ${ocrPlan.actions.map(action =>
              `${action.id} ${action.range.start}–${action.range.end}s source=${action.sourceFrames} plannedTARGET=${action.plannedTargetTimes}`).join("; ")}.` })));
        }
      }
      const validation = { pass: errors.length === 0, errors };
      return { ...validation, ...(stage ? await stage({ probe: fields.probe, captureProtocol: fields.captureProtocol }, validation) as object : {}) };
    }
  };
}

function explainLinkageError(error: unknown, probeValue: unknown, protocolValue: unknown): DraftError[] {
  const code = error instanceof Error ? error.message : "RESPONSES_PROTOCOL_LINKAGE_INVALID";
  const probe = probeValue as Record<string, unknown>;
  const protocol = protocolValue as Record<string, unknown>;
  if (code === "RESPONSES_PROTOCOL_VERSION_OR_PROBE_MISMATCH") {
    const errors: DraftError[] = [];
    if (protocol.schemaVersion !== "capture-protocol-2.0") errors.push({ document: "captureProtocol",
      path: "/schemaVersion", message: 'Must equal "capture-protocol-2.0"' });
    if (protocol.probe !== "probe.json") errors.push({ document: "captureProtocol",
      path: "/probe", message: 'Must equal "probe.json"; this field names the probe file, not a SWEEP ID' });
    return errors;
  }
  if (code === "RESPONSES_PROTOCOL_NOT_PROBE_DERIVED") {
    const groups = ["carrierSweep", "informationCarriers", "meaningChanges", "relationshipHypotheses",
      "omissionRisks", "criticalQuestions"];
    const ids = new Set(groups.flatMap(group => Array.isArray(probe[group])
      ? (probe[group] as Array<{ id?: string }>).map(row => row.id).filter((id): id is string => typeof id === "string") : []));
    const errors: DraftError[] = [];
    for (const group of ["knowledgeUnitFields", "captureActions", "requiredRelations"] as const) {
      const rows = protocol[group];
      if (!Array.isArray(rows)) continue;
      rows.forEach((row: { derivedFrom?: string[] }, index: number) => {
        if (!row.derivedFrom?.length) errors.push({ document: "captureProtocol",
          path: `/${group}/${index}/derivedFrom`, message: `Must cite probe IDs; allowed: ${[...ids].join(", ")}` });
        row.derivedFrom?.forEach((id, idIndex) => {
          if (!ids.has(id)) errors.push({ document: "captureProtocol",
            path: `/${group}/${index}/derivedFrom/${idIndex}`,
            message: `Unknown probe ID ${id}; allowed: ${[...ids].join(", ")}. Capture-action IDs cannot serve as probe sources.` });
        });
      });
    }
    return errors.length ? errors.slice(0, 20) : [{ document: "captureProtocol", path: "/", message: code }];
  }
  return [{ document: "draft", path: "/", message: code }];
}

export type Phase2CaptureAction = { id: string; mode?: string; reason?: string; expectedObservation?: string;
  range?: { start: number; end: number }; carrier?: string };
export type Phase2EvidenceOverview = {
  protocolActions: readonly Phase2CaptureAction[];
  manifestActions: readonly { id: string; frameIds: readonly string[] }[];
  frames: readonly { id: string; time: number; actionId?: string }[];
};

export function phase2Readiness(tools: ResponsesEvidenceTools, evidence: Phase2EvidenceOverview,
  needsOcr: boolean, priorReportRef?: string): {
    ready: boolean;
    readinessScope: "minimum_input_access";
    semanticCoverage: "not_evaluated";
    missingText: Array<{ ref: string; nextOffset: number; totalCharacters: number }>;
    missingImages: string[];
    inspectedTargetRefs: string[];
    uninspectedTargetRefs: string[];
    actionCoverage: Array<{ id: string; question: string | null; expectedObservation: string | null;
      timeRange: { start: number; end: number } | null; targetFrames: Array<{ ref: string; timeSeconds: number }>;
      inspectedRefs: string[]; uninspectedRefs: string[]; semanticCoverage: "not_evaluated" }>;
  } {
  const required = ["post-source-input", "media-preparation", "evidence-pack", "probe", "capture-protocol", "targeted-evidence",
    ...(needsOcr ? ["ocr-evidence"] : []), ...(priorReportRef ? [priorReportRef, "repair-review"] : [])];
  const missingText = required.filter(ref => !tools.fullyRead(ref)).map(ref => ({ ref, ...tools.readProgress(ref) }));
  const targetFrames = evidence.frames.map(frame => ({ ref: frame.id, timeSeconds: frame.time }));
  const inspectedTargetRefs = targetFrames.filter(frame => tools.inspectedImages.has(frame.ref)).map(frame => frame.ref);
  const uninspectedTargetRefs = targetFrames.filter(frame => !tools.inspectedImages.has(frame.ref)).map(frame => frame.ref);
  const frameById = new Map(evidence.frames.map(frame => [frame.id, frame]));
  const actionCoverage = evidence.protocolActions.map(action => {
    const frameIds = evidence.manifestActions.find(manifestAction => manifestAction.id === action.id)?.frameIds ?? [];
    const frames = frameIds.flatMap(ref => {
      const frame = frameById.get(ref);
      return frame ? [{ ref, timeSeconds: frame.time }] : [];
    });
    const inspectedRefs = frames.filter(frame => tools.inspectedImages.has(frame.ref)).map(frame => frame.ref);
    return { id: action.id, question: action.reason ?? null, expectedObservation: action.expectedObservation ?? null,
      timeRange: action.range ?? null, targetFrames: frames, inspectedRefs,
      uninspectedRefs: frames.filter(frame => !tools.inspectedImages.has(frame.ref)).map(frame => frame.ref),
      semanticCoverage: "not_evaluated" as const };
  });
  const missingImages: string[] = [];
  for (const ref of ["opening-contact", "post-cover", ...tools.list().filter(value => /^editing-cuts-\d+$/u.test(value))]) {
    if (tools.list().includes(ref) && !tools.inspectedImages.has(ref)) missingImages.push(`inspect_image ${ref}`);
  }
  if (!tools.inspectedImages.has("targeted-contact")) missingImages.push("inspect_image targeted-contact");
  if (!inspectedTargetRefs.length) {
    missingImages.push(`inspect_image at least one TARGET frame: ${targetFrames.map(frame => frame.ref).join(", ")}`);
  }
  return { ready: missingText.length === 0 && missingImages.length === 0,
    readinessScope: "minimum_input_access", semanticCoverage: "not_evaluated", missingText, missingImages,
    inspectedTargetRefs, uninspectedTargetRefs, actionCoverage };
}

/** Keep readiness and overflow guidance attached to the exact verified reviewer batch. */
export function postReviewerContextResponse(bundle: ReturnType<ResponsesEvidenceTools["readBundle"]>,
  readiness: { ready: boolean; missingText: Array<{ ref: string; nextOffset: number; totalCharacters: number }>;
    missingImages: string[] }) {
  if ("error" in bundle) return { ...bundle, readiness,
    recovery: "The full verified reviewer context exceeds a batch limit; no observations were recorded. Read each exact missing text ref from readiness with read_evidence at nextOffset until totalCharacters, inspect the required bound images, then call check_review_evidence_readiness." };
  return { ...bundle, value: { ...(bundle.value as Record<string, unknown>), readiness, readinessScope: "minimum_input_access",
    semanticCoverage: "not_evaluated" } } as SiwcVisualToolResult;
}

/** Preserve the frozen repair inputs and exact missing offsets when a full batch cannot fit. */
export function postRepairContextResponse(bundle: ReturnType<ResponsesEvidenceTools["readBundle"]>,
  readiness: ReturnType<typeof phase2Readiness>) {
  if ("error" in bundle) return { ...bundle, readiness,
    recovery: "The full verified repair context exceeds a batch limit; no observations were recorded. Read each exact missing text ref from readiness with read_evidence at nextOffset until totalCharacters, inspect required bound images, then call check_evidence_readiness." };
  return { ...bundle, value: { ...(bundle.value as Record<string, unknown>), readiness,
    readinessScope: "minimum_input_access", semanticCoverage: "not_evaluated" } } as SiwcVisualToolResult;
}

function finalSummaryContractErrors(value: unknown, directory: string, required: boolean): string[] {
  const report = value && typeof value === "object" && !Array.isArray(value)
    ? value as { summaryContractVersion?: unknown; builderLenses?: { finalSummary?: unknown } } : {};
  if (!required && report.summaryContractVersion === undefined) return [];
  const errors: string[] = [];
  if (report.summaryContractVersion !== "single-post-summary@1") {
    errors.push("RESPONSES_FINAL_SUMMARY_CONTRACT_REQUIRED: set summaryContractVersion to single-post-summary@1");
  }
  if (report.builderLenses?.finalSummary === undefined) {
    errors.push("RESPONSES_FINAL_SUMMARY_REQUIRED: Builder must write builderLenses.finalSummary");
  } else {
    const frozenSource = JSON.parse(fs.readFileSync(path.join(directory, "post-source-input.json"), "utf8")) as {
      facts?: unknown };
    try { assertFinalSummaryPerformance(report.builderLenses.finalSummary,
      postSourceFactsSchema.parse(frozenSource.facts)); }
    catch (error) { errors.push(`RESPONSES_FINAL_SUMMARY_SOURCE_FACTS:${String(error)}`); }
  }
  return errors;
}

/** Schemas are static method inputs, so they remain available when a large evidence batch must be paged. */
export function phase2BuilderContextResponse(bundle: ReturnType<ResponsesEvidenceTools["readBundle"]>,
  schemaPath: string, readiness: ReturnType<typeof phase2Readiness>): SiwcVisualToolResult | Record<string, unknown> {
  const canonical = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as { $defs: Record<string, unknown> };
  const schemas = { builderLensSchemas: Object.fromEntries(builderLensSlots.map(slot =>
    [slot, builderLensSchema(schemaPath, slot)])), reconstructionIndexSchema: builderLensIndexSchema(schemaPath),
    finalSummarySchema: canonical.$defs.finalSummary, summaryContractVersion: "single-post-summary@1" };
  if ("error" in bundle) return { ...bundle, ...schemas, readiness };
  return { ...bundle, value: { ...(bundle.value as Record<string, unknown>), ...schemas, readiness } } as SiwcVisualToolResult;
}

async function validateJsonSchema(schemaPath: string, documentPath: string): Promise<void> {
  const code = `import json,sys\nfrom jsonschema import Draft202012Validator\nschema=json.load(open(sys.argv[1]))\ndocument=json.load(open(sys.argv[2]))\nerrors=list(Draft202012Validator(schema).iter_errors(document))\nif errors:\n print(json.dumps([{"path":list(e.path),"message":e.message} for e in errors[:20]],ensure_ascii=False))\n sys.exit(2)\n`;
  await runFile("python3", ["-c", code, schemaPath, documentPath], { timeout: 60_000 });
}

async function validateDraftJsonSchema(schemaPath: string, value: unknown, directory: string,
  signal: AbortSignal): Promise<Array<{ path: string; message: string }>> {
  const draftDir = path.join(directory, "phase2-validation");
  fs.mkdirSync(draftDir, { recursive: true, mode: 0o700 });
  const draftFile = path.join(draftDir, "reconstruction.json");
  const document = JSON.stringify(value);
  if (document.length > 8_000_000) return [{ path: "/", message: "Reconstruction exceeds 8 MB" }];
  fs.writeFileSync(draftFile, document);
  const code = `import json,sys\nfrom jsonschema import Draft202012Validator\nschema=json.load(open(sys.argv[1])); document=json.load(open(sys.argv[2]))\nprint(json.dumps([{"path":"/"+"/".join(str(part) for part in error.path),"message":error.message} for error in list(Draft202012Validator(schema).iter_errors(document))[:20]],ensure_ascii=False))`;
  const result = await execFileAsync("python3", ["-c", code, schemaPath, draftFile],
    { cwd: draftDir, timeout: 60_000, signal, maxBuffer: 1_000_000 });
  return JSON.parse(result.stdout) as Array<{ path: string; message: string }>;
}

function openingFrameDiagnostics(value: unknown, directory: string): string[] {
  const pack = JSON.parse(fs.readFileSync(path.join(directory, "evidence/evidence-pack.json"), "utf8")) as {
    media?: { duration?: number }; frameIndex?: Array<{ id: string; time: number }>;
  };
  const targets = JSON.parse(fs.readFileSync(path.join(directory, "targeted-evidence/targeted-evidence.json"), "utf8")) as {
    frames?: Array<{ id: string; time: number }>;
  };
  const frames = new Map<string, number>();
  for (const frame of [...(pack.frameIndex ?? []), ...(targets.frames ?? [])]) {
    if (frame.id && Number.isFinite(frame.time)) frames.set(frame.id, frame.time);
  }
  const ocrPath = path.join(directory, "targeted-evidence/ocr-evidence.json");
  if (fs.existsSync(ocrPath)) {
    const ocr = JSON.parse(fs.readFileSync(ocrPath, "utf8")) as { frames?: Array<{ time: number; lines?: Array<{ id: string }> }> };
    for (const frame of ocr.frames ?? []) for (const line of frame.lines ?? []) {
      if (line.id && Number.isFinite(frame.time)) frames.set(line.id, frame.time);
    }
  }
  return collectOpeningFrameDiagnostics(value, Number(pack.media?.duration), frames);
}

function openingFrameTool(directory: string, pinned: PinnedResearchInput): SiwcTool {
  let checks = 0;
  return { name: "check_opening_frames",
    description: "Before writing the full report, check the opening time skeleton only. Supply openingAnalysis {duration,segments:[{id,timeRange:{start,end},frameRefs}]}. Returns ALL range/coverage issues with real available frame timestamps; never changes your segments or conclusions. Advisory only; final canonical validation still runs.",
    parameters: { type: "object", additionalProperties: false, required: ["openingAnalysis"],
      properties: { openingAnalysis: { type: "object" } } },
    execute: async (args) => {
      assertPinnedResearchInput(pinned);
      if (++checks > 4) return { pass: false, errors: ["Opening preflight call limit (4) reached"] };
      const errors = openingFrameDiagnostics({ builderLenses: { visualEditing: {
        openingAnalysis: (args as { openingAnalysis?: unknown }).openingAnalysis } } }, directory);
      return { pass: errors.length === 0, errors };
    } };
}

async function validateReconstructionDraft(options: {
  value: unknown; directory: string; skillDir: string; media: string; signal: AbortSignal;
  integrity: typeof validateBuilderIntegrity;
  assemble?: boolean;
}): Promise<{ pass: boolean; errors: string[] }> {
  const { value, directory, skillDir, media, signal, integrity } = options;
  const openingErrors = openingFrameDiagnostics(value, directory);
  const diagnosticErrors = (errors: string[]) => [...new Set([...errors, ...openingErrors])].slice(0, 40);
  const schemaErrors = await validateDraftJsonSchema(path.join(skillDir, "schemas/reconstruction.schema.json"),
    value, directory, signal);
  if (schemaErrors.length) return { pass: false, errors: diagnosticErrors(schemaErrors.slice(0, 20).map(error =>
    `SCHEMA ${error.path} ${error.message}`)) };
  const draft = path.join(directory, "phase2-validation", "candidate");
  fs.rmSync(draft, { recursive: true, force: true });
  fs.mkdirSync(draft, { recursive: true, mode: 0o700 });
  try {
  // Assembly rewrites probe and reconstruction, so both are independent copies.
  for (const relative of ["probe.json", "capture-protocol.json", "post-source-input.json"]) {
    fs.copyFileSync(path.join(directory, relative), path.join(draft, relative));
  }
  for (const relative of ["evidence", "targeted-evidence"]) {
    fs.symlinkSync(path.join(directory, relative), path.join(draft, relative), "dir");
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "media-preparation.json"), "utf8")) as {
    evidencePack?: { path?: string };
  };
  if (manifest.evidencePack) manifest.evidencePack.path = path.join(draft, "evidence/evidence-pack.json");
  fs.writeFileSync(path.join(draft, "media-preparation.json"), JSON.stringify(manifest));
  const source = JSON.parse(fs.readFileSync(path.join(directory, "post-source-input.json"), "utf8")) as {
    cover?: { path?: string };
  };
  if (source.cover?.path) {
    const relative = source.cover.path;
    const cover = path.resolve(directory, relative);
    if (!cover.startsWith(`${path.resolve(directory)}${path.sep}`) || !fs.statSync(cover).isFile()) {
      throw new Error("RESPONSES_DRAFT_COVER_PATH_INVALID");
    }
    const link = path.join(draft, relative);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(cover, link, "file");
  }
  fs.writeFileSync(path.join(draft, "reconstruction.json"), JSON.stringify(value));
  if (options.assemble !== false) assembleHostOwnedReconstruction(draft);
  let schemaOutput: string;
  try {
    schemaOutput = (await execFileAsync("python3", [path.join(skillDir, "scripts/validate-schemas.py"),
      "--probe", path.join(draft, "probe.json"), "--protocol", path.join(draft, "capture-protocol.json"),
      "--reconstruction", path.join(draft, "reconstruction.json")],
    { cwd: draft, timeout: 60_000, signal, maxBuffer: 1_000_000 })).stdout;
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string };
    if (failure.code !== 2 || !failure.stdout) throw error;
    schemaOutput = failure.stdout;
  }
  const schemas = JSON.parse(schemaOutput) as { pass?: boolean; failures?: Array<{ artifact: string; location: string; message: string }> };
  if (schemas.pass !== true) return { pass: false, errors: diagnosticErrors((schemas.failures ?? []).slice(0, 20).map(error =>
    `SCHEMA ${error.artifact}/${error.location} ${error.message}`)) };
  try { integrity(draft, media); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("BUILDER_INTEGRITY_")) throw error;
    return { pass: false, errors: diagnosticErrors(error.message.split("\n").filter(Boolean).slice(0, 30)) };
  }
  return { pass: true, errors: [] };
  } finally {
    // PG ingests the attempt tree even after a model failure; scratch links must never escape it.
    fs.rmSync(draft, { recursive: true, force: true });
  }
}

function validateProbeProtocolLinkage(probeValue: unknown, protocolValue: unknown, packValue: unknown): void {
  const probe = probeValue as { carrierSweep?: Array<{ id: string; range: { start: number; end: number } }>;
    informationCarriers?: Array<{ id: string; discoveredIn?: string[] }>;
    meaningChanges?: Array<{ id: string }>; relationshipHypotheses?: Array<{ id: string }>;
    omissionRisks?: Array<{ id: string }>; criticalQuestions?: Array<{ id: string }> };
  const protocol = protocolValue as { schemaVersion?: string; probe?: string;
    knowledgeUnitFields?: Array<{ derivedFrom?: string[] }>;
    captureActions?: Array<{ derivedFrom?: string[]; consumers?: string[]; presentationIntent?: string }>;
    requiredRelations?: Array<{ derivedFrom?: string[] }> };
  const pack = packValue as { media?: { duration?: number } };
  if (protocol.schemaVersion !== "capture-protocol-2.0" || protocol.probe !== "probe.json") {
    throw new Error("RESPONSES_PROTOCOL_VERSION_OR_PROBE_MISMATCH");
  }
  const sweeps = [...(probe.carrierSweep ?? [])].sort((a, b) => a.range.start - b.range.start);
  const duration = Number(pack.media?.duration);
  let cursor = 0;
  for (const sweep of sweeps) {
    if (sweep.range.start > cursor + 0.25 || sweep.range.end < sweep.range.start) throw new Error("RESPONSES_PROBE_TIMELINE_GAP");
    cursor = Math.max(cursor, sweep.range.end);
  }
  if (!sweeps.length || !Number.isFinite(duration) || cursor < duration - 0.25) throw new Error("RESPONSES_PROBE_TIMELINE_GAP");
  const sweepIds = new Set(sweeps.map(row => row.id));
  if (probe.informationCarriers?.some(carrier => !carrier.discoveredIn?.length
    || carrier.discoveredIn.some(id => !sweepIds.has(id)))) throw new Error("RESPONSES_PROBE_CARRIER_UNTRACED");
  const ids = new Set([...(probe.carrierSweep ?? []), ...(probe.informationCarriers ?? []),
    ...(probe.meaningChanges ?? []), ...(probe.relationshipHypotheses ?? []),
    ...(probe.omissionRisks ?? []), ...(probe.criticalQuestions ?? [])].map(item => item.id));
  const derived = [...(protocol.knowledgeUnitFields ?? []), ...(protocol.captureActions ?? []),
    ...(protocol.requiredRelations ?? [])];
  if (derived.some(row => !row.derivedFrom?.length || row.derivedFrom.some(id => !ids.has(id)))) {
    throw new Error("RESPONSES_PROTOCOL_NOT_PROBE_DERIVED");
  }
  if (!protocol.captureActions?.length || protocol.captureActions.some(action =>
    !action.consumers?.length || !action.presentationIntent)) throw new Error("RESPONSES_PROTOCOL_CONSUMER_MISSING");
}

function jsonPointerExists(root: unknown, pointer: string): boolean {
  if (!pointer.startsWith("/")) return false;
  let current: unknown = root;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!current || typeof current !== "object" || !(key in current)) return false;
    current = (current as Record<string, unknown>)[key];
  }
  return current !== undefined;
}

function validateRevisionResponse(value: unknown, review: Record<string, unknown> | undefined): unknown {
  const findings = (review?.findings ?? []) as Array<{ id?: string }>;
  if (!Array.isArray(value) || value.length !== findings.length) {
    throw new Error(`RESPONSES_REVISION_RESPONSE_INCOMPLETE: expected=${findings.length} actual=${Array.isArray(value) ? value.length : "not_array"}`);
  }
  const expected = new Set(findings.map(item => item.id));
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`RESPONSES_REVISION_RESPONSE_INVALID:/revisionResponse/${index} must be an object`);
    }
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || !expected.has(row.id) || seen.has(row.id)) {
      throw new Error(`RESPONSES_REVISION_RESPONSE_INVALID:/revisionResponse/${index}/id expected one unused finding ID from ${[...expected].join(",")}; findingId cannot substitute for id`);
    }
    if (!["changed", "disputed", "missing_evidence"].includes(String(row.status ?? ""))) {
      throw new Error(`RESPONSES_REVISION_RESPONSE_INVALID:/revisionResponse/${index}/status must be changed, disputed, or missing_evidence`);
    }
    if (typeof row.reason !== "string" || !row.reason.trim()) {
      throw new Error(`RESPONSES_REVISION_RESPONSE_INVALID:/revisionResponse/${index}/reason must be a non-empty string`);
    }
    seen.add(row.id);
  }
  return value;
}

const fixedCreatorRevisionFields = new Set(["portfolioClassification", "postAnalyses", "schemaVersion",
  "creatorRunId", "generatedAt", "inputs"]);

function validateCreatorRevisionResponse(value: unknown, review: Record<string, unknown> | undefined): unknown {
  const response = validateRevisionResponse(value, review) as Array<{ id: string; status: string }>;
  const findings = (review?.findings ?? []) as Array<{ id: string; location: string }>;
  const locationById = new Map(findings.map((finding) => [finding.id, finding.location]));
  for (const disposition of response) {
    if (disposition.status !== "changed") continue;
    const location = locationById.get(disposition.id) ?? "";
    const topLevel = location.replace(/^\//u, "").split(/[/.]/u, 1)[0]?.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (topLevel && fixedCreatorRevisionFields.has(topLevel)) {
      throw new Error(`RESPONSES_CREATOR_FIXED_FIELD_CLAIM_CHANGED:${disposition.id}:${location}`);
    }
  }
  return response;
}
