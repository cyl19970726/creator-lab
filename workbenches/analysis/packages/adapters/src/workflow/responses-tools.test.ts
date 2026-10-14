import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OpenAIAgentsSdkRunner } from "@signal-room/workflow-agent-sdk";
import { ResponsesEvidenceTools } from "./responses-tools.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/0XcAAAAASUVORK5CYII=", "base64");

it("binds image pixels by exact reference and rejects arbitrary paths", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "responses-evidence-")); roots.push(root);
  const image = path.join(root, "cover.png");
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/0XcAAAAASUVORK5CYII=", "base64");
  fs.writeFileSync(image, bytes);
  const tools = new ResponsesEvidenceTools([{ ref: "cover", path: image,
    sha256: createHash("sha256").update(bytes).digest("hex") }], root);
  const inspect = tools.tools().find(tool => tool.name === "inspect_image")!;
  const result = await inspect.execute({ ref: "cover" }, new AbortController().signal);
  expect(result).toMatchObject({ kind: "siwc_visual_tool_result", value: { ref: "cover" },
    images: [{ mimeType: "image/png", base64: bytes.toString("base64") }] });
  expect(tools.inspectedImages.has("cover")).toBe(true);
  expect(await inspect.execute({ ref: image }, new AbortController().signal)).toMatchObject({
    success: false, error: "RESPONSES_EVIDENCE_NOT_BOUND", unknownRefs: [image],
    eligibleRefs: ["cover"], eligibleRefCount: 1, eligibleRefsComplete: true, suggestedTool: "inspect_image" });
  fs.writeFileSync(image, "changed");
  await expect(inspect.execute({ ref: "cover" }, new AbortController().signal)).rejects.toThrow("RESPONSES_EVIDENCE_MUTATED");
});

it("delivers ordered actual pixels for independent bound images without claiming semantic coverage", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "responses-image-batch-")); roots.push(root);
  const pixels = [tinyPng, Buffer.concat([tinyPng, Buffer.from("second frame")])];
  const bound = pixels.map((bytes, index) => {
    const file = path.join(root, `image-${index}.png`); fs.writeFileSync(file, bytes);
    return { ref: `image-${index}`, path: file, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const evidence = new ResponsesEvidenceTools(bound, root);
  const inspect = evidence.tools().find(tool => tool.name === "inspect_images")!;
  const result = await inspect.execute({ refs: ["image-1", "image-0"] }, new AbortController().signal);
  expect(result).toMatchObject({ kind: "siwc_visual_tool_result", value: {
    orderedRefs: [{ imageIndex: 0, ref: "image-1" }, { imageIndex: 1, ref: "image-0" }],
    imageRefs: [{ ref: "image-1", sha256: bound[1]!.sha256 }, { ref: "image-0", sha256: bound[0]!.sha256 }],
    semanticCoverage: "not_evaluated", coverage: { textRefs: 0, imageRefs: 2 }
  }, images: [{ mimeType: "image/png", base64: pixels[1]!.toString("base64") },
    { mimeType: "image/png", base64: pixels[0]!.toString("base64") }] });
  expect([...evidence.inspectedImages]).toEqual(["image-1", "image-0"]);
});

it("rejects invalid, duplicate, unbound, and oversized image batches without partial observations", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "responses-image-batch-fail-")); roots.push(root);
  const image = path.join(root, "bound.png"); fs.writeFileSync(image, tinyPng);
  const evidence = new ResponsesEvidenceTools([{ ref: "bound", path: image,
    sha256: createHash("sha256").update(tinyPng).digest("hex") }], root);
  const inspect = evidence.tools().find(tool => tool.name === "inspect_images")!;
  const signal = new AbortController().signal;
  await expect(inspect.execute({ refs: [] }, signal)).rejects.toThrow("RESPONSES_IMAGE_BATCH_INVALID");
  await expect(inspect.execute({ refs: Array.from({ length: 25 }, (_, index) => `ref-${index}`) }, signal))
    .rejects.toThrow("RESPONSES_IMAGE_BATCH_INVALID");
  await expect(inspect.execute({ refs: ["bound", ""] }, signal)).rejects.toThrow("RESPONSES_IMAGE_BATCH_INVALID");
  await expect(inspect.execute({ refs: ["bound", "bound"] }, signal)).rejects.toThrow("RESPONSES_CONTEXT_DUPLICATE_REF");
  expect(await inspect.execute({ refs: ["bound", "missing"] }, signal)).toMatchObject({
    success: false, error: "RESPONSES_EVIDENCE_NOT_BOUND", unknownRefs: ["missing"],
    eligibleRefs: ["bound"], eligibleRefCount: 1, eligibleRefsComplete: true });
  expect(evidence.inspectedImages.size).toBe(0);
  expect(evidence.readRefs.size).toBe(0);
  fs.writeFileSync(image, "changed");
  await expect(inspect.execute({ refs: ["bound", "missing"] }, signal)).rejects.toThrow("RESPONSES_EVIDENCE_MUTATED");
  await expect(inspect.execute({ refs: ["bound"] }, signal)).rejects.toThrow("RESPONSES_EVIDENCE_MUTATED");
  expect(evidence.inspectedImages.size).toBe(0);
});

