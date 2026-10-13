import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { carrierInspectionStatus, contentBlockTemporalDiagnostics, contentBlockVisualDiagnostics,
  validateBuilderIntegrity } from "./video-builder-integrity.js";

const fixtureRoot = path.join(process.cwd(), ".agents", "skills", "video-content-reconstruction", "tests", "fixtures", "valid");

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "builder-integrity-"));
  const videoPath = path.join(root, "source-video.mp4");
  fs.writeFileSync(videoPath, "video");
  fs.mkdirSync(path.join(root, "evidence"), { recursive: true });
  fs.mkdirSync(path.join(root, "targeted-evidence"), { recursive: true });
  fs.copyFileSync(path.join(fixtureRoot, "evidence-pack.json"), path.join(root, "evidence/evidence-pack.json"));
  fs.copyFileSync(path.join(fixtureRoot, "targeted-evidence.json"), path.join(root, "targeted-evidence/targeted-evidence.json"));
  fs.copyFileSync(path.join(fixtureRoot, "probe.json"), path.join(root, "probe.json"));
  fs.copyFileSync(path.join(fixtureRoot, "reconstruction.json"), path.join(root, "reconstruction.json"));
  const evidencePath = path.join(root, "evidence/evidence-pack.json");
  fs.writeFileSync(path.join(root, "media-preparation.json"), JSON.stringify({
    sourceMedia: { fingerprint: sha256(videoPath) },
    transcript: { path: null, fingerprint: null },
    evidencePack: { path: evidencePath, fingerprint: sha256(evidencePath) }
  }));
  return { root, videoPath };
}

function upgradeFixtureToV2(root: string) {
  const file = path.join(root, "reconstruction.json");
  const reconstruction = JSON.parse(fs.readFileSync(file, "utf8"));
  reconstruction.schemaVersion = "video-reconstruction-2.0";
  reconstruction.builderLenses = {
    contentRestoration: {
      summary: "视频展示从设置入口到结果状态的完整变化。",
      blocks: [{ id: "BLOCK-001", type: "before_after", title: "设置前后变化", body: "先打开设置，再看到结果。",
        timeRange: { start: 0, end: 10 }, evidenceRefs: ["CUE-001", "TARGET-0004"],
        beforeFrameRef: "TARGET-0001", afterFrameRef: "TARGET-0004" }],
      unknowns: ["隐藏设置没有展示"]
    },
    directingLogic: {
      viewerBefore: "不知道入口", viewerAfter: "知道如何得到结果", activatedQuestion: "入口在哪里？", promise: "展示最短路径",
      payoff: "结果状态出现", endingResolution: "用结果完成闭环",
      stages: [
        { label: "提出问题", timeRange: { start: 0, end: 5 }, viewerQuestion: "入口在哪里？", function: "建立操作目标", proof: "口播要求打开设置",
          cognitiveChange: "从未知变成知道入口", comprehensionLoad: "低", payoff: "路径明确", evidenceRefs: ["CUE-001"] },
        { label: "展示结果", timeRange: { start: 5, end: 10 }, viewerQuestion: "操作是否成功？", function: "用结果状态验证操作", proof: "结果帧可见",
          cognitiveChange: "从理解步骤变成确认结果", comprehensionLoad: "低", payoff: "看到结果", evidenceRefs: ["CUE-002", "TARGET-0004"] }
      ],
      informationDesign: [], proofDesign: [],
      loadAndPayoff: { compression: "一步一信息", repetition: "口播与界面互补", payoffDistance: "五秒内", comprehensionCosts: ["隐藏参数未知"] }, notes: []
    },
    visualEditing: {
      orientation: "landscape", composition: "界面录屏承担操作与结果证明", shotCount: 2, cutsPerMinute: 12, resultFirstAt: 5,
      shotMetricBasis: "证据包技术分段，仅用于观察变化密度，不等同真实剪辑点。",
      analyzedDuration: 10, carriers: [{ name: "UI", roles: ["操作路径", "结果证明"], timeRange: { start: 0, end: 10 } }],
      claims: [{ statement: "结果状态在操作后出现", function: "证明操作闭环", timeRange: { start: 5, end: 10 }, evidenceRefs: ["TARGET-0004"] }],
      shotSemantics: [{ timeRange: { start: 0, end: 10 }, role: "步骤到结果", carrier: "UI", meaningChange: "从设置入口切换到结果", evidenceRefs: ["TARGET-0001", "TARGET-0004"] }],
      uiProcedureStates: [],
      transitions: [{ timeRange: { start: 4.5, end: 5.5 }, from: "设置界面", to: "结果界面", mechanism: "界面状态切换", function: "把操作转成可见回报", evidenceRefs: ["TARGET-0002", "TARGET-0004"] }],
      rhythm: [{ timeRange: { start: 0, end: 10 }, pace: "稳定", density: "一步一状态", function: "降低操作理解成本", evidenceRefs: ["TARGET-0001", "TARGET-0004"] }],
      missingBridges: [{ timeRange: { start: 0, end: 10 }, statement: "隐藏设置没有展示", impact: "无法完整复现参数", evidenceRefs: ["TARGET-0001", "TARGET-0004"] }],
      audioRole: null, notes: ["非旁白音频无可读语义证据"]
    }
  };
  fs.writeFileSync(file, JSON.stringify(reconstruction));
}

