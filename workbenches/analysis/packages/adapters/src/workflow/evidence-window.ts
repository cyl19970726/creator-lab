import type { SiwcTool } from "@signal-room/workflow-agent-sdk";
import type { ResponsesEvidenceTools } from "./responses-tools.js";

export type IndexedEvidenceFrame = { ref: string; timeSeconds: number };

/** Use frozen source and target indexes together; TARGET sampling may miss a short caption. */
export function indexedEvidenceFrames(pack: unknown, targeted: unknown): IndexedEvidenceFrame[] {
  const source = pack as { frameIndex?: Array<{ id?: unknown; time?: unknown }> } | null;
  const target = targeted as { frames?: Array<{ id?: unknown; time?: unknown }> } | null;
  const frames = new Map<string, number>();
  for (const row of [...(source?.frameIndex ?? []), ...(target?.frames ?? [])]) {
    if (typeof row.id !== "string" || typeof row.time !== "number" || !Number.isFinite(row.time) || row.time < 0) continue;
    if (frames.has(row.id) && frames.get(row.id) !== row.time) throw new Error("RESPONSES_FRAME_INDEX_CONFLICT");
    frames.set(row.id, row.time);
  }
  return [...frames].map(([ref, timeSeconds]) => ({ ref, timeSeconds }))
    .sort((a, b) => a.timeSeconds - b.timeSeconds || a.ref.localeCompare(b.ref));
}

export function createEvidenceWindowTool(tools: ResponsesEvidenceTools, frames: readonly IndexedEvidenceFrame[]): SiwcTool {
  return {
    name: "inspect_evidence_window",
    description: "Inspect every indexed original and TARGET image in a short time window, in timestamp order. Includes DENSE, OPEN, CUE and CUT frames, so a TARGET sampling gap does not hide already available source pixels. Use for disputed captions, onset/continuation and visual unknowns. Maximum window 8 seconds / 24 images; on overflow narrow the window, never assume omitted pixels were inspected. This is sampled evidence, not continuous video or semantic validation.",
    parameters: { type: "object", additionalProperties: false, required: ["start", "end"], properties: {
      start: { type: "number", minimum: 0 }, end: { type: "number", minimum: 0 }
    } },
    execute: async (args): ReturnType<SiwcTool["execute"]> => {
      const { start, end } = (args ?? {}) as { start?: unknown; end?: unknown };
      if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end)
        || start < 0 || end < start || end - start > 8) {
        return { success: false, error: "RESPONSES_EVIDENCE_WINDOW_INVALID", recovery: "Choose a finite ordered time window of at most 8 seconds." };
      }
      const selected = frames.filter(frame => frame.timeSeconds >= start && frame.timeSeconds <= end);
      if (!selected.length || selected.length > 24) return { success: false,
        error: selected.length ? "RESPONSES_EVIDENCE_WINDOW_TOO_LARGE" : "RESPONSES_EVIDENCE_WINDOW_EMPTY",
        indexedFrames: selected, imagesInspected: 0,
        recovery: selected.length ? "Split this interval into narrower windows; no images were marked inspected."
          : "Use the frozen frame index to locate nearby samples; absence of a sample is not absence of content." };
      const available = new Set(tools.list());
      const unbound = selected.filter(frame => !available.has(frame.ref));
      if (unbound.length) return { success: false, error: "RESPONSES_EVIDENCE_WINDOW_UNBOUND", unbound, imagesInspected: 0 };
      const bundle = tools.readBundle([], selected.map(frame => frame.ref));
      if (!("kind" in bundle)) return bundle;
      return { ...bundle, value: { ...(bundle.value as object), requestedWindow: { start, end },
        orderedFrames: selected.map((frame, imageIndex) => ({ imageIndex, ...frame })),
        coverageScope: "all_indexed_frames_in_requested_window", semanticCoverage: "not_evaluated",
        limitation: "Only indexed samples are shown. Determine onset from preceding and following samples; do not treat a later readable sample as first appearance." } };
    }
  };
}
