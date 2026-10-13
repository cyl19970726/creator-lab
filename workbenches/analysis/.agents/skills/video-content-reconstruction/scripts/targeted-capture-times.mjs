export function captureTimes(action, start, end, maxSamples = 60) {
  if (action.times?.length) return action.times;
  if (action.mode === "exact_times") throw new Error(`exact_times action ${action.id} requires times`);
  if (action.mode === "before_during_after") return [start, (start + end) / 2, end];

  const isTextReview = action.mode === "ocr_review" || action.mode === "ui_state_review";
  const fallback = action.mode === "motion_sequence" ? 0.2 : isTextReview ? 0.25 : 0.5;
  // A short, explicitly requested text window gets interior samples; a broad one
  // widens the automatic spacing to stay within the action cap.
  const spacing = isTextReview ? Math.min(fallback, Math.max(0.08, (end - start) / 6)) : fallback;
  const adaptiveSpacing = isTextReview ? Math.max(spacing, (end - start) / Math.max(1, maxSamples - 1)) : spacing;
  const density = Number(action.densitySeconds ?? adaptiveSpacing);
  if (!Number.isFinite(density) || density <= 0) throw new Error(`Invalid densitySeconds for ${action.id}`);
  if ((end - start) / density > maxSamples) {
    throw new Error(`${action.id} exceeds ${maxSamples} sampled frames; refine its range or raise --max-frames-per-action explicitly`);
  }
  const times = [];
  for (let time = start; time <= end + 0.0001; time += density) times.push(time);
  times.push(end);
  return times;
}