describe("Builder deterministic integrity gate", () => {
  it("identifies the exact visual content block and missing visual-binding fields", () => {
    expect(contentBlockVisualDiagnostics({ blocks: [
      { id: "B2", type: "spoken", body: "voice-only" },
      { id: "B3", type: "frame_strip", body: "state changes" }
    ] })).toEqual([
      "BUILDER_INTEGRITY_CONTENT_BLOCK_VISUAL_MISSING:builderLenses.contentRestoration.blocks[1](B3) has no visuals, frameRefs, beforeFrameRef/afterFrameRef, or steps"
    ]);
    expect(contentBlockVisualDiagnostics({ blocks: [{ id: "B3", type: "frame_strip", frameRefs: ["TARGET-0001"] }] })).toEqual([]);
    expect(contentBlockVisualDiagnostics({ blocks: [null, "bad block"] })).toEqual([]);
  });

  it("rejects v4.9-style out-of-range primary frame anchors with exact locations", () => {
    const times = new Map([["TARGET-0001", 1], ["TARGET-0034", 82.2], ["DENSE-0036", 87.5]]);
    expect(contentBlockTemporalDiagnostics({ blocks: [
      { id: "B1", type: "frame_strip", timeRange: { start: 0, end: 38.467 },
        evidenceRefs: ["TARGET-0034"], frameRefs: ["TARGET-0001", "TARGET-0034"],
        visuals: [{ role: "key_frame", ref: "TARGET-0001" }] },
      { id: "B2", type: "operation_sequence", timeRange: { start: 40, end: 60 },
        steps: [{ frameRefs: ["DENSE-0036"] }], visuals: [{ role: "during", ref: "TARGET-0034" }] }
    ] }, times, 100)).toEqual([
      "BUILDER_INTEGRITY_CONTENT_BLOCK_FRAME_TIME:builderLenses.contentRestoration.blocks[0](B1).frameRefs[1]:TARGET-0034@82.2 outside 0..38.467",
      "BUILDER_INTEGRITY_CONTENT_BLOCK_FRAME_TIME:builderLenses.contentRestoration.blocks[1](B2).visuals[0].ref:TARGET-0034@82.2 outside 40..60",
      "BUILDER_INTEGRITY_CONTENT_BLOCK_FRAME_TIME:builderLenses.contentRestoration.blocks[1](B2).steps[0].frameRefs[0]:DENSE-0036@87.5 outside 40..60"
    ]);
  });

  it("allows ordinary evidence comparisons and explicit before/after visual roles", () => {
    const times = new Map([["CURRENT", 20], ["EARLIER", 2], ["LATER", 82.2]]);
    expect(contentBlockTemporalDiagnostics({ blocks: [
      { id: "B1", type: "before_after", timeRange: { start: 19, end: 21 },
        evidenceRefs: ["EARLIER", "LATER"], frameRefs: ["CURRENT"],
        beforeFrameRef: "EARLIER", afterFrameRef: "LATER",
        visuals: [{ role: "before", ref: "EARLIER" }, { role: "during", ref: "CURRENT" },
          { role: "after", ref: "LATER" }] }
    ] }, times, 100)).toEqual([]);
    expect(contentBlockTemporalDiagnostics({ blocks: [
      { id: "B2", type: "text", timeRange: { start: 19, end: 21 }, evidenceRefs: ["LATER"] }
    ] }, times, 100)).toEqual([]);
  });

  it("uses the existing half-second tolerance and rejects malformed block ranges", () => {
    const times = new Map([["LOW", 9.5], ["HIGH", 20.5], ["OUT", 20.501]]);
    expect(contentBlockTemporalDiagnostics({ blocks: [
      { id: "EDGE", timeRange: { start: 10, end: 20 }, frameRefs: ["LOW", "HIGH", "OUT"] },
      { id: "REVERSED", timeRange: { start: 8, end: 7 }, frameRefs: ["OUT"] },
      { id: "PAST_DURATION", timeRange: { start: 0, end: 21 }, frameRefs: ["OUT"] }
    ] }, times, 20)).toEqual([
      "BUILDER_INTEGRITY_CONTENT_BLOCK_FRAME_TIME:builderLenses.contentRestoration.blocks[0](EDGE).frameRefs[2]:OUT@20.501 outside 10..20",
      "BUILDER_INTEGRITY_CONTENT_BLOCK_TIME_RANGE:builderLenses.contentRestoration.blocks[1](REVERSED).timeRange:8..7 duration=20",
      "BUILDER_INTEGRITY_CONTENT_BLOCK_TIME_RANGE:builderLenses.contentRestoration.blocks[2](PAST_DURATION).timeRange:0..21 duration=20"
    ]);
  });

  it("applies the content-block frame gate to the final v2 integrity validation", () => {
    const item = createFixture();
    try {
      upgradeFixtureToV2(item.root);
      const file = path.join(item.root, "reconstruction.json");
      const reconstruction = JSON.parse(fs.readFileSync(file, "utf8"));
      const block = reconstruction.builderLenses.contentRestoration.blocks[0];
      block.timeRange = { start: 0, end: 3 };
      block.frameRefs = ["TARGET-0001", "TARGET-0004"];
      fs.writeFileSync(file, JSON.stringify(reconstruction));
      expect(() => validateBuilderIntegrity(item.root, item.videoPath)).toThrow(
        "BUILDER_INTEGRITY_CONTENT_BLOCK_FRAME_TIME:builderLenses.contentRestoration.blocks[0](BLOCK-001).frameRefs[1]:TARGET-0004@7.5 outside 0..3"
      );
      block.frameRefs = ["TARGET-0001"];
      fs.writeFileSync(file, JSON.stringify(reconstruction));
      expect(() => validateBuilderIntegrity(item.root, item.videoPath)).not.toThrow();
    } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
  });

  it("treats checked_unreadable as closed without claiming semantic readability", () => {
    expect(carrierInspectionStatus({
      id: "CAR-AUDIO", available: true, inspected: true,
      inspectionStatus: "checked_unreadable", inspectionRationale: "Only technical stream presence is model-readable."
    })).toBe("checked_unreadable");
  });

  it("binds every transcript cue, unit relation, evidence reference, channel, and media revision", () => {
    const item = createFixture();
    try {
      expect(validateBuilderIntegrity(item.root, item.videoPath)).toMatchObject({
        transcriptCues: 2,
        accountableCues: 2,
        knowledgeUnits: 2,
        coreUnits: 2
      });
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it("rejects stale core evidence counts and accepts the mechanically derived count", () => {
    const item = createFixture();
    try {
      const file = path.join(item.root, "reconstruction.json");
      const reconstruction = JSON.parse(fs.readFileSync(file, "utf8"));
      for (let index = 3; index <= 5; index += 1) {
        reconstruction.knowledgeUnits.push({
          ...structuredClone(reconstruction.knowledgeUnits[0]),
          id: `KU-00${index}`
        });
      }
      reconstruction.coverageMatrix.coreEvidence = { covered: 4, total: 4 };
      fs.writeFileSync(file, JSON.stringify(reconstruction));
      expect(() => validateBuilderIntegrity(item.root, item.videoPath))
        .toThrow("BUILDER_INTEGRITY_CORE_EVIDENCE_COUNT:4/4!=5/5");

      reconstruction.coverageMatrix.coreEvidence = { covered: 5, total: 5 };
      fs.writeFileSync(file, JSON.stringify(reconstruction));
      expect(validateBuilderIntegrity(item.root, item.videoPath)).toMatchObject({ coreUnits: 5 });
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it("reports independent dangling, core-count, and derived-source path failures in one pass", () => {
    const item = createFixture();
    try {
      const file = path.join(item.root, "reconstruction.json");
      const reconstruction = JSON.parse(fs.readFileSync(file, "utf8"));
      reconstruction.knowledgeUnits[0].evidence.push({ refType: "frame", ref: "FRAME-MISSING", supports: "missing frame" });
      reconstruction.coverageMatrix.coreEvidence = { covered: 0, total: 0 };
      reconstruction.derivedSources.push(
        { id: "SRC-MEDIA", path: "media-preparation.json#/sourceMedia" },
        { id: "POST-TITLE", path: "post-source-input.json#/facts/title" }
      );
      fs.writeFileSync(file, JSON.stringify(reconstruction));

      let message = "";
      try { validateBuilderIntegrity(item.root, item.videoPath); }
      catch (error) { message = error instanceof Error ? error.message : String(error); }
      expect(message.split("\n")).toEqual(expect.arrayContaining([
        "BUILDER_INTEGRITY_DANGLING_REFERENCE:frame:FRAME-MISSING@knowledgeUnits[0].evidence[1]",
        "BUILDER_INTEGRITY_CORE_EVIDENCE_COUNT:0/0!=2/2",
        "BUILDER_INTEGRITY_DERIVED_SOURCE_MISSING:media-preparation.json#/sourceMedia",
        "BUILDER_INTEGRITY_DERIVED_SOURCE_MISSING:post-source-input.json#/facts/title"
      ]));
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it("stops on a frozen media fingerprint failure before collecting candidate integrity issues", () => {
    const item = createFixture();
    try {
      const manifestPath = path.join(item.root, "media-preparation.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest.sourceMedia.fingerprint = "stale";
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      const reconstructionPath = path.join(item.root, "reconstruction.json");
      const reconstruction = JSON.parse(fs.readFileSync(reconstructionPath, "utf8"));
      reconstruction.knowledgeUnits[0].evidence.push({ refType: "frame", ref: "FRAME-MISSING", supports: "missing frame" });
      fs.writeFileSync(reconstructionPath, JSON.stringify(reconstruction));
      expect(() => validateBuilderIntegrity(item.root, item.videoPath)).toThrow("BUILDER_INTEGRITY_MEDIA_FINGERPRINT");
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it("accepts a complete V2 Builder result with three evidence-bound lenses", () => {
    const item = createFixture();
    try {
      upgradeFixtureToV2(item.root);
      expect(validateBuilderIntegrity(item.root, item.videoPath)).toMatchObject({ builderLensEvidenceReferences: 16 });
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it("rejects V2 lens references that do not exist in the frozen revision", () => {
    const item = createFixture();
    try {
      upgradeFixtureToV2(item.root);
      const file = path.join(item.root, "reconstruction.json");
      const reconstruction = JSON.parse(fs.readFileSync(file, "utf8"));
      reconstruction.builderLenses.visualEditing.claims[0].evidenceRefs = ["TARGET-MISSING"];
      fs.writeFileSync(file, JSON.stringify(reconstruction));
      expect(() => validateBuilderIntegrity(item.root, item.videoPath))
        .toThrow("BUILDER_INTEGRITY_BUILDER_LENS_DANGLING_REFERENCE:TARGET-MISSING");
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it("rejects repeated directing stages that only rename the same function", () => {
    const item = createFixture();
    try {
      upgradeFixtureToV2(item.root);
      const file = path.join(item.root, "reconstruction.json");
      const reconstruction = JSON.parse(fs.readFileSync(file, "utf8"));
      reconstruction.builderLenses.directingLogic.stages[1].function = reconstruction.builderLenses.directingLogic.stages[0].function;
      reconstruction.builderLenses.directingLogic.stages[1].cognitiveChange = reconstruction.builderLenses.directingLogic.stages[0].cognitiveChange;
      fs.writeFileSync(file, JSON.stringify(reconstruction));
      expect(() => validateBuilderIntegrity(item.root, item.videoPath)).toThrow("BUILDER_INTEGRITY_DIRECTING_STAGE_REPETITION");
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it("reports content-block failures even when directing stages are missing", () => {
    const item = createFixture();
    try {
      upgradeFixtureToV2(item.root);
      const file = path.join(item.root, "reconstruction.json");
      const reconstruction = JSON.parse(fs.readFileSync(file, "utf8"));
      reconstruction.builderLenses.contentRestoration.blocks[0].body = " ";
      reconstruction.builderLenses.contentRestoration.blocks[0].evidenceRefs = [];
      reconstruction.builderLenses.directingLogic.stages = [];
      fs.writeFileSync(file, JSON.stringify(reconstruction));

      let message = "";
      try { validateBuilderIntegrity(item.root, item.videoPath); }
      catch (error) { message = error instanceof Error ? error.message : String(error); }
      expect(message.split("\n")).toEqual(expect.arrayContaining([
        "BUILDER_INTEGRITY_BUILDER_LENSES_INCOMPLETE",
        "BUILDER_INTEGRITY_CONTENT_BLOCK_EVIDENCE"
      ]));
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it("rejects a plausible reconstruction that silently changes one cue", () => {
    const item = createFixture();
    try {
      const file = path.join(item.root, "reconstruction.json");
      const reconstruction = JSON.parse(fs.readFileSync(file, "utf8"));
      reconstruction.transcript.cues[0].text = "被悄悄改写的字幕";
      fs.writeFileSync(file, JSON.stringify(reconstruction));
      expect(() => validateBuilderIntegrity(item.root, item.videoPath)).toThrow("BUILDER_INTEGRITY_CUE_DRIFT");
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it("locates missing cue accountability rows without weakening the gate", () => {
    const item = createFixture();
    try {
      const file = path.join(item.root, "reconstruction.json");
      const reconstruction = JSON.parse(fs.readFileSync(file, "utf8"));
      reconstruction.coverageMatrix.cueAccountability = [];
      fs.writeFileSync(file, JSON.stringify(reconstruction));
      expect(() => validateBuilderIntegrity(item.root, item.videoPath)).toThrow(
        "BUILDER_INTEGRITY_CUE_ACCOUNTABILITY:expected=2 actual=0 missing=CUE-001,CUE-002"
      );
    } finally { fs.rmSync(item.root, { recursive: true, force: true }); }
  });

  it("rejects knowledge or context cues that claim semantic use without a unit link", () => {
    const item = createFixture();
    try {
      const file = path.join(item.root, "reconstruction.json");
      const reconstruction = JSON.parse(fs.readFileSync(file, "utf8"));
      reconstruction.coverageMatrix.cueAccountability[0] = {
        cueId: "CUE-001",
        disposition: "context",
        unitIds: [],
        rationale: "其信息已在相邻知识单元中归纳。"
      };
      fs.writeFileSync(file, JSON.stringify(reconstruction));
      expect(() => validateBuilderIntegrity(item.root, item.videoPath))
        .toThrow("BUILDER_INTEGRITY_CUE_UNIT_LINK_MISSING:CUE-001");
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it("requires OCR evidence to reference a recognized OCR line rather than its TARGET frame", () => {
    const item = createFixture();
    try {
      fs.writeFileSync(path.join(item.root, "targeted-evidence/ocr-evidence.json"), JSON.stringify({
        frames: [{ frameId: "TARGET-0001", time: 0.5, status: "processed", lines: [{ id: "OCR-00001" }] }]
      }));
      const file = path.join(item.root, "reconstruction.json");
      const reconstruction = JSON.parse(fs.readFileSync(file, "utf8"));
      reconstruction.knowledgeUnits[0].evidence.push({ refType: "ocr", ref: "TARGET-0001", supports: "invalid alias" });
      fs.writeFileSync(file, JSON.stringify(reconstruction));
      expect(() => validateBuilderIntegrity(item.root, item.videoPath))
        .toThrow("BUILDER_INTEGRITY_DANGLING_REFERENCE:ocr:TARGET-0001");
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it("reports every dangling evidence reference together while retaining valid references", () => {
    const item = createFixture();
    try {
      const file = path.join(item.root, "reconstruction.json");
      const reconstruction = JSON.parse(fs.readFileSync(file, "utf8"));
      reconstruction.knowledgeUnits[0].evidence.push(
        { refType: "frame", ref: "FRAME-MISSING-001", supports: "invalid frame" },
        { refType: "source", ref: "SOURCE-MISSING-002", supports: "invalid source" }
      );
      reconstruction.relations[0].evidence.push(
        { refType: "ocr", ref: "OCR-MISSING-003", supports: "invalid OCR line" },
        { refType: "cue", ref: "CUE-002", supports: "valid cue" }
      );
      fs.writeFileSync(file, JSON.stringify(reconstruction));
      expect(() => validateBuilderIntegrity(item.root, item.videoPath)).toThrow(
        "BUILDER_INTEGRITY_DANGLING_REFERENCE:" +
        "frame:FRAME-MISSING-001@knowledgeUnits[0].evidence[1]," +
        "source:SOURCE-MISSING-002@knowledgeUnits[0].evidence[2]," +
        "ocr:OCR-MISSING-003@relations[0].evidence[2]"
      );
      reconstruction.knowledgeUnits[0].evidence.splice(1, 2);
      reconstruction.relations[0].evidence.splice(2, 1);
      fs.writeFileSync(file, JSON.stringify(reconstruction));
      expect(validateBuilderIntegrity(item.root, item.videoPath)).toMatchObject({ evidenceReferences: 7 });
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it("requires source evidence to use a registered derivedSources ID instead of a path", () => {
    const item = createFixture();
    try {
      const file = path.join(item.root, "reconstruction.json");
      const reconstruction = JSON.parse(fs.readFileSync(file, "utf8"));
      reconstruction.knowledgeUnits[0].evidence.push({
        refType: "source", ref: "SRC-MEDIA-PREP", supports: "media-preparation.json#/audio: technical stream presence"
      });
      fs.writeFileSync(file, JSON.stringify(reconstruction));
      expect(() => validateBuilderIntegrity(item.root, item.videoPath))
        .toThrow("BUILDER_INTEGRITY_DANGLING_REFERENCE:source:SRC-MEDIA-PREP");

      reconstruction.derivedSources.push({ id: "SRC-MEDIA-PREP", path: "media-preparation.json#/sourceMedia" });
      fs.writeFileSync(file, JSON.stringify(reconstruction));
      expect(() => validateBuilderIntegrity(item.root, item.videoPath))
        .toThrow("BUILDER_INTEGRITY_DERIVED_SOURCE_MISSING:media-preparation.json#/sourceMedia");

      reconstruction.derivedSources[0].path = "media-preparation.json";
      fs.writeFileSync(file, JSON.stringify(reconstruction));
      expect(() => validateBuilderIntegrity(item.root, item.videoPath)).not.toThrow();
      expect(reconstruction.knowledgeUnits[0].evidence.at(-1)).toEqual({ refType: "source", ref: "SRC-MEDIA-PREP",
        supports: "media-preparation.json#/audio: technical stream presence" });
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it("rejects frame evidence outside its knowledge-unit time range", () => {
    const item = createFixture();
    try {
      const file = path.join(item.root, "reconstruction.json");
      const reconstruction = JSON.parse(fs.readFileSync(file, "utf8"));
      reconstruction.knowledgeUnits[0].evidence.push({
        refType: "targeted_frame", ref: "TARGET-0004", supports: "outside the unit"
      });
      fs.writeFileSync(file, JSON.stringify(reconstruction));
      expect(() => validateBuilderIntegrity(item.root, item.videoPath))
        .toThrow("BUILDER_INTEGRITY_EVIDENCE_TIME_RANGE:KU-001:TARGET-0004");
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it("reports every out-of-range frame reference with frozen times and all same-unit timed evidence", () => {
    const item = createFixture();
    try {
      const file = path.join(item.root, "reconstruction.json");
      const reconstruction = JSON.parse(fs.readFileSync(file, "utf8"));
      reconstruction.knowledgeUnits[0].timeRange.end = 2;
      reconstruction.knowledgeUnits[0].evidence.push(
        { refType: "targeted_frame", ref: "TARGET-0001", supports: "within the unit" },
        { refType: "targeted_frame", ref: "TARGET-0003", supports: "outside the unit" },
        { refType: "targeted_frame", ref: "TARGET-0004", supports: "outside the unit" }
      );
      fs.writeFileSync(file, JSON.stringify(reconstruction));
      let message = "";
      try { validateBuilderIntegrity(item.root, item.videoPath); }
      catch (error) { message = (error as Error).message; }
      expect(message).toContain("BUILDER_INTEGRITY_EVIDENCE_TIME_RANGE:KU-001:TARGET-0003,KU-001:TARGET-0004");
      expect(message).toContain('temporalContext=[{"unitId":"KU-001","range":{"start":0,"end":2},' +
        '"outside":[{"ref":"TARGET-0003","time":4.5},{"ref":"TARGET-0004","time":7.5}],' +
        '"timedEvidence":[{"ref":"TARGET-0001","time":0.5},{"ref":"TARGET-0003","time":4.5},' +
        '{"ref":"TARGET-0004","time":7.5}]}]');
      expect(message).toContain("correct the actual unit time range");
      expect(message).toContain("split a cross-time knowledge unit");
      expect(message).toContain("remove inapplicable references");
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it("rejects an inspection status that contradicts compatibility booleans", () => {
    const item = createFixture();
    try {
      const file = path.join(item.root, "reconstruction.json");
      const reconstruction = JSON.parse(fs.readFileSync(file, "utf8"));
      reconstruction.coverageMatrix.channels.push({
        id: "CAR-AUDIO", available: true, inspected: false,
        inspectionStatus: "checked_unreadable", inspectionRationale: "technical stream only"
      });
      fs.writeFileSync(file, JSON.stringify(reconstruction));
      expect(() => validateBuilderIntegrity(item.root, item.videoPath))
        .toThrow("BUILDER_INTEGRITY_CARRIER_STATUS:reconstruction:CAR-AUDIO");
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it("reports every invalid carrier in one repairable failure", () => {
    const item = createFixture();
    try {
      const file = path.join(item.root, "reconstruction.json");
      const reconstruction = JSON.parse(fs.readFileSync(file, "utf8"));
      reconstruction.coverageMatrix.channels.push(
        { id: "CAR-AUDIO", available: true, inspected: true, inspectionStatus: "checked_readable", inspectionRationale: null },
        { id: "CAR-UI", available: true, inspected: true, inspectionStatus: "checked_readable", inspectionRationale: "" }
      );
      fs.writeFileSync(file, JSON.stringify(reconstruction));
      expect(() => validateBuilderIntegrity(item.root, item.videoPath))
        .toThrow("BUILDER_INTEGRITY_CARRIER_STATUS:reconstruction:CAR-AUDIO,reconstruction:CAR-UI");
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

  it("rejects a probe carrier whose explicit inspection state lacks a rationale", () => {
    const item = createFixture();
    try {
      const file = path.join(item.root, "probe.json");
      const probe = JSON.parse(fs.readFileSync(file, "utf8"));
      delete probe.informationCarriers[0].inspectionRationale;
      fs.writeFileSync(file, JSON.stringify(probe));
      expect(() => validateBuilderIntegrity(item.root, item.videoPath))
        .toThrow("BUILDER_INTEGRITY_CARRIER_STATUS:probe:CAR-SPEECH");
    } finally {
      fs.rmSync(item.root, { recursive: true, force: true });
    }
  });

});
