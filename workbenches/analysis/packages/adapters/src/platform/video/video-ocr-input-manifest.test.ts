import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { assertCompleteOcrResult, computeOcrInputManifest, preflightOcrInputUnion,
  readVerifiedOcrInputManifest, writeOcrInputManifest } from "./video-ocr-input-manifest.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-union-")); roots.push(root);
  fs.mkdirSync(path.join(root, "evidence/frames/dense"), { recursive: true });
  fs.mkdirSync(path.join(root, "targeted-evidence/frames"), { recursive: true });
  for (const name of ["a", "b", "out"]) fs.writeFileSync(path.join(root, `evidence/frames/dense/${name}.jpg`), name);
  fs.writeFileSync(path.join(root, "targeted-evidence/frames/t.jpg"), "target pixels");
  const pack = { frameIndex: [
    { id: "DENSE-0001", time: 1, frame: "frames/dense/a.jpg" },
    { id: "FRAME-SHOT-0002", time: 2, frame: "frames/dense/b.jpg" },
    { id: "DENSE-OUT", time: 9, frame: "frames/dense/out.jpg" }
  ] };
  const protocol = { captureActions: [
    { id: "TEXT-A", mode: "ocr_review", range: { start: 0, end: 2 } },
    { id: "TEXT-B", mode: "ui_state_review", range: { start: 1, end: 3 } },
    { id: "VISUAL", mode: "exact_times", range: { start: 9, end: 9 } }
  ] };
  const target = { frames: [{ id: "TARGET-0001", time: 1.5, frame: "frames/t.jpg", actionId: "TEXT-A" }],
    actions: [{ id: "TEXT-A", frameIds: ["TARGET-0001"] },
      { id: "TEXT-B", frameIds: ["TARGET-0001"] }, { id: "VISUAL", frameIds: [] }] };
  fs.writeFileSync(path.join(root, "evidence/evidence-pack.json"), JSON.stringify(pack));
  fs.writeFileSync(path.join(root, "capture-protocol.json"), JSON.stringify(protocol));
  fs.writeFileSync(path.join(root, "targeted-evidence/targeted-evidence.json"), JSON.stringify(target));
  return { root, pack, protocol, target };
}

it("plans and builds the full frozen OCR window union, retaining overlapping action IDs and real pixels", () => {
  const item = fixture();
  const plan = preflightOcrInputUnion(item.pack, item.protocol, [
    { id: "TEXT-A", selectedTimes: [1.5] }, { id: "TEXT-B", selectedTimes: [1.5] },
    { id: "VISUAL", selectedTimes: [9] }
  ]);
  expect(plan).toMatchObject({ pass: true, sourceFrames: 2, plannedTargetTimes: 1, upperBound: 3 });
  const outsideExplicit = structuredClone(item.protocol);
  (outsideExplicit.captureActions[0] as { times?: number[] }).times = [9];
  expect(preflightOcrInputUnion(item.pack, outsideExplicit, [
    { id: "TEXT-A", selectedTimes: [9] }, { id: "TEXT-B", selectedTimes: [1.5] }
  ])).toMatchObject({ pass: false, errors: [{ code: "OCR_ACTION_TARGET_TIME_OUTSIDE_RANGE",
    path: "/captureActions/0/times" }] });
  const written = writeOcrInputManifest(item.root);
  expect(written.manifest.frames.map(frame => frame.id)).toEqual(["DENSE-0001", "TARGET-0001", "FRAME-SHOT-0002"]);
  expect(written.manifest.frames.find(frame => frame.id === "DENSE-0001")).toMatchObject({
    frame: "evidence/frames/dense/a.jpg", actionId: "TEXT-A", actionIds: ["TEXT-A", "TEXT-B"], origin: "source" });
  expect(written.manifest.frames.find(frame => frame.id === "TARGET-0001")?.actionIds).toEqual(["TEXT-A", "TEXT-B"]);
  expect(written.manifest.frames.some(frame => frame.id === "DENSE-OUT")).toBe(false);
  expect(readVerifiedOcrInputManifest(item.root).manifest).toEqual(written.manifest);
  const completed = { schemaVersion: "ocr-evidence-1.0", sourceFrameBase: "candidate-root", frames: written.manifest.frames.map(frame => ({
    frameId: frame.id, time: frame.time, sourceFrame: frame.frame, actionId: frame.actionId,
    actionIds: frame.actionIds, status: "processed", lines: []
  })) };
  expect(() => assertCompleteOcrResult(completed, written.manifest)).not.toThrow();
  expect(() => assertCompleteOcrResult({ ...completed, frames: completed.frames.slice(1) }, written.manifest))
    .toThrow("OCR_RESULT_FRAME_SET_INCOMPLETE");
  expect(() => assertCompleteOcrResult({ ...completed, frames: [{ ...completed.frames[0], sourceFrame: "targeted-evidence/frames/t.jpg" },
    ...completed.frames.slice(1)] }, written.manifest)).toThrow("OCR_RESULT_FRAME_MISMATCH");
});