it("lets the real SIWC tool loop recover from choosing the text tool for a bound image", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "responses-tool-recovery-")); roots.push(root);
  const image = path.join(root, "frame.png");
  const bytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/0XcAAAAASUVORK5CYII=", "base64");
  fs.writeFileSync(image, bytes);
  const tools = new ResponsesEvidenceTools([{ ref: "FRAME-SHOT-001", path: image,
    sha256: createHash("sha256").update(bytes).digest("hex") }], root);
  const bodies: Array<{ input: Array<{ type?: string; output?: string; content?: Array<{ image_url?: string }> }> }> = [];
  const stream = (output: unknown) => new Response(`data: ${JSON.stringify({ type: "response.completed", response: { output } })}\n\n`,
    { headers: { "content-type": "text/event-stream" } });
  const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "fake" }, tools: () => tools.tools(),
    fetch: vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      const turn = bodies.length;
      return turn < 3 ? stream([{ type: "function_call", name: turn === 1 ? "read_evidence" : "inspect_image",
        call_id: `call-${turn}`, arguments: '{"ref":"FRAME-SHOT-001"}' }])
        : stream([{ type: "message", content: [{ type: "output_text", text: "seen" }] }]);
    }) as typeof fetch });
  const events: Array<{ type: string; data?: unknown }> = [];
  const result = await runner.run({ runId: "r", stepRunId: "s", attemptId: "a", input: {},
    signal: new AbortController().signal, definition: { id: "post-builder", revision: "v1", model: "gpt-6-luna",
      reasoningEffort: "medium", promptRevision: "v1", skillsRevision: "none", permissionsRevision: "bound",
      config: { instructions: "Look at the frame" } }, emit: async (type, data) => { events.push({ type, data }); } });
  expect(result.output).toBe("seen");
  expect(bodies[1]!.input.at(-1)).toMatchObject({ type: "function_call_output",
    output: '{"error":"use_inspect_image","ref":"FRAME-SHOT-001","suggestedTool":"inspect_image"}' });
  expect(bodies[2]!.input.at(-1)!.content).toContainEqual({ type: "input_image",
    image_url: `data:image/png;base64,${bytes.toString("base64")}`, detail: "high" });
  expect(tools.inspectedImages.has("FRAME-SHOT-001")).toBe(true);
  expect(events.some(event => event.type === "siwc.tool_failed")).toBe(false);
  expect(JSON.stringify(events)).not.toContain(bytes.toString("base64"));
});

