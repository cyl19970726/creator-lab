import { validateVideoDepth } from "./video-depth-integrity.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "../../core/config.js";

const skillDir = process.env.SELF_MEDIA_VIDEO_RECONSTRUCTION_SKILL_DIR ??
  path.join(projectRoot, ".agents", "skills", "video-content-reconstruction");
const builderIntegrityContractVersion = "builder-integrity-v9-evidence-time-feedback";

export function builderIntegrityContractRevision(): string {
  const contractFiles = [
    path.join(skillDir, "references/builder-operator.md"),
    path.join(skillDir, "references/single-post-depth.md"),
    path.join(skillDir, "schemas/capture-protocol.schema.json"),
    path.join(skillDir, "schemas/reconstruction.schema.json")
  ];
  const hash = crypto.createHash("sha256").update(builderIntegrityContractVersion);
  for (const file of contractFiles) hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

type EvidenceRef = { refType?: string; ref?: string };
type Carrier = {
  id?: string;
  name?: string;
  modalityKeys?: string[];
  discoveredIn?: string[];
  available?: boolean;
  inspected?: boolean;
  inspectionStatus?: "absent" | "unchecked" | "checked_readable" | "checked_unreadable";
  inspectionRationale?: string;
};
type ReconstructionLike = {
  schemaVersion?: string;
  transcript?: { cues?: Array<Record<string, unknown>> };
  knowledgeUnits?: Array<{
    id?: string;
    importance?: string;
    timeRange?: { start?: number; end?: number };
    evidence?: EvidenceRef[];
  }>;
  relations?: Array<{ from?: string; to?: string; evidence?: EvidenceRef[] }>;
  derivedSources?: Array<{ id?: string; path?: string }>;
  coverageMatrix?: {
    coreEvidence?: { covered?: number; total?: number };
    channels?: Carrier[];
    cueAccountability?: Array<{
      cueId?: string;
      disposition?: "knowledge" | "context" | "nonsemantic" | "uncertain";
      unitIds?: string[];
    }>;
    criticalQuestions?: Array<{ unitIds?: string[] }>;
    uncheckedChannels?: string[];
  };
  metaGate?: {
    pass?: boolean;
    uncheckedChannels?: string[];
    overlookedMeaningChanges?: string[];
    overlookedRelationships?: string[];
  };
  builderLenses?: {
    contentRestoration?: {
      summary?: string;
      blocks?: Array<{
        id?: string;
        type?: string;
        body?: string;
        evidenceRefs?: string[];
        frameRefs?: string[];
        visuals?: Array<{ ref?: string }>;
        beforeFrameRef?: string;
        afterFrameRef?: string;
        steps?: Array<{ frameRefs?: string[] }>;
      }>;
    };
    directingLogic?: {
      stages?: Array<{ label?: string; function?: string; cognitiveChange?: string; evidenceRefs?: string[] }>;
      informationDesign?: Array<{ evidenceRefs?: string[] }>;
      proofDesign?: Array<{ evidenceRefs?: string[] }>;
    };
    visualEditing?: {
      carriers?: Array<Record<string, unknown>>;
      claims?: Array<{ evidenceRefs?: string[] }>;
      shotSemantics?: Array<{ evidenceRefs?: string[] }>;
      uiProcedureStates?: Array<{ evidenceRefs?: string[] }>;
      transitions?: Array<{ evidenceRefs?: string[] }>;
      rhythm?: Array<{ evidenceRefs?: string[] }>;
      missingBridges?: Array<{ evidenceRefs?: string[] }>;
    };
  };
};

type EvidencePackLike = {
  media?: { duration?: number };
  shots?: Array<{ id?: string }>;
  frameIndex?: Array<{ id?: string; time?: number }>;
  transcript?: { cues?: Array<Record<string, unknown>> };
};

type ProbeLike = { informationCarriers?: Carrier[] };

function exists(file: string): boolean {
  return fs.existsSync(file) && fs.statSync(file).isFile();
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function fail(code: string, detail?: string): never {
  throw new Error(`BUILDER_INTEGRITY_${code}${detail ? `:${detail}` : ""}`);
}

/** Return actionable locations for visual content blocks that have no bound visual evidence. */
export function contentBlockVisualDiagnostics(contentRestoration: unknown): string[] {
  const lens = contentRestoration && typeof contentRestoration === "object" && !Array.isArray(contentRestoration)
    ? contentRestoration as { blocks?: unknown } : {};
  const blocks = Array.isArray(lens.blocks) ? lens.blocks : [];
  const visualBlockTypes = new Set(["single_frame", "annotated_crop", "before_after", "operation_sequence", "frame_strip"]);
  return blocks.flatMap((block, index) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return [];
    const row = block as Record<string, unknown>;
    if (!visualBlockTypes.has(String(row.type ?? "")) ||
      (Array.isArray(row.visuals) && row.visuals.length > 0) ||
      (Array.isArray(row.frameRefs) && row.frameRefs.length > 0) ||
      Boolean(row.beforeFrameRef) || Boolean(row.afterFrameRef) ||
      (Array.isArray(row.steps) && row.steps.length > 0)) return [];
    const id = typeof row.id === "string" ? `(${row.id})` : "";
    return [`BUILDER_INTEGRITY_CONTENT_BLOCK_VISUAL_MISSING:builderLenses.contentRestoration.blocks[${index}]${id} has no visuals, frameRefs, beforeFrameRef/afterFrameRef, or steps`];
  });
}

/** Check the timing of primary visual anchors; explicit before/after comparisons may cross the block boundary. */
/** Checks declared prose coverage, not whether the prose correctly interprets the pixels. */
export function contentRestorationCoverageDiagnostics(contentRestoration: unknown, duration: number): string[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const lens = contentRestoration as { blocks?: Array<{ timeRange?: { start?: number; end?: number } }> } | null;
  const ranges = (Array.isArray(lens?.blocks) ? lens.blocks : [])
    .map(block => block?.timeRange)
    .filter((range): range is { start: number; end: number } => Boolean(range
      && typeof range.start === "number" && Number.isFinite(range.start) && range.start >= 0
      && typeof range.end === "number" && Number.isFinite(range.end) && range.end > range.start
      && range.end <= duration + 0.5))
    .sort((left, right) => left.start - right.start);
  const gaps: Array<[number, number]> = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start - cursor > 0.5) gaps.push([cursor, range.start]);
    cursor = Math.max(cursor, range.end);
  }
  if (duration - cursor > 0.5) gaps.push([cursor, duration]);
  return gaps.map(([start, end]) => `BUILDER_INTEGRITY_CONTENT_COVERAGE:builderLenses.contentRestoration.blocks uncovered=${start}..${end}s duration=${duration}; add continuous prose blocks for this interval, including explicitly unknown content where evidence is insufficient; summary text does not replace blocks. Preserve supported existing prose and revise_builder_lens slot=contentRestoration useLatest:true.`);
}

