import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentRunRequest, ArtifactRef } from "@signal-room/workflow";
import { OpenAIAgentsSdkRunner } from "@signal-room/workflow-agent-sdk";
import { artifactPath, artifactRef } from "../core/artifacts.js";
import { createResearchAgentDefinitions } from "../../../research/src/workflows/agents.js";
import { createProbeProtocolDraftValidator, ResponsesResearchRunner } from "./responses-research-runner.js";

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
      frameRefs: ["TARGET-0001"], unknowns: ["fixture"] }], unknowns: ["fixture"] };
  return { ...result, schemaVersion: "video-reconstruction-2.0", depthContractVersion: "single-post-depth@1",
    builderLenses: lenses };
}

it("runs probe, host capture, reconstruction, independent review and bounded repair in order", async () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "responses-post-runner-")); roots.push(runtime);
  const previous = process.env.SELF_MEDIA_RUNTIME_DIR; process.env.SELF_MEDIA_RUNTIME_DIR = runtime;
  try {
    const creatorRunId = crypto.randomUUID();
    const runDir = path.join(runtime, "runs", creatorRunId); fs.mkdirSync(runDir, { recursive: true });
    const sourceRef = artifactRef(creatorRunId, "source.mp4");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:d=10",
      "-c:v", "mpeg4", "-y", path.join(runDir, "source.mp4")]);
    for (const [name, data] of Object.entries({ "detail.json": { posts: [{ externalId: "p1", title: "标题" }] },
      "manifest.json": { items: [] }, "selection.json": { items: [] } })) fs.writeFileSync(path.join(runDir, name), JSON.stringify(data));
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
        const pack = fixture("evidence-pack.json") as { frameIndex: Array<{ frame: string }> };
        fs.writeFileSync(path.join(evidenceDir, "evidence-pack.json"), JSON.stringify(pack));
        for (const frame of pack.frameIndex) {
          const file = path.join(evidenceDir, frame.frame);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, png);
        }
        fs.writeFileSync(path.join(evidenceDir, "opening-contact.jpg"), png);
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
          for (const ref of [candidate.reportArtifactRef, "post-source-input.json", "evidence/evidence-pack.json",
            "targeted-evidence/targeted-evidence.json"]) await read(ref);
          await image("TARGET-0001");
          return { output: { schemaVersion: "research-review@1", kind: "post", candidate: input.candidate,
            candidateReportSha256: candidate.reportSha256, summary: "有一处待修", findings: [{ id: "F1", location: "/scopeStatement",
              issue: "需要补足", evidenceRefs: ["TARGET-0001"], suggestedChange: "补述状态", priority: "major", kind: "content" }] } } as never;
        }
        if (instruction.includes("PHASE 1/2")) {
          phases.push(role + ":probe");
          expect(instruction).toContain("check_probe_evidence_readiness");
          for (const ref of ["post-source-input", "media-preparation"]) await read(ref);
          await read("evidence-pack", 0, 8);
          await image("opening-contact"); await image("FRAME-CUE-001");
          if (role === "post-repair") {
            const prior = payloads.get((request.input as { candidate: ArtifactRef }).candidate.id) as { reportArtifactRef: string };
            await read(prior.reportArtifactRef); await read("repair-review");
          }
          const protocol = fixture("capture-protocol.json") as { schemaVersion: string; captureActions: Array<{ mode: string; consumers?: string[]; presentationIntent?: string }> };
          protocol.schemaVersion = "capture-protocol-2.0";
          for (const action of protocol.captureActions) { action.mode = "exact_times"; action.consumers = ["content_restoration"]; action.presentationIntent = "operation_sequence"; }
          const invalid = await tools.find(tool => tool.name === "validate_probe_protocol")!.execute({
            probe: fixture("probe.json"), captureProtocol: { ...protocol, probe: "SWEEP-001" } } as never, request.signal) as {
              pass: boolean; draftId: string; sha256: string };
          expect(invalid).toMatchObject({ pass: false, draftId: expect.any(String), sha256: expect.any(String) });
          const staged = await tools.find(tool => tool.name === "revise_validated_draft")!.execute({
            draftId: invalid.draftId, sha256: invalid.sha256,
            patches: [{ op: "replace", path: "/captureProtocol/probe", value: "probe.json" }] } as never, request.signal) as {
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
          await read("evidence-pack", before.missingText.find(item => item.ref === "evidence-pack")!.nextOffset);
          expect(await readiness.execute({}, request.signal)).toMatchObject({ ready: true, missingText: [], missingImages: [] });
          expect(await options.validateOutput!(receipt, request)).toMatchObject({ probe: expect.any(Object), captureProtocol: expect.any(Object) });
          return { output: receipt } as never;
        }
        phases.push(role + ":reconstruction");
        const readiness = tools.find(tool => tool.name === "check_evidence_readiness")!;
        const before = await readiness.execute({}, request.signal) as { ready: boolean; missingText: Array<{ ref: string; nextOffset: number }> };
        expect(before.ready).toBe(false);
        expect(before.missingText.find(item => item.ref === "evidence-pack")?.nextOffset).toBe(0);
        for (const ref of ["post-source-input", "media-preparation", "evidence-pack", "probe",
          "capture-protocol", "targeted-evidence"]) await read(ref);
        if (role === "post-repair") {
          const prior = payloads.get((request.input as { candidate: ArtifactRef }).candidate.id) as { reportArtifactRef: string };
          await read(prior.reportArtifactRef); await read("repair-review");
        }
        await image("targeted-contact"); await image("TARGET-0001");
        expect(await readiness.execute({}, request.signal)).toMatchObject({ ready: true,
          missingText: [], missingImages: [] });
        const draftTool = tools.find(tool => tool.name === "validate_reconstruction_draft")!;
        const candidateDir = path.join(runDir, "workflow-responses", request.runId, request.attemptId);
        const beforeProbe = digest(path.join(candidateDir, "probe.json"));
        const productionReport = path.join(candidateDir, "reconstruction.json");
        const beforeReport = fs.existsSync(productionReport) ? digest(productionReport) : null;
        const unfinished = completeReconstruction() as { metaGate: { overlookedRelationships: string[] } };
        unfinished.metaGate.overlookedRelationships = ["已检查但尚不确定的关系"];
        const incompleteReceipt = await draftTool.execute({ reconstruction: unfinished } as never, request.signal) as {
          pass: boolean; errors: string[]; draftId: string; sha256: string };
        expect(incompleteReceipt).toMatchObject({
          pass: false, errors: expect.arrayContaining(["BUILDER_INTEGRITY_META_GATE"]),
          draftId: expect.any(String), sha256: expect.any(String) });
        expect(digest(path.join(candidateDir, "probe.json"))).toBe(beforeProbe);
        expect(fs.existsSync(productionReport) ? digest(productionReport) : null).toBe(beforeReport);
        expect(fs.existsSync(path.join(candidateDir, "phase2-validation/candidate"))).toBe(false);
        const scratch = JSON.parse(fs.readFileSync(path.join(candidateDir,
          "phase2-validation/reconstruction.json"), "utf8")) as { metaGate: { overlookedRelationships: string[] } };
        expect(scratch.metaGate.overlookedRelationships).toEqual(["已检查但尚不确定的关系"]);
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
          const response = (valid: boolean) => ({ reconstruction: completeReconstruction(), revisionResponse: valid
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
            { op: "replace", path: "/derivedSources", value: [{ id: "POST-TITLE", path: "post-source-input.json",
              kind: "post_title", producedBy: "source-freeze", timeRange: { start: 0, end: 0 }, limitations: [] }] },
          ] } as never, request.signal) as {
          pass: boolean; draftId: string; sha256: string };
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
      .toEqual(completeReconstruction().builderLenses);
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
}, 15_000);

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
        for (const ref of images) await tools.find(tool => tool.name === "inspect_image")!.execute({ ref }, request.signal);
        return { output: round === 1 ? { schemaVersion: "post-source-consistency@2", verdict: "conflict",
          summary: "封面与初查帧有疑点", comparisons: [
            { postClaim: "来源身份", bearing: "identity", relation: "contradicts",
              evidenceRefs: ["post-cover.png", "frames/sample-1.jpg"], reason: "初查疑点" },
            { postClaim: "局部说明", bearing: "claim_detail", relation: "contradicts",
              evidenceRefs: ["post-cover.png"], reason: "文字细节不同" }] }
          : { schemaVersion: "post-source-consistency@2", verdict: "consistent", summary: "新时间上下文支持来源身份",
            comparisons: [
              { postClaim: "来源身份", bearing: "identity", relation: "supports",
                evidenceRefs: ["contact-sheets/sheet-1.jpg"], reason: "连续上下文可匹配" },
              { postClaim: "局部说明", bearing: "claim_detail", relation: "contradicts",
                evidenceRefs: ["post-cover.png"], reason: "细节仍不一致，不改变身份结论" }] } } as never;
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