it("lets the official SDK continue after an unbound text ref, then read the exact bound ref", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "responses-unbound-recovery-")); roots.push(root);
  const file = path.join(root, "batch.json");
  fs.writeFileSync(file, '{"source":"verified"}');
  const evidence = new ResponsesEvidenceTools([{ ref: "post-source-input", path: file,
    sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") }], root);
  const bodies: Array<{ input: Array<{ type?: string; output?: string }> }> = [];
  const stream = (output: unknown) => new Response(`data: ${JSON.stringify({ type: "response.completed", response: { output } })}\n\n`,
    { headers: { "content-type": "text/event-stream" } });
  const events: string[] = [];
  const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "fake" }, tools: () => evidence.tools(),
    fetch: vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      const turn = bodies.length;
      return turn < 3 ? stream([{ type: "function_call", name: "read_evidence", call_id: `c-${turn}`,
        arguments: JSON.stringify({ ref: turn === 1 ? "video-reconstruction-batch-r60" : "post-source-input" }) }])
        : stream([{ type: "message", content: [{ type: "output_text", text: "done" }] }]);
    }) as typeof fetch });
  const result = await runner.run({ runId: "r", stepRunId: "s", attemptId: "a", input: {},
    signal: new AbortController().signal, definition: { id: "post-builder", revision: "v1", model: "gpt-6-luna",
      reasoningEffort: "medium", promptRevision: "v1", skillsRevision: "none", permissionsRevision: "bound",
      config: { instructions: "Read exact bound evidence" } }, emit: async type => { events.push(type); } });
  expect(result.output).toBe("done");
  expect(JSON.parse(bodies[1]!.input.at(-1)!.output!)).toMatchObject({
    success: false, error: "RESPONSES_EVIDENCE_NOT_BOUND", unknownRefs: ["video-reconstruction-batch-r60"],
    eligibleRefs: ["post-source-input"], eligibleRefCount: 1, eligibleRefsComplete: true });
  expect(evidence.fullyRead("post-source-input")).toBe(true);
  expect(JSON.parse(bodies[2]!.input.at(-1)!.output!)).toMatchObject({ ref: "post-source-input",
    text: '{"source":"verified"}' });
  expect(events).not.toContain("siwc.tool_failed");
  fs.writeFileSync(file, "tampered");
  await expect(evidence.tools().find(tool => tool.name === "read_evidence")!
    .execute({ ref: "post-source-input" }, new AbortController().signal)).rejects.toThrow("RESPONSES_EVIDENCE_MUTATED");
});

it("suggests the text tool for a bound text ref but rejects tampering", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "responses-text-hint-")); roots.push(root);
  const file = path.join(root, "evidence.json"); fs.writeFileSync(file, "{\"ok\":true}");
  const tools = new ResponsesEvidenceTools([{ ref: "evidence", path: file,
    sha256: createHash("sha256").update(fs.readFileSync(file)).digest("hex") }], root);
  const inspect = tools.tools().find(tool => tool.name === "inspect_image")!;
  expect(await inspect.execute({ ref: "evidence" }, new AbortController().signal)).toEqual({
    error: "use_read_evidence", ref: "evidence", suggestedTool: "read_evidence" });
  expect(tools.inspectedImages.size).toBe(0);
  fs.writeFileSync(file, "changed");
  await expect(inspect.execute({ ref: "evidence" }, new AbortController().signal)).rejects.toThrow("RESPONSES_EVIDENCE_MUTATED");
});

