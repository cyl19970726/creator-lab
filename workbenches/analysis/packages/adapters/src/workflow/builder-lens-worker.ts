import fs from "node:fs";
import type { SiwcTool, SiwcVisualToolResult } from "@signal-room/workflow-agent-sdk";
import { BuilderLensDrafts, builderLensSchema, type BuilderLensSlot } from "./builder-lens-drafts.js";
import { createBuilderFactHandoff, type BuilderFactChallenge, type ContentRestorationHandoff } from "./builder-fact-handoff.js";
import type { ResponsesEvidenceTools } from "./responses-tools.js";
import type { ValidatedDraftReceipt, ValidatedDraftRef } from "./validated-draft-store.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Readiness = { ready: boolean; missingText: unknown[]; missingImages: string[] };
type ModelCall = (tools: ResponsesEvidenceTools, instructions: string,
  validate: (value: unknown) => unknown | Promise<unknown>, extraTools: readonly SiwcTool[],
  feedback: (error: unknown) => string | null, finish: readonly string[]) => Promise<unknown>;

/** One lens owns its context, tools and draft files. It cannot revise another lens or the index. */
export async function writeIsolatedBuilderLens(options: {
  slot: BuilderLensSlot;
  directory: string;
  schemaPath: string;
  parentTools: ResponsesEvidenceTools;
  textRefs: readonly string[];
  overviewRefs: readonly string[];
  prioritizedImageRefs: readonly string[];
  readiness: (tools: ResponsesEvidenceTools) => Readiness;
  evidenceTools: (tools: ResponsesEvidenceTools) => readonly SiwcTool[];
  validateLens: (slot: BuilderLensSlot, value: unknown, directory: string) => Promise<{ pass: boolean; errors: string[] }>;
  model: ModelCall;
  emit: (type: string, data: Record<string, unknown>) => Promise<void>;
  contentRestorationHandoff?: ContentRestorationHandoff;
}): Promise<{ slot: BuilderLensSlot; value: unknown; receipt: ValidatedDraftRef;
  factChallenges?: BuilderFactChallenge[]; factChallengeSidecar?: { ref: string; sha256: string } }> {
  const { slot } = options;
  fs.mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const tools = options.parentTools.fork(options.directory);
  const handoff = options.contentRestorationHandoff
    ? createBuilderFactHandoff({ slot, directory: options.directory, tools, source: options.contentRestorationHandoff })
    : undefined;
  const drafts = new BuilderLensDrafts(options.directory,
    (owner, value) => options.validateLens(owner, value, options.directory));
  const textRefs = [...new Set([...options.textRefs, ...(handoff ? [handoff.ref] : [])])];
  const prioritizedImageRefs = [...new Set([...(handoff?.prioritizedImageRefs ?? []), ...options.prioritizedImageRefs])];
  const imageRefs = [...new Set([...options.overviewRefs, ...prioritizedImageRefs])];
  const pendingImages = () => prioritizedImageRefs.filter(ref => !tools.inspectedImages.has(ref));
  const state = () => {
    handoff?.assertIntegrity();
    const given = options.readiness(tools);
    const missingText = [...given.missingText, ...textRefs.filter(ref => !tools.fullyRead(ref))];
    const missingImages = [...new Set([...given.missingImages,
      ...options.overviewRefs.filter(ref => !tools.inspectedImages.has(ref))])];
    const pendingEvidenceImageRefs = pendingImages();
    return { ready: given.ready && !missingText.length && !missingImages.length && !pendingEvidenceImageRefs.length,
      missingText, missingImages, pendingEvidenceImageRefs };
  };
  const unread = (): Json | undefined => {
    const readiness = state();
    return readiness.ready ? undefined : { pass: false, errors: ["BUILDER_LENS_UNREAD_EVIDENCE"],
      readiness: json(readiness) };
  };
  const receiptResult = async (receipt: ValidatedDraftReceipt): Promise<Json> => {
    await options.emit("responses.draft_staged", { phase: `builder-lens-${slot}`, slot, ...receipt });
    return { slot, ...receipt } as Json;
  };
  const context: SiwcTool = { name: "read_builder_context", description: "Read the shared frozen evidence and actual pixels for this single lens. Only this lens schema is needed. Follow pendingEvidenceImageRefs with read_builder_evidence_batch.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    execute: async () => {
      const result = tools.readBundle(textRefs, imageRefs.slice(0, 24));
      const extra = { assignedLens: slot, builderLensSchema: json(builderLensSchema(options.schemaPath, slot)),
        readiness: json(state()), existingLensDraft: json(drafts.latestRef(slot) ?? null),
        ...(handoff ? { contentRestorationHandoff: json({ ref: handoff.ref, copySha256: handoff.copySha256,
          sourceReceipt: handoff.sourceReceipt, prioritizedImageRefs: handoff.prioritizedImageRefs,
          status: "accepted CR candidate; independently verify and challenge against source pixels" }) } : {}),
        evidencePolicy: "Read original pixels. Decision judgments and CR text are fallible claims, not facts or a substitute for open investigation." };
      return "kind" in result ? { ...result, value: { ...(result.value as Record<string, Json>), ...extra } } as SiwcVisualToolResult
        : json({ ...result, ...extra });
    } };
  const evidenceBatch: SiwcTool = { name: "read_builder_evidence_batch", description: "Deliver the next pending selected original images in one verified batch. No missing image is marked inspected.",
    parameters: { type: "object", additionalProperties: false, properties: {} }, execute: async () => {
      const pending = pendingImages();
      if (!pending.length) return { complete: true, readiness: json(state()) };
      const result = tools.readImageBatch(pending);
      return "kind" in result ? { ...result, value: { ...(result.value as Record<string, Json>), readiness: json(state()) } } as SiwcVisualToolResult
        : json({ ...result, readiness: state() });
    } };
  const stage: SiwcTool = { name: "stage_builder_lens", description: `Stage only the complete ${slot} lens. A passing receipt completes this branch.`,
    parameters: { type: "object", additionalProperties: false, required: ["slot", "value"],
      properties: { slot: { type: "string", enum: [slot] }, value: { type: "object" } } },
    execute: async args => {
      const row = args as { slot?: string; value?: unknown };
      if (row.slot !== slot) throw new Error("BUILDER_LENS_CROSS_BRANCH_WRITE");
      const notReady = unread();
      if (notReady) return notReady;
      return receiptResult(await drafts.stage(slot, row.value));
    } };
  const revise: SiwcTool = { name: "revise_builder_lens", description: `Patch only the current ${slot} draft at /${slot}/... paths, keeping all supported prose. Use add for a missing object property and replace only an existing path; replace arrays whole. A rejected patch returns the unchanged latest draft receipt and an error to correct.`,
    parameters: { type: "object", additionalProperties: false, required: ["slot", "useLatest", "patches"], properties: {
      slot: { type: "string", enum: [slot] }, useLatest: { type: "boolean", enum: [true] },
      patches: { type: "array", maxItems: 64, items: { type: "object", additionalProperties: false,
        required: ["op", "path", "value"], properties: { op: { type: "string", enum: ["replace", "add"] }, path: { type: "string" }, value: {} } } }
    } }, execute: async (args, signal) => {
      const row = args as { slot?: string; useLatest?: boolean; patches?: unknown };
      if (row.slot !== slot || row.useLatest !== true) throw new Error("BUILDER_LENS_CROSS_BRANCH_WRITE");
      const notReady = unread();
      if (notReady) return notReady;
      const latest = drafts.latestRef(slot);
      if (!latest) return { pass: false, errors: ["No current lens draft; stage this lens first."] };
      signal?.throwIfAborted();
      let receipt: ValidatedDraftReceipt;
      try { receipt = await drafts.revise(slot, latest, row.patches); }
      catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof Error) || !/^RECONSTRUCTION_PATCH_[A-Z_]+$/u.test(error.message)) throw error;
        return { slot, ...latest, pass: false, errors: [error.message] };
      }
      signal?.throwIfAborted();
      return receiptResult(receipt);
    } };
  const validate = (value: unknown) => {
    const row = value as { acceptedDraft?: ValidatedDraftRef };
    const receipt = row?.acceptedDraft;
    if (!receipt) throw new Error("BUILDER_LENS_ACCEPTED_RECEIPT_REQUIRED");
    const readiness = state();
    if (!readiness.ready) throw new Error(`BUILDER_LENS_UNREAD_EVIDENCE:${JSON.stringify(readiness)}`);
    return { slot, value: drafts.resolve(slot, receipt), receipt };
  };
  const handoffInstructions = handoff ? ` The exact accepted contentRestoration is bound as ${handoff.ref} with copy SHA ${handoff.copySha256} and source draft receipt ${handoff.sourceReceipt.draftId}/${handoff.sourceReceipt.sha256}. Read that full JSON through read_builder_context or read_evidence until readiness confirms it is fully read. Treat it as a candidate account, not truth: verify disputed states against original pixels, and use challenge_builder_fact for a specific conflicting CR pointer with evidence you actually read. The challenge only records a proposed dispute; it does not authorize editing CR. Keep your assigned ${slot} lens complete and within scope. Original CR visual refs are prioritized for actual pixel delivery; a ref name or CR prose is not pixel observation.` : "";
  const modelResult = await options.model(tools,
    `SPECIALIST PHASE 2. Your sole assigned lens is ${slot}. This scope overrides generic instructions to write all three lenses, index or summary. Other independent agents own those outputs. Read shared evidence and original pixels, then write the complete canonical ${slot} with the same depth and evidence constraints. Do not create knowledgeUnits, relations, finalSummary or a whole reconstruction. Use real cue/frame/TARGET IDs already provided, never invented knowledge-unit IDs. For source refs use POST-TITLE/POST-COVER only where actually bound. Call read_builder_context once; consume pendingEvidenceImageRefs in batches, and inspect any remaining uncertainty with original evidence tools.${handoffInstructions} Do not repeat resolved evidence lookups merely to narrate steps; still investigate new gaps. After a passing stage_builder_lens or revise_builder_lens receipt return only its acceptedDraft. Preserve continuous content, specific observed detail, exact cuts, counterfactuals and transferable filming/editing conditions. A schema pass is not semantic truth.`,
    validate, [context, evidenceBatch, ...(handoff ? [handoff.challengeTool] : []), stage, revise, ...options.evidenceTools(tools)],
    error => `This branch needs correction: ${String(error)}. Read missing refs or patch only ${slot}; preserve complete prose and return its valid acceptedDraft.`,
    ["stage_builder_lens", "revise_builder_lens"]);
  const output = modelResult as { slot?: unknown; value?: unknown; receipt?: ValidatedDraftRef } | null;
  if (!output || output.slot !== slot || !output.receipt || !Object.hasOwn(output, "value")) {
    throw new Error("BUILDER_LENS_MODEL_RESULT_INVALID");
  }
  const verified = validate({ acceptedDraft: output.receipt });
  if (JSON.stringify(output.value) !== JSON.stringify(verified.value)) {
    throw new Error("BUILDER_LENS_MODEL_VALUE_MISMATCH");
  }
  return handoff ? { ...verified, factChallenges: [...handoff.factChallenges], factChallengeSidecar: handoff.sidecar() }
    : verified;
}

function json(value: unknown): Json {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("BUILDER_LENS_TOOL_RESULT_NOT_JSON");
  return JSON.parse(encoded) as Json;
}
