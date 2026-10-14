import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("Vision OCR reads only frames requested by text actions, including reused frames", { skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync(join(tmpdir(), "requested-ocr-"));
  try {
    mkdirSync(join(root, "frames"));
    for (const [name, color] of [["visual", "white"], ["shared", "black"]]) {
      const result = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=320x100`, "-frames:v", "1", join(root, "frames", `${name}.jpg`)], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    }
    const protocol = join(root, "capture-protocol.json");
    writeFileSync(protocol, JSON.stringify({ captureActions: [
      { id: "VISUAL", mode: "exact_times" }, { id: "TEXT", mode: "ocr_review" }
    ] }));
    const manifest = join(root, "targeted-evidence.json");
    writeFileSync(manifest, JSON.stringify({ protocol, frames: [
      { id: "VISUAL-ONLY", actionId: "VISUAL", time: 1, frame: "frames/visual.jpg" },
      { id: "SHARED", actionId: "VISUAL", time: 2, frame: "frames/shared.jpg" }
    ], actions: [
      { id: "VISUAL", frameIds: ["VISUAL-ONLY", "SHARED"] },
      { id: "TEXT", frameIds: ["SHARED"] }
    ] }));
    const out = join(root, "ocr-evidence.json");
    const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "../scripts/run-ocr.mjs"), "--manifest", manifest, "--out", out], { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(evidence.frames.map((frame) => [frame.frameId, frame.actionId, frame.status]), [["SHARED", "TEXT", "processed"]]);

    const standaloneManifest = join(root, "standalone-manifest.json");
    writeFileSync(standaloneManifest, JSON.stringify({ frames: [
      { id: "VISUAL-ONLY", actionId: "VISUAL", time: 1, frame: "frames/visual.jpg" },
      { id: "SHARED", actionId: "VISUAL", time: 2, frame: "frames/shared.jpg" }
    ] }));
    const standaloneOut = join(root, "standalone-ocr.json");
    const standalone = spawnSync(process.execPath, [resolve(import.meta.dirname, "../scripts/run-ocr.mjs"),
      "--manifest", standaloneManifest, "--out", standaloneOut], { encoding: "utf8", timeout: 30_000 });
    assert.equal(standalone.status, 0, standalone.stderr);
    assert.deepEqual(JSON.parse(readFileSync(standaloneOut, "utf8")).frames.map((frame) => frame.frameId), ["VISUAL-ONLY", "SHARED"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Vision OCR rejects a missing mapping even when another text action is valid", { skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync(join(tmpdir(), "requested-ocr-missing-"));
  try {
    const protocol = join(root, "capture-protocol.json");
    writeFileSync(protocol, JSON.stringify({ captureActions: [
      { id: "VALID", mode: "ocr_review" }, { id: "MISSING", mode: "ui_state_review" }
    ] }));
    const manifest = join(root, "targeted-evidence.json");
    const base = { protocol, frames: [{ id: "FRAME-1", actionId: "VALID", time: 1, frame: "unused.jpg" }] };
    for (const frameIds of [[], ["FRAME-NOT-PRESENT"]]) {
      writeFileSync(manifest, JSON.stringify({ ...base, actions: [
        { id: "VALID", frameIds: ["FRAME-1"] }, { id: "MISSING", frameIds }
      ] }));
      const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "../scripts/run-ocr.mjs"),
        "--manifest", manifest, "--out", join(root, "ocr-evidence.json")], { encoding: "utf8", timeout: 30_000 });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, frameIds.length ? /references missing frame/ : /has no targeted frames/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
