import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildEditingCutEvidence, cutSheetPages } from "../scripts/cut-evidence.mjs";

const scripts = join(dirname(fileURLToPath(import.meta.url)), "../scripts");

test("each detected boundary has in-shot frames within 0.08s, including narrow shots", () => {
  const shots = [
    { id: "SHOT-001", start: 0, end: 1 },
    { id: "SHOT-002", start: 1, end: 1.04 },
    { id: "SHOT-003", start: 1.04, end: 2 }
  ];
  const cues = [
    { id: "CUE-001", start: 0.9, end: 1.02 },
    { id: "CUE-002", start: 1.02, end: 1.2 },
    { id: "CUE-003", start: 1.8, end: 1.9 }
  ];
  const { records, frames } = buildEditingCutEvidence(shots, [1, 1.04], cues);
  assert.equal(records.length, 2);
  assert.deepEqual(frames.map((frame) => frame.id), [
    "FRAME-CUT-001-BEFORE", "FRAME-CUT-001-AFTER",
    "FRAME-CUT-002-BEFORE", "FRAME-CUT-002-AFTER"
  ]);
  assert.deepEqual(records.map((record) => record.cueIds), [
    ["CUE-001", "CUE-002"], ["CUE-001", "CUE-002"]
  ]);
  for (const record of records) {
    const from = shots.find((shot) => shot.id === record.fromShot);
    const to = shots.find((shot) => shot.id === record.toShot);
    const before = frames.find((frame) => frame.id === record.beforeFrame.id);
    const after = frames.find((frame) => frame.id === record.afterFrame.id);
    assert.ok(before.time > from.start && before.time < record.boundary);
    assert.ok(after.time > record.boundary && after.time < to.end);
    assert.ok(record.boundary - before.time <= 0.080001);
    assert.ok(after.time - record.boundary <= 0.080001);
    assert.equal(record.detected, true);
    assert.equal(record.semanticallyConfirmed, false);
  }
  assert.equal(frames[1].time, frames[2].time, "both sides of a narrow shot may share one extraction");
  assert.deepEqual(buildEditingCutEvidence([{ id: "SHOT-001", start: 0, end: 2 }], [], []),
    { records: [], frames: [] });
  assert.deepEqual(cutSheetPages([]), []);
  assert.deepEqual(cutSheetPages(records, 1).map((page) => page.cutIds), [["CUT-001"], ["CUT-002"]]);
  assert.throws(() => buildEditingCutEvidence(shots, [1.5], []), /no adjacent shot pair/);
});

test("pack materializes every cut pair and labeled page with resolvable manifest references", () => {
  const root = mkdtempSync(join(tmpdir(), "cut-evidence-test-"));
  try {
    const source = join(root, "source.mp4");
    const output = join(root, "evidence");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=red:s=180x320:r=25:d=0.6",
      "-f", "lavfi", "-i", "color=c=blue:s=180x320:r=25:d=0.6",
      "-f", "lavfi", "-i", "color=c=green:s=180x320:r=25:d=0.6",
      "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
      "-map", "[v]", "-c:v", "mpeg4", "-q:v", "2", "-y", source]);
    execFileSync(process.execPath, [join(scripts, "build-evidence-pack.mjs"),
      "--video", source, "--out", output, "--dense-seconds", "0.75"]);
    const pack = JSON.parse(readFileSync(join(output, "evidence-pack.json"), "utf8"));
    assert.equal(pack.schemaVersion, "video-evidence-pack-1.0");
    assert.equal(pack.sceneDetection.cuts.length, 2);
    assert.equal(pack.editingCuts.cuts.length, pack.sceneDetection.cuts.length);
    assert.equal(pack.editingCuts.contactSheets.length, 1);
    const index = new Map(pack.frameIndex.map((frame) => [frame.id, frame]));
    for (const record of pack.editingCuts.cuts) {
      for (const id of [record.beforeFrame.id, record.afterFrame.id]) {
        const frame = index.get(id);
        assert.ok(frame, `${id} is indexed`);
        assert.ok(existsSync(join(output, frame.frame)), `${id} file exists`);
      }
    }
    for (const sheet of pack.editingCuts.contactSheets) {
      assert.ok(existsSync(join(output, sheet.frame)));
      assert.deepEqual(sheet.cutIds, pack.editingCuts.cuts.map((record) => record.id));
    }
    execFileSync("python3", ["-c", `
from PIL import Image
import json, os, sys
root=sys.argv[1]
pack=json.load(open(os.path.join(root,'evidence-pack.json')))
im=Image.open(os.path.join(root,pack['editingCuts']['contactSheets'][0]['frame'])).convert('RGB')
assert im.width == 736 and im.height == 2 * 712
assert any(max(im.getpixel((x,y))) > 100 for y in range(4,25) for x in range(4,330))
expected=((0,2),(2,1))
for cut, pair in zip(pack['editingCuts']['cuts'],expected):
 for frame, dominant in zip((cut['beforeFrame'],cut['afterFrame']),pair):
  rgb=Image.open(os.path.join(root,frame['frame'])).convert('RGB').getpixel((180,320))
  assert rgb[dominant]>rgb[(dominant+1)%3]+60 and rgb[dominant]>rgb[(dominant+2)%3]+60,(cut['id'],frame['id'],rgb)
`, output]);

    const single = join(root, "single.mp4");
    const singleOutput = join(root, "single-evidence");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
      "color=c=red:s=180x320:r=25:d=0.6", "-c:v", "mpeg4", "-y", single]);
    execFileSync(process.execPath, [join(scripts, "build-evidence-pack.mjs"),
      "--video", single, "--out", singleOutput]);
    const singlePack = JSON.parse(readFileSync(join(singleOutput, "evidence-pack.json"), "utf8"));
    assert.deepEqual(singlePack.editingCuts.cuts, []);
    assert.deepEqual(singlePack.editingCuts.contactSheets, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cut timing keeps a continuing cue separate from the next cue and does not infer semantic synchronization", () => {
  const shots = [{ id: "A", start: 0, end: 5 }, { id: "B", start: 5, end: 10 }];
  const cues = [
    { id: "C1", start: 3, end: 7, text: "previous topic continues" },
    { id: "C2", start: 7, end: 9, text: "next topic" }
  ];
  const [cut] = buildEditingCutEvidence(shots, [5], cues).records;
  assert.deepEqual(cut.cueTiming.before, [cues[0]]);
  assert.deepEqual(cut.cueTiming.after, [cues[0]]);
  assert.deepEqual(cut.cueTiming.next, cues[1]);
  assert.equal(cut.semanticallyConfirmed, false);
  const boundaryCues = [{ id: "old", start: 0, end: 4.92, text: "ends" },
    { id: "new", start: 5.08, end: 6, text: "starts" }];
  const [edge] = buildEditingCutEvidence(shots, [5], boundaryCues).records;
  assert.deepEqual(edge.cueTiming.before, []);
  assert.deepEqual(edge.cueTiming.after, [boundaryCues[1]]);
  assert.equal(edge.cueTiming.next, null);
});
