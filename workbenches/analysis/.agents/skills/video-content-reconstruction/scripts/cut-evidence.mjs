import { round } from "./lib.mjs";

const MAX_BOUNDARY_OFFSET = 0.08;

function insideShot(boundary, shot, side) {
  const available = side === "before" ? boundary - shot.start : shot.end - boundary;
  if (available <= 0) throw new Error(`Cut boundary ${boundary}s falls outside ${shot.id}`);
  const offset = Math.min(MAX_BOUNDARY_OFFSET, available / 2);
  const time = round(boundary + (side === "before" ? -offset : offset));
  if (time <= shot.start || time >= shot.end || (side === "before" ? time >= boundary : time <= boundary)) {
    throw new Error(`No millisecond-resolution ${side} frame inside ${shot.id} at ${boundary}s`);
  }
  return time;
}

export function buildEditingCutEvidence(shots, detectedCuts, cues) {
  const records = [];
  const frames = [];
  for (const detected of detectedCuts) {
    const boundary = round(detected);
    const fromShot = shots.find((shot) => Math.abs(shot.end - boundary) < 0.001);
    const toShot = shots.find((shot) => Math.abs(shot.start - boundary) < 0.001);
    if (!fromShot || !toShot) throw new Error(`Detected cut at ${boundary}s has no adjacent shot pair`);
    const cutId = `CUT-${String(records.length + 1).padStart(3, "0")}`;
    const beforeTime = insideShot(boundary, fromShot, "before");
    const afterTime = insideShot(boundary, toShot, "after");
    const beforeFrame = `FRAME-${cutId}-BEFORE`;
    const afterFrame = `FRAME-${cutId}-AFTER`;
    frames.push(
      { id: beforeFrame, time: beforeTime, frame: `frames/cuts/${cutId.toLowerCase()}-before.jpg`, purpose: "detected_cut_before" },
      { id: afterFrame, time: afterTime, frame: `frames/cuts/${cutId.toLowerCase()}-after.jpg`, purpose: "detected_cut_after" }
    );
    const cueIds = cues.filter((cue) => cue.start <= afterTime && cue.end >= beforeTime)
      .map((cue) => cue.id);
    const cueSnapshot = (cue) => ({ id: cue.id, start: cue.start, end: cue.end, text: cue.text ?? "" });
    const activeAt = (time) => cues.filter((cue) => cue.start <= time && time < cue.end).map(cueSnapshot);
    const nextCue = cues.filter((cue) => cue.start > afterTime).sort((a, b) => a.start - b.start)[0];
    records.push({
      id: cutId, boundary, detected: true, semanticallyConfirmed: false,
      fromShot: fromShot.id, toShot: toShot.id,
      beforeFrame: frames.at(-2), afterFrame: frames.at(-1), cueIds,
      cueTiming: {
        basis: "Frozen ASR cue intervals; not verified spoken-word or on-screen caption timing.",
        before: activeAt(beforeTime), after: activeAt(afterTime),
        next: nextCue ? cueSnapshot(nextCue) : null
      }
    });
  }
  return { records, frames };
}

export function cutSheetPages(records, pairsPerPage = 4) {
  const pages = [];
  for (let index = 0; index < records.length; index += pairsPerPage) {
    const page = pages.length + 1;
    pages.push({
      id: `editing-cuts-${String(page).padStart(2, "0")}`,
      page,
      frame: `contact/cuts-${String(page).padStart(3, "0")}.jpg`,
      cutIds: records.slice(index, index + pairsPerPage).map((record) => record.id)
    });
  }
  return pages;
}