export function contentBlockTemporalDiagnostics(contentRestoration: unknown,
  frameTimes: ReadonlyMap<string, number>, duration: number): string[] {
  const lens = contentRestoration && typeof contentRestoration === "object" && !Array.isArray(contentRestoration)
    ? contentRestoration as { blocks?: unknown } : {};
  const blocks = Array.isArray(lens.blocks) ? lens.blocks : [];
  const issues: string[] = [];
  blocks.forEach((block, index) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return;
    const row = block as Record<string, unknown>;
    const location = `builderLenses.contentRestoration.blocks[${index}]${typeof row.id === "string" ? `(${row.id})` : ""}`;
    const range = row.timeRange && typeof row.timeRange === "object" && !Array.isArray(row.timeRange)
      ? row.timeRange as { start?: unknown; end?: unknown } : {};
    const start = range.start;
    const end = range.end;
    if (typeof start !== "number" || !Number.isFinite(start) || typeof end !== "number" || !Number.isFinite(end) ||
      start < 0 || end < start || !Number.isFinite(duration) || duration < 0 || end > duration + 0.5) {
      issues.push(`BUILDER_INTEGRITY_CONTENT_BLOCK_TIME_RANGE:${location}.timeRange:${String(start)}..${String(end)} duration=${duration}`);
      return;
    }
    const check = (ref: unknown, field: string) => {
      if (typeof ref !== "string") return; // Schema and dangling-reference checks own invalid/unknown IDs.
      const time = frameTimes.get(ref);
      if (time !== undefined && Number.isFinite(time) && (time < start - 0.5 || time > end + 0.5)) {
        issues.push(`BUILDER_INTEGRITY_CONTENT_BLOCK_FRAME_TIME:${location}.${field}:${ref}@${time} outside ${start}..${end}`);
      }
    };
    if (Array.isArray(row.frameRefs)) row.frameRefs.forEach((ref, refIndex) => check(ref, `frameRefs[${refIndex}]`));
    if (Array.isArray(row.visuals)) row.visuals.forEach((visual, visualIndex) => {
      if (!visual || typeof visual !== "object" || Array.isArray(visual)) return;
      const item = visual as { ref?: unknown; role?: unknown };
      if (item.role !== "before" && item.role !== "after") check(item.ref, `visuals[${visualIndex}].ref`);
    });
    if (row.type === "operation_sequence" && Array.isArray(row.steps)) row.steps.forEach((step, stepIndex) => {
      if (!step || typeof step !== "object" || Array.isArray(step)) return;
      const refs = (step as { frameRefs?: unknown }).frameRefs;
      if (Array.isArray(refs)) refs.forEach((ref, refIndex) => check(ref, `steps[${stepIndex}].frameRefs[${refIndex}]`));
    });
  });
  return issues;
}

