import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SiwcTool } from "@signal-room/workflow-agent-sdk";
import type { BuilderLensSlot } from "./builder-lens-drafts.js";
import type { ResponsesEvidenceTools } from "./responses-tools.js";
import type { ValidatedDraftRef } from "./validated-draft-store.js";

const handoffRef = "builder-content-restoration";
const maxChallenges = 8;
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const textExtensions = new Set([".json", ".txt", ".md", ".srt", ".vtt", ".csv"]);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type ContentRestorationHandoff = {
  slot: "contentRestoration";
  value: unknown;
  receipt: ValidatedDraftRef;
};

export type BuilderFactChallenge = {
  id: string;
  raisedBy: "directingLogic" | "visualEditing";
  handoffCopySha256: string;
  sourceReceipt: ValidatedDraftRef;
  crPointer: string;
  claimQuote: string;
  counterObservation: string;
  evidenceRefs: string[];
  affectedOwnPaths: string[];
  status: "proposed";
};

export type BuilderFactHandoff = {
  ref: typeof handoffRef;
  copySha256: string;
  sourceReceipt: ValidatedDraftRef;
  prioritizedImageRefs: string[];
  factChallenges: BuilderFactChallenge[];
  challengeTool: SiwcTool;
  sidecar: () => { ref: "builder-fact-challenges"; sha256: string };
  assertIntegrity: () => void;
};

function tokens(pointer: string): string[] | null {
  if (!pointer.startsWith("/") || /~(?:[^01]|$)/u.test(pointer)) return null;
  return pointer.slice(1).split("/").map(token => token.replace(/~1/gu, "/").replace(/~0/gu, "~"));
}

function claimAt(root: unknown, pointer: string): string | null {
  const parts = tokens(pointer);
  if (!parts || !["summary", "blocks", "unknowns"].includes(parts[0] ?? "")) return null;
  const claimPath = (parts.length === 1 && parts[0] === "summary")
    || (parts.length === 2 && parts[0] === "unknowns" && /^(?:0|[1-9]\d*)$/u.test(parts[1]!))
    || (parts[0] === "blocks" && /^(?:0|[1-9]\d*)$/u.test(parts[1] ?? "") && (
      (parts.length === 3 && ["title", "body", "boundary"].includes(parts[2]!))
      || (parts.length === 5 && parts[2] === "visuals" && /^(?:0|[1-9]\d*)$/u.test(parts[3]!)
        && ["focus", "proves", "cannotProve"].includes(parts[4]!))
      || (parts.length === 5 && parts[2] === "steps" && /^(?:0|[1-9]\d*)$/u.test(parts[3]!)
        && ["label", "description"].includes(parts[4]!))));
  if (!claimPath) return null;
  let value: unknown = root;
  for (const token of parts) {
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(token)) return null;
      value = value[Number(token)];
    } else if (record(value) && Object.hasOwn(value, token)) value = value[token];
    else return null;
  }
  // A challenge cites one exact existing claim, not an entire block or a host summary.
  return typeof value === "string" && value.length > 0 && value.length <= 12_000 ? value : null;
}

function imageRefsInCr(value: unknown, tools: ResponsesEvidenceTools): string[] {
  const bindings = new Map(tools.snapshotBindings().map(item => [item.ref, item]));
  const result: string[] = [];
  const add = (ref: unknown) => {
    if (typeof ref !== "string" || result.includes(ref)) return;
    const bound = bindings.get(ref);
    if (bound && imageExtensions.has(path.extname(bound.path).toLowerCase())) result.push(ref);
  };
  if (!record(value) || !Array.isArray(value.blocks)) return result;
  for (const block of value.blocks) {
    if (!record(block)) continue;
    if (Array.isArray(block.visuals)) for (const visual of block.visuals) if (record(visual)) add(visual.ref);
    if (Array.isArray(block.frameRefs)) block.frameRefs.forEach(add);
    add(block.beforeFrameRef);
    add(block.afterFrameRef);
    if (Array.isArray(block.evidenceRefs)) block.evidenceRefs.forEach(add);
  }
  return result;
}