it("reads a verified full-field JSON batch with ordered image pixels and fresh-call coverage", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "responses-bundle-")); roots.push(root);
  const object = { title: "字 A", nested: { zero: 0, nil: null, rows: [false, { text: "x y" }] } };
  const source = JSON.stringify(object, null, 2);
  const pixelA = tinyPng; const pixelB = Buffer.concat([tinyPng, Buffer.from("second")]);
  const files = [
    ["evidence", "source.json", Buffer.from(source)], ["notes", "notes.txt", Buffer.from("first\nsecond\n")],
    ["cover", "cover.png", pixelA], ["contact", "contact.png", pixelB],
  ] as const;
  const bound = files.map(([ref, name, bytes]) => {
    const file = path.join(root, name); fs.writeFileSync(file, bytes);
    return { ref, path: file, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const tools = new ResponsesEvidenceTools(bound, root);
  const batch = tools.readBundle(["evidence", "notes"], ["contact", "cover"]);
  expect(batch).toMatchObject({ kind: "siwc_visual_tool_result", value: {
    imageRefs: [{ ref: "contact", sha256: bound[3]!.sha256 }, { ref: "cover", sha256: bound[2]!.sha256 }],
    coverage: { textRefs: 2, imageRefs: 2, sourceCharacters: source.length + 13 }
  } });
  if ("error" in batch) throw new Error(batch.error);
  expect(JSON.parse(batch.value.text[0]!.content)).toEqual(object);
  expect(batch.value.text[0]!.content).toBe(JSON.stringify(object));
  expect(batch.value.text[1]!.content).toBe("first\nsecond\n");
  expect(batch.images.map(image => image.base64)).toEqual([pixelB.toString("base64"), pixelA.toString("base64")]);
  expect(tools.fullyRead("evidence")).toBe(true);
  expect(tools.fullyRead("notes")).toBe(true);
  expect([...tools.inspectedImages]).toEqual(["contact", "cover"]);
  tools.resetObservationTracking();
  expect(tools.fullyRead("evidence")).toBe(false);
  expect(tools.inspectedImages.size).toBe(0);
});

it("forks exact bindings without carrying text or pixel observations and rejects later source mutation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "responses-fork-")); roots.push(root);
  const textFile = path.join(root, "source.json");
  const imageFile = path.join(root, "frame.png");
  const source = Buffer.from('{"observed":true}');
  fs.writeFileSync(textFile, source);
  fs.writeFileSync(imageFile, tinyPng);
  const bindings = [
    { ref: "source", path: textFile, sha256: createHash("sha256").update(source).digest("hex") },
    { ref: "frame", path: imageFile, sha256: createHash("sha256").update(tinyPng).digest("hex") },
  ];
  const parent = new ResponsesEvidenceTools(bindings, root);
  const observed = parent.readBundle(["source"], ["frame"]);
  expect("kind" in observed).toBe(true);
  const copy = parent.snapshotBindings();
  expect(copy).toEqual(bindings);
  copy[0]!.sha256 = "0".repeat(64);
  expect(parent.snapshotBindings()).toEqual(bindings);
  const first = parent.fork(path.join(root, "branch-one"));
  const second = parent.fork(path.join(root, "branch-two"));
  expect(first.list()).toEqual(["source", "frame"]);
  expect(first.fullyRead("source")).toBe(false);
  expect(first.inspectedImages.size).toBe(0);
  expect(second.fullyRead("source")).toBe(false);
  expect(second.inspectedImages.size).toBe(0);
  first.readBundle(["source"], ["frame"]);
  expect(first.fullyRead("source")).toBe(true);
  expect(first.inspectedImages.has("frame")).toBe(true);
  expect(second.fullyRead("source")).toBe(false);
  expect(second.inspectedImages.size).toBe(0);
  expect(parent.fullyRead("source")).toBe(true);
  fs.writeFileSync(textFile, '{"observed":false}');
  expect(parent.snapshotBindings()).toEqual(bindings);
  const late = parent.fork(path.join(root, "late-branch"));
  expect(() => first.readBundle(["source"], [])).toThrow("RESPONSES_EVIDENCE_MUTATED");
  expect(() => second.readBundle(["source"], ["frame"])).toThrow("RESPONSES_EVIDENCE_MUTATED");
  expect(() => late.readBundle(["source"], [])).toThrow("RESPONSES_EVIDENCE_MUTATED");
  expect(second.fullyRead("source")).toBe(false);
  expect(second.inspectedImages.size).toBe(0);
});

it("copies large media bindings without reading bytes until a tool actually opens the ref", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "responses-snapshot-media-")); roots.push(root);
  const mediaPath = path.join(root, "source.mp4");
  const bytes = Buffer.alloc(8 * 1024 * 1024, 7);
  fs.writeFileSync(mediaPath, bytes);
  const binding = { ref: "source-media", path: mediaPath, sha256: createHash("sha256").update(bytes).digest("hex") };
  const tools = new ResponsesEvidenceTools([binding], root);
  const read = vi.spyOn(fs, "readFileSync");
  try {
    expect(tools.snapshotBindings()).toEqual([binding]);
    const branch = tools.fork(path.join(root, "branch"));
    expect(branch.list()).toEqual(["source-media"]);
    expect(read).not.toHaveBeenCalled();
  } finally { read.mockRestore(); }
  fs.writeFileSync(mediaPath, "changed");
  expect(() => tools.readBundle([], ["source-media"])).toThrow("RESPONSES_EVIDENCE_MUTATED");
});

