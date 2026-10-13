import { finalSummarySchema, type PostSourceFacts } from "../../../../contracts/index.js";

const metricKeys = ["likes", "collections", "comments", "shares"] as const;
const mismatch = (field: string, expected: unknown, received: unknown): never => {
  throw new Error(`FINAL_SUMMARY_SOURCE_FACTS field=/performance/${field} frozenExpected=${JSON.stringify(expected)} received=${JSON.stringify(received)}`);
};

/** Check only source identity and observed numbers; Builder owns every interpretation. */
export function assertFinalSummaryPerformance(summary: unknown, sourceFacts: PostSourceFacts): void {
  const parsed = finalSummarySchema.parse(summary);
  const performance = parsed.performance;
  if (performance.observedAt !== sourceFacts.capturedAt) {
    mismatch("observedAt", sourceFacts.capturedAt, performance.observedAt);
  }
  if (performance.publishedLabel !== sourceFacts.publishedLabel) {
    mismatch("publishedLabel", sourceFacts.publishedLabel, performance.publishedLabel);
  }
  const seen = new Set<string>();
  for (const observation of performance.observedMetrics) {
    if (seen.has(observation.metric)) mismatch(`observedMetrics/${observation.metric}`, "exactly one entry", "duplicate entries");
    seen.add(observation.metric);
    if (observation.value !== sourceFacts.metrics[observation.metric]) {
      mismatch(`observedMetrics/${observation.metric}/value`, sourceFacts.metrics[observation.metric], observation.value);
    }
  }
  for (const metric of metricKeys) if (!seen.has(metric)) mismatch(`observedMetrics/${metric}`, sourceFacts.metrics[metric], "missing");
  if (performance.comparison !== null) {
    mismatch("comparison", null, performance.comparison);
  }
}