/** Copies the exact accepted CR value without interpreting it or weakening its source receipt. */
export function createBuilderFactHandoff(options: {
  slot: BuilderLensSlot;
  directory: string;
  tools: ResponsesEvidenceTools;
  source: ContentRestorationHandoff;
}): BuilderFactHandoff {
  const { slot, directory, tools, source } = options;
  if (slot === "contentRestoration" || source?.slot !== "contentRestoration" || !record(source.value)
    || typeof source.receipt?.draftId !== "string" || !/^[a-f0-9]{64}$/u.test(source.receipt.sha256)) {
    throw new Error("BUILDER_FACT_HANDOFF_INVALID");
  }
  if (typeof source.value.summary !== "string" || !Array.isArray(source.value.blocks)
    || !Array.isArray(source.value.unknowns)) throw new Error("BUILDER_FACT_HANDOFF_INVALID");
  const content = JSON.stringify(source.value);
  if (typeof content !== "string") throw new Error("BUILDER_FACT_HANDOFF_INVALID");
  const exactValue = JSON.parse(content) as unknown;
  // ValidatedDraftStore.stage serializes its plain JSON clone followed by one newline.
  // A future storage format must use an explicit contract version, not skip this check.
  const bytes = Buffer.from(`${JSON.stringify(exactValue)}\n`, "utf8");
  const copySha256 = sha(bytes);
  if (copySha256 !== source.receipt.sha256) throw new Error("BUILDER_FACT_SOURCE_RECEIPT_MISMATCH");
  const file = path.join(directory, `${handoffRef}.json`);
  fs.writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
  tools.addGenerated(handoffRef, file);
  const sourceReceipt = { draftId: source.receipt.draftId, sha256: source.receipt.sha256 };
  const factChallenges: BuilderFactChallenge[] = [];
  const prioritizedImageRefs = imageRefsInCr(exactValue, tools);
  const sidecarFile = path.join(directory, "builder-fact-challenges.json");
  const persist = (challenges = factChallenges): { ref: "builder-fact-challenges"; sha256: string } => {
    const sidecarBytes = Buffer.from(`${JSON.stringify({ version: 1, handoffCopySha256: copySha256,
      sourceReceipt, factChallenges: challenges })}\n`, "utf8");
    const temporary = `${sidecarFile}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, sidecarBytes, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, sidecarFile);
    return { ref: "builder-fact-challenges", sha256: sha(sidecarBytes) };
  };
  persist();
  const assertIntegrity = () => {
    if (sha(fs.readFileSync(file)) !== copySha256) throw new Error("BUILDER_FACT_HANDOFF_MUTATED");
  };
  const challengeTool: SiwcTool = {
    name: "challenge_builder_fact",
    description: "Propose an evidence-backed challenge to an exact CR claim. This records a dispute; it cannot change CR or decide truth. At most eight challenges per branch.",
    parameters: { type: "object", additionalProperties: false,
      required: ["handoffCopySha256", "crPointer", "counterObservation", "evidenceRefs"], properties: {
        handoffCopySha256: { type: "string" }, crPointer: { type: "string" },
        counterObservation: { type: "string", maxLength: 2000 },
        evidenceRefs: { type: "array", minItems: 1, maxItems: 12, items: { type: "string" } },
        affectedOwnPaths: { type: "array", maxItems: 8, items: { type: "string" } }
      } },
    execute: async (args, signal): Promise<Json> => {
      signal?.throwIfAborted();
      assertIntegrity();
      const row = args as Record<string, unknown>;
      if (row.handoffCopySha256 !== copySha256) throw new Error("BUILDER_FACT_HANDOFF_SHA_MISMATCH");
      if (!tools.fullyRead(handoffRef)) return { pass: false, errors: ["BUILDER_FACT_HANDOFF_UNREAD"] };
      if (factChallenges.length >= maxChallenges) return { pass: false, errors: ["BUILDER_FACT_CHALLENGE_LIMIT"] };
      const crPointer = row.crPointer;
      const claimQuote = typeof crPointer === "string" ? claimAt(exactValue, crPointer) : null;
      if (claimQuote === null) return { pass: false, errors: ["BUILDER_FACT_POINTER_INVALID"] };
      const counterObservation = row.counterObservation;
      if (typeof counterObservation !== "string" || !counterObservation.trim() || counterObservation.length > 2000) {
        return { pass: false, errors: ["BUILDER_FACT_OBSERVATION_INVALID"] };
      }
      const evidenceRefs = row.evidenceRefs;
      if (!Array.isArray(evidenceRefs) || evidenceRefs.length < 1 || evidenceRefs.length > 12
        || evidenceRefs.some(ref => typeof ref !== "string") || new Set(evidenceRefs).size !== evidenceRefs.length) {
        return { pass: false, errors: ["BUILDER_FACT_EVIDENCE_INVALID"] };
      }
      const affectedOwnPaths = row.affectedOwnPaths ?? [];
      if (!Array.isArray(affectedOwnPaths) || affectedOwnPaths.length > 8
        || affectedOwnPaths.some(pointer => typeof pointer !== "string" ||
          tokens(pointer)?.[0] !== slot || pointer === `/${slot}`)) {
        return { pass: false, errors: ["BUILDER_FACT_OWN_PATH_INVALID"] };
      }
      const bindings = new Map(tools.snapshotBindings().map(item => [item.ref, item]));
      for (const ref of evidenceRefs as string[]) {
        if (ref === handoffRef) return { pass: false, errors: ["BUILDER_FACT_SELF_CITATION_INVALID"], ref };
        const bound = bindings.get(ref);
        if (!bound) return { pass: false, errors: ["BUILDER_FACT_EVIDENCE_NOT_BOUND"], ref };
        const extension = path.extname(bound.path).toLowerCase();
        if (sha(fs.readFileSync(bound.path)) !== bound.sha256) throw new Error("BUILDER_FACT_EVIDENCE_MUTATED");
        const observed = imageExtensions.has(extension) ? tools.inspectedImages.has(ref)
          : textExtensions.has(extension) && tools.fullyRead(ref);
        if (!observed) return { pass: false, errors: ["BUILDER_FACT_EVIDENCE_UNREAD"], ref };
      }
      signal?.throwIfAborted();
      const challenge: BuilderFactChallenge = { id: randomUUID(), raisedBy: slot as "directingLogic" | "visualEditing",
        handoffCopySha256: copySha256, sourceReceipt, crPointer: crPointer as string, claimQuote,
        counterObservation, evidenceRefs: [...evidenceRefs] as string[], affectedOwnPaths: [...affectedOwnPaths] as string[],
        status: "proposed" };
      const sidecar = persist([...factChallenges, challenge]);
      factChallenges.push(challenge);
      return { pass: true, challenge, sidecar };
    }
  };
  return { ref: handoffRef, copySha256, sourceReceipt, prioritizedImageRefs, factChallenges,
    challengeTool, sidecar: persist, assertIntegrity };
}