it("shrinks an overflowing image batch and credits only pixels actually returned", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "responses-batch-shrink-")); roots.push(root);
  const bindings = Array.from({ length: 3 }, (_, index) => {
    const file = path.join(root, `image-${index}.png`);
    const bytes = Buffer.alloc(12 * 1024 * 1024);
    tinyPng.copy(bytes, 0, 0, 8);
    bytes[bytes.length - 1] = index;
    fs.writeFileSync(file, bytes);
    return { ref: `image-${index}`, path: file, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  const tools = new ResponsesEvidenceTools(bindings, root);
  const first = tools.readImageBatch(bindings.map(item => item.ref));
  if ("error" in first) throw new Error(first.error);
  expect(first.value.imageRefs.map(item => item.ref)).toEqual(["image-0"]);
  expect([...tools.inspectedImages]).toEqual(["image-0"]);
  const remaining = bindings.map(item => item.ref).filter(ref => !tools.inspectedImages.has(ref));
  const second = tools.readImageBatch(remaining);
  if ("error" in second) throw new Error(second.error);
  expect(second.value.imageRefs.map(item => item.ref)).toEqual(["image-1", "image-2"]);
  expect([...tools.inspectedImages]).toEqual(["image-0", "image-1", "image-2"]);
});

it("compacts only JSON whitespace without changing number or string tokens", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "responses-bundle-lexical-")); roots.push(root);
  const source = '{ "id": 9007199254740993, "minusZero": -0, "label": " a b ", "escaped": "a\\u0020b\\n" }';
  const file = path.join(root, "source.json"); fs.writeFileSync(file, source);
  const tools = new ResponsesEvidenceTools([{ ref: "source", path: file, sha256: createHash("sha256").update(source).digest("hex") }], root);
  const result = tools.readBundle(["source"], []);
  if ("error" in result) throw new Error(result.error);
  expect(result.value.text[0]!.content).toBe('{"id":9007199254740993,"minusZero":-0,"label":" a b ","escaped":"a\\u0020b\\n"}');
  expect(tools.fullyRead("source")).toBe(true);
  const invalid = path.join(root, "invalid.json"); fs.writeFileSync(invalid, '{"a":}');
  const broken = new ResponsesEvidenceTools([{ ref: "invalid", path: invalid,
    sha256: createHash("sha256").update('{"a":}').digest("hex") }], root);
  expect(() => broken.readBundle(["invalid"], [])).toThrow(SyntaxError);
  expect(broken.fullyRead("invalid")).toBe(false);
});

it("fails a batch closed for unbound, changed, wrong-type, and oversized refs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "responses-bundle-fail-")); roots.push(root);
  const files = [["small", "small.json", Buffer.from("{\"n\":1}")], ["large", "large.txt", Buffer.from("x".repeat(1000))],
    ["image", "image.png", tinyPng]] as const;
  const bound = files.map(([ref, name, content]) => {
    const file = path.join(root, name); fs.writeFileSync(file, content);
    return { ref, path: file, sha256: createHash("sha256").update(content).digest("hex") };
  });
  const tools = new ResponsesEvidenceTools(bound, root);
  expect(() => tools.readBundle(["small", "missing"], ["image"])).toThrow("RESPONSES_EVIDENCE_NOT_BOUND");
  expect(() => tools.readBundle(["small", "image"], [])).toThrow("RESPONSES_NON_TEXT_EVIDENCE");
  expect(() => tools.readBundle(["small"], ["large"])).toThrow("RESPONSES_NOT_IMAGE");
  expect(() => tools.readBundle(["small", "small"], [])).toThrow("RESPONSES_CONTEXT_DUPLICATE_REF");
  expect(tools.fullyRead("small")).toBe(false);
  expect(tools.inspectedImages.size).toBe(0);
  const overflow = tools.readBundle(["small", "large"], ["image"], 20);
  expect(overflow).toMatchObject({ error: "RESPONSES_CONTEXT_BUNDLE_TOO_LARGE", characterLimit: 20 });
  expect(tools.fullyRead("small")).toBe(false);
  expect(tools.fullyRead("large")).toBe(false);
  expect(tools.inspectedImages.size).toBe(0);
  fs.writeFileSync(bound[1]!.path, "changed");
  expect(() => tools.readBundle(["small", "large"], ["image"])).toThrow("RESPONSES_EVIDENCE_MUTATED");
  expect(tools.fullyRead("small")).toBe(false);
  const corrupt = path.join(root, "corrupt.png"); fs.writeFileSync(corrupt, "bad pixels");
  const malformed = new ResponsesEvidenceTools([{ ref: "corrupt", path: corrupt,
    sha256: createHash("sha256").update("bad pixels").digest("hex") }], root);
  expect(() => malformed.readBundle([], ["corrupt"])).toThrow("RESPONSES_IMAGE_TYPE_MISMATCH");
  expect(malformed.inspectedImages.size).toBe(0);
});

