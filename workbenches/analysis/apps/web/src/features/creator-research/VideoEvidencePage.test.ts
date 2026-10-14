import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { VideoResearch } from "../../shared/contracts/core";
import { ReportChapters } from "./VideoEvidencePage";

const report = {
  thesis: "原始内容还原。",
  contentBlocks: [], contentUnknowns: [],
  frames: { dense: [], sparse: [] }, transcript: [], evidenceIndex: [],
  sourceFacts: { coverHref: null },
  finalSummary: {
    conclusion: "Builder 的原始总论，不能改写。",
    contentSynthesis: "内容综合原文。",
    directingSynthesis: "编导综合原文。",
    editingSynthesis: "剪辑综合原文。",
    reusableLessons: [{ lesson: "可复用经验原文", conditions: "适用条件原文", action: "制作动作原文", evidenceRefs: [] }],
    performance: { observedAt: null, publishedLabel: null, observedMetrics: [], interpretation: "表现解释原文。", comparison: null, limitations: [], evidenceRefs: [] },
    limits: ["结论边界原文。"]
  }
} as unknown as VideoResearch;

function render(data: VideoResearch) {
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ["/report?run=run-1&version=original&lens=summary#summary"] },
    createElement(ReportChapters, { data, current: "summary", search: new URLSearchParams("run=run-1&version=original&lens=summary") })));
}

describe("ordinary single-post report summary", () => {
  it("links to the selected version's summary and renders Builder text unchanged", () => {
    const html = render(report);
    expect(html).toContain('href="/report?run=run-1&amp;version=original&amp;lens=summary#summary"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('id="summary"');
    for (const text of ["Builder 的原始总论，不能改写。", "内容综合原文。", "编导综合原文。", "剪辑综合原文。", "可复用经验原文", "表现解释原文。", "结论边界原文。"])
      expect(html).toContain(text);
  });

  it("hides the summary chapter and shows content when this version has no finalSummary", () => {
    const html = render({ ...report, finalSummary: null });
    expect(html).not.toContain("综合总结");
    expect(html).not.toContain('id="summary"');
    expect(html).toContain("原始内容还原。");
  });
});
