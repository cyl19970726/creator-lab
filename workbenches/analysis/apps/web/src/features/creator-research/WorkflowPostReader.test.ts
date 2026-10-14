import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { VideoResearch } from "../../shared/contracts/core";
import { WorkflowPostReader } from "./WorkflowPostReader";

const data = {
  frames: { dense: [], sparse: [] }, transcript: [], evidenceIndex: [], sourceFacts: { coverHref: null },
  thesis: "整篇内容的原始主张。",
  contentBlocks: [],
  contentUnknowns: [],
  visualEditing: {
    composition: "视听总览。", orientation: "竖屏", shotCount: 4, cutsPerMinute: 12,
    analyzedDuration: 20, resultFirstAt: 10, shotMetricBasis: null,
    carriers: [], claims: [], shotSemantics: [], uiProcedureStates: [], missingBridges: [],
    transitions: [{ start: 1, end: 2, from: "画面A", to: "画面B", mechanism: "直接切换。", function: "转场功能完整保留。".repeat(20), evidenceRefs: [] }],
    rhythm: [{ start: 2, end: 5, pace: "加速", density: "高", function: "节奏功能完整保留。".repeat(20), evidenceRefs: [] }],
    audioRole: "声音说明。", omissionRisks: [], notes: ["Builder 原始说明完整保留。".repeat(12)]
  }
} as unknown as VideoResearch;

function renderAt(entry: string) {
  return renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [entry] }, createElement(WorkflowPostReader, { data })));
}

const withFinalSummary = { ...data, evidenceIndex: [
  { id: "FRAME-1", kind: "frame", label: "关键画面", anchorId: "FRAME-1", artifactRef: "/artifacts/frame-1.jpg" },
  { id: "POST-SOURCE-INPUT", kind: "source", label: "平台数据", anchorId: null, artifactRef: "/artifacts/post-source-input.json" }
], directingLogic: {
  packagingAnalysis: null, viewerBefore: null, viewerAfter: null, activatedQuestion: null,
  promise: null, payoff: null, endingResolution: null, stages: [], informationDesign: [],
  proofDesign: [], loadAndPayoff: { compression: "", repetition: "", payoffDistance: "", comprehensionCosts: [] }, notes: []
}, finalSummary: {
  conclusion: "这条作品以问题推动理解。", contentSynthesis: "完整内容结论。",
  directingSynthesis: "完整编导结论。", editingSynthesis: "完整剪辑结论。",
  reusableLessons: [{ lesson: "先展示结果", conditions: "有可视结果时", action: "开头展示成品", evidenceRefs: ["FRAME-1"] }],
  limits: ["缺少留存数据。"], performance: {
    observedAt: "2026-10-13T04:00:00.000Z", publishedLabel: null,
    observedMetrics: [{ metric: "likes", value: 23 }, { metric: "collections", value: 0 },
      { metric: "comments", value: null }, { metric: "shares", value: null }],
    interpretation: "只有可见互动数。", comparison: null,
    limitations: ["没有曝光分母。"], evidenceRefs: ["POST-SOURCE-INPUT"]
  }
} } as unknown as VideoResearch;

describe("single-post report lens deep links", () => {
  it("opens the requested visual lens and preserves long Builder text", () => {
    const html = renderAt("/workflow-runs/run-42?run=creator-7&workflow=post-8&version=original&lens=visual#visual-editing");
    expect(html).toContain('aria-current="page" href="/workflow-runs/run-42?run=creator-7&amp;workflow=post-8&amp;version=original&amp;lens=visual#visual-editing"');
    expect(html).toContain('id="visual-editing"');
    expect(html).toContain("转场功能完整保留。".repeat(20));
    expect(html).toContain("节奏功能完整保留。".repeat(20));
    expect(html).toContain("Builder 原始说明完整保留。".repeat(12));
  });

  it("builds lens links with matching hashes while retaining run and workflow parameters", () => {
    const html = renderAt("/workflow-runs/run-42?run=creator-7&workflow=post-8&returnTo=%2Fworkflow-runs%2Frun-42&lens=visual#visual-editing");
    expect(html).toContain('href="/workflow-runs/run-42?run=creator-7&amp;workflow=post-8&amp;returnTo=%2Fworkflow-runs%2Frun-42&amp;lens=content#post-content"');
    expect(html).toContain('href="/workflow-runs/run-42?run=creator-7&amp;workflow=post-8&amp;returnTo=%2Fworkflow-runs%2Frun-42&amp;lens=directing#directing"');
    expect(html).toContain('href="/workflow-runs/run-42?run=creator-7&amp;workflow=post-8&amp;returnTo=%2Fworkflow-runs%2Frun-42&amp;lens=visual#visual-editing"');
  });

  it("defaults an unknown lens value to content", () => {
    const html = renderAt("/workflow-runs/run-42?run=creator-7&workflow=post-8&lens=unknown");
    expect(html).toContain('aria-current="page" href="/workflow-runs/run-42?run=creator-7&amp;workflow=post-8&amp;lens=content#post-content"');
    expect(html).toContain('id="post-content"');
    expect(html).not.toContain('id="visual-editing"');
  });

  it("appends the Builder conclusion and exact observed metrics at the end of every lens", () => {
    for (const lens of ["content", "directing", "visual"]) {
      const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [`/post?lens=${lens}`] }, createElement(WorkflowPostReader, { data: withFinalSummary })));
      expect(html).toContain("这条作品以问题推动理解。");
      expect(html).toContain("完整内容结论。");
      expect(html).toContain("完整编导结论。");
      expect(html).toContain("完整剪辑结论。");
      expect(html).toContain("先展示结果");
      expect(html).toContain("没有曝光分母。");
      expect(html).toContain("未取得");
      expect(html).toContain("整片总结");
      expect(html).toContain('href="/artifacts/frame-1.jpg"');
      expect(html).toContain('href="/artifacts/post-source-input.json"');
      expect(html).toContain("抓取时间：");
      expect(html).toContain("发布时间：未记录");
      expect(html).not.toContain("Builder · 综合总结");
      expect(html.indexOf("单帖综合总结")).toBeGreaterThan(html.indexOf("POST CANDIDATE"));
    }
    expect(renderAt("/post?lens=content")).not.toContain("单帖综合总结");
  });
});
