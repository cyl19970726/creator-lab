import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentRunRequest, ArtifactRef } from "@signal-room/workflow";
import { OpenAIAgentsSdkRunner, type SiwcTool } from "@signal-room/workflow-agent-sdk";
import { artifactPath, artifactRef } from "../core/artifacts.js";
import { createResearchAgentDefinitions } from "../../../research/src/workflows/agents.js";
import { phase2Readiness, phase2BuilderContextResponse, postReviewerContextResponse, postRepairContextResponse,
  createProbeProtocolDraftValidator, bindPostCandidateFiles, ResponsesResearchRunner } from "./responses-research-runner.js";
import { ResponsesEvidenceTools } from "./responses-tools.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const fixtures = path.resolve(".agents/skills/video-content-reconstruction/tests/fixtures/valid");
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(fixtures, name), "utf8")) as Record<string, unknown>;
const digest = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const assertIngestableTree = (directory: string): void => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unregistered media symlink: ${file}`);
    if (entry.isDirectory()) assertIngestableTree(file);
  }
};
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/0XcAAAAASUVORK5CYII=", "base64");

it("binds only the frozen post-cover path and SHA, including WebP, without admitting paths outside the candidate", () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "responses-frozen-cover-")); roots.push(runtime);
  const previous = process.env.SELF_MEDIA_RUNTIME_DIR; process.env.SELF_MEDIA_RUNTIME_DIR = runtime;
  try {
    const runId = crypto.randomUUID();
    const relativeRoot = "workflow-responses/reviewer/attempt";
    const directory = path.join(runtime, "runs", runId, relativeRoot);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "reconstruction.json"), "{}");
    const cover = path.join(directory, "post-cover.webp");
    fs.writeFileSync(cover, Buffer.from("UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAgA0JaQAA3AA/vv9UAA=", "base64"));
    const source = path.join(directory, "post-source-input.json");
    const frozen = { cover: { path: "post-cover.webp", sha256: digest(cover) } };
    fs.writeFileSync(source, JSON.stringify(frozen));
    const candidate = { reportArtifactRef: artifactRef(runId, `${relativeRoot}/reconstruction.json`), relativeRoot };
    const bound: Array<{ ref: string; path: string; sha256: string }> = [];
    bindPostCandidateFiles(bound, candidate, runId);
    expect(bound).toContainEqual({ ref: "post-cover.webp", path: cover, sha256: digest(cover) });
    const evidence = new ResponsesEvidenceTools(bound, directory);
    const batch = evidence.readBundle([], ["post-cover.webp"]);
    expect(batch).toMatchObject({ kind: "siwc_visual_tool_result", value: {
      imageRefs: [{ ref: "post-cover.webp", sha256: digest(cover), mimeType: "image/webp" }] } });
    expect(evidence.inspectedImages.has("post-cover.webp")).toBe(true);
    const outside = path.join(runtime, "outside.webp");
    fs.copyFileSync(cover, outside);
    fs.rmSync(cover);
    fs.symlinkSync(outside, cover);
    expect(() => bindPostCandidateFiles([], candidate, runId)).toThrow("RESPONSES_CANDIDATE_COVER_PATH_INVALID");
    fs.rmSync(cover); fs.copyFileSync(outside, cover);
    fs.writeFileSync(source, JSON.stringify({ cover: { path: "../outside.webp", sha256: digest(cover) } }));
    expect(() => bindPostCandidateFiles([], candidate, runId)).toThrow("RESPONSES_CANDIDATE_COVER_SOURCE_INVALID");
    fs.writeFileSync(source, JSON.stringify({ cover: { path: "post-cover.webp", sha256: "0".repeat(64) } }));
    expect(() => bindPostCandidateFiles([], candidate, runId)).toThrow("RESPONSES_CANDIDATE_COVER_FINGERPRINT_INVALID");
    fs.writeFileSync(source, JSON.stringify({ cover: null }));
    const withoutCover: typeof bound = [];
    expect(() => bindPostCandidateFiles(withoutCover, candidate, runId)).not.toThrow();
    expect(withoutCover.some(item => item.ref === "post-cover.webp")).toBe(false);
    fs.writeFileSync(cover, "changed");
    expect(() => evidence.readBundle([], ["post-cover.webp"])).toThrow("RESPONSES_EVIDENCE_MUTATED");
  } finally {
    if (previous === undefined) delete process.env.SELF_MEDIA_RUNTIME_DIR;
    else process.env.SELF_MEDIA_RUNTIME_DIR = previous;
  }
});

it("rejects an aggregate capture plan before issuing a passing phase-one receipt", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "responses-capture-budget-")); roots.push(root);
  const probe = fixture("probe.json") as { carrierSweep: Array<{ range: { start: number; end: number } }> };
  probe.carrierSweep[1]!.range.end = 123.88;
  const protocol = fixture("capture-protocol.json") as { schemaVersion: string;
    captureActions: Array<Record<string, unknown>> };
  protocol.schemaVersion = "capture-protocol-2.0";
  const template = protocol.captureActions[0]!;
  const windows: Array<[string, number, number]> = [
    ["ocr_review", 6.56, 10.96], ["ocr_review", 30.44, 43.28],
    ["ui_state_review", 40.4, 53.96], ["ui_state_review", 53.96, 66.32],
    ["before_during_after", 0, 21.2], ["before_during_after", 35.6, 43.28],
    ["before_during_after", 86.08, 108.16], ["before_during_after", 108.16, 123.88]
  ];
  protocol.captureActions = windows.map(([mode, start, end], index) => ({ ...template,
    id: `A${index + 1}`, mode, range: { start, end }, times: [],
    consumers: ["content_restoration"], presentationIntent: "analysis_only" }));
  const pack = fixture("evidence-pack.json") as { media: { duration: number } };
  pack.media.duration = 123.88;
  const tool = createProbeProtocolDraftValidator(root,
    path.resolve(".agents/skills/video-content-reconstruction/schemas"), pack);
  const result = await tool.execute({ probe, captureProtocol: protocol } as never, new AbortController().signal) as {
    pass: boolean; errors: Array<{ document: string; path: string; message: string }> };
  expect(result.pass).toBe(false);
  expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ document: "captureProtocol",
    path: "/captureActions/4", message: expect.stringContaining("187/180 total unique times") })]));
});

it("returns a correctable OCR union cap error in the phase-one preflight", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "responses-ocr-budget-")); roots.push(root);
  const probe = fixture("probe.json");
  const protocol = fixture("capture-protocol.json") as { schemaVersion: string; probe: string;
    captureActions: Array<Record<string, unknown>> };
  protocol.schemaVersion = "capture-protocol-2.0";
  protocol.probe = "probe.json";
  for (const action of protocol.captureActions) {
    action.consumers = ["content_restoration"];
    action.presentationIntent = "analysis_only";
  }
  protocol.captureActions[0] = { ...protocol.captureActions[0], mode: "ocr_review", times: [1] };
  const pack = fixture("evidence-pack.json") as { frameIndex: Array<{ id: string; time: number; frame: string }> };
  pack.frameIndex = Array.from({ length: 513 }, (_, index) => ({ id: `DENSE-${index}`, time: 1,
    frame: "frames/dense/reused.jpg" }));
  const tool = createProbeProtocolDraftValidator(root,
    path.resolve(".agents/skills/video-content-reconstruction/schemas"), pack);
  const result = await tool.execute({ probe, captureProtocol: protocol } as never, new AbortController().signal) as {
    pass: boolean; errors: Array<{ path: string; message: string }> };
  expect(result.pass).toBe(false);
  expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ path: "/captureActions",
    message: expect.stringContaining("515/512") })]));
});

it("retains phase-two schemas and readiness when the evidence bundle requires pagination", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "responses-phase-two-overflow-")); roots.push(root);
  const file = path.join(root, "large.json"); fs.writeFileSync(file, JSON.stringify({ evidence: "x".repeat(1000) }));
  const tools = new ResponsesEvidenceTools([{ ref: "large", path: file, sha256: digest(file) }], root);
  const bundle = tools.readBundle(["large"], [], 20);
  expect(bundle).toMatchObject({ success: false, error: "RESPONSES_CONTEXT_BUNDLE_TOO_LARGE" });
  const response = phase2BuilderContextResponse(bundle,
    path.resolve(".agents/skills/video-content-reconstruction/schemas/reconstruction.schema.json"),
    { ready: false, missingText: [{ ref: "large", nextOffset: 0, totalCharacters: 1015 }] } as never);
  expect(response).toMatchObject({ success: false, error: "RESPONSES_CONTEXT_BUNDLE_TOO_LARGE",
    builderLensSchemas: { contentRestoration: expect.any(Object), directingLogic: expect.any(Object),
      visualEditing: expect.any(Object) }, reconstructionIndexSchema: expect.any(Object),
    readiness: { ready: false, missingText: [{ ref: "large", nextOffset: 0 }] } });
  expect(response).not.toHaveProperty("images");
  expect(tools.fullyRead("large")).toBe(false);
});

it("reports phase-two capture-action coverage from the frozen protocol and manifest without implying semantic resolution", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "responses-phase-two-coverage-")); roots.push(root);
  const textRefs = ["post-source-input", "media-preparation", "evidence-pack", "probe", "capture-protocol", "targeted-evidence"];
  const imageRefs = ["opening-contact", "post-cover", "targeted-contact", "TARGET-9001", "TARGET-9002", "TARGET-9003"];
  const bound = [...textRefs, ...imageRefs].map(ref => {
    const file = path.join(root, `${ref}.${imageRefs.includes(ref) ? "jpg" : "json"}`);
    fs.writeFileSync(file, imageRefs.includes(ref) ? png : "{}");
    return { ref, path: file, sha256: digest(file) };
  });
  const tools = new ResponsesEvidenceTools(bound, root);
  const inspect = tools.tools().find(tool => tool.name === "inspect_image")!;
  const signal = new AbortController().signal;
  await inspect.execute({ ref: "opening-contact" }, signal);
  await inspect.execute({ ref: "post-cover" }, signal);
  await inspect.execute({ ref: "TARGET-9001" }, signal);
  tools.resetObservationTracking();

  const evidence = { protocolActions: [
    { id: "CAP-REL", reason: "check the state relationship", expectedObservation: "the transition is visible",
      range: { start: 20.7, end: 21.2 } },
    { id: "CAP-TEXT", reason: "read the on-screen AI statement", expectedObservation: "the full claim is legible",
      range: { start: 89.8, end: 90.3 } },
  ], manifestActions: [
    { id: "CAP-REL", frameIds: ["TARGET-9001", "TARGET-9002"] },
    { id: "CAP-TEXT", frameIds: ["TARGET-9003"] },
  ], frames: [
    { id: "TARGET-9001", time: 20.8, actionId: "CAP-REL" },
    { id: "TARGET-9002", time: 21.1, actionId: "CAP-REL" },
    { id: "TARGET-9003", time: 90.1, actionId: "CAP-TEXT" },
  ] };

  const afterReset = phase2Readiness(tools, evidence, false);
  expect(afterReset.readinessScope).toBe("minimum_input_access");
  expect(afterReset.semanticCoverage).toBe("not_evaluated");
  expect(afterReset.inspectedTargetRefs).toEqual([]);
  expect(afterReset.uninspectedTargetRefs).toEqual(["TARGET-9001", "TARGET-9002", "TARGET-9003"]);
  expect(afterReset.actionCoverage).toMatchObject([
    { id: "CAP-REL", question: "check the state relationship", expectedObservation: "the transition is visible",
      timeRange: { start: 20.7, end: 21.2 }, targetFrames: [
        { ref: "TARGET-9001", timeSeconds: 20.8 }, { ref: "TARGET-9002", timeSeconds: 21.1 }], inspectedRefs: [],
      uninspectedRefs: ["TARGET-9001", "TARGET-9002"], semanticCoverage: "not_evaluated" },
    { id: "CAP-TEXT", question: "read the on-screen AI statement", expectedObservation: "the full claim is legible",
      targetFrames: [{ ref: "TARGET-9003", timeSeconds: 90.1 }], inspectedRefs: [], uninspectedRefs: ["TARGET-9003"],
      semanticCoverage: "not_evaluated" },
  ]);

  await inspect.execute({ ref: "TARGET-9001" }, signal);
  const oneFrameInspected = phase2Readiness(tools, evidence, false);
  expect(oneFrameInspected.actionCoverage[0]).toMatchObject({ inspectedRefs: ["TARGET-9001"],
    uninspectedRefs: ["TARGET-9002"], semanticCoverage: "not_evaluated" });
  expect(oneFrameInspected.actionCoverage[1]).toMatchObject({ inspectedRefs: [],
    uninspectedRefs: ["TARGET-9003"], semanticCoverage: "not_evaluated" });
});

it("delivers a lossless reviewer batch through the official SDK and keeps overflow unobserved", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "responses-reviewer-context-")); roots.push(root);
  const rows = [["candidate", "candidate.json", '{ "claim": "原始内容" }'],
    ["ocr", "ocr.json", '{ "frames": [{ "text": "短字幕" }] }']] as const;
  const bound: Array<{ ref: string; path: string; sha256: string }> = rows.map(([ref, name, value]) => {
    const file = path.join(root, name); fs.writeFileSync(file, value);
    return { ref, path: file, sha256: digest(file) };
  });
  const image = path.join(root, "opening.png"); fs.writeFileSync(image, png);
  bound.push({ ref: "opening", path: image, sha256: digest(image) });
  const evidence = new ResponsesEvidenceTools(bound, root);
  const readiness = () => {
    const missingText = ["candidate", "ocr"].filter(ref => !evidence.fullyRead(ref))
      .map(ref => ({ ref, ...evidence.readProgress(ref) }));
    const missingImages = evidence.inspectedImages.has("opening") ? [] : ["opening"];
    return { ready: !missingText.length && !missingImages.length, missingText, missingImages };
  };
  const overflow = postReviewerContextResponse(evidence.readBundle(["candidate", "ocr"], ["opening"], 5), readiness());
  expect(overflow).toMatchObject({ success: false, error: "RESPONSES_CONTEXT_BUNDLE_TOO_LARGE",
    readiness: { ready: false, missingText: [{ ref: "candidate", nextOffset: 0 }, { ref: "ocr", nextOffset: 0 }],
      missingImages: ["opening"] }, recovery: expect.stringContaining("nextOffset") });
  expect(evidence.readRefs.size).toBe(0);
  expect(evidence.inspectedImages.size).toBe(0);
  const contextTool: SiwcTool = { name: "read_reviewer_context", description: "Read verified reviewer context",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    execute: async () => postReviewerContextResponse(evidence.readBundle(["candidate", "ocr"], ["opening"]), readiness()) };
  const bodies: Array<{ input: Array<{ type?: string; output?: string; content?: Array<{ type: string }> }> }> = [];
  const stream = (output: unknown) => new Response(`data: ${JSON.stringify({ type: "response.completed", response: { output } })}\n\n`,
    { headers: { "content-type": "text/event-stream" } });
  const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "fake" }, tools: () => [contextTool],
    validateOutput: async value => {
      expect(readiness()).toMatchObject({ ready: true, missingText: [], missingImages: [] });
      return value;
    }, fetch: vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      return stream(bodies.length === 1
        ? [{ type: "function_call", name: "read_reviewer_context", call_id: "review-context", arguments: "{}" }]
        : [{ type: "message", content: [{ type: "output_text", text: '{"findings":[]}' }] }]);
    }) as typeof fetch });
  const result = await runner.run({ runId: "r", stepRunId: "s", attemptId: "a", input: {},
    signal: new AbortController().signal, definition: { id: "post-reviewer", revision: "v1", model: "gpt-6-luna",
      reasoningEffort: "medium", promptRevision: "v1", skillsRevision: "none", permissionsRevision: "bound",
      config: { instructions: "Call read_reviewer_context first", outputFormat: "json" } }, emit: async () => {} });
  expect(result.output).toEqual({ findings: [] });
  const receipt = JSON.parse(bodies[1]!.input.find(item => item.type === "function_call_output")!.output!);
  expect(receipt.text.map((item: { ref: string }) => item.ref)).toEqual(["candidate", "ocr"]);
  expect(receipt.text[0].content).toBe('{"claim":"原始内容"}');
  expect(receipt.text[1].content).toBe('{"frames":[{"text":"短字幕"}]}');
  expect(receipt.readiness).toMatchObject({ ready: true, missingText: [], missingImages: [] });
  expect(bodies[1]!.input.at(-1)!.content).toContainEqual(expect.objectContaining({ type: "input_image" }));
});

it("delivers frozen repair context through the official SDK; an over-limit batch records no partial reads", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "responses-repair-context-")); roots.push(root);
  const prior = "prior-report";
  const textRefs = [prior, "repair-review", "post-source-input", "media-preparation", "evidence-pack",
    "probe", "capture-protocol", "targeted-evidence", "ocr-evidence"];
  const imageRefs = ["opening-contact", "targeted-contact", "TARGET-0001"];
  const bound = [...textRefs.map((ref, index) => {
    const file = path.join(root, `${index}.json`);
    fs.writeFileSync(file, JSON.stringify({ ref, conclusion: "冻结原文" }));
    return { ref, path: file, sha256: digest(file) };
  }), ...imageRefs.map((ref, index) => {
    const file = path.join(root, `${index}.png`); fs.writeFileSync(file, png);
    return { ref, path: file, sha256: digest(file) };
  })];
  const evidence = new ResponsesEvidenceTools(bound, root);
  const overview = { protocolActions: [{ id: "ACTION-1", mode: "ocr_review", reason: "Check caption" }],
    manifestActions: [{ id: "ACTION-1", frameIds: ["TARGET-0001"] }],
    frames: [{ id: "TARGET-0001", time: 1, actionId: "ACTION-1" }] };
  const readiness = () => phase2Readiness(evidence, overview, true, prior);
  const overflow = postRepairContextResponse(evidence.readBundle(textRefs, imageRefs.slice(0, 2), 5), readiness());
  expect(overflow).toMatchObject({ success: false, error: "RESPONSES_CONTEXT_BUNDLE_TOO_LARGE",
    readiness: { ready: false, missingText: expect.arrayContaining([
      expect.objectContaining({ ref: "ocr-evidence", nextOffset: 0 })]) },
    recovery: expect.stringContaining("nextOffset") });
  expect(evidence.readRefs.size).toBe(0);
  expect(evidence.inspectedImages.size).toBe(0);
  const contextTool: SiwcTool = { name: "read_repair_context", description: "Read verified repair context",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    execute: async () => postRepairContextResponse(evidence.readBundle(textRefs, imageRefs.slice(0, 2)), readiness()) };
  const bodies: Array<{ input: Array<{ type?: string; output?: string; content?: Array<{ type: string }> }> }> = [];
  const stream = (output: unknown) => new Response(`data: ${JSON.stringify({ type: "response.completed", response: { output } })}\n\n`,
    { headers: { "content-type": "text/event-stream" } });
  const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "fake" },
    tools: () => [...evidence.tools(), contextTool],
    validateOutput: async value => {
      expect(readiness()).toMatchObject({ ready: true, missingText: [], missingImages: [] });
      return value;
    }, fetch: vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      return stream(bodies.length === 1
        ? [{ type: "function_call", name: "read_repair_context", call_id: "repair-context", arguments: "{}" }]
        : bodies.length === 2
          ? [{ type: "function_call", name: "inspect_image", call_id: "target-pixels",
              arguments: '{"ref":"TARGET-0001"}' }]
          : [{ type: "message", content: [{ type: "output_text", text: '{"acceptedDraft":{"draftId":"saved"}}' }] }]);
    }) as typeof fetch });
  const result = await runner.run({ runId: "r", stepRunId: "s", attemptId: "a", input: {},
    signal: new AbortController().signal, definition: { id: "post-repair", revision: "v1", model: "gpt-6-luna",
      reasoningEffort: "medium", promptRevision: "v1", skillsRevision: "none", permissionsRevision: "bound",
      config: { instructions: "Call read_repair_context first", outputFormat: "json" } }, emit: async () => {} });
  expect(result.output).toEqual({ acceptedDraft: { draftId: "saved" } });
  const receipt = JSON.parse(bodies[1]!.input.find(item => item.type === "function_call_output")!.output!);
  expect(receipt.text.map((item: { ref: string }) => item.ref)).toEqual(textRefs);
  expect(receipt.readiness).toMatchObject({ ready: false, missingText: [], missingImages: [
    "inspect_image at least one TARGET frame: TARGET-0001" ] });
  expect(bodies[1]!.input.at(-1)!.content).toContainEqual(expect.objectContaining({ type: "input_image" }));
  expect(readiness()).toMatchObject({ ready: true, missingText: [], missingImages: [] });
});

it("returns exact phase-one draft errors through the real SIWC tool loop before accepting a correction", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "responses-draft-check-")); roots.push(root);
  const probe = fixture("probe.json");
  const protocol = fixture("capture-protocol.json") as {
    schemaVersion: string; probe: string; captureActions: Array<{ consumers?: string[]; presentationIntent?: string }>;
    requiredRelations: Array<{ derivedFrom: string[] }>;
  };
  protocol.schemaVersion = "capture-protocol-2.0";
  for (const action of protocol.captureActions) {
    action.consumers = ["content_restoration"];
    action.presentationIntent = "operation_sequence";
  }
  const first = structuredClone(protocol); first.probe = "SWEEP-001";
  const second = structuredClone(protocol); second.requiredRelations[0]!.derivedFrom = ["CAP-001"];
  const drafts = [first, second, protocol];
  const tool = createProbeProtocolDraftValidator(root,
    path.resolve(".agents/skills/video-content-reconstruction/schemas"), fixture("evidence-pack.json"));
  const bodies: Array<{ input: Array<{ type?: string; output?: string }> }> = [];
  const stream = (output: unknown) => new Response(`data: ${JSON.stringify({ type: "response.completed", response: { output } })}\n\n`,
    { headers: { "content-type": "text/event-stream" } });
  const runner = new OpenAIAgentsSdkRunner({ auth: { accessToken: async () => "fake" }, tools: () => [tool],
    fetch: vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      const turn = bodies.length;
      return turn <= drafts.length ? stream([{ type: "function_call", name: "validate_probe_protocol",
        call_id: `draft-${turn}`, arguments: JSON.stringify({ probe, captureProtocol: drafts[turn - 1] }) }])
        : stream([{ type: "message", content: [{ type: "output_text", text: '{"done":true}' }] }]);
    }) as typeof fetch });
  const events: Array<{ type: string; data?: unknown }> = [];
  await runner.run({ runId: "r", stepRunId: "s", attemptId: "a", input: {}, signal: new AbortController().signal,
    definition: { id: "post-builder", revision: "v1", model: "gpt-6-luna", reasoningEffort: "medium",
      promptRevision: "v1", skillsRevision: "none", permissionsRevision: "bound",
      config: { instructions: "Validate this draft", outputFormat: "json" } },
    emit: async (type, data) => { events.push({ type, data }); } });
  const results = events.filter(event => event.type === "siwc.tool_result").map(event =>
    (event.data as { output: { pass: boolean; errors: Array<{ path: string; message: string }> } }).output);
  expect(results).toHaveLength(3);
  expect(results[0]).toMatchObject({ pass: false, errors: [{ path: "/probe", message: expect.stringContaining("probe.json") }] });
  expect(results[1]).toMatchObject({ pass: false, errors: [{ path: "/requiredRelations/0/derivedFrom/0",
    message: expect.stringContaining("CAP-001") }] });
  expect(results[1]!.errors[0]!.message).toContain("REL-001");
  expect(results[2]).toEqual({ pass: true, errors: [] });
  expect(JSON.parse(bodies[1]!.input.at(-1)!.output!)).toEqual(results[0]);
});

it("accepts the fourth validated SIWC draft without charging a fifth host validation", async () => {
  let providerTurn = 0;
  let draftValidations = 0;
  const acceptedDraft = { draftId: "fourth-draft", sha256: "a".repeat(64) };
  const fullDraft = { probe: { accepted: true }, captureProtocol: { probe: "probe.json" } };
  const stream = (output: unknown) => new Response(`data: ${JSON.stringify({ type: "response.completed",
    response: { output } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  const runner = new ResponsesResearchRunner({} as never, {} as never, {
    auth: { accessToken: async () => "fake" },
    fetch: vi.fn(async () => {
      providerTurn++;
      return providerTurn <= 4
        ? stream([{ type: "function_call", name: "validate_probe_protocol", call_id: `draft-${providerTurn}`,
          arguments: "{}" }])
        : stream([{ type: "message", content: [{ type: "output_text",
          text: JSON.stringify({ acceptedDraft }) }] }]);
    }) as typeof fetch
  }) as unknown as { model: (...args: unknown[]) => Promise<unknown> };
  const validationTool = { name: "validate_probe_protocol", description: "Validate the probe draft",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ pass: ++draftValidations <= 4, ...acceptedDraft }) };
  const validate = async (value: unknown) => {
    const row = value as Record<string, unknown>;
    if (row.acceptedDraft) {
      expect(row.acceptedDraft).toEqual(acceptedDraft);
      expect(draftValidations).toBe(4);
      return fullDraft;
    }
    const result = await validationTool.execute();
    if (!result.pass) throw new Error("DRAFT_VALIDATION_CALL_LIMIT");
    return row;
  };
  const request = { runId: "run", stepRunId: "step", attemptId: "attempt", input: {},
    signal: new AbortController().signal,
    definition: { id: "post-builder", revision: "v11", model: "gpt-6-sol", reasoningEffort: "medium",
      promptRevision: "v1", skillsRevision: "none", permissionsRevision: "bound", config: {} },
    emit: async () => {} };
  const tools = { tools: () => [], list: () => [] };
  expect(await runner.model(request, "post-builder", tools, "", validate, [validationTool]))
    .toEqual(fullDraft);
  expect(draftValidations).toBe(4);
  expect(providerTurn).toBe(5);
});

