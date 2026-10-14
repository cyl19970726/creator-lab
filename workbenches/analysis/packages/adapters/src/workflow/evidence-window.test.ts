import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEvidenceWindowTool, indexedEvidenceFrames, probeTimelineFrames } from "./evidence-window.js";
import { ResponsesEvidenceTools } from "./responses-tools.js";

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
const signal = () => new AbortController().signal;
function fixture(ids: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-window-")); roots.push(root);
  const tools = new ResponsesEvidenceTools([], root);
  for (const [i, id] of ids.entries()) {
    const file = path.join(root, `${id}.jpg`);
    fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, i])); tools.addGenerated(id, file);
  }
  return { tools, root };
}

it("delivers bounded original middle and ending pixels even when the cut index has no middle boundary", () => {
  const frames = indexedEvidenceFrames({ frameIndex: [
    { id: "FRAME-CUT-001-AFTER", time: 0.1 },
    ...Array.from({ length: 31 }, (_, i) => ({ id: `DENSE-${String(i + 1).padStart(4, "0")}`, time: i * 1.5 })),
  ] }, null);
  const timeline = probeTimelineFrames(frames);
  expect(timeline).toHaveLength(16);
  expect(timeline[0]).toEqual({ ref: "DENSE-0001", timeSeconds: 0 });
  expect(timeline.at(-1)).toEqual({ ref: "DENSE-0031", timeSeconds: 45 });
  expect(timeline.some(frame => frame.timeSeconds >= 10 && frame.timeSeconds <= 25)).toBe(true);
  expect(new Set(timeline.map(frame => frame.ref)).size).toBe(16);
  const { tools } = fixture(["opening-contact", ...timeline.map(frame => frame.ref)]);
  const result = tools.readBundle([], ["opening-contact", ...timeline.map(frame => frame.ref)]);
  expect(result).toMatchObject({ kind: "siwc_visual_tool_result", value: { coverage: { imageRefs: 17 } } });
  expect([...tools.inspectedImages]).toEqual(["opening-contact", ...timeline.map(frame => frame.ref)]);
  if ("kind" in result) expect(result.images).toHaveLength(17);
});

it("keeps short dense timelines complete and does not mistake cut samples for timeline coverage", () => {
  const frames = [{ ref: "DENSE-0002", timeSeconds: 8 }, { ref: "DENSE-0001", timeSeconds: 0 },
    { ref: "FRAME-CUT-001-BEFORE", timeSeconds: 4 }];
  expect(probeTimelineFrames(frames)).toEqual([frames[1], frames[0]]);
  expect(probeTimelineFrames([frames[2]!])).toEqual([]);
  expect(() => probeTimelineFrames(frames, 1)).toThrow("RESPONSES_PROBE_TIMELINE_LIMIT_INVALID");
});

it("includes original dense pixels between sparse TARGET samples with exact ordered labels", async () => {
  const frames = indexedEvidenceFrames({ frameIndex: [{ id: "DENSE-0036", time: 87.5 }] },
    { frames: [{ id: "TARGET-0002", time: 88.2 }, { id: "TARGET-0001", time: 86.2 }] });
  const { tools } = fixture(frames.map(frame => frame.ref));
  const result = await createEvidenceWindowTool(tools, frames).execute({ start: 86, end: 89 }, signal()) as {
    value: { orderedFrames: unknown[]; semanticCoverage: string }; images: Array<{ base64: string }>
  };
  expect(result.value.orderedFrames).toEqual(frames.map((frame, imageIndex) => ({ imageIndex, ...frame })));
  expect(result.value.semanticCoverage).toBe("not_evaluated");
  expect(result.images.map(image => image.base64)).toEqual([0, 1, 2].map(i => Buffer.from([0xff, 0xd8, 0xff, i]).toString("base64")));
  expect([...tools.inspectedImages]).toEqual(["TARGET-0001", "DENSE-0036", "TARGET-0002"]);
});

it("fails closed on overlarge, invalid or partly unbound windows without recording partial inspection", async () => {
  const { tools } = fixture(["OPEN-0001"]);
  const crowded = Array.from({ length: 25 }, (_, i) => ({ ref: `FRAME-${i}`, timeSeconds: i / 10 }));
  const overflow = await createEvidenceWindowTool(tools, crowded).execute({ start: 0, end: 3 }, signal());
  expect(overflow).toMatchObject({ error: "RESPONSES_EVIDENCE_WINDOW_TOO_LARGE", imagesInspected: 0, indexedFrames: crowded });
  const tool = createEvidenceWindowTool(tools, [{ ref: "OPEN-0001", timeSeconds: 1 }, { ref: "missing", timeSeconds: 2 }]);
  expect(await tool.execute({ start: 0, end: 3 }, signal())).toMatchObject({ error: "RESPONSES_EVIDENCE_WINDOW_UNBOUND" });
  expect(await tool.execute({ start: 0, end: 9 }, signal())).toMatchObject({ error: "RESPONSES_EVIDENCE_WINDOW_INVALID" });
  expect(await tool.execute({ start: 4, end: 5 }, signal())).toMatchObject({ error: "RESPONSES_EVIDENCE_WINDOW_EMPTY" });
  expect(tools.inspectedImages.size).toBe(0);
});

it("rejects conflicting index timestamps and detects mutated image data before marking any reads", async () => {
  expect(() => indexedEvidenceFrames({ frameIndex: [{ id: "same", time: 1 }] }, { frames: [{ id: "same", time: 2 }] }))
    .toThrow("RESPONSES_FRAME_INDEX_CONFLICT");
  const { root, tools } = fixture(["A", "B"]);
  fs.appendFileSync(path.join(root, "B.jpg"), "mutation");
  const tool = createEvidenceWindowTool(tools, [{ ref: "A", timeSeconds: 1 }, { ref: "B", timeSeconds: 2 }]);
  await expect(tool.execute({ start: 0, end: 3 }, signal())).rejects.toThrow("RESPONSES_EVIDENCE_MUTATED");
  expect(tools.inspectedImages.size).toBe(0);
});
