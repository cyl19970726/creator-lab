type FrameOption = { id: string; time: number };
type SegmentLike = { id?: unknown; timeRange?: unknown; frameRefs?: unknown };

const OPENING_PATH = "builderLenses.visualEditing.openingAnalysis";
const SEGMENTS_PATH = `${OPENING_PATH}.segments`;
const FRAME_PREVIEW_LIMIT = 32;
const OPENING_PREVIEW_LIMIT = 80;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function previewFrames(frames: FrameOption[], limit: number): string {
  const selected = frames.slice(0, limit).map(({ id, time }) => `${id}@${time}`);
  return `${selected.join(",")}${frames.length > limit ? ` (+${frames.length - limit} more)` : ""}` || "none";
}

function compactFrames(frames: Map<string, number>, start: number, end: number, limit: number): FrameOption[] {
  const byTime = new Map<number, FrameOption>();
  for (const [id, time] of frames) {
    if (!Number.isFinite(time) || time < start - 0.05 || time > end + 0.05) continue;
    const current = byTime.get(time);
    if (!current || (id.startsWith("OPEN-") && !current.id.startsWith("OPEN-"))) byTime.set(time, { id, time });
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id)).slice(0, limit + 1);
}

function timeText(time: number | undefined): string {
  return time === undefined ? "missing" : String(time);
}