it("rejects one image above the SIWC base64 limit before marking any batch observation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "responses-bundle-image-limit-")); roots.push(root);
  const textFile = path.join(root, "source.json"); fs.writeFileSync(textFile, '{"observed":true}');
  const imageFile = path.join(root, "large.png");
  const pixels = Buffer.alloc(15_000_001);
  tinyPng.copy(pixels, 0, 0, 8);
  fs.writeFileSync(imageFile, pixels);
  const bound = [["source", textFile], ["large", imageFile]].map(([ref, file]) => ({
    ref: ref!, path: file!, sha256: createHash("sha256").update(fs.readFileSync(file!)).digest("hex")
  }));
  const tools = new ResponsesEvidenceTools(bound, root);
  const result = tools.readBundle(["source"], ["large"]);
  expect(result).toMatchObject({ success: false, error: "RESPONSES_CONTEXT_BUNDLE_TOO_LARGE",
    requiredImageBytes: 15_000_001, imageByteLimit: 32 * 1024 * 1024,
    imageBase64CharacterLimit: 20_000_000,
    oversizedImageRefs: [{ ref: "large", encodedCharacters: 20_000_004 }] });
  expect("error" in result && result.recovery).toContain("smaller bound image derivatives");
  expect(tools.fullyRead("source")).toBe(false);
  expect(tools.inspectedImages.size).toBe(0);
  expect(tools.readRefs.size).toBe(0);
});

it("passes batch image pixels to the official SDK in the declared ref order", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "responses-bundle-sdk-")); roots.push(root);
  const bytes = [tinyPng, Buffer.concat([tinyPng, Buffer.from("pixel B")])];
  const bound = bytes.map((data, index) => {
    const file = path.join(root, `image-${index}.png`); fs.writeFileSync(file, data);
    return { ref: `image-${index}`, path: file, sha256: createHash("sha256").update(data).digest("hex") };
  });
  const evidence = new ResponsesEvidenceTools(bound, root);
  const bodies: Array<{ input: Array<{ content?: Array<{ type?: string; image_url?: string }> }> }> = [];
  const stream = (output: unknown) => new Response(`data: ${JSON.stringify({ type: "response.completed", response: { output } })}\n\n`,
    { headers: { "content-type": "text/event-stream" } });
  const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "fake" }, tools: () => [{
    name: "batch", description: "Read bound images", parameters: { type: "object", additionalProperties: false, properties: {} },
    execute: async () => evidence.readBundle([], ["image-1", "image-0"])
  }], fetch: vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
    bodies.push(JSON.parse(init!.body as string));
    return stream(bodies.length === 1 ? [{ type: "function_call", name: "batch", call_id: "c1", arguments: "{}" }]
      : [{ type: "message", content: [{ type: "output_text", text: "seen" }] }]);
  }) as typeof fetch });
  await runner.run({ runId: "r", stepRunId: "s", attemptId: "a", input: {}, signal: new AbortController().signal,
    definition: { id: "post-builder", revision: "v1", model: "gpt-6-luna", reasoningEffort: "medium",
      promptRevision: "v1", skillsRevision: "none", permissionsRevision: "bound", config: { instructions: "read" } },
    emit: async () => {} });
  const delivered = bodies[1]!.input.at(-1)!.content!.filter(item => item.type === "input_image");
  expect(delivered.map(item => item.image_url)).toEqual([bytes[1]!, bytes[0]!]
    .map(data => `data:image/png;base64,${data.toString("base64")}`));
});
