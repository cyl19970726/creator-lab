import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { artifactPath } from "../core/artifacts.js";
import type { PinnedResearchInput } from "./research-inputs.js";
import { ResponsesEvidenceTools } from "./responses-tools.js";

const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const boundaryKeys = ["boundaries", "boundary", "gates", "failedGateIds"] as const;
const evaluationKeys = ["evaluationArtifactRef", "gateReportArtifactRef", "threeLensEvaluationArtifactRef",
  "threeLensGateReportArtifactRef"] as const;

type BatchItem = { postExternalId: string; tier: string; state: string; evaluationPolicy?: string;
  failedGateIds: string[]; reconstructionArtifactRef?: string | null;
  evaluationArtifactRef?: string | null; gateReportArtifactRef?: string | null;
  threeLensEvaluationArtifactRef?: string | null; threeLensGateReportArtifactRef?: string | null;
  researchReview?: { reviewArtifactRef?: string | null } | null };

/** Generated read-only views. The original refs remain the only citation targets. */
export function bindCreatorEvidenceViews(input: {
  tools: ResponsesEvidenceTools; directory: string; pinned: PinnedResearchInput;
  sourceRefs: Array<{ name: string; ref: string }>;
  batchRef: string; batchItems: readonly BatchItem[];
}): { requiredRefs: string[]; verifySources: () => void } {
  const expected = new Map(input.pinned.files.map(file => [file.ref, file.sha256]));
  const sources = new Map<string, string>();
  const generatedFiles = new Map<string, string>();
  const readPinned = (ref: string): { bytes: Buffer; value: Record<string, unknown> } => {
    const sha256 = expected.get(ref);
    if (!sha256) throw new Error(`RESPONSES_CREATOR_SOURCE_NOT_PINNED:${ref}`);
    const bytes = fs.readFileSync(artifactPath(ref));
    if (digest(bytes) !== sha256) throw new Error(`RESPONSES_CREATOR_SOURCE_CHANGED:${ref}`);
    sources.set(ref, sha256);
    const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    return { bytes, value };
  };
  const generated = (name: string, value: unknown): string => {
    const ref = `creator-input/${name}.json`;
    const file = path.join(input.directory, ref);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    input.tools.addGenerated(ref, file);
    generatedFiles.set(file, digest(fs.readFileSync(file)));
    return ref;
  };
  const requiredRefs = input.sourceRefs.map(({ name, ref }) => generated(name, readPinned(ref).value));
  const batch = readPinned(input.batchRef);
  const batchItems = batch.value.items as BatchItem[] | undefined;
  if (!Array.isArray(batchItems) || batchItems.length !== input.batchItems.length
    || input.batchItems.some((item, index) => item.postExternalId !== batchItems[index]?.postExternalId
      || item.reconstructionArtifactRef !== batchItems[index]?.reconstructionArtifactRef
      || item.state !== batchItems[index]?.state)) {
    throw new Error("RESPONSES_CREATOR_BATCH_SOURCE_CHANGED");
  }
  for (const [index, item] of batchItems.entries()) {
    const reconstructionRef = item.reconstructionArtifactRef;
    if (!reconstructionRef) continue;
    const reconstruction = readPinned(reconstructionRef);
    const builderLenses = reconstruction.value.builderLenses;
    if (!builderLenses || typeof builderLenses !== "object" || Array.isArray(builderLenses)
      || !["contentRestoration", "directingLogic", "visualEditing"].every(key =>
        Object.prototype.hasOwnProperty.call(builderLenses, key))) {
      throw new Error(`RESPONSES_CREATOR_BUILDER_LENSES_MISSING:${reconstructionRef}`);
    }
    const evaluationBoundaries = evaluationKeys.flatMap((key) => {
      const ref = item[key];
      if (!ref) return [];
      const linked = readPinned(ref);
      return [{ artifactRef: ref, sourceSha256: digest(linked.bytes),
        fields: boundaryKeys.filter(field => Object.prototype.hasOwnProperty.call(linked.value, field))
          .map(field => ({ jsonPointer: `#/${field}`, value: linked.value[field] })) }];
    });
    const reviewRef = item.researchReview?.reviewArtifactRef;
    const review = reviewRef ? readPinned(reviewRef) : null;
    const view = { schemaVersion: "creator-builder-material-view@1", postExternalId: item.postExternalId,
      source: { reconstructionArtifactRef: reconstructionRef, reconstructionSha256: digest(reconstruction.bytes),
        jsonPointer: "#/builderLenses", batchArtifactRef: input.batchRef, batchSha256: digest(batch.bytes),
        batchItemPointer: `#/items/${index}` },
      batchBoundary: { tier: item.tier, state: item.state, evaluationPolicy: item.evaluationPolicy ?? null,
        failedGateIds: item.failedGateIds, researchReview: item.researchReview ?? null },
      builderLenses, evaluationBoundaries,
      reviewReceipt: review ? { artifactRef: reviewRef, sourceSha256: digest(review.bytes),
        jsonPointer: "#", value: review.value } : null };
    requiredRefs.push(generated(`material-${String(index + 1).padStart(2, "0")}`, view));
  }
  return { requiredRefs, verifySources: () => {
    for (const [ref, sha256] of sources) {
      if (digest(fs.readFileSync(artifactPath(ref))) !== sha256) {
        throw new Error(`RESPONSES_CREATOR_SOURCE_CHANGED:${ref}`);
      }
    }
    for (const [file, sha256] of generatedFiles) {
      if (digest(fs.readFileSync(file)) !== sha256) throw new Error(`RESPONSES_CREATOR_VIEW_CHANGED:${file}`);
    }
  } };
}

export function creatorEvidenceReadiness(tools: ResponsesEvidenceTools, requiredRefs: readonly string[]) {
  const missingText = requiredRefs.filter(ref => !tools.fullyRead(ref)).map(ref => ({ ref, ...tools.readProgress(ref) }));
  return { ready: missingText.length === 0, missingText };
}
