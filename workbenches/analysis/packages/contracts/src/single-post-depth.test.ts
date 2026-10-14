import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { packagingAnalysisSchema } from "./single-post-depth";

const surface = {
  state: "available", sourceRef: "POST-TITLE", audience: "受众", promise: "承诺", tension: "冲突",
  specificity: "具体信息", searchTerms: "搜索词", composition: "构图", typeHierarchy: "字号层级",
  smallSizeReadability: "可读性", evidenceRefs: ["POST-TITLE"], unknowns: []
};

describe("packaging fulfillment origins", () => {
  it("accepts historical and frame/text-specific origins", () => {
    const origins = ["title", "cover", "first_sentence", "first_frame", "on_screen_text"] as const;
    const parsed = packagingAnalysisSchema.parse({
      title: surface, cover: surface, firstFrame: surface, unknowns: [],
      fulfillment: origins.map((origin) => ({ origin, promise: `${origin} 的承诺`, status: "fulfilled", bodyEvidenceRefs: ["FRAME-01"], explanation: "对应正文证据已展示。" }))
    });

    expect(parsed.fulfillment.map(({ origin }) => origin)).toEqual(origins);
  });

  it("rejects unknown origins", () => {
    const base = { title: surface, cover: surface, firstFrame: surface, unknowns: [] };
    expect(packagingAnalysisSchema.safeParse({ ...base, fulfillment: [{ origin: "video_text", promise: "承诺", status: "fulfilled", bodyEvidenceRefs: [], explanation: "说明" }] }).success).toBe(false);
  });

  it("keeps the reconstruction JSON Schema origin enum in sync", () => {
    const schema = JSON.parse(readFileSync(new URL("../../../.agents/skills/video-content-reconstruction/schemas/reconstruction.schema.json", import.meta.url), "utf8"));
    const origin = schema.$defs.packagingAnalysis.properties.fulfillment.items.properties.origin;

    expect(origin.enum).toEqual(["title", "cover", "first_frame", "on_screen_text", "first_sentence"]);
    expect(schema.$defs.packagingAnalysis.properties.fulfillment.items.additionalProperties).toBe(false);
  });
});