it("keeps a fail-closed output check for injected fake model runners", async () => {
  const runner = new ResponsesResearchRunner({} as never, {} as never, {
    createModelRunner: () => ({ run: async () => ({ output: { unchecked: true } }) }) as never
  }) as unknown as { model: (...args: unknown[]) => Promise<unknown> };
  const request = { runId: "run", stepRunId: "step", attemptId: "attempt", input: {},
    signal: new AbortController().signal,
    definition: { id: "post-builder", revision: "v11", model: "gpt-6-luna", reasoningEffort: "medium",
      promptRevision: "v1", skillsRevision: "none", permissionsRevision: "bound", config: {} },
    emit: async () => {} };
  await expect(runner.model(request, "post-builder", { tools: () => [], list: () => [] }, "",
    () => { throw new Error("FAKE_OUTPUT_REJECTED"); }))
    .rejects.toThrow("FAKE_OUTPUT_REJECTED");
});

it("dispatches canonical creator synthesis agent definitions", async () => {
  const config = { model: "gpt-6-luna", reasoningEffort: "medium", prompt: "fixture", promptRevision: "v1",
    skillSnapshotsRevision: "none", permissionsRevision: "bound", config: {} };
  const agents = createResearchAgentDefinitions({ postSourceChecker: config, postBuilder: config,
    postReviewer: config, postRepair: config, postEvaluationRepair: config,
    creatorBuilder: config, creatorReviewer: config, creatorRepair: config });
  const runner = new ResponsesResearchRunner({} as never, {} as never);
  for (const definition of [agents.creatorBuilder, agents.creatorReviewer, agents.creatorRepair]) {
    const request = { runId: "workflow", stepRunId: "step", attemptId: "attempt", input: {},
      signal: new AbortController().signal, definition, emit: async () => {} };
    await expect(runner.run(request as never)).rejects.toThrow(
      definition.id.endsWith("builder") ? "RESPONSES_FROZEN_INPUT_REQUIRED" : "RESPONSES_CANDIDATE_REQUIRED");
  }
});
function completeReconstruction(): Record<string, unknown> {
  const result = fixture("reconstruction.json");
  const lenses = fixture("builder-lenses-v2.json") as { directingLogic: Record<string, unknown>; visualEditing: Record<string, unknown> };
  const surface = (state: string, ref: string | null) => ({ state, sourceRef: ref, audience: null,
    promise: null, tension: null, specificity: null, searchTerms: null, composition: null,
    typeHierarchy: null, smallSizeReadability: null, evidenceRefs: ref ? [ref] : [], unknowns: ["fixture"] });
  lenses.directingLogic.packagingAnalysis = { title: surface("available", "POST-TITLE"),
    cover: surface("missing", null), firstFrame: surface("available", "TARGET-0001"),
    fulfillment: [], unknowns: ["fixture"] };
  lenses.visualEditing.openingAnalysis = { duration: 10, inspectionBasis: "fixture frames",
    segments: [{ id: "OPEN-1", timeRange: { start: 0, end: 10 }, boundaryReason: "fixture",
      spokenWords: "先打开设置，然后得到结果", burnedCaptions: "未知", composition: "单画面",
      motion: "未知", audioRole: "未知", evidenceArrival: "开头", viewerQuestion: "如何开始",
      meaningChange: "知道步骤", alignmentStatus: "uncertain", evidenceRefs: ["CUE-001"],
      frameRefs: Array.from({ length: 10 }, (_, index) => `OPEN-SYNTH-${String(index + 1).padStart(2, "0")}`),
      unknowns: ["fixture"] }], unknowns: ["fixture"] };
  return { ...result, schemaVersion: "video-reconstruction-2.0", depthContractVersion: "single-post-depth@1",
    builderLenses: lenses };
}
function finalSummaryFor(candidateDir: string): Record<string, unknown> {
  const frozen = JSON.parse(fs.readFileSync(path.join(candidateDir, "post-source-input.json"), "utf8")) as {
    facts: { capturedAt: string | null; publishedLabel: string | null;
      metrics: Record<"likes" | "collections" | "comments" | "shares", number | null> } };
  return { conclusion: "从内容、编导和画面看，先交代问题再显示操作结果。",
    contentSynthesis: "内容保留了作者说明的操作条件与可见结果。",
    directingSynthesis: "编导先给问题，再用操作过程回答。",
    editingSynthesis: "画面以步骤和状态变化维持理解。",
    reusableLessons: [{ lesson: "先交代问题", conditions: "教学型短视频", action: "用真实操作镜头回答问题",
      evidenceRefs: ["TARGET-0001"] }], limits: ["单片证据不能证明普遍效果。"],
    performance: { observedAt: frozen.facts.capturedAt, publishedLabel: frozen.facts.publishedLabel,
      observedMetrics: (["likes", "collections", "comments", "shares"] as const).map(metric =>
        ({ metric, value: frozen.facts.metrics[metric] })),
      interpretation: "仅报告冻结时的互动数，不把片中口述数字当作品表现。", comparison: null,
      limitations: ["未取得播放与完播数据，也没有可比样本。"], evidenceRefs: ["POST-SOURCE-FACTS"] } };
}
function frozenSourceRegistrations() {
  return [
    { id: "POST-TITLE", path: "post-source-input.json", kind: "post_title",
      producedBy: "source-freeze", timeRange: { start: 0, end: 0 }, limitations: [] },
    { id: "POST-SOURCE-FACTS", path: "post-source-input.json", kind: "post_source_facts",
      producedBy: "source-freeze", timeRange: { start: 0, end: 0 }, limitations: [] }
  ];
}

