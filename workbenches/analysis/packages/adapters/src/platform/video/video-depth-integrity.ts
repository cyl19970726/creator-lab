import { openingAnalysisSchema, packagingAnalysisSchema } from "../../../../contracts/index.js";

type PostSource = { facts: { title: string | null; coverHref: string | null }; cover?: unknown } | null;

/** Source identity can be checked when directingLogic is staged; index registration is checked after assembly. */
export function depthPackagingSourceDiagnostics(directingLogic: unknown, source: PostSource,
  derivedSourceIds?: ReadonlySet<string>, frames?: ReadonlyMap<string, number>): string[] {
  const packaging = packagingAnalysisSchema.safeParse((directingLogic as { packagingAnalysis?: unknown } | null)?.packagingAnalysis);
  if (!packaging.success) return [];
  const errors: string[] = [];
  for (const [key, required, exists, code] of [
    ["cover", "POST-COVER", Boolean(source?.facts.coverHref && source?.cover), "INDEPENDENT_COVER"],
    ["title", "POST-TITLE", Boolean(source?.facts.title), "TITLE_SOURCE"]
  ] as const) {
    const surface = packaging.data[key];
    if (surface.state !== "available") continue;
    const field = `builderLenses.directingLogic.packagingAnalysis.${key}`;
    if (!exists) {
      errors.push(`BUILDER_INTEGRITY_DEPTH_${code}:${field}.state received="available" but frozen post source has no ${key === "cover" ? "cover image/coverHref" : "title"}; do not mark this source available or register ${required} without frozen source evidence`);
      continue;
    }
    const mismatches: string[] = [];
    if (surface.sourceRef !== required) mismatches.push(`${field}.sourceRef received=${JSON.stringify(surface.sourceRef)} required=${JSON.stringify(required)}`);
    if (!surface.evidenceRefs.includes(required)) mismatches.push(`${field}.evidenceRefs received=${JSON.stringify(surface.evidenceRefs)} must include ${JSON.stringify(required)}`);
    if (derivedSourceIds && !derivedSourceIds.has(required)) {
      mismatches.push(`derivedSources missing id=${JSON.stringify(required)}; register the existing frozen source in the reconstruction index`);
    }
    if (mismatches.length) {
      errors.push(`BUILDER_INTEGRITY_DEPTH_${code}:${mismatches.join("; ")}; correct the directingLogic lens with revise_builder_lens slot=directingLogic useLatest:true, then validate_reconstruction_draft useLatestBuilderLenses:true; changing only the index cannot correct a lens binding`);
    }
  }
  const firstFrame = packaging.data.firstFrame;
  if (frames && firstFrame.state !== "missing") {
    const sourceRef = firstFrame.sourceRef;
    const resolvedTime = sourceRef === null ? undefined : frames.get(sourceRef);
    if (resolvedTime === undefined || !Number.isFinite(resolvedTime) || resolvedTime < 0 || resolvedTime > 0.5) {
      const examples = [...frames.entries()]
        .filter(([, time]) => Number.isFinite(time) && time >= 0 && time <= 0.5)
        .sort(([leftId, leftTime], [rightId, rightTime]) => leftTime - rightTime || leftId.localeCompare(rightId))
        .slice(0, 6).map(([ref, time]) => `${ref}@${time}s`);
      errors.push(`BUILDER_INTEGRITY_DEPTH_FIRST_FRAME:builderLenses.directingLogic.packagingAnalysis.firstFrame.sourceRef received=${JSON.stringify(sourceRef)} resolvedTime=${resolvedTime === undefined ? "missing" : `${resolvedTime}s`} required=0..0.5s; valid frozen opening frame examples=${JSON.stringify(examples)} (inspect pixels before choosing); revise_builder_lens slot=directingLogic useLatest:true to change firstFrame.sourceRef, then validate_reconstruction_draft useLatestBuilderLenses:true; changing only evidenceRefs or an index timeRange cannot repair this lens field`);
    }
  }
  return errors;
}