function ids(values: Array<{ id?: string }> | undefined): Set<string> {
  return new Set((values ?? []).map((item) => item.id).filter((id): id is string => Boolean(id)));
}

export function carrierInspectionStatus(carrier: Carrier): "absent" | "unchecked" | "checked_readable" | "checked_unreadable" {
  return carrier.inspectionStatus ?? (!carrier.available ? "absent" : carrier.inspected ? "checked_readable" : "unchecked");
}

function invalidCarrierInspectionContract(carrier: Carrier): boolean {
  if (!carrier.inspectionStatus) return false;
  const expected = carrier.inspectionStatus === "absent"
    ? { available: false, inspected: carrier.inspected }
    : carrier.inspectionStatus === "unchecked"
      ? { available: true, inspected: false }
      : { available: true, inspected: true };
  return carrier.available !== expected.available || carrier.inspected !== expected.inspected ||
    !carrier.inspectionRationale?.trim();
}

function cueContract(cue: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(["id", "start", "end", "text", "representativeFrame", "overlappingShots"]
    .map((key) => [key, cue[key]]));
}

export type BuilderIntegrityReport = {
  transcriptCues: number;
  accountableCues: number;
  knowledgeUnits: number;
  coreUnits: number;
  evidenceReferences: number;
  availableChannels: number;
  inspectedChannels: number;
  builderLensEvidenceReferences: number;
};

