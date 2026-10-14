import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { VideoResearch } from "../../shared/contracts/core";
import { PackagingReport } from "./DepthReports";

const surface = {
  state: "available", sourceRef: null, audience: null, promise: null, tension: null, specificity: null,
  searchTerms: null, composition: null, typeHierarchy: null, smallSizeReadability: null, evidenceRefs: [], unknowns: []
};
const data = {
  sourceFacts: { title: null, coverHref: null }, frames: { dense: [], sparse: [] }, transcript: [], evidenceIndex: [],
  directingLogic: { packagingAnalysis: {
    title: surface, cover: surface, firstFrame: surface, unknowns: [], fulfillment: [
      { origin: "first_frame", promise: "首帧出现产品型号", status: "partial", bodyEvidenceRefs: ["FRAME-01"], explanation: "首帧 0.0 秒可见型号，引用 FRAME-01。" },
      { origin: "on_screen_text", promise: "后续画面给出操作步骤", status: "fulfilled", bodyEvidenceRefs: ["OCR-02"], explanation: "2.4 秒片内文字写明步骤，引用 OCR-02。" },
      { origin: "title", promise: "标题说明测试结果", status: "fulfilled", bodyEvidenceRefs: [], explanation: "正文给出了测试结果。" }
    ]
  } }
} as unknown as VideoResearch;

describe("packaging fulfillment source labels", () => {
  it("shows first-frame and later on-screen text as separate Chinese origins", () => {
    const html = renderToStaticMarkup(createElement(PackagingReport, { data }));

    expect(html).toContain("视频首帧画面或文字 → 正文");
    expect(html).toContain("后续片内可观察文字 → 正文");
    expect(html).toContain("发布标题 → 正文");
    expect(html).toContain("首帧 0.0 秒可见型号，引用 FRAME-01。");
    expect(html).toContain("2.4 秒片内文字写明步骤，引用 OCR-02。");
  });
});
