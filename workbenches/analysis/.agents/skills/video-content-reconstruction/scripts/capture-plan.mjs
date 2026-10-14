import { uniqueTimes } from "./lib.mjs";
import { captureTimes } from "./targeted-capture-times.mjs";

const timeKey = (time) => time.toFixed(2);

export function planCaptureProtocol(protocol, duration, { maxFramesPerAction = 60, maxTotalFrames = 180 } = {}) {
  const errors = [];
  const actions = [];
  const exactTimes = new Set();
  for (const [index, action] of (protocol.captureActions || []).entries()) {
    const start = Number(action.range?.start ?? 0);
    const end = Number(action.range?.end ?? start);
    const path = `/captureActions/${index}`;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end > duration + 0.25) {
      errors.push({ path: `${path}/range`, message: `${action.id}: invalid range ${start}–${end}s for ${duration}s video` });
      continue;
    }
    try {
      const sampleSource = action.times?.length ? "explicit times" : action.mode === "before_during_after"
        ? "range endpoints and midpoint" : "range and densitySeconds";
      const selected = uniqueTimes(captureTimes(action, start, end, maxFramesPerAction), duration);
      if (selected.length > maxFramesPerAction) {
        const recovery = sampleSource === "explicit times"
          ? `Nonempty action.times takes precedence over range and densitySeconds; changing range alone will not reduce these ${selected.length} samples. Select at most ${maxFramesPerAction} question-relevant values in action.times.`
          : `Sampling uses ${sampleSource}; narrow the range or increase the spacing in densitySeconds to reach at most ${maxFramesPerAction} samples.`;
        errors.push({ code: "ACTION_LIMIT", path, message: `${action.id} (${start}–${end}s) requests ${selected.length}/${maxFramesPerAction} times from ${sampleSource} (${selected.length - maxFramesPerAction} over cap). ${recovery}` });
      }
      let newUniqueTimes = 0;
      for (const time of selected) {
        const key = timeKey(time);
        if (!exactTimes.has(key)) { exactTimes.add(key); newUniqueTimes += 1; }
      }
      actions.push({ action, index, selected, sampleSource, sampleCount: selected.length, newUniqueTimes,
        cumulativeUniqueTimes: exactTimes.size });
    } catch (error) {
      errors.push({ path, message: `${action.id} (${start}–${end}s): ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  if (exactTimes.size > maxTotalFrames) {
    const firstOver = actions.find(row => row.cumulativeUniqueTimes > maxTotalFrames);
    const reduction = exactTimes.size - maxTotalFrames;
    const recovery = actions.some(row => row.sampleSource === "explicit times")
      ? `Reduce the protocol-wide union by at least ${reduction} unique times. For actions with nonempty times, select fewer actual action.times values; changing only range will not reduce their selected samples. Keep every action at or below ${maxFramesPerAction} samples.`
      : `Reduce the protocol-wide union by at least ${reduction} unique times by narrowing action ranges or increasing densitySeconds spacing; keep every action at or below ${maxFramesPerAction} samples.`;
    errors.push({ code: "TOTAL_LIMIT", path: firstOver ? `/captureActions/${firstOver.index}` : "/captureActions",
      message: `Protocol plans ${exactTimes.size}/${maxTotalFrames} total unique times (${reduction} over cap); ${firstOver?.action.id ?? "an action"} first exceeds the cap at ${firstOver?.cumulativeUniqueTimes ?? exactTimes.size} (${firstOver?.newUniqueTimes ?? 0} new times, ${firstOver?.sampleCount ?? 0} samples from ${firstOver?.sampleSource ?? "unknown source"}, ${firstOver?.action.range?.start ?? "?"}–${firstOver?.action.range?.end ?? "?"}s). ${recovery}` });
  }
  return { pass: errors.length === 0, maxFramesPerAction, maxTotalFrames,
    totalUniqueTimes: exactTimes.size, actions, errors };
}