it("keeps a mapped TARGET reused from an earlier canonical time in a later text action", () => {
  const item = fixture();
  item.target.frames[0]!.time = 0.5;
  fs.writeFileSync(path.join(item.root, "targeted-evidence/targeted-evidence.json"), JSON.stringify(item.target));
  const input = computeOcrInputManifest(item.root);
  expect(input.frames.find(frame => frame.id === "TARGET-0001")).toMatchObject({
    time: 0.5, actionIds: ["TEXT-A", "TEXT-B"] });
  expect(input.actions.find(action => action.id === "TEXT-B")?.frameIds).toContain("TARGET-0001");
});

it("rejects malformed frozen indexes and paths instead of dropping source frames", () => {
  const item = fixture();
  const planned = [{ id: "TEXT-A", selectedTimes: [1.5] }, { id: "TEXT-B", selectedTimes: [1.5] }];
  const broken = structuredClone(item.pack);
  delete (broken.frameIndex[0] as { time?: number }).time;
  expect(() => preflightOcrInputUnion(broken, item.protocol, planned)).toThrow("OCR_SOURCE_FRAME_INDEX_INVALID");
  broken.frameIndex[0] = { id: "DENSE-0001", time: 1, frame: "frames/../outside.jpg" };
  expect(() => preflightOcrInputUnion(broken, item.protocol, planned)).toThrow("OCR_SOURCE_FRAME_INDEX_INVALID");
  broken.frameIndex[0] = { ...broken.frameIndex[1]!, time: 1 };
  expect(() => preflightOcrInputUnion(broken, item.protocol, planned)).toThrow("OCR_SOURCE_FRAME_INDEX_INVALID");
  const sourceFile = path.join(item.root, "evidence/frames/dense/a.jpg");
  fs.rmSync(sourceFile);
  fs.symlinkSync(path.join(item.root, "targeted-evidence/frames/t.jpg"), sourceFile);
  expect(() => computeOcrInputManifest(item.root)).toThrow("OCR_FRAME_PATH_IDENTITY_INVALID");
  fs.rmSync(sourceFile);
  fs.writeFileSync(sourceFile, "a");
  const { path: manifestPath } = writeOcrInputManifest(item.root);
  fs.writeFileSync(path.join(item.root, "evidence/frames/dense/a.jpg"), "tampered");
  expect(() => readVerifiedOcrInputManifest(item.root)).toThrow("OCR_INPUT_MANIFEST_CHANGED");
  fs.writeFileSync(sourceFile, "a");
  fs.writeFileSync(path.join(item.root, "capture-protocol.json"), JSON.stringify({ ...item.protocol,
    rationale: "changed frozen protocol text" }));
  expect(() => readVerifiedOcrInputManifest(item.root)).toThrow("OCR_INPUT_MANIFEST_CHANGED");
  expect(fs.existsSync(manifestPath)).toBe(true);
});

it("rejects a 513-frame OCR union with action counts and without writing a partial manifest", () => {
  const item = fixture();
  const pack = { frameIndex: Array.from({ length: 513 }, (_, index) => ({ id: `DENSE-${index}`,
    time: 1, frame: "frames/dense/a.jpg" })) };
  const protocol = { captureActions: [item.protocol.captureActions[0]] };
  const plan = preflightOcrInputUnion(pack, protocol, [{ id: "TEXT-A", selectedTimes: [1.5] }]);
  expect(plan).toMatchObject({ pass: false, sourceFrames: 513, plannedTargetTimes: 1, upperBound: 514,
    errors: [{ code: "OCR_FRAME_LIMIT", message: expect.stringContaining("514/512") }] });
  fs.writeFileSync(path.join(item.root, "evidence/evidence-pack.json"), JSON.stringify(pack));
  fs.writeFileSync(path.join(item.root, "capture-protocol.json"), JSON.stringify(protocol));
  expect(() => computeOcrInputManifest(item.root)).toThrow("OCR_FRAME_LIMIT");
  expect(fs.existsSync(path.join(item.root, "ocr-input-manifest.json"))).toBe(false);
});