it("runs probe, host capture, reconstruction, independent review and bounded repair in order", async () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "responses-post-runner-")); roots.push(runtime);
  const previous = process.env.SELF_MEDIA_RUNTIME_DIR; process.env.SELF_MEDIA_RUNTIME_DIR = runtime;
  try {
    const creatorRunId = crypto.randomUUID();
    const runDir = path.join(runtime, "runs", creatorRunId); fs.mkdirSync(runDir, { recursive: true });
    const sourceRef = artifactRef(creatorRunId, "source.mp4");
    const coverRef = artifactRef(creatorRunId, "cover.jpg");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=0.1",
      "-frames:v", "1", "-y", path.join(runDir, "cover.jpg")]);
    const jpeg = fs.readFileSync(path.join(runDir, "cover.jpg"));
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=10",
      "-c:v", "mpeg4", "-y", path.join(runDir, "source.mp4")]);
    for (const [name, data] of Object.entries({ "detail.json": { posts: [{ externalId: "p1", title: "标题" }] },
      "manifest.json": { items: [{ externalId: "p1", coverState: "ready", coverArtifactRef: coverRef }] },
      "selection.json": { items: [] } })) fs.writeFileSync(path.join(runDir, name), JSON.stringify(data));
    const source = { creatorRunId, postExternalId: "p1", sourceUrl: "https://example.com/p1",
      sourceMediaArtifactRef: sourceRef, detailArtifactRef: artifactRef(creatorRunId, "detail.json"),
      mediaManifestArtifactRef: artifactRef(creatorRunId, "manifest.json"),
      selectionArtifactRef: artifactRef(creatorRunId, "selection.json"), reconstructionBatchArtifactRef: artifactRef(creatorRunId, "batch.json") };
    const frozen: ArtifactRef = { id: "frozen", revision: "1", sha256: "frozen", type: "post-evidence", schemaVersion: "v1",
      uri: "memory", producedBy: { workflowRunId: "w", stepRunId: "s", attemptId: "a" }, dependsOn: [],
      validation: "valid", review: "not_applicable" };
    const payloads = new Map<string, unknown>([[frozen.id, { kind: "post", executor: "responses", source, files: [], methods: [] }]]);
    const refs = new Map<string, ArtifactRef>([[frozen.id, frozen]]);
    const store = { getArtifact: async (id: string) => refs.get(id), getArtifactPayload: async (id: string) => payloads.get(id) };
    const managedLinks = new Map<string, string>();
    const artifacts = { write: async (runId: string, name: string, value: unknown) => {
      const file = path.join(runtime, "runs", runId, name); fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(value)); return artifactRef(runId, name);
    }, verifyManagedMediaLink: async (reference: string, filename: string) =>
      artifactPath(reference) === filename && fs.lstatSync(filename).isSymbolicLink()
      && managedLinks.get(reference) === fs.realpathSync(filename) };
    const phases: string[] = [];
    const repairBodies: Array<{ input: Array<{ role?: string; content?: unknown; type?: string }> }> = [];
    const repairEvents: string[] = [];
    let preparationCalls = 0;
    const runner = new ResponsesResearchRunner(store as never, artifacts as never, {
      auth: { accessToken: async () => "fake" },
      prepareMedia: async ({ videoPath, outputDir }) => {
        preparationCalls++;
        const evidenceDir = path.join(outputDir, "evidence"); fs.mkdirSync(evidenceDir, { recursive: true });
        const pack = fixture("evidence-pack.json") as { frameIndex: Array<{ id: string; frame: string; time: number }> };
        for (let index = 0; index < 10; index += 1) pack.frameIndex.push({
          id: `OPEN-SYNTH-${String(index + 1).padStart(2, "0")}`,
          frame: `frames/opening/open-synth-${String(index + 1).padStart(2, "0")}.jpg`, time: index + 0.5
        });
        pack.frameIndex.push({ id: "OPEN-0021", frame: "frames/opening/open-0021.jpg", time: 10 });
        fs.writeFileSync(path.join(evidenceDir, "evidence-pack.json"), JSON.stringify(pack));
        for (const frame of pack.frameIndex) {
          const file = path.join(evidenceDir, frame.frame);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, png);
        }
        fs.writeFileSync(path.join(evidenceDir, "opening-contact.jpg"), jpeg);
        const manifest = { sourceMedia: { fingerprint: digest(videoPath) },
          transcript: { path: null, fingerprint: null },
          evidencePack: { path: path.join(evidenceDir, "evidence-pack.json"), fingerprint: digest(path.join(evidenceDir, "evidence-pack.json")) } };
        fs.writeFileSync(path.join(outputDir, "media-preparation.json"), JSON.stringify(manifest));
        return manifest as never;
      },
      validateIntegrity: candidateDir => {
        const report = JSON.parse(fs.readFileSync(path.join(candidateDir, "reconstruction.json"), "utf8")) as {
          metaGate: { pass: boolean; overlookedRelationships: string[] };
        };
        if (report.metaGate.pass !== true || report.metaGate.overlookedRelationships.length) {
          throw new Error("BUILDER_INTEGRITY_META_GATE");
        }
        return { passed: true } as never;
      },
      createModelRunner: options => { expect(options.enforceJsonObject).toBe(true); new OpenAIAgentsSdkRunner(options); return { run: async request => {
        const instruction = String(request.definition.config?.instructions);
        const role = request.definition.id;
        const tools = await options.tools!({} as never);
        if (role === "post-builder") expect(options.finishOnPassingDraftTools).toEqual(instruction.includes("PHASE 1/2")
          ? ["validate_probe_protocol", "revise_validated_draft"]
          : ["validate_reconstruction_draft", "revise_validated_draft"]);
        else expect(options.finishOnPassingDraftTools).toBeUndefined();
        if (role === "post-reviewer") expect(tools.some(tool => tool.name === "capture_frame")).toBe(false);
        if (role === "post-builder") expect(tools.some(tool => tool.name === "capture_frame")).toBe(true);
        const read = async (ref: string, offset = 0, length = 32768) => tools.find(tool => tool.name === "read_evidence")!
          .execute({ ref, offset, length }, request.signal);
        const image = async (ref: string) => tools.find(tool => tool.name === "inspect_image")!.execute({ ref }, request.signal);
        if (role === "post-reviewer") {
          phases.push("review");
          const input = request.input as { candidate: ArtifactRef };
          const candidate = payloads.get(input.candidate.id) as { reportArtifactRef: string; reportSha256: string };
          expect(instruction).toContain("researchReviewReceiptSchema");
          expect(instruction).toContain("captureActions");
          expect(instruction).toContain("TARGET-0001");
          expect(instruction).toContain("Call read_reviewer_context with {} once");
          const context = tools.find(tool => tool.name === "read_reviewer_context")!;
          const result = await context.execute({}, request.signal) as { kind: string; value: {
            text: Array<{ ref: string; deliveredCharacters: number; sourceCharacters: number }>;
            imageRefs: Array<{ ref: string }>;
            readiness: { missingText: unknown[]; missingImages: unknown[] }; semanticCoverage: string } };
          expect(result.kind).toBe("siwc_visual_tool_result");
          expect(result.value.text.map(item => item.ref)).toEqual(expect.arrayContaining([
            candidate.reportArtifactRef, "post-source-input.json", "probe.json", "capture-protocol.json",
            "evidence/evidence-pack.json", "targeted-evidence/targeted-evidence.json"]));
          expect(result.value.text.every(item => item.deliveredCharacters <= item.sourceCharacters)).toBe(true);
          expect(result.value.semanticCoverage).toBe("not_evaluated");
          expect(result.value.imageRefs.map(item => item.ref)).toContain("post-cover.jpg");
          expect(result.value.readiness.missingText).toEqual([]);
          expect(result.value.readiness.missingImages).toEqual([]);
          await image("TARGET-0001");
          const receipt = { schemaVersion: "research-review@1", kind: "post", candidate: input.candidate,
            candidateReportSha256: candidate.reportSha256, summary: "有一处待修", findings: [{ id: "F1", location: "/scopeStatement",
              issue: "需要补足", evidenceRefs: ["TARGET-0001"], suggestedChange: "补述状态", priority: "major", kind: "content" }] };
          await tools.find(tool => tool.name === "compare_review_finding")!.execute({ finding: receipt.findings[0]! }, request.signal);
          return { output: receipt } as never;
        }
        if (instruction.includes("PHASE 1/2")) {
          phases.push(role + ":probe");
          expect(tools.some(tool => tool.name === "check_probe_evidence_readiness")).toBe(true);
          for (const ref of ["post-source-input", "media-preparation"]) await read(ref);
          await read("evidence-pack", 0, 8);
          await image("opening-contact"); await image("post-cover"); await image("FRAME-CUE-001");
          if (role === "post-repair") {
            const prior = payloads.get((request.input as { candidate: ArtifactRef }).candidate.id) as { reportArtifactRef: string };
            await read(prior.reportArtifactRef); await read("repair-review");
          }
          const protocol = fixture("capture-protocol.json") as { schemaVersion: string; captureActions: Array<{
            mode: string; times: number[]; range: { start: number; end: number }; consumers?: string[]; presentationIntent?: string
          }> };
          protocol.schemaVersion = "capture-protocol-2.0";
          protocol.captureActions[0]!.times = [0.5, 1.5, 2.5, 3.5, 4.5];
          protocol.captureActions[1]!.times = [5, 5.5, 6.5, 7.5, 8.5, 9.5];
          for (const action of protocol.captureActions) { action.mode = "exact_times"; action.consumers = ["content_restoration"]; action.presentationIntent = "operation_sequence"; }
          const missingProtocol = { ...protocol } as Record<string, unknown>;
          delete missingProtocol.probe;
          const invalid = await tools.find(tool => tool.name === "validate_probe_protocol")!.execute({
            probe: fixture("probe.json"), captureProtocol: role === "post-repair"
              ? { ...protocol, probe: "SWEEP-001" } : missingProtocol } as never, request.signal) as {
              pass: boolean; draftId: string; sha256: string };
          expect(invalid).toMatchObject({ pass: false, draftId: expect.any(String), sha256: expect.any(String) });
          const staged = await tools.find(tool => tool.name === "revise_validated_draft")!.execute({
            draftId: invalid.draftId, sha256: invalid.sha256,
            patches: [{ op: role === "post-repair" ? "replace" : "add", path: "/captureProtocol/probe", value: "probe.json" }] } as never, request.signal) as {
              pass: boolean; draftId: string; sha256: string };
          expect(staged).toMatchObject({ pass: true, draftId: expect.any(String), sha256: expect.any(String) });
          const receipt = { acceptedDraft: { draftId: staged.draftId, sha256: staged.sha256 } };
          const readiness = tools.find(tool => tool.name === "check_probe_evidence_readiness")!;
          const before = await readiness.execute({}, request.signal) as {
            ready: boolean; missingText: Array<{ ref: string; nextOffset: number }>; missingImages: string[];
          };
          expect(before.ready).toBe(false);
          expect(before.missingText.find(item => item.ref === "evidence-pack")?.nextOffset).toBe(8);
          expect(before.missingImages).toEqual([]);
          let unreadError: unknown;
          try { await options.validateOutput!(receipt, request); } catch (error) { unreadError = error; }
          expect(String(unreadError)).toContain("evidence-pack read_evidence offset=8");
          const feedback = await options.outputValidationFeedback!(unreadError, request);
          expect(feedback).toContain("same passing acceptedDraft receipt");
          expect(feedback).toContain("Do not rerun validate_probe_protocol");
          const context = tools.find(tool => tool.name === "read_builder_context")!;
          const batch = await context.execute({}, request.signal) as { value: {
            text: Array<{ ref: string; content: string }>; readiness: { ready: boolean };
          } };
          expect(batch.value.text.map(item => item.ref)).toEqual(["post-source-input", "media-preparation", "evidence-pack"]);
          expect(batch.value.readiness.ready).toBe(true);
          expect(await readiness.execute({}, request.signal)).toMatchObject({ ready: true, missingText: [], missingImages: [] });
          expect(await options.validateOutput!(receipt, request)).toMatchObject({ probe: expect.any(Object), captureProtocol: expect.any(Object) });
          return { output: receipt } as never;
        }
        expect(instruction).toContain(role === "post-builder" ? "Call read_builder_context with {} once"
          : "Call read_repair_context with {} once");
        phases.push(role + ":reconstruction");
        const readiness = tools.find(tool => tool.name === "check_evidence_readiness")!;
        const before = await readiness.execute({}, request.signal) as { ready: boolean; missingText: Array<{ ref: string; nextOffset: number }>;
          missingImages: string[] };
        expect(before.ready).toBe(false);
        expect(before.missingImages).toEqual(expect.arrayContaining([
          "inspect_image opening-contact", "inspect_image post-cover"]));
        expect(before.missingText.find(item => item.ref === "evidence-pack")?.nextOffset).toBe(0);
        if (role === "post-repair") {
          const patch = tools.find(tool => tool.name === "validate_reconstruction_patch")!;
          const prior = payloads.get((request.input as { candidate: ArtifactRef }).candidate.id) as {
            report: { scopeStatement: string }; reportArtifactRef: string };
          const original = digest(artifactPath(prior.reportArtifactRef));
          const premature = await patch.execute({ patches: [{ op: "replace", path: "/scopeStatement",
            value: `${prior.report.scopeStatement} 修订` }], revisionResponse: [
            { id: "F1", status: "changed", reason: "已补状态" }] } as never, request.signal) as {
              pass: boolean; errors: string[]; draftId?: string; readiness: { missingText: Array<{ ref: string }> } };
          expect(premature).toMatchObject({ pass: false, errors: expect.arrayContaining([
            expect.stringContaining("RESPONSES_REPAIR_UNREAD: evidence-pack read_evidence offset=0")]) });
          expect(premature.draftId).toBeUndefined();
          expect(premature.readiness.missingText.map(item => item.ref)).toContain("repair-review");
          expect(digest(artifactPath(prior.reportArtifactRef))).toBe(original);
        }
        for (const ref of ["post-source-input", "media-preparation", "evidence-pack", "probe",
          "capture-protocol", "targeted-evidence"]) await read(ref);
        if (role === "post-repair") {
          const prior = payloads.get((request.input as { candidate: ArtifactRef }).candidate.id) as { reportArtifactRef: string };
          await read(prior.reportArtifactRef); await read("repair-review");
        }
        await image("targeted-contact"); await image("TARGET-0001");
        const withoutSourceImages = await readiness.execute({}, request.signal) as { ready: boolean; missingImages: string[] };
        expect(withoutSourceImages.ready).toBe(false);
        expect(withoutSourceImages.missingImages).toEqual(expect.arrayContaining([
          "inspect_image opening-contact", "inspect_image post-cover"]));
        let finalGateError: unknown;
        try { await options.validateOutput!({ reconstruction: completeReconstruction(), revisionResponse: [] }, request); }
        catch (error) { finalGateError = error; }
        expect(String(finalGateError)).toMatch(/RESPONSES_(?:PHASE2|REPAIR)_VISUAL_UNREAD/);
        expect(String(finalGateError)).toContain("inspect_image opening-contact");
        expect(String(finalGateError)).toContain("inspect_image post-cover");
        if (role === "post-repair") {
          const context = tools.find(tool => tool.name === "read_repair_context")!;
          expect(instruction).toContain("Call read_repair_context with {} once");
          const batch = await context.execute({}, request.signal) as { value: {
            text: Array<{ ref: string }>; readiness: { ready: boolean } } };
          expect(batch.value.text.map(item => item.ref)).toContain("evidence-pack");
          expect(batch.value.text.map(item => item.ref)).toContain("repair-review");
          expect(batch.value.readiness.ready).toBe(true);
        } else { await image("opening-contact"); await image("post-cover"); }
        expect(await readiness.execute({}, request.signal)).toMatchObject({ ready: true, missingText: [], missingImages: [] });
        const draftTool = tools.find(tool => tool.name === "validate_reconstruction_draft")!;
        const candidateDir = path.join(runDir, "workflow-responses", request.runId, request.attemptId);
        if (role === "post-builder") {
          expect(instruction).not.toContain("Canonical reconstruction index schema");
          expect(instruction).toContain("useLatestBuilderLenses:true");
          expect(instruction).toContain("revise_builder_lens");
          expect(instruction).toContain("Preserve all unpatched lens content exactly");
          expect(instruction).not.toContain("If you revise a lens, stage the revised value");
          expect(draftTool.parameters).toMatchObject({ properties: { builderLensDrafts: { type: "object" } } });
          expect(tools.find(tool => tool.name === "get_builder_lens_schema")).toBeUndefined();
          const context = tools.find(tool => tool.name === "read_builder_context")!;
          const contextResult = await context.execute({}, request.signal) as { value: {
            builderLensSchemas: Record<string, Record<string, unknown>>; reconstructionIndexSchema: Record<string, unknown>;
            readiness: { ready: boolean; missingText: unknown[]; missingImages: string[] };
          } };
          expect(Object.keys(contextResult.value.builderLensSchemas)).toEqual([
            "contentRestoration", "directingLogic", "visualEditing"]);
          expect(contextResult.value.reconstructionIndexSchema).not.toHaveProperty("builderLenses");
          expect(contextResult.value.reconstructionIndexSchema).not.toHaveProperty("transcript");
          expect(contextResult.value.reconstructionIndexSchema).toMatchObject({ required:
            expect.arrayContaining(["summaryContractVersion"]) });
          expect((contextResult.value as unknown as { finalSummarySchema: Record<string, unknown> }).finalSummarySchema)
            .toMatchObject({ type: "object", required: expect.arrayContaining(["performance", "conclusion"]) });
          expect(contextResult.value.reconstructionIndexSchema).toMatchObject({ additionalProperties: false });
          expect(contextResult.value.readiness).toMatchObject({ ready: true, missingText: [], missingImages: [] });
          const stageLens = tools.find(tool => tool.name === "stage_builder_lens")!;
          const reviseLens = tools.find(tool => tool.name === "revise_builder_lens")!;
          expect(reviseLens.parameters).toMatchObject({ properties: { patches: { maxItems: 64 } } });
          const toolParameters = draftTool.parameters as { properties: { reconstruction: {
            required: string[]; properties: Record<string, unknown>; additionalProperties: boolean;
          } } };
          expect(toolParameters.properties.reconstruction.properties).not.toHaveProperty("transcript");
          expect(toolParameters.properties.reconstruction.required).not.toContain("transcript");
          expect(toolParameters.properties.reconstruction.additionalProperties).toBe(false);
          const lenses = (completeReconstruction().builderLenses as Record<string, unknown>);
          const targetedFrames = JSON.parse(fs.readFileSync(path.join(candidateDir, "targeted-evidence/targeted-evidence.json"), "utf8")) as {
            frames: Array<{ id: string }>;
          };
          const sourceFrames = JSON.parse(fs.readFileSync(path.join(candidateDir, "evidence/evidence-pack.json"), "utf8")) as {
            frameIndex: Array<{ id: string; time: number }>;
          };
          const correctedVisual = structuredClone(lenses.visualEditing) as {
            openingAnalysis: { segments: Array<Record<string, unknown> & { frameRefs: string[] }> };
          };
          correctedVisual.openingAnalysis.segments[0]!.frameRefs = sourceFrames.frameIndex
            .filter(frame => frame.time < 10).map(frame => frame.id);
          lenses.visualEditing = correctedVisual;
          const copiedCoverLens = structuredClone(lenses.directingLogic) as {
            packagingAnalysis: { cover: Record<string, unknown> };
          };
          Object.assign(copiedCoverLens.packagingAnalysis.cover,
            { state: "available", sourceRef: "post-cover.webp", evidenceRefs: ["post-cover"] });
          const rejectedCover = await stageLens.execute({ slot: "directingLogic", value: copiedCoverLens } as never,
            request.signal) as { pass: boolean; errors: string[] };
          expect(rejectedCover.pass).toBe(false);
          expect(rejectedCover.errors.join("; ")).toContain('packagingAnalysis.cover.sourceRef received="post-cover.webp" required="POST-COVER"');
          expect(rejectedCover.errors.join("; ")).toContain("revise_builder_lens slot=directingLogic useLatest:true");
          expect(rejectedCover.errors.join("; ")).not.toContain("derivedSources missing");
          const handles: Record<string, { draftId: string; sha256: string }> = {};
          for (const slot of ["contentRestoration", "directingLogic", "visualEditing"] as const) {
            const schema = contextResult.value.builderLensSchemas[slot]!;
            expect(JSON.stringify(schema)).not.toContain('"builderLenses"');
            const receipt = await stageLens.execute({ slot, value: lenses[slot] } as never, request.signal) as {
              slot: string; draftId: string; sha256: string; pass: boolean; errors: unknown[] };
            expect(receipt).toMatchObject({ slot, pass: true, errors: [], draftId: expect.any(String), sha256: expect.any(String) });
            expect(receipt).not.toHaveProperty("value");
            handles[slot] = { draftId: receipt.draftId, sha256: receipt.sha256 };
          }
          const content = structuredClone(lenses.contentRestoration) as { blocks: Array<Record<string, unknown>> };
          const brokenBlock: Record<string, unknown> = { ...content.blocks[0]!, id: "B3", type: "frame_strip" };
          delete brokenBlock.visuals; delete brokenBlock.frameRefs; delete brokenBlock.beforeFrameRef;
          delete brokenBlock.afterFrameRef; delete brokenBlock.steps;
          content.blocks.push(brokenBlock);
          const rejectedBlock = await stageLens.execute({ slot: "contentRestoration", value: content } as never, request.signal) as {
            pass: boolean; errors: string[]; draftId: string; sha256: string;
          };
          expect(rejectedBlock.pass).toBe(false);
          expect(rejectedBlock.errors.join("; ")).toContain("blocks[1](B3) has no visuals, frameRefs");
          const badPointer = await reviseLens.execute({ slot: "contentRestoration", draftId: rejectedBlock.draftId,
            sha256: rejectedBlock.sha256,
            patches: [{ op: "replace", path: "/contentRestoration/blocks/9/frameRefs", value: [] }] } as never, request.signal) as {
              pass: boolean; draftId: string; sha256: string; errors: string[] };
          expect(badPointer).toMatchObject({ pass: false, draftId: rejectedBlock.draftId, sha256: rejectedBlock.sha256,
            errors: ["RECONSTRUCTION_PATCH_ARRAY_INDEX_INVALID"] });
          const stillMissing = await reviseLens.execute({ slot: "contentRestoration", draftId: rejectedBlock.draftId,
            sha256: rejectedBlock.sha256,
            patches: [{ op: "replace", path: "/contentRestoration/blocks/1", value: brokenBlock }]
          } as never, request.signal) as { pass: boolean; draftId: string; sha256: string; errors: string[] };
          expect(stillMissing.pass).toBe(false);
          expect(stillMissing.draftId).not.toBe(rejectedBlock.draftId);
          expect(stillMissing.errors.join("; ")).toContain("blocks[1](B3) has no visuals");
          const correctedContent = await reviseLens.execute({ slot: "contentRestoration", draftId: stillMissing.draftId,
            sha256: stillMissing.sha256,
            patches: [{ op: "replace", path: "/contentRestoration/blocks/1",
              value: { ...brokenBlock, frameRefs: [targetedFrames.frames[0]!.id] } }]
          } as never, request.signal) as {
            pass: boolean; draftId: string; sha256: string;
          };
          expect(correctedContent.pass).toBe(true);
          brokenBlock.frameRefs = [targetedFrames.frames[0]!.id];
          lenses.contentRestoration = content;
          handles.contentRestoration = { draftId: correctedContent.draftId, sha256: correctedContent.sha256 };

          const brokenVisual = structuredClone(correctedVisual);
          brokenVisual.openingAnalysis.segments[0]!.id = "O3";
          brokenVisual.openingAnalysis.segments[0]!.timeRange = { start: 4.667, end: 9.7 };
          brokenVisual.openingAnalysis.segments[0]!.frameRefs = [...sourceFrames.frameIndex
            .filter(frame => frame.time < 10).map(frame => frame.id), "OPEN-0021"];
          const rejectedOpening = await stageLens.execute({ slot: "visualEditing", value: brokenVisual } as never, request.signal) as {
            pass: boolean; errors: string[]; draftId: string; sha256: string;
          };
          expect(rejectedOpening.pass).toBe(false);
          expect(rejectedOpening.errors.join("; ")).toContain('invalid frame="OPEN-0021" time=10 segment=O3 range=[4.667,9.7]');
          const badOpeningHandles = { ...handles, visualEditing: { draftId: rejectedOpening.draftId, sha256: rejectedOpening.sha256 } };
          const index = { ...completeReconstruction(), summaryContractVersion: "single-post-summary@1" } as Record<string, unknown>;
          delete index.builderLenses;
          delete index.transcript;
          index.derivedSources = frozenSourceRegistrations();
          const finalSummary = finalSummaryFor(candidateDir);
          const failedFinal = await draftTool.execute({
            reconstruction: index,
            builderLensDrafts: badOpeningHandles, finalSummary
          } as never, request.signal) as { pass: boolean; errors: string[] };
          expect(failedFinal.pass).toBe(false);
          expect(failedFinal.errors.join("; ")).toContain("VALIDATED_DRAFT_NOT_VALID");
          const failedLatest = await draftTool.execute({ reconstruction: index, useLatestBuilderLenses: true,
            finalSummary } as never,
            request.signal) as { pass: boolean; errors: string[] };
          expect(failedLatest).toMatchObject({ pass: false, errors: [expect.stringContaining("VALIDATED_DRAFT_NOT_VALID")] });
          const ambiguous = await draftTool.execute({ reconstruction: index, useLatestBuilderLenses: true,
            builderLensDrafts: handles, finalSummary } as never, request.signal) as { pass: boolean; errors: string[] };
          expect(ambiguous).toMatchObject({ pass: false, errors: [expect.stringContaining("HANDLE_SELECTION_AMBIGUOUS")] });
          const correctedOpening = await reviseLens.execute({ slot: "visualEditing", useLatest: true,
            patches: [
              { op: "replace", path: "/visualEditing/openingAnalysis/segments/0/id",
                value: correctedVisual.openingAnalysis.segments[0]!.id },
              { op: "replace", path: "/visualEditing/openingAnalysis/segments/0/timeRange", value: { start: 0, end: 10 } },
              { op: "replace", path: "/visualEditing/openingAnalysis/segments/0/frameRefs",
                value: correctedVisual.openingAnalysis.segments[0]!.frameRefs }
            ] } as never, request.signal) as {
            pass: boolean; draftId: string; sha256: string;
          };
          expect(correctedOpening.pass).toBe(true);
          correctedVisual.openingAnalysis.segments[0]!.timeRange = { start: 0, end: 10 };
          brokenVisual.openingAnalysis.segments[0]!.frameRefs = correctedVisual.openingAnalysis.segments[0]!.frameRefs;
          lenses.visualEditing = correctedVisual;
          handles.visualEditing = { draftId: correctedOpening.draftId, sha256: correctedOpening.sha256 };
          const rejectedModelTranscript = await draftTool.execute({
            reconstruction: { ...index, transcript: { origin: "model-override", cues: [] } }, builderLensDrafts: handles,
            finalSummary
          } as never, request.signal) as { pass: boolean; errors: string[] };
          expect(rejectedModelTranscript.pass).toBe(false);
          expect(rejectedModelTranscript.errors.join("; ")).toContain("BUILDER_LENS_INDEX_HOST_FIELD_PRESENT:transcript");
          const noSummary = await draftTool.execute({ reconstruction: index, useLatestBuilderLenses: true } as never,
            request.signal) as { pass: boolean; errors: string[] };
          expect(noSummary).toMatchObject({ pass: false,
            errors: [expect.stringContaining("BUILDER_LENS_FINAL_SUMMARY_REQUIRED")] });
          const wrongSummary = structuredClone(finalSummary) as { performance: {
            observedMetrics: Array<{ metric: string; value: number | null }> } };
          wrongSummary.performance.observedMetrics[0]!.value = 999_999;
          const wrongFacts = await draftTool.execute({ reconstruction: index, useLatestBuilderLenses: true,
            finalSummary: wrongSummary } as never, request.signal) as { pass: boolean; errors: string[] };
          expect(wrongFacts.pass).toBe(false);
          expect(wrongFacts.errors.join("; ")).toContain("RESPONSES_FINAL_SUMMARY_SOURCE_FACTS");
          expect(wrongFacts.errors.join("; ")).toMatch(/field=\/performance\/observedMetrics\/likes\/value frozenExpected=(?:\d+|null) received=999999/u);
          const passing = await draftTool.execute({ reconstruction: index, useLatestBuilderLenses: true,
            finalSummary } as never, request.signal) as {
            pass: boolean; draftId: string; sha256: string; errors?: string[]; builderLensDraftsUsed: unknown };
          expect(passing).toMatchObject({ pass: true, draftId: expect.any(String), sha256: expect.any(String) });
          expect(passing.builderLensDraftsUsed).toEqual(handles);
          const accepted = await options.validateOutput!({ acceptedDraft: { draftId: passing.draftId, sha256: passing.sha256 } }, request) as {
            reconstruction: { builderLenses: unknown; transcript: unknown } };
          expect(accepted.reconstruction.builderLenses).toEqual({ ...lenses, finalSummary });
          const frozenPack = JSON.parse(fs.readFileSync(path.join(candidateDir, "evidence/evidence-pack.json"), "utf8")) as {
            transcript: { origin?: string; cues: Array<Record<string, unknown>> };
          };
          expect(accepted.reconstruction.transcript).toEqual({
            origin: frozenPack.transcript.origin?.trim() ? frozenPack.transcript.origin : "frozen_evidence_pack",
            cues: frozenPack.transcript.cues.map(({ id, start, end, text, representativeFrame, overlappingShots }) =>
              ({ id, start, end, text, representativeFrame, overlappingShots }))
          });
        }
        const beforeProbe = digest(path.join(candidateDir, "probe.json"));
        const productionReport = path.join(candidateDir, "reconstruction.json");
        const beforeReport = fs.existsSync(productionReport) ? digest(productionReport) : null;
        const unfinished = completeReconstruction() as { metaGate: { overlookedRelationships: string[] } };
        unfinished.metaGate.overlookedRelationships = ["已检查但尚不确定的关系"];
        if (role === "post-builder") {
          Object.assign(unfinished, { summaryContractVersion: "single-post-summary@1" });
          Object.assign((unfinished as unknown as { builderLenses: Record<string, unknown> }).builderLenses,
            { finalSummary: finalSummaryFor(candidateDir) });
          (unfinished as unknown as Record<string, unknown>).transcript = { origin: "model-override", cues: [] };
          delete ((unfinished as unknown as { coverageMatrix: Record<string, unknown> }).coverageMatrix).uncheckedChannels;
        }
        const incompleteReceipt = await draftTool.execute({ reconstruction: unfinished } as never, request.signal) as {
          pass: boolean; errors: string[]; draftId: string; sha256: string };
        expect(incompleteReceipt).toMatchObject({
          pass: false, errors: expect.arrayContaining([role === "post-builder"
            ? "SCHEMA /coverageMatrix 'uncheckedChannels' is a required property"
            : "BUILDER_INTEGRITY_META_GATE"]),
          draftId: expect.any(String), sha256: expect.any(String) });
        expect(digest(path.join(candidateDir, "probe.json"))).toBe(beforeProbe);
        expect(fs.existsSync(productionReport) ? digest(productionReport) : null).toBe(beforeReport);
        expect(fs.existsSync(path.join(candidateDir, "phase2-validation/candidate"))).toBe(false);
        const scratch = JSON.parse(fs.readFileSync(path.join(candidateDir,
          "phase2-validation/reconstruction.json"), "utf8")) as { metaGate: { overlookedRelationships: string[] }; transcript: unknown };
        expect(scratch.metaGate.overlookedRelationships).toEqual(["已检查但尚不确定的关系"]);
        const frozenPack = JSON.parse(fs.readFileSync(path.join(candidateDir, "evidence/evidence-pack.json"), "utf8")) as {
          transcript: { origin?: string; cues: Array<Record<string, unknown>> };
        };
        if (role === "post-builder") {
          expect(scratch.transcript).toEqual({
            origin: frozenPack.transcript.origin?.trim() ? frozenPack.transcript.origin : "frozen_evidence_pack",
            cues: frozenPack.transcript.cues.map(({ id, start, end, text, representativeFrame, overlappingShots }) =>
              ({ id, start, end, text, representativeFrame, overlappingShots }))
          });
        } else expect(scratch.transcript).toEqual((completeReconstruction() as { transcript: unknown }).transcript);
        if (role === "post-repair") {
          if (request.attemptId === "attempt-7") {
            const patchTool = tools.find(tool => tool.name === "validate_reconstruction_patch")!;
            const prior = payloads.get((request.input as { candidate: ArtifactRef }).candidate.id) as {
              report: { scopeStatement: string } };
            const incompletePatch = await patchTool.execute({ patches: [{ op: "replace", path: "/scopeStatement",
              value: `${prior.report.scopeStatement} 修订` }], revisionResponse: [
                { id: "WRONG", status: "changed", reason: "已补状态" }] } as never, request.signal) as {
                  pass: boolean; draftId: string; sha256: string };
            expect(incompletePatch).toMatchObject({ pass: false, draftId: expect.any(String), sha256: expect.any(String) });
            const revise = tools.find(tool => tool.name === "revise_validated_draft")!;
            const originalScope = prior.report.scopeStatement;
            expect(await revise.execute({ draftId: incompletePatch.draftId, sha256: incompletePatch.sha256,
              patches: [{ op: "replace", path: "/reconstruction/transcript", value: "forbidden" }] } as never,
            request.signal)).toMatchObject({ pass: false,
              errors: ["RECONSTRUCTION_PATCH_ROOT_NOT_ALLOWED"] });
            expect(prior.report.scopeStatement).toBe(originalScope);
            const staged = await revise.execute({ draftId: incompletePatch.draftId, sha256: incompletePatch.sha256,
              patches: [{ op: "replace", path: "/revisionResponse/0/id", value: "F1" }] } as never, request.signal) as {
                  pass: boolean; draftId: string; sha256: string };
            expect(staged).toEqual({ pass: true, draftId: expect.any(String), sha256: expect.any(String), errors: [] });
            return { output: { acceptedDraft: { draftId: staged.draftId, sha256: staged.sha256 } } } as never;
          }
          expect(instruction).toContain("Canonical revisionResponse required fields");
          expect(instruction).toContain('"required":["id","status","reason"]');
          expect(instruction).toContain("findingId cannot substitute for it");
          const prior = payloads.get((request.input as { candidate: ArtifactRef }).candidate.id) as {
            report: Record<string, unknown> };
          const response = (valid: boolean) => ({ reconstruction: structuredClone(prior.report), revisionResponse: valid
            ? [{ id: "F1", status: "changed", reason: "已补状态", evidenceRefs: ["TARGET-0001"] }]
            : [{ findingId: "F1", status: "changed", reason: "已补状态" }] });
          const stream = (value: unknown) => new Response(`data: ${JSON.stringify({ type: "response.completed",
            response: { output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }] } })}\n\n`,
            { headers: { "content-type": "text/event-stream" } });
          const actual = new OpenAIAgentsSdkRunner({ ...options, fetch: vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
            repairBodies.push(JSON.parse(init!.body as string));
            return stream(response(repairBodies.length > 1));
          }) as typeof fetch });
          return await actual.run(request) as never;
        }
        const staged = await tools.find(tool => tool.name === "revise_validated_draft")!.execute({
          draftId: incompleteReceipt.draftId, sha256: incompleteReceipt.sha256,
          patches: [
            { op: "replace", path: "/metaGate/overlookedRelationships", value: [] },
            { op: "add", path: "/coverageMatrix/uncheckedChannels", value: [] },
            { op: "replace", path: "/derivedSources", value: frozenSourceRegistrations() },
          ] } as never, request.signal) as {
          pass: boolean; draftId: string; sha256: string };
        if (!staged.pass) throw new Error(`Unexpected fixture validation failure: ${JSON.stringify(staged)}`);
        expect(staged).toMatchObject({ pass: true, draftId: expect.any(String), sha256: expect.any(String) });
        const patchTool = tools.find(tool => tool.name === "revise_validated_draft")!;
        expect(patchTool.description).toContain("Allowed report roots:");
        expect(patchTool.description).toContain("derivedSources");
        let wrongHandle: unknown;
        try { await options.validateOutput!({ acceptedDraft: { draftId: staged.draftId, sha256: "0".repeat(64) } }, request); }
        catch (error) { wrongHandle = error; }
        expect(String(wrongHandle)).toContain("RESPONSES_POST_DRAFT_REFERENCE_INVALID");
        expect(await options.outputValidationFeedback!(wrongHandle, request)).toContain("exact draftId and sha256");
        return { output: { acceptedDraft: { draftId: staged.draftId, sha256: staged.sha256 } } } as never;
      } }; }
    });
    const request = (id: string, input: unknown, index: number): AgentRunRequest<unknown> => ({
      runId: "workflow", stepRunId: id, attemptId: `attempt-${index}`, input, signal: new AbortController().signal,
      definition: { id, revision: "v1", model: "gpt-6-luna", reasoningEffort: "medium", promptRevision: "v1",
        skillsRevision: "none", permissionsRevision: "bound" }, emit: async () => {} });
    const buildEvents: string[] = [];
    const phase1DraftStages: unknown[] = [];
    const buildRequest = request("post-builder", { evidence: frozen }, 1);
    buildRequest.emit = async (type, data) => {
      buildEvents.push(type);
      if (type === "responses.draft_staged" && (data as { phase?: string } | undefined)?.phase === "post-probe") {
        phase1DraftStages.push(data);
      }
    };
    const build = (await runner.run(buildRequest)).output as { artifact: unknown };
    expect(buildEvents).toContain("responses.draft_staged");
    expect(buildEvents).toContain("responses.draft_accepted");
    expect(phase1DraftStages).toHaveLength(2);
    const original = build.artifact as { reportArtifactRef: string; reportSha256: string; relativeRoot: string };
    expect((build.artifact as { report: { derivedSources: Array<{ id: string; path: string }> } }).report.derivedSources)
      .toContainEqual(expect.objectContaining({ id: "POST-TITLE", path: "post-source-input.json" }));
    const originalTarget = path.join(runDir, original.relativeRoot, "targeted-evidence/targeted-evidence.json");
    const originalTargetSha = digest(originalTarget);
    const hydratedImage = path.join(runDir, original.relativeRoot, "evidence/opening-contact.jpg");
    const managedImage = path.join(runtime, "managed-opening-contact.jpg");
    fs.copyFileSync(hydratedImage, managedImage);
    fs.rmSync(hydratedImage);
    fs.symlinkSync(managedImage, hydratedImage);
    managedLinks.set(artifactRef(creatorRunId, path.relative(runDir, hydratedImage).split(path.sep).join("/")),
      fs.realpathSync(managedImage));
    expect((build.artifact as { report: { builderLenses: unknown } }).report.builderLenses)
      .toEqual({ ...completeReconstruction().builderLenses as Record<string, unknown>,
        finalSummary: finalSummaryFor(path.join(runDir, original.relativeRoot)) });
    const candidate1: ArtifactRef = { ...frozen, id: "candidate-1", revision: "1", sha256: "candidate-1" };
    refs.set(candidate1.id, candidate1); payloads.set(candidate1.id, build.artifact);
    const review = (await runner.run(request("post-reviewer", { candidate: candidate1 }, 2))).output as { artifact: unknown };
    const reviewRef: ArtifactRef = { ...frozen, id: "review-1", revision: "1", sha256: "review-1" };
    refs.set(reviewRef.id, reviewRef); payloads.set(reviewRef.id, review.artifact);
    const repairRequest = request("post-repair", { candidate: candidate1, review: reviewRef }, 3);
    repairRequest.emit = async type => { repairEvents.push(type); };
    const repair = (await runner.run(repairRequest)).output as { artifact: { revisionResponse: unknown[] } };
    expect(repair.artifact.revisionResponse).toEqual([{ id: "F1", status: "changed", reason: "已补状态",
      evidenceRefs: ["TARGET-0001"] }]);
    expect(repairBodies).toHaveLength(2);
    expect(repairEvents).toContain("siwc.validation_failed");
    expect(JSON.stringify(repairBodies[1]!.input)).toContain("findingId");
    expect(repairBodies[1]!.input.some(item => item.role === "user" &&
      String(item.content).includes("findingId cannot substitute for id"))).toBe(true);
    expect(preparationCalls).toBe(1);
    expect(digest(originalTarget)).toBe(originalTargetSha);
    expect(digest(artifactPath(original.reportArtifactRef))).toBe(original.reportSha256);
    expect(digest(path.join(runDir, "workflow-responses/workflow/attempt-3/targeted-evidence/targeted-evidence.json")))
      .toBe(originalTargetSha);
    expect(fs.lstatSync(path.join(runDir, "workflow-responses/workflow/attempt-3/evidence/opening-contact.jpg")).isFile()).toBe(true);
    assertIngestableTree(path.join(runDir, "workflow-responses/workflow/attempt-3"));
    const patchedRepairRequest = request("post-repair", { candidate: candidate1, review: reviewRef }, 7);
    const patchedEvents: string[] = [];
    patchedRepairRequest.emit = async type => { patchedEvents.push(type); };
    const patchedRepair = (await runner.run(patchedRepairRequest)).output as { artifact: { report: { scopeStatement: string } } };
    expect(patchedRepair.artifact.report.scopeStatement).toContain(" 修订");
    expect(patchedEvents).toContain("responses.draft_patched");
    expect(patchedEvents).toContain("responses.draft_accepted");
    expect(phases).toEqual(["post-builder:probe", "post-builder:reconstruction", "review",
      "post-repair:reconstruction", "post-repair:reconstruction"]);
    payloads.set(frozen.id, { kind: "post", executor: "responses", source, files: [], methods: [],
      reuseCandidate: { artifactRef: original.reportArtifactRef, sha256: original.reportSha256 } });
    const reuseEvents: string[] = [];
    const reuseRequest = request("post-builder", { evidence: frozen }, 4);
    reuseRequest.emit = async type => { reuseEvents.push(type); };
    const reused = (await runner.run(reuseRequest)).output as { artifact: { report: unknown; evidence: ArtifactRef } };
    expect(reused.artifact.report).toEqual((build.artifact as { report: unknown }).report);
    expect(reused.artifact.evidence).toEqual(frozen);
    expect(fs.lstatSync(path.join(runDir, "workflow-responses/workflow/attempt-4/evidence/opening-contact.jpg")).isFile()).toBe(true);
    assertIngestableTree(path.join(runDir, "workflow-responses/workflow/attempt-4"));
    expect(reuseEvents).toContain("responses.candidate_reused");
    expect(preparationCalls).toBe(1);
    expect(phases).toHaveLength(5);
    const unknownMedia = path.join(runtime, "unknown-opening-contact.jpg");
    fs.copyFileSync(managedImage, unknownMedia);
    fs.rmSync(hydratedImage);
    fs.symlinkSync(unknownMedia, hydratedImage);
    await expect(runner.run(request("post-builder", { evidence: frozen }, 5)))
      .rejects.toThrow("RESPONSES_PRESERVED_CANDIDATE_UNVERIFIED_MEDIA");
    const orphan = artifactRef(creatorRunId, "orphan/orphan.json");
    fs.mkdirSync(path.join(runDir, "orphan"));
    fs.writeFileSync(path.join(runDir, "orphan/orphan.json"), JSON.stringify({ schemaVersion: "video-reconstruction-2.0" }));
    payloads.set(frozen.id, { kind: "post", executor: "responses", source, files: [], methods: [],
      reuseCandidate: { artifactRef: orphan, sha256: digest(path.join(runDir, "orphan/orphan.json")) } });
    await expect(runner.run(request("post-builder", { evidence: frozen }, 6)))
      .rejects.toThrow("RESPONSES_PRESERVED_CANDIDATE_INCOMPLETE");
  } finally { if (previous === undefined) delete process.env.SELF_MEDIA_RUNTIME_DIR; else process.env.SELF_MEDIA_RUNTIME_DIR = previous; }
}, 30_000);

