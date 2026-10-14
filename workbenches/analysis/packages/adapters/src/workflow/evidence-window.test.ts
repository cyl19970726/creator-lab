import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEvidenceWindowTool, indexedEvidenceFrames } from "./evidence-window.js";
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