function normalizedMeaning(value: string | undefined): string {
  return (value ?? "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function builderLensRefs(reconstruction: ReconstructionLike): string[] {
  const lenses = reconstruction.builderLenses;
  if (!lenses) return [];
  const content = lenses.contentRestoration?.blocks ?? [];
  return [
    ...content.flatMap((block) => [
      ...(block.evidenceRefs ?? []), ...(block.frameRefs ?? []),
      ...(block.visuals ?? []).flatMap((visual) => visual.ref ? [visual.ref] : []),
      ...(block.beforeFrameRef ? [block.beforeFrameRef] : []),
      ...(block.afterFrameRef ? [block.afterFrameRef] : []),
      ...(block.steps ?? []).flatMap((step) => step.frameRefs ?? [])
    ]),
    ...(lenses.directingLogic?.stages ?? []).flatMap((stage) => stage.evidenceRefs ?? []),
    ...(lenses.directingLogic?.informationDesign ?? []).flatMap((item) => item.evidenceRefs ?? []),
    ...(lenses.directingLogic?.proofDesign ?? []).flatMap((item) => item.evidenceRefs ?? []),
    ...(lenses.visualEditing?.claims ?? []).flatMap((item) => item.evidenceRefs ?? []),
    ...(lenses.visualEditing?.shotSemantics ?? []).flatMap((item) => item.evidenceRefs ?? []),
    ...(lenses.visualEditing?.uiProcedureStates ?? []).flatMap((item) => item.evidenceRefs ?? []),
    ...(lenses.visualEditing?.transitions ?? []).flatMap((item) => item.evidenceRefs ?? []),
    ...(lenses.visualEditing?.rhythm ?? []).flatMap((item) => item.evidenceRefs ?? []),
    ...(lenses.visualEditing?.missingBridges ?? []).flatMap((item) => item.evidenceRefs ?? [])
  ];
}

export function validateBuilderIntegrity(outputDir: string, videoPath: string): BuilderIntegrityReport {
  const manifest = readJson<{
    sourceMedia?: { fingerprint?: string };
    transcript?: { path?: string | null; fingerprint?: string | null };
    evidencePack?: { path?: string; fingerprint?: string };
  }>(path.join(outputDir, "media-preparation.json"));
  const evidencePath = path.join(outputDir, "evidence/evidence-pack.json");
  const targetedPath = path.join(outputDir, "targeted-evidence/targeted-evidence.json");
  const ocrPath = path.join(outputDir, "targeted-evidence/ocr-evidence.json");
  const reconstructionPath = path.join(outputDir, "reconstruction.json");
  const probePath = path.join(outputDir, "probe.json");
  if (manifest.sourceMedia?.fingerprint !== sha256(videoPath)) fail("MEDIA_FINGERPRINT");
  if (manifest.evidencePack?.path !== evidencePath || manifest.evidencePack.fingerprint !== sha256(evidencePath)) {
    fail("EVIDENCE_FINGERPRINT");
  }
  if (manifest.transcript?.path && manifest.transcript.fingerprint !== sha256(manifest.transcript.path)) {
    fail("TRANSCRIPT_FINGERPRINT");
  }

  const pack = readJson<EvidencePackLike>(evidencePath);
  const targeted = readJson<{ frames?: Array<{ id?: string; time?: number }> }>(targetedPath);
  const ocr = exists(ocrPath) ? readJson<{
    frames?: Array<{ frameId?: string; time?: number; lines?: Array<{ id?: string }> }>
  }>(ocrPath) : null;
  const reconstruction = readJson<ReconstructionLike>(reconstructionPath);
  const probe = readJson<ProbeLike>(probePath);
  // Post identity and cover fingerprints are trusted prerequisites. Stop before
  // inspecting candidate-derived source references if the frozen cover changed.
  const sourcePath = path.join(outputDir, "post-source-input.json");
  const postSource = exists(sourcePath) ? readJson<{ facts: { title: string | null; coverHref: string | null }; cover: { path: string; sha256: string } | null }>(sourcePath) : null;
  if (postSource?.cover) {
    const coverPath = path.resolve(outputDir, postSource.cover.path);
    if (!coverPath.startsWith(path.resolve(outputDir) + path.sep) || !exists(coverPath) || sha256(coverPath) !== postSource.cover.sha256) fail("POST_COVER_FINGERPRINT");
  }
  const issues: string[] = [];
  const problem = (code: string, detail?: string) => issues.push(`BUILDER_INTEGRITY_${code}${detail ? `:${detail}` : ""}`);
  const sourceCues = pack.transcript?.cues ?? [];
  const outputCues = reconstruction.transcript?.cues ?? [];
  if (sourceCues.length !== outputCues.length) problem("CUE_COUNT", `${outputCues.length}/${sourceCues.length}`);
  for (let index = 0; index < sourceCues.length; index += 1) {
    if (JSON.stringify(cueContract(sourceCues[index] ?? {})) !== JSON.stringify(cueContract(outputCues[index] ?? {}))) {
      problem("CUE_DRIFT", String(index));
    }
  }

  const sourceCueIds = ids(sourceCues as Array<{ id?: string }>);
  const units = reconstruction.knowledgeUnits ?? [];
  const unitIds = ids(units);
  const accountability = reconstruction.coverageMatrix?.cueAccountability ?? [];
  const accountedIds = accountability.map((row) => row.cueId).filter((id): id is string => Boolean(id));
  if (accountedIds.length !== sourceCueIds.size || new Set(accountedIds).size !== sourceCueIds.size ||
      accountedIds.some((id) => !sourceCueIds.has(id))) {
    const missing = [...sourceCueIds].filter(id => !accountedIds.includes(id));
    const duplicates = [...new Set(accountedIds.filter((id, index) => accountedIds.indexOf(id) !== index))];
    const unknown = [...new Set(accountedIds.filter(id => !sourceCueIds.has(id)))];
    const preview = (values: string[]) => `${values.slice(0, 8).join(",")}${values.length > 8 ? ` (+${values.length - 8} more)` : ""}`;
    problem("CUE_ACCOUNTABILITY", `expected=${sourceCueIds.size} actual=${accountedIds.length}` +
      ` missing=${preview(missing)} duplicates=${preview(duplicates)} unknown=${preview(unknown)}`);
  }
  for (const row of accountability) {
    if ((row.unitIds ?? []).some((id) => !unitIds.has(id))) problem("CUE_UNIT_REFERENCE", row.cueId);
    if ((row.disposition === "knowledge" || row.disposition === "context") && !(row.unitIds ?? []).length) {
      problem("CUE_UNIT_LINK_MISSING", row.cueId);
    }
  }

  const shotIds = ids(pack.shots);
  const frameIds = ids(pack.frameIndex);
  const targetedIds = ids(targeted.frames);
  const ocrIds = new Set((ocr?.frames ?? []).flatMap((item) => item.lines ?? [])
    .map((item) => item.id).filter((id): id is string => Boolean(id)));
  const sourceIds = ids(reconstruction.derivedSources);
  const allEvidenceIds = new Set([...sourceCueIds, ...shotIds, ...frameIds, ...targetedIds, ...ocrIds, ...sourceIds]);
  const frameTimes = new Map<string, number>();
  for (const frame of pack.frameIndex ?? []) if (frame.id && Number.isFinite(frame.time)) frameTimes.set(frame.id, Number(frame.time));
  for (const frame of targeted.frames ?? []) if (frame.id && Number.isFinite(frame.time)) frameTimes.set(frame.id, Number(frame.time));
  for (const frame of ocr?.frames ?? []) for (const line of frame.lines ?? []) {
    if (line.id && Number.isFinite(frame.time)) frameTimes.set(line.id, Number(frame.time));
  }
  const relations = reconstruction.relations ?? [];
  const references = [
    ...units.flatMap((unit) => unit.evidence ?? []),
    ...relations.flatMap((relation) => relation.evidence ?? [])
  ];
  const danglingReferences: string[] = [];
  const checkReference = (reference: EvidenceRef, sourcePath: string): void => {
    const ref = reference.ref;
    if (!ref) { problem("EMPTY_REFERENCE", sourcePath); return; }
    const valid = reference.refType === "cue" ? sourceCueIds.has(ref)
      : reference.refType === "shot" ? shotIds.has(ref)
        : reference.refType === "frame" ? frameIds.has(ref)
          : reference.refType === "targeted_frame" ? targetedIds.has(ref)
            : reference.refType === "ocr" ? ocrIds.has(ref)
              : reference.refType === "source" ? sourceIds.has(ref) : false;
    if (!valid) danglingReferences.push(`${reference.refType}:${ref}@${sourcePath}`);
  };
  units.forEach((unit, unitIndex) => {
    (unit.evidence ?? []).forEach((reference, evidenceIndex) => {
      checkReference(reference, `knowledgeUnits[${unitIndex}].evidence[${evidenceIndex}]`);
    });
  });
  relations.forEach((relation, relationIndex) => {
    (relation.evidence ?? []).forEach((reference, evidenceIndex) => {
      checkReference(reference, `relations[${relationIndex}].evidence[${evidenceIndex}]`);
    });
  });
  if (danglingReferences.length > 0) problem("DANGLING_REFERENCE", danglingReferences.join(","));
  const coreUnits = units.filter((unit) => unit.importance === "core");
  const coveredCoreUnits = coreUnits.filter((unit) => (unit.evidence ?? []).length > 0);
  const reportedCoreEvidence = reconstruction.coverageMatrix?.coreEvidence;
  if (reportedCoreEvidence?.covered !== coveredCoreUnits.length || reportedCoreEvidence.total !== coreUnits.length) {
    problem("CORE_EVIDENCE_COUNT",
      `${reportedCoreEvidence?.covered ?? "missing"}/${reportedCoreEvidence?.total ?? "missing"}` +
      `!=${coveredCoreUnits.length}/${coreUnits.length}`);
  }
  for (const relation of reconstruction.relations ?? []) {
    if (!relation.from || !unitIds.has(relation.from) || !relation.to || !unitIds.has(relation.to)) {
      problem("RELATION_UNIT_REFERENCE", `${relation.from ?? "missing"}->${relation.to ?? "missing"}`);
    }
  }
  try { validateVideoDepth(reconstruction, Number(pack.media?.duration), allEvidenceIds, frameTimes, postSource); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("BUILDER_INTEGRITY_")) throw error;
    issues.push(error.message);
  }
  const lensReferences = builderLensRefs(reconstruction);
  if (reconstruction.schemaVersion === "video-reconstruction-2.0") {
    const lenses = reconstruction.builderLenses;
    if (!lenses?.contentRestoration?.blocks?.length || !lenses.directingLogic?.stages?.length ||
        !lenses?.visualEditing?.carriers?.length || !lenses?.visualEditing?.claims?.length ||
        !lenses?.visualEditing?.shotSemantics?.length || !lenses?.visualEditing?.rhythm?.length) problem("BUILDER_LENSES_INCOMPLETE");
    const danglingLensRefs = [...new Set(lensReferences.filter((ref) => !allEvidenceIds.has(ref)))];
    if (danglingLensRefs.length > 0) problem("BUILDER_LENS_DANGLING_REFERENCE", danglingLensRefs.join(","));
    {
      const contentBlocks = lenses?.contentRestoration?.blocks ?? [];
      if (contentBlocks.some((block) => !(block.body?.trim()) || !(block.evidenceRefs?.length))) {
        problem("CONTENT_BLOCK_EVIDENCE");
      }
      issues.push(...contentBlockVisualDiagnostics(lenses?.contentRestoration));
      issues.push(...contentBlockTemporalDiagnostics(lenses?.contentRestoration, frameTimes, Number(pack.media?.duration)));
      if ((reconstruction as { summaryContractVersion?: string }).summaryContractVersion === "single-post-summary@1") {
        issues.push(...contentRestorationCoverageDiagnostics(lenses?.contentRestoration, Number(pack.media?.duration)));
      }
      const stages = lenses?.directingLogic?.stages ?? [];
      const meanings = stages.map((stage) => normalizedMeaning(`${stage.function} ${stage.cognitiveChange}`));
      if (meanings.some((value) => !value) || new Set(meanings).size !== meanings.length) {
        problem("DIRECTING_STAGE_REPETITION");
      }
    }
  }
  for (const question of reconstruction.coverageMatrix?.criticalQuestions ?? []) {
    if ((question.unitIds ?? []).some((id) => !unitIds.has(id))) problem("QUESTION_UNIT_REFERENCE");
  }

  const duration = Number(pack.media?.duration ?? 0);
  const evidenceTimeViolations: string[] = [];
  const evidenceTimeContexts: Array<{ unitId: string; range: { start: number; end: number };
    outside: Array<{ ref: string; time: number }>; timedEvidence: Array<{ ref: string; time: number }> }> = [];
  for (const unit of units) {
    const start = Number(unit.timeRange?.start);
    const end = Number(unit.timeRange?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end > duration + 0.5) {
      problem("UNIT_TIME_RANGE", unit.id);
    }
    const timedEvidence = (unit.evidence ?? []).flatMap((reference) => {
      const time = reference.ref ? frameTimes.get(reference.ref) : undefined;
      return reference.ref && time !== undefined && Number.isFinite(time) ? [{ ref: reference.ref, time }] : [];
    });
    const outside = timedEvidence.filter(({ time }) => time < start - 0.5 || time > end + 0.5);
    for (const { ref } of outside) evidenceTimeViolations.push(`${unit.id}:${ref}`);
    if (outside.length) evidenceTimeContexts.push({ unitId: unit.id ?? "unknown", range: { start, end },
      outside, timedEvidence });
  }
  if (evidenceTimeViolations.length > 0) problem("EVIDENCE_TIME_RANGE",
    `${evidenceTimeViolations.join(",")}; temporalContext=${JSON.stringify(evidenceTimeContexts)}; ` +
    "correctionChoices=correct the actual unit time range after checking every cited time | " +
    "split a cross-time knowledge unit | remove inapplicable references; " +
    "do not widen a range solely to pass validation or rewrite the conclusion");
  for (const source of reconstruction.derivedSources ?? []) {
    if (!source.path) { problem("DERIVED_SOURCE_PATH", source.id); continue; }
    const resolved = path.resolve(outputDir, source.path);
    const root = path.resolve(outputDir);
    if (!resolved.startsWith(`${root}${path.sep}`) || !exists(resolved)) problem("DERIVED_SOURCE_MISSING", source.path);
  }

  const channels = reconstruction.coverageMatrix?.channels ?? [];
  const invalidCarrierIds = [
    ...(probe.informationCarriers ?? []).filter(invalidCarrierInspectionContract)
      .map((carrier) => `probe:${carrier.id ?? "unknown"}`),
    ...channels.filter(invalidCarrierInspectionContract)
      .map((carrier) => `reconstruction:${carrier.id ?? "unknown"}`)
  ];
  if (invalidCarrierIds.length > 0) problem("CARRIER_STATUS", invalidCarrierIds.join(","));
  const availableChannels = channels.filter((channel) => channel.available);
  if (availableChannels.some((channel) => !["checked_readable", "checked_unreadable"].includes(carrierInspectionStatus(channel)))) {
    problem("UNCHECKED_AVAILABLE_CHANNEL");
  }
  if ((reconstruction.coverageMatrix?.uncheckedChannels ?? []).length > 0) problem("UNCHECKED_CHANNELS");
  const meta = reconstruction.metaGate;
  if (meta?.pass !== true || (meta.uncheckedChannels ?? []).length > 0 ||
      (meta.overlookedMeaningChanges ?? []).length > 0 || (meta.overlookedRelationships ?? []).length > 0) {
    problem("META_GATE");
  }

  if (issues.length > 0) throw new Error(issues.join("\n"));

  return {
    transcriptCues: sourceCues.length,
    accountableCues: accountability.length,
    knowledgeUnits: units.length,
    coreUnits: coreUnits.length,
    evidenceReferences: references.length,
    availableChannels: availableChannels.length,
    inspectedChannels: availableChannels.filter((channel) => ["checked_readable", "checked_unreadable"].includes(carrierInspectionStatus(channel))).length,
    builderLensEvidenceReferences: lensReferences.length
  };
}
