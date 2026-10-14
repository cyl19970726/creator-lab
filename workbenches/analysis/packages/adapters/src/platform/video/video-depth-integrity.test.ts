import { describe, it, expect } from "vitest";
import { depthPackagingSourceDiagnostics, validateVideoDepth } from "./video-depth-integrity.js";
function fixture(duration = 10) {
  const missing = { state: "missing", sourceRef: null, audience: null, promise: null, tension: null, specificity: null,
    searchTerms: null, composition: null, typeHierarchy: null, smallSizeReadability: null, evidenceRefs: [], unknowns: ["来源未取得"] };
  return { depthContractVersion: "single-post-depth@1", builderLenses: {
    visualEditing: { openingAnalysis: { duration, inspectionBasis: "逐帧核对；声音无法语义读取", unknowns: ["音乐未知"],
      segments: [{ id: "a", timeRange: { start: 0, end: duration }, boundaryReason: "连续固定镜头",
        spokenWords: "ASR提案保留", burnedCaptions: "未见字幕", composition: "近景", motion: "静止",
        audioRole: "未知，只有音轨存在信息", evidenceArrival: "未见结果", viewerQuestion: "是什么？",
        meaningChange: "提出问题", alignmentStatus: "ASR错时，未静默修正", evidenceRefs: ["CUE-1"], frameRefs: Array.from({length: Math.floor(duration*2)+1},(_,i)=>`FRAME-${i}`), unknowns: ["口播错时"] }] } },
    directingLogic: { packagingAnalysis: { title: {...missing}, cover: {...missing}, firstFrame: {...missing}, fulfillment: [], unknowns: [] } } } };
}
const frames = new Map(Array.from({length:21},(_,i)=>[`FRAME-${i}`,i*.5] as const));
const ids = new Set([...frames.keys(), "CUE-1", "POST-COVER"]);
const source = { facts: { title: null, coverHref: null }, cover: null };
const check = (input: unknown, duration = 83) => validateVideoDepth(input, duration, ids, frames, source);
describe("single-post depth integrity", () => {
  it("accepts explicit missing source/audio and ASR conflict without inventing certainty", () => expect(() => check(fixture())).not.toThrow());
  it("covers actual short duration", () => expect(() => check(fixture(1.2), 1.2)).not.toThrow());
  it("rejects fabricated ten seconds for a short video", () => expect(() => check(fixture(), 1.2)).toThrow("DURATION"));
  it("rejects an uncovered opening", () => { const input = fixture(); input.builderLenses.visualEditing.openingAnalysis.segments[0]!.timeRange.start = 0.3; expect(() => check(input)).toThrow("COVERAGE"); });
  it("rejects a frame outside the segment", () => expect(() => validateVideoDepth(fixture(), 83, ids, new Map([["FRAME-1",20]]), source)).toThrow("FRAME_"));
  it("locates an out-of-segment frame without changing the frame boundary rule", () => {
    const shifted = new Map(frames);
    shifted.set("FRAME-20", 10.2);
    expect(() => validateVideoDepth(fixture(), 83, ids, shifted, source)).toThrow(
      "BUILDER_INTEGRITY_DEPTH_FRAME_RANGE:segments[0](a):FRAME-20@10.2 outside [0,10]"
    );
  });
  it("rejects a midpoint masquerading as a continuous strip", () => { const input=fixture(); input.builderLenses.visualEditing.openingAnalysis.segments[0]!.frameRefs=["FRAME-10"]; expect(() => check(input)).toThrow("FRAME_STRIP_COVERAGE"); });
  it("locates a frame-strip gap within the affected segment", () => {
    const input = fixture();
    input.builderLenses.visualEditing.openingAnalysis.segments[0]!.frameRefs = ["FRAME-0", "FRAME-3", "FRAME-6", "FRAME-8", "FRAME-10", "FRAME-12", "FRAME-14", "FRAME-16", "FRAME-18", "FRAME-20"];
    expect(() => check(input)).toThrow(
      "BUILDER_INTEGRITY_DEPTH_FRAME_STRIP_COVERAGE:segments[0](a) range=[0,10] internal gap=1.5 at 0..1.5"
    );
  });
  it("rejects missing source with generated conclusions", () => { const input = fixture(); Object.assign(input.builderLenses.directingLogic.packagingAnalysis.cover,{promise:"带你省钱"}); expect(() => check(input)).toThrow("MISSING_SOURCE_CLAIM"); });
  it("rejects using the first video frame as independent cover", () => { const input = fixture(); Object.assign(input.builderLenses.directingLogic.packagingAnalysis.cover,{state:"available",sourceRef:"FRAME-1",evidenceRefs:["FRAME-1"]}); expect(() => check(input)).toThrow("INDEPENDENT_COVER"); });
  it("locates a copied cover filename and evidence alias, then requires index registration", () => {
    const input = fixture();
    const coverSource = { facts: { title: null, coverHref: "https://example.com/cover" }, cover: { path: "post-cover.webp" } };
    Object.assign(input.builderLenses.directingLogic.packagingAnalysis.cover,
      { state: "available", sourceRef: "post-cover.webp", evidenceRefs: ["post-cover"] });
    const staged = depthPackagingSourceDiagnostics(input.builderLenses.directingLogic, coverSource);
    expect(staged).toHaveLength(1);
    expect(staged[0]).toContain('packagingAnalysis.cover.sourceRef received="post-cover.webp" required="POST-COVER"');
    expect(staged[0]).toContain('evidenceRefs received=["post-cover"] must include "POST-COVER"');
    expect(staged[0]).toContain("revise_builder_lens slot=directingLogic useLatest:true");
    expect(staged[0]).not.toContain("derivedSources missing");
    expect(() => validateVideoDepth(input, 83, ids, frames, coverSource)).toThrow("derivedSources missing id=\"POST-COVER\"");
    Object.assign(input, { derivedSources: [{ id: "POST-COVER", path: "post-cover.webp" }] });
    expect(() => validateVideoDepth(input, 83, ids, frames, coverSource)).toThrow(
      'packagingAnalysis.cover.sourceRef received="post-cover.webp" required="POST-COVER"');
    Object.assign(input.builderLenses.directingLogic.packagingAnalysis.cover,
      { sourceRef: "POST-COVER", evidenceRefs: ["POST-COVER"] });
    expect(depthPackagingSourceDiagnostics(input.builderLenses.directingLogic, coverSource)).toEqual([]);
    expect(() => validateVideoDepth(input, 83, ids, frames, coverSource)).not.toThrow();
  });
  it("does not let a missing frozen cover masquerade as available", () => {
    const input = fixture();
    Object.assign(input.builderLenses.directingLogic.packagingAnalysis.cover,
      { state: "available", sourceRef: "POST-COVER", evidenceRefs: ["POST-COVER"] });
    Object.assign(input, { derivedSources: [{ id: "POST-COVER", path: "post-cover.webp" }] });
    expect(depthPackagingSourceDiagnostics(input.builderLenses.directingLogic, source)[0])
      .toContain('state received="available" but frozen post source has no cover image/coverHref');
    expect(() => check(input)).toThrow("do not mark this source available");
  });
  it("requires firstFrame.sourceRef itself to name a frozen opening frame", () => {
    const input = fixture();
    const firstFrame = input.builderLenses.directingLogic.packagingAnalysis.firstFrame;
    const frozenFrames = new Map([...frames, ["OPEN-0001", 0], ["OPEN-0002", 0.5], ["FRAME-SHOT-001", 1.4]] as [string, number][]);
    const frozenIds = new Set([...ids, ...frozenFrames.keys()]);
    Object.assign(firstFrame, { state: "available", sourceRef: "FRAME-SHOT-001", evidenceRefs: ["OPEN-0001"] });
    const staged = depthPackagingSourceDiagnostics(input.builderLenses.directingLogic, source, undefined, frozenFrames);
    expect(staged).toHaveLength(1);
    expect(staged[0]).toContain('packagingAnalysis.firstFrame.sourceRef received="FRAME-SHOT-001" resolvedTime=1.4s required=0..0.5s');
    expect(staged[0]).toContain("OPEN-0001@0s");
    expect(staged[0]).toContain("revise_builder_lens slot=directingLogic useLatest:true");
    expect(staged[0]).toContain("validate_reconstruction_draft useLatestBuilderLenses:true");
    const validate = () => validateVideoDepth(input, 83, frozenIds, frozenFrames, source);
    expect(validate).toThrow("BUILDER_INTEGRITY_DEPTH_FIRST_FRAME");

    // A new evidence citation or index time range does not rewrite the staged lens sourceRef.
    Object.assign(firstFrame, { evidenceRefs: ["OPEN-0001", "OPEN-0002"] });
    expect(validate).toThrow('firstFrame.sourceRef received="FRAME-SHOT-001"');
    Object.assign(input, { derivedSources: [{ id: "FRAME-SHOT-001", path: "evidence/evidence-pack.json",
      timeRange: { start: 0, end: 0.5 } }] });
    expect(validate).toThrow('firstFrame.sourceRef received="FRAME-SHOT-001"');
    expect(firstFrame.sourceRef).toBe("FRAME-SHOT-001");

    Object.assign(firstFrame, { sourceRef: "OPEN-0001" });
    expect(depthPackagingSourceDiagnostics(input.builderLenses.directingLogic, source, undefined, frozenFrames)).toEqual([]);
    expect(validate).not.toThrow();
  });
  it.each([undefined, Number.NaN, -0.1])("rejects an unknown or invalid frozen first-frame time (%s)", time => {
    const input = fixture();
    Object.assign(input.builderLenses.directingLogic.packagingAnalysis.firstFrame,
      { state: "available", sourceRef: "OPEN-INVALID", evidenceRefs: ["OPEN-INVALID"] });
    const invalidFrames = new Map<string, number>(frames);
    if (time !== undefined) invalidFrames.set("OPEN-INVALID", time);
    expect(depthPackagingSourceDiagnostics(input.builderLenses.directingLogic, source, undefined, invalidFrames)[0])
      .toContain('FIRST_FRAME:builderLenses.directingLogic.packagingAnalysis.firstFrame.sourceRef received="OPEN-INVALID"');
  });
  it("reports the precise fulfillment evidence field and every invalid ID", () => {
    const input = fixture();
    Object.assign(input.builderLenses.directingLogic.packagingAnalysis, { fulfillment: [
      { origin: "title", promise: "标题承诺", status: "fulfilled", bodyEvidenceRefs: ["KU-02", "KU-05"], explanation: "正文完成承诺" },
      { origin: "cover", promise: "封面承诺", status: "partial", bodyEvidenceRefs: ["KU-02", "KU-03"], explanation: "正文部分兑现" }
    ] });
    expect(() => check(input)).toThrow(
      "BUILDER_INTEGRITY_DEPTH_REFERENCE:builderLenses.directingLogic.packagingAnalysis.fulfillment[0].bodyEvidenceRefs:KU-02,KU-05"
    );
  });
  it("reports invalid IDs from all fulfillment reference arrays in one failure", () => {
    const input = fixture();
    Object.assign(input.builderLenses.directingLogic.packagingAnalysis, { fulfillment: [
      { origin: "title", promise: "标题承诺", status: "fulfilled", bodyEvidenceRefs: ["BAD-TITLE-A", "BAD-TITLE-B"], explanation: "正文完成承诺" },
      { origin: "cover", promise: "封面承诺", status: "partial", bodyEvidenceRefs: ["BAD-COVER"], explanation: "正文部分兑现" },
      { origin: "first_sentence", promise: "开头承诺", status: "not_shown", bodyEvidenceRefs: ["BAD-OPENING"], explanation: "正文未出现" }
    ] });
    let message = "";
    try { check(input); } catch (error) { message = error instanceof Error ? error.message : String(error); }
    expect(message.split("\n")).toEqual([
      "BUILDER_INTEGRITY_DEPTH_REFERENCE:builderLenses.directingLogic.packagingAnalysis.fulfillment[0].bodyEvidenceRefs:BAD-TITLE-A,BAD-TITLE-B",
      "builderLenses.directingLogic.packagingAnalysis.fulfillment[1].bodyEvidenceRefs:BAD-COVER",
      "builderLenses.directingLogic.packagingAnalysis.fulfillment[2].bodyEvidenceRefs:BAD-OPENING"
    ]);
  });
  it("checks final summary lessons against registered evidence and performance against a registered frozen source", () => {
    const input = fixture() as ReturnType<typeof fixture> & { derivedSources?: Array<{ id: string; path: string }>;
      builderLenses: ReturnType<typeof fixture>["builderLenses"] & { finalSummary?: {
        reusableLessons: Array<{ evidenceRefs: string[] }>; performance: { evidenceRefs: string[] } } } };
    input.derivedSources = [{ id: "POST-SOURCE-FACTS", path: "post-source-input.json" }];
    input.builderLenses.finalSummary = { reusableLessons: [{ evidenceRefs: ["CUE-1", "FRAME-1"] }],
      performance: { evidenceRefs: ["POST-SOURCE-FACTS"] } };
    const registered = new Set([...ids, "POST-SOURCE-FACTS"]);
    expect(() => validateVideoDepth(input, 83, registered, frames, source)).not.toThrow();
    input.builderLenses.finalSummary.reusableLessons[0]!.evidenceRefs = ["UNBOUND-FRAME"];
    expect(() => validateVideoDepth(input, 83, registered, frames, source)).toThrow(
      "BUILDER_INTEGRITY_DEPTH_REFERENCE:builderLenses.finalSummary.reusableLessons[0].evidenceRefs:UNBOUND-FRAME");
    input.builderLenses.finalSummary.reusableLessons[0]!.evidenceRefs = ["FRAME-1"];
    input.builderLenses.finalSummary.performance.evidenceRefs = ["CUE-1"];
    expect(() => validateVideoDepth(input, 83, registered, frames, source)).toThrow(
      "BUILDER_INTEGRITY_DEPTH_FINAL_SUMMARY_PERFORMANCE_SOURCE");
    input.builderLenses.finalSummary.performance.evidenceRefs = ["POST-SOURCE-FACTS", "UNBOUND-FACTS"];
    expect(() => validateVideoDepth(input, 83, registered, frames, source)).toThrow(
      "BUILDER_INTEGRITY_DEPTH_REFERENCE:builderLenses.finalSummary.performance.evidenceRefs:UNBOUND-FACTS");
  });
  it("legacy artifacts cannot pass a new depth run", () => expect(() => check({})).toThrow("CONTRACT_MISSING"));
  it("legacy integrity stays compatible without depth inputs", () => expect(() => validateVideoDepth({},83,ids,frames,null)).not.toThrow());
});