export function validateVideoDepth(input: unknown, duration: number, ids: Set<string>, frames: Map<string, number>,
  source: PostSource) {
  const root = input as { depthContractVersion?: string; derivedSources?: Array<{ id?: string; path?: string }>;
    builderLenses?: { visualEditing?: { openingAnalysis?: unknown }; directingLogic?: { packagingAnalysis?: unknown };
      finalSummary?: { reusableLessons?: Array<{ evidenceRefs?: string[] }>;
        performance?: { evidenceRefs?: string[] } } } };
  const fail = (reason: string, detail?: string): never => {
    throw new Error(`BUILDER_INTEGRITY_DEPTH_${reason}${detail ? `:${detail}` : ""}`);
  };
  if (!root.depthContractVersion && !source) return;
  if (root.depthContractVersion !== "single-post-depth@1") fail("CONTRACT_MISSING");
  const openingResult = openingAnalysisSchema.safeParse(root.builderLenses?.visualEditing?.openingAnalysis);
  const packagingResult = packagingAnalysisSchema.safeParse(root.builderLenses?.directingLogic?.packagingAnalysis);
  if (!openingResult.success || !packagingResult.success) return fail("SCHEMA");
  const opening = openingResult.data, packaging = packagingResult.data;
  const sourceErrors = depthPackagingSourceDiagnostics(root.builderLenses?.directingLogic,
    source, new Set((root.derivedSources ?? []).map(item => item.id).filter((id): id is string => Boolean(id))), frames);
  if (sourceErrors.length) throw new Error(sourceErrors.join("\n"));
  if (!Number.isFinite(duration) || Math.abs(opening.duration - Math.min(10, duration)) > 0.02) fail("DURATION");
  const invalidReferenceDetails: string[] = [];
  const checkRefs = (refs: string[], location: string) => {
    const invalid = [...new Set(refs.filter(ref => !ids.has(ref)))];
    if (invalid.length > 0) invalidReferenceDetails.push(`${location}:${invalid.join(",")}`);
  };
  let cursor = 0;
  const seen = new Set<string>();
  for (const [index, segment] of opening.segments.entries()) {
    if (seen.has(segment.id)) fail("DUPLICATE_SEGMENT");
    seen.add(segment.id);
    const { start, end } = segment.timeRange;
    if (Math.abs(start - cursor) > 0.001 || end <= start || end > opening.duration + 0.001) fail("COVERAGE");
    cursor = end;
    checkRefs(segment.evidenceRefs, `builderLenses.visualEditing.openingAnalysis.segments[${index}].evidenceRefs`);
    const times = [...new Set(segment.frameRefs.map(ref => frames.get(ref)).filter((time): time is number => time !== undefined))].sort((a,b) => a-b);
    const gapIndex = times.findIndex((time, position) => position > 0 && time - times[position - 1]! > 1.01);
    if (!times.length || times[0]! - start > .55 || end - times.at(-1)! > .55 || gapIndex >= 0) {
      const reason = !times.length ? "no frames"
        : times[0]! - start > .55 ? `start gap=${times[0]! - start}`
          : end - times.at(-1)! > .55 ? `end gap=${end - times.at(-1)!}`
            : `internal gap=${times[gapIndex]! - times[gapIndex - 1]!} at ${times[gapIndex - 1]}..${times[gapIndex]}`;
      fail("FRAME_STRIP_COVERAGE", `segments[${index}](${segment.id}) range=[${start},${end}] ${reason}`);
    }
    for (const ref of segment.frameRefs) {
      const time = frames.get(ref);
      if (time === undefined || time < start - 0.05 || time > end + 0.05) {
        fail("FRAME_RANGE", `segments[${index}](${segment.id}):${ref}@${time ?? "missing"} outside [${start},${end}]`);
      }
    }
  }
  if (Math.abs(cursor - opening.duration) > 0.001) fail("COVERAGE");
  for (const key of ["title", "cover", "firstFrame"] as const) {
    const surface = packaging[key];
    if (surface.state === "missing") {
      if (surface.sourceRef !== null || surface.evidenceRefs.length || !surface.unknowns.length ||
          [surface.audience, surface.promise, surface.tension, surface.specificity, surface.searchTerms,
            surface.composition, surface.typeHierarchy, surface.smallSizeReadability].some(value => value !== null)) fail("MISSING_SOURCE_CLAIM");
    } else {
      if (!surface.sourceRef || !surface.evidenceRefs.length) fail("SOURCE_REFERENCE");
      checkRefs(surface.evidenceRefs, `builderLenses.directingLogic.packagingAnalysis.${key}.evidenceRefs`);
      checkRefs([surface.sourceRef!], `builderLenses.directingLogic.packagingAnalysis.${key}.sourceRef`);
    }
  }
  for (const [index, item] of packaging.fulfillment.entries()) {
    checkRefs(item.bodyEvidenceRefs, `builderLenses.directingLogic.packagingAnalysis.fulfillment[${index}].bodyEvidenceRefs`);
    if ((item.status === "fulfilled" || item.status === "partial") && !item.bodyEvidenceRefs.length) fail("FULFILLMENT_EVIDENCE");
  }
  const summary = root.builderLenses?.finalSummary;
  if (summary) {
    for (const [index, lesson] of (summary.reusableLessons ?? []).entries()) {
      if (Array.isArray(lesson.evidenceRefs)) {
        checkRefs(lesson.evidenceRefs, `builderLenses.finalSummary.reusableLessons[${index}].evidenceRefs`);
      }
    }
    const performanceRefs = summary.performance?.evidenceRefs;
    if (Array.isArray(performanceRefs)) {
      checkRefs(performanceRefs, "builderLenses.finalSummary.performance.evidenceRefs");
      const frozenSourceIds = new Set((root.derivedSources ?? [])
        .filter(item => item.path === "post-source-input.json" && item.id && ids.has(item.id))
        .map(item => item.id));
      if (!performanceRefs.some(ref => frozenSourceIds.has(ref))) {
        fail("FINAL_SUMMARY_PERFORMANCE_SOURCE", `builderLenses.finalSummary.performance.evidenceRefs=${JSON.stringify(performanceRefs)} must include a derivedSources ID whose path is exactly post-source-input.json`);
      }
    }
  }
  if (invalidReferenceDetails.length > 0) fail("REFERENCE", invalidReferenceDetails.join("\n"));
}