/** Collects opening-frame integrity issues without changing the reconstruction. */
export function collectOpeningFrameDiagnostics(
  reconstruction: unknown,
  duration: number,
  frames: Map<string, number>
): string[] {
  const diagnostics: string[] = [];
  const root = record(reconstruction);
  const lenses = record(root?.builderLenses);
  const visualEditing = record(lenses?.visualEditing);
  const opening = record(visualEditing?.openingAnalysis);
  const expectedDuration = Number.isFinite(duration) && duration > 0 ? Math.min(10, duration) : NaN;
  const globalOptions = Number.isFinite(expectedDuration)
    ? compactFrames(frames, 0, expectedDuration, OPENING_PREVIEW_LIMIT)
    : [];
  const globalPreview = previewFrames(globalOptions, OPENING_PREVIEW_LIMIT);

  if (!opening) {
    diagnostics.push(`${OPENING_PATH}: missing or malformed opening analysis; expected range=[0,${Number.isFinite(expectedDuration) ? expectedDuration : "unknown"}]; available=${globalPreview}`);
    return diagnostics;
  }
  if (!Number.isFinite(expectedDuration)) {
    diagnostics.push(`${OPENING_PATH}.duration: invalid source duration=${duration}; expected opening range unavailable; available=${globalPreview}`);
  }
  const openingDuration = opening.duration;
  if (!Number.isFinite(openingDuration) || (Number.isFinite(expectedDuration) && Math.abs(Number(openingDuration) - expectedDuration) > 0.02)) {
    diagnostics.push(`${OPENING_PATH}.duration: current=${String(openingDuration)} expected=${Number.isFinite(expectedDuration) ? expectedDuration : "unknown"}; opening range=[0,${Number.isFinite(expectedDuration) ? expectedDuration : "unknown"}]; available=${globalPreview}`);
  }

  const rawSegments = opening.segments;
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) {
    diagnostics.push(`${SEGMENTS_PATH}: missing, malformed, or empty; expected consecutive coverage [0,${Number.isFinite(expectedDuration) ? expectedDuration : "unknown"}]; available=${globalPreview}`);
    return diagnostics;
  }

  let cursor = 0;
  let chainParseable = true;
  const seen = new Map<string, number>();
  rawSegments.forEach((rawSegment, index) => {
    const path = `${SEGMENTS_PATH}[${index}]`;
    const segment = record(rawSegment) as SegmentLike | null;
    if (!segment) {
      diagnostics.push(`${path}: malformed segment; expected range follows previous end=${cursor}; available=${globalPreview}`);
      chainParseable = false;
      return;
    }

    const id = typeof segment.id === "string" ? segment.id : String(segment.id ?? "missing");
    const range = record(segment.timeRange);
    const start = range?.start;
    const end = range?.end;
    const validRange = Number.isFinite(start) && Number.isFinite(end) && Number(end) > Number(start);
    const rangeText = validRange ? `[${String(start)},${String(end)}]` : `[${String(start ?? "missing")},${String(end ?? "missing")}]`;
    const available = validRange
      ? compactFrames(frames, Number(start), Number(end), FRAME_PREVIEW_LIMIT)
      : globalOptions;
    const availableText = previewFrames(available, validRange ? FRAME_PREVIEW_LIMIT : OPENING_PREVIEW_LIMIT);

    if (typeof segment.id === "string") {
      const prior = seen.get(segment.id);
      if (prior !== undefined) diagnostics.push(`${path}.id: duplicate=${JSON.stringify(segment.id)} firstAt=${SEGMENTS_PATH}[${prior}].id current=${JSON.stringify(segment.id)} segment=${id} range=${rangeText}; available=${availableText}`);
      else seen.set(segment.id, index);
    } else {
      diagnostics.push(`${path}.id: malformed current=${JSON.stringify(segment.id ?? null)} segment=${id} range=${rangeText}; available=${availableText}`);
    }

    if (!validRange) {
      diagnostics.push(`${path}.timeRange: malformed current=${JSON.stringify(segment.timeRange ?? null)}; segment=${id} range=${rangeText}; available=${availableText}`);
      chainParseable = false;
    } else {
      const segmentStart = Number(start);
      const segmentEnd = Number(end);
      if (Math.abs(segmentStart - cursor) > 0.001) {
        diagnostics.push(`${path}.timeRange.start: gap/overlap current=${segmentStart} previousEnd=${cursor} segment=${id} range=${rangeText}; available=${availableText}`);
      }
      if (Number.isFinite(expectedDuration) && (segmentStart < -0.001 || segmentEnd > expectedDuration + 0.001)) {
        diagnostics.push(`${path}.timeRange: outside opening current=${rangeText} expected=[0,${expectedDuration}] segment=${id}; available=${availableText}`);
      }
      cursor = segmentEnd;
    }

    const refs = segment.frameRefs;
    const stringRefs = Array.isArray(refs) ? refs.filter((ref): ref is string => typeof ref === "string") : [];
    if (!Array.isArray(refs) || stringRefs.length !== refs.length || stringRefs.length === 0) {
      diagnostics.push(`${path}.frameRefs: missing or malformed current=${JSON.stringify(refs ?? null)} segment=${id} range=${rangeText}; available=${availableText}`);
    }

    if (validRange) {
      const validTimes: number[] = [];
      for (const [refIndex, ref] of stringRefs.entries()) {
        const frameTime = frames.get(ref);
        if (frameTime === undefined || !Number.isFinite(frameTime) || frameTime < Number(start) - 0.05 || frameTime > Number(end) + 0.05) {
          diagnostics.push(`${path}.frameRefs[${refIndex}]: invalid frame=${JSON.stringify(ref)} time=${timeText(frameTime)} segment=${id} range=${rangeText}; available=${availableText}`);
        } else {
          validTimes.push(frameTime);
        }
      }
      const times = [...new Set(validTimes)].sort((a, b) => a - b);
      if (times.length === 0) {
        diagnostics.push(`${path}.frameRefs: no valid known frames; segment=${id} range=${rangeText} current=${JSON.stringify(refs)}; available=${availableText}`);
      } else {
        const first = times[0]!;
        const last = times.at(-1)!;
        if (first - Number(start) > 0.55) {
          diagnostics.push(`${path}.frameRefs: start gap=${first - Number(start)} first=${first} segment=${id} range=${rangeText}; current=${JSON.stringify(refs)}; available=${availableText}`);
        }
        for (let timeIndex = 1; timeIndex < times.length; timeIndex += 1) {
          const previous = times[timeIndex - 1]!;
          const current = times[timeIndex]!;
          if (current - previous > 1.01) {
            diagnostics.push(`${path}.frameRefs: interior gap=${current - previous} at ${previous}..${current} segment=${id} range=${rangeText}; current=${JSON.stringify(refs)}; available=${availableText}`);
          }
        }
        if (Number(end) - last > 0.55) {
          diagnostics.push(`${path}.frameRefs: end gap=${Number(end) - last} last=${last} segment=${id} range=${rangeText}; current=${JSON.stringify(refs)}; available=${availableText}`);
        }
      }
    }
  });

  if (chainParseable && Number.isFinite(expectedDuration) && Math.abs(cursor - expectedDuration) > 0.001) {
    diagnostics.push(`${SEGMENTS_PATH}: final coverage gap/overrun currentEnd=${cursor} expectedEnd=${expectedDuration} range=[0,${expectedDuration}]; available=${globalPreview}`);
  }
  return diagnostics;
}
