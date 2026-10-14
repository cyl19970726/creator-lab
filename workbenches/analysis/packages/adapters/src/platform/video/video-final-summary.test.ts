import { describe, expect, it } from "vitest";
import { assertFinalSummaryPerformance } from "./video-final-summary.js";
import { missingPostSourceFacts } from "../../../../contracts/index.js";

const facts = {
  ...missingPostSourceFacts,
  capturedAt: "2026-10-13T04:00:00.000Z",
  publishedLabel: "2026-10-01",
  metrics: { likes: 23, collections: 4, comments: null, shares: 0 }
};
const summary = {
  conclusion: "整体判断", contentSynthesis: "内容综合", directingSynthesis: "编导综合", editingSynthesis: "剪辑综合",
  reusableLessons: [{ lesson: "经验", conditions: "适用条件", action: "行动", evidenceRefs: ["SHOT-1"] }],
  limits: ["限制"],
  performance: {
    observedAt: facts.capturedAt, publishedLabel: facts.publishedLabel,
    observedMetrics: [
      { metric: "likes", value: 23 }, { metric: "collections", value: 4 },
      { metric: "comments", value: null }, { metric: "shares", value: 0 }
    ],
    interpretation: "目前只能说明有可见互动，缺少曝光分母。", comparison: null,
    limitations: ["没有浏览量和留存数据。"], evidenceRefs: ["POST-SOURCE-INPUT"]
  }
};

describe("frozen post performance in Builder final summary", () => {
  it("accepts exact counts, including true zero and missing null", () => {
    expect(() => assertFinalSummaryPerformance(summary, facts)).not.toThrow();
  });
  it("rejects invented counts, duplicate or absent metrics, and an unsupported comparison", () => {
    for (const observedMetrics of [
      summary.performance.observedMetrics.map((item) => item.metric === "likes" ? { ...item, value: 24 } : item),
      [summary.performance.observedMetrics[0], summary.performance.observedMetrics[0], ...summary.performance.observedMetrics.slice(2)],
      summary.performance.observedMetrics.slice(0, 3)
    ]) {
      expect(() => assertFinalSummaryPerformance({ ...summary, performance: { ...summary.performance, observedMetrics } }, facts)).toThrow();
    }
    expect(() => assertFinalSummaryPerformance({ ...summary, performance: { ...summary.performance, comparison: "高于同类" } }, facts)).toThrow();
  });
  it("requires the exact frozen observation and publication labels", () => {
    expect(() => assertFinalSummaryPerformance({ ...summary, performance: { ...summary.performance, observedAt: null } }, facts))
      .toThrow('field=/performance/observedAt frozenExpected="2026-10-13T04:00:00.000Z" received=null');
    expect(() => assertFinalSummaryPerformance({ ...summary, performance: { ...summary.performance, publishedLabel: null } }, facts))
      .toThrow('field=/performance/publishedLabel frozenExpected="2026-10-01" received=null');
  });
  it("reports the exact frozen and received value for a count, preserving null versus zero", () => {
    const observedMetrics = summary.performance.observedMetrics.map(item => item.metric === "comments"
      ? { metric: item.metric, value: 0 } : item);
    expect(() => assertFinalSummaryPerformance({ ...summary, performance: { ...summary.performance, observedMetrics } }, facts))
      .toThrow("field=/performance/observedMetrics/comments/value frozenExpected=null received=0");
  });
});
