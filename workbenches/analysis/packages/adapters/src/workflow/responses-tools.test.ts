import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OpenAIAgentsSdkRunner } from "@signal-room/workflow-agent-sdk";
import { ResponsesEvidenceTools } from "./responses-tools.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

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
  await expect(inspect.execute({ ref: image }, new AbortController().signal)).rejects.toThrow("RESPONSES_EVIDENCE_NOT_BOUND");
  fs.writeFileSync(image, "changed");
  await expect(inspect.execute({ ref: "cover" }, new AbortController().signal)).rejects.toThrow("RESPONSES_EVIDENCE_MUTATED");
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