it("rechecks a cover/identity conflict from fresh context without carrying the first verdict", async () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "responses-source-rounds-")); roots.push(runtime);
  const previous = process.env.SELF_MEDIA_RUNTIME_DIR; process.env.SELF_MEDIA_RUNTIME_DIR = runtime;
  try {
    const creatorRunId = crypto.randomUUID();
    const runDir = path.join(runtime, "runs", creatorRunId); fs.mkdirSync(runDir, { recursive: true });
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=10",
      "-c:v", "mpeg4", "-y", path.join(runDir, "source.mp4")]);
    const coverRef = artifactRef(creatorRunId, "cover.png"); fs.writeFileSync(path.join(runDir, "cover.png"), png);
    fs.writeFileSync(path.join(runDir, "detail.json"), JSON.stringify({ posts: [{ externalId: "p1", title: "封面主张" }] }));
    fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify({ items: [{ externalId: "p1",
      coverState: "ready", coverArtifactRef: coverRef }] }));
    fs.writeFileSync(path.join(runDir, "selection.json"), JSON.stringify({ items: [] }));
    const source = { creatorRunId, postExternalId: "p1", sourceUrl: "https://example.com/p1",
      sourceMediaArtifactRef: artifactRef(creatorRunId, "source.mp4"), detailArtifactRef: artifactRef(creatorRunId, "detail.json"),
      mediaManifestArtifactRef: artifactRef(creatorRunId, "manifest.json"), selectionArtifactRef: artifactRef(creatorRunId, "selection.json") };
    const frozen: ArtifactRef = { id: "source-frozen", revision: "1", sha256: "source-frozen", type: "post-evidence", schemaVersion: "v1",
      uri: "memory", producedBy: { workflowRunId: "w", stepRunId: "s", attemptId: "a" }, dependsOn: [],
      validation: "valid", review: "not_applicable" };
    const rounds: string[] = [];
    const runner = new ResponsesResearchRunner({ getArtifact: async () => frozen,
      getArtifactPayload: async () => ({ kind: "post", executor: "responses", source, files: [], methods: [] }) } as never,
    { write: async () => "unused" } as never, { auth: { accessToken: async () => "fake" },
      createModelRunner: options => { expect(options.enforceJsonObject).toBe(true); new OpenAIAgentsSdkRunner(options); return { run: async request => {
        const instructions = String(request.definition.config?.instructions);
        const round = instructions.includes("ROUND 1/2") ? 1 : 2;
        rounds.push(`round-${round}`);
        const imageList = instructions.match(/inspect each image in (\[[^\]]+\])/);
        expect(imageList).toBeTruthy();
        const images = JSON.parse(imageList![1]!) as string[];
        if (round === 2) {
          expect(instructions).not.toContain("first-round verdict: conflict");
          expect(instructions).not.toContain("frames/sample-1.jpg");
          expect(images.some(ref => ref.startsWith("contact-sheets/"))).toBe(true);
        }
        const tools = await options.tools!({} as never);
        for (const ref of ["post-source-input.json", `source-consistency-input-round-${round}.json`]) {
          await tools.find(tool => tool.name === "read_evidence")!.execute({ ref }, request.signal);
        }
        for (const ref of images.slice(0, round === 1 ? -1 : undefined)) {
          await tools.find(tool => tool.name === "inspect_image")!.execute({ ref }, request.signal);
        }
        const output = round === 1 ? { schemaVersion: "post-source-consistency@2", verdict: "conflict",
          summary: "封面与初查帧有疑点", comparisons: [
            { postClaim: "来源身份", bearing: "identity", relation: "contradicts",
              evidenceRefs: ["post-cover.png", "frames/sample-1.jpg", `source-consistency-input-round-${round}.json`], reason: "初查疑点" },
            { postClaim: "局部说明", bearing: "claim_detail", relation: "contradicts",
              evidenceRefs: ["post-cover.png"], reason: "文字细节不同" }] }
          : { schemaVersion: "post-source-consistency@2", verdict: "consistent", summary: "新时间上下文支持来源身份",
            comparisons: [
              { postClaim: "来源身份", bearing: "identity", relation: "supports",
                evidenceRefs: ["contact-sheets/sheet-1.jpg"], reason: "连续上下文可匹配" },
              { postClaim: "局部说明", bearing: "claim_detail", relation: "contradicts",
                evidenceRefs: ["post-cover.png"], reason: "细节仍不一致，不改变身份结论" }] } as never;
        let correctedOutput: unknown = output;
        if (round === 1) {
          let unread: unknown;
          try { await options.validateOutput!(output, request); } catch (error) { unread = error; }
          expect(String(unread)).toContain("RESPONSES_SOURCE_ROUND_EVIDENCE_UNREAD");
          const feedback = await options.outputValidationFeedback!(unread, request);
          expect(feedback).toContain(`inspect_image ${images.at(-1)}`);
          await tools.find(tool => tool.name === "inspect_image")!.execute({ ref: images.at(-1)! }, request.signal);
          let wrapperRejected: unknown;
          try { await options.validateOutput!(output, request); } catch (error) { wrapperRejected = error; }
          expect(String(wrapperRejected)).toContain("RESPONSES_SOURCE_EVIDENCE_NOT_INSPECTED");
          expect(String(wrapperRejected)).toContain(`source-consistency-input-round-${round}.json`);
          const wrapperFeedback = await options.outputValidationFeedback!(wrapperRejected, request);
          expect(wrapperFeedback).toContain("allowed=post-source-input.json,post-cover.png,frames/sample-1.jpg");
          const corrected = structuredClone(output) as { comparisons: Array<{ evidenceRefs: string[] }> };
          corrected.comparisons[0]!.evidenceRefs = corrected.comparisons[0]!.evidenceRefs
            .filter(ref => ref !== `source-consistency-input-round-${round}.json`);
          expect(await options.validateOutput!(corrected, request)).toMatchObject({ verdict: "conflict" });
          correctedOutput = corrected;
        }
        return { output: correctedOutput } as never;
      } }; } });
    const result = (await runner.run({ runId: "workflow", stepRunId: "source", attemptId: "attempt", input: { evidence: frozen },
      signal: new AbortController().signal, definition: { id: "post-source-checker", revision: "v1", model: "gpt-6-luna",
        reasoningEffort: "medium", promptRevision: "v1", skillsRevision: "none", permissionsRevision: "bound" },
      emit: async () => {} })).output as { artifact: { verdict: string; comparisons: Array<{ bearing: string; relation: string; evidenceRefs: string[] }> } };
    expect(rounds).toEqual(["round-1", "round-2"]);
    expect(result.artifact.verdict).toBe("consistent");
    expect(result.artifact.comparisons.map(item => [item.bearing, item.relation])).toEqual([
      ["identity", "supports"], ["claim_detail", "contradicts"]]);
    expect(result.artifact.comparisons[0]?.evidenceRefs[0]).toContain("contact-sheets/sheet-1.jpg");
  } finally { if (previous === undefined) delete process.env.SELF_MEDIA_RUNTIME_DIR; else process.env.SELF_MEDIA_RUNTIME_DIR = previous; }
});
