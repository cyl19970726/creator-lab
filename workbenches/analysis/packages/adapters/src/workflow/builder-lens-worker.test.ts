import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { SiwcTool, SiwcVisualToolResult } from "@signal-room/workflow-agent-sdk";
import { writeIsolatedBuilderLens } from "./builder-lens-worker.js";
import { ResponsesEvidenceTools } from "./responses-tools.js";
import type { BuilderLensSlot } from "./builder-lens-drafts.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const withSourceReceipt = <T>(value: T) => ({ slot: "contentRestoration" as const, value,
  receipt: { draftId: "accepted-cr", sha256: sha(Buffer.from(`${JSON.stringify(JSON.parse(JSON.stringify(value)))}\n`)) } });
const schemaPath = path.resolve(".agents/skills/video-content-reconstruction/schemas/reconstruction.schema.json");
const signal = new AbortController().signal;

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "builder-lens-worker-")); roots.push(root);
  const source = Buffer.from('{"post":"observed"}\n');
  const pixel = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c636000020000050001a5f645400000000049454e44ae426082", "hex");
  const sourcePath = path.join(root, "source.json");
  const imagePath = path.join(root, "frame.png");
  fs.writeFileSync(sourcePath, source);
  fs.writeFileSync(imagePath, pixel);
  const parentTools = new ResponsesEvidenceTools([
    { ref: "source", path: sourcePath, sha256: sha(source) },
    { ref: "frame", path: imagePath, sha256: sha(pixel) },
  ], root);
  return { root, parentTools };
}

function runOptions(base: ReturnType<typeof fixture>, slot: BuilderLensSlot,
  model: Parameters<typeof writeIsolatedBuilderLens>[0]["model"]) {
  return {
    slot, directory: path.join(base.root, slot), schemaPath, parentTools: base.parentTools,
    textRefs: ["source"], overviewRefs: ["frame"], prioritizedImageRefs: ["frame"],
    readiness: (tools: ResponsesEvidenceTools) => ({
      ready: tools.fullyRead("source") && tools.inspectedImages.has("frame"),
      missingText: tools.fullyRead("source") ? [] : ["source"],
      missingImages: tools.inspectedImages.has("frame") ? [] : ["frame"],
    }),
    evidenceTools: () => [] as SiwcTool[],
    validateLens: async (_slot: BuilderLensSlot, value: unknown) => {
      const pass = typeof (value as { body?: unknown })?.body === "string";
      return { pass, errors: pass ? [] : ["body is required"] };
    },
    model, emit: vi.fn(async () => {}),
  };
}

function named(tools: readonly SiwcTool[], name: string): SiwcTool {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

function handle(value: unknown): { draftId: string; sha256: string } {
  const row = value as { draftId: string; sha256: string; pass: boolean; errors: unknown[] };
  expect(row.pass).toBe(true);
  expect(row.errors).toEqual([]);
  expect(row.draftId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(row.sha256).toMatch(/^[0-9a-f]{64}$/i);
  return { draftId: row.draftId, sha256: row.sha256 };
}

it("uses independent pixel observations and draft receipts for concurrent lens calls", async () => {
  const base = fixture();
  const seen = new Map<BuilderLensSlot, ResponsesEvidenceTools>();
  const validators = new Map<BuilderLensSlot, (value: unknown) => unknown>();
  const makeModel = (slot: BuilderLensSlot): Parameters<typeof writeIsolatedBuilderLens>[0]["model"] =>
    async (tools, _instructions, validate, extra, _feedback, finish) => {
      seen.set(slot, tools);
      validators.set(slot, validate);
      expect(finish).toEqual(["stage_builder_lens", "revise_builder_lens"]);
      const stage = named(extra, "stage_builder_lens");
      const premature = await stage.execute({ slot, value: { body: "valid schema alone" } }, signal);
      expect(premature).toMatchObject({ pass: false, errors: ["BUILDER_LENS_UNREAD_EVIDENCE"] });
      expect(premature).not.toHaveProperty("draftId");
      const context = await named(extra, "read_builder_context").execute({}, signal) as SiwcVisualToolResult;
      expect(context.kind).toBe("siwc_visual_tool_result");
      expect(context.images).toHaveLength(1);
      expect(context.images[0]?.base64).toBeTruthy();
      const receipt = handle(await stage.execute({ slot, value: { body: `original ${slot}` } }, signal));
      return validate({ acceptedDraft: receipt });
    };
  const [content, directing] = await Promise.all([
    writeIsolatedBuilderLens(runOptions(base, "contentRestoration", makeModel("contentRestoration"))),
    writeIsolatedBuilderLens(runOptions(base, "directingLogic", makeModel("directingLogic"))),
  ]);
  expect(content.value).toEqual({ body: "original contentRestoration" });
  expect(directing.value).toEqual({ body: "original directingLogic" });
  expect(content.receipt).not.toEqual(directing.receipt);
  expect(() => validators.get("directingLogic")!({ acceptedDraft: content.receipt }))
    .toThrow("BUILDER_LENS_HANDLE_NOT_LATEST:directingLogic");
  expect(() => validators.get("contentRestoration")!({ acceptedDraft: directing.receipt }))
    .toThrow("BUILDER_LENS_HANDLE_NOT_LATEST:contentRestoration");
  expect(seen.get("contentRestoration")).not.toBe(seen.get("directingLogic"));
  expect(base.parentTools.inspectedImages.size).toBe(0);
  expect(base.parentTools.readRefs.size).toBe(0);
});

it("rejects cross-slot stage and revision even when the other slot has a valid receipt", async () => {
  const base = fixture();
  await writeIsolatedBuilderLens(runOptions(base, "visualEditing", async (_tools, _prompt, validate, extra) => {
    await named(extra, "read_builder_context").execute({}, signal);
    await expect(named(extra, "stage_builder_lens").execute({ slot: "directingLogic", value: { body: "wrong" } }, signal))
      .rejects.toThrow("BUILDER_LENS_CROSS_BRANCH_WRITE");
    const receipt = handle(await named(extra, "stage_builder_lens").execute({ slot: "visualEditing", value: { body: "right" } }, signal));
    await expect(named(extra, "revise_builder_lens").execute({ slot: "directingLogic", useLatest: true,
      patches: [{ op: "replace", path: "/directingLogic/body", value: "wrong" }] }, signal))
      .rejects.toThrow("BUILDER_LENS_CROSS_BRANCH_WRITE");
    return validate({ acceptedDraft: receipt });
  }));
});

it("keeps untouched prose during a local patch and returns only a passing staged value and receipt", async () => {
  const base = fixture();
  const stable = `observed sequence ${"keep ".repeat(3000)}`;
  const result = await writeIsolatedBuilderLens(runOptions(base, "contentRestoration", async (_tools, _prompt, validate, extra) => {
    await named(extra, "read_builder_context").execute({}, signal);
    const stage = named(extra, "stage_builder_lens");
    const first = await stage.execute({ slot: "contentRestoration", value: { body: "draft", stable, nested: { note: "unaltered" } } }, signal);
    const initial = handle(first);
    const revised = await named(extra, "revise_builder_lens").execute({ slot: "contentRestoration", useLatest: true,
      patches: [{ op: "replace", path: "/contentRestoration/body", value: "corrected" }] }, signal);
    const final = handle(revised);
    expect(final).not.toEqual(initial);
    return validate({ acceptedDraft: final });
  }));
  expect(result.value).toEqual({ body: "corrected", stable, nested: { note: "unaltered" } });
  expect(result.receipt.sha256).toMatch(/^[0-9a-f]{64}$/i);
});

it("returns C2's missing replace path as feedback, then accepts the corrected add without losing the draft", async () => {
  const base = fixture();
  const options = runOptions(base, "visualEditing", async (_tools, _prompt, validate, extra) => {
    await named(extra, "read_builder_context").execute({}, signal);
    const stage = named(extra, "stage_builder_lens");
    const first = await stage.execute({ slot: "visualEditing", value: {
      body: "preserve this prose", transitions: [{}, {}],
    } }, signal) as { draftId: string; sha256: string; pass: boolean; errors: string[] };
    expect(first.pass).toBe(false);
    expect(first.errors).toContain("openingAnalysis and transitions[1].function are required");
    const revise = named(extra, "revise_builder_lens");
    const rejected = await revise.execute({ slot: "visualEditing", useLatest: true, patches: [
      { op: "add", path: "/visualEditing/openingAnalysis", value: { note: "observed opening" } },
      { op: "replace", path: "/visualEditing/transitions/1/function", value: "cut" },
    ] }, signal);
    expect(rejected).toMatchObject({ slot: "visualEditing", draftId: first.draftId, sha256: first.sha256,
      pass: false, errors: ["RECONSTRUCTION_PATCH_PATH_MISSING"] });
    const malformed = await revise.execute({ slot: "visualEditing", useLatest: true,
      patches: [{ op: "replace", path: "visualEditing/body", value: "wrong" }] }, signal);
    expect(malformed).toMatchObject({ draftId: first.draftId, sha256: first.sha256,
      pass: false, errors: ["RECONSTRUCTION_PATCH_PATH_INVALID"] });
    const final = handle(await revise.execute({ slot: "visualEditing", useLatest: true, patches: [
      { op: "add", path: "/visualEditing/openingAnalysis", value: { note: "observed opening" } },
      { op: "add", path: "/visualEditing/transitions/1/function", value: "cut" },
    ] }, signal));
    expect(final.draftId).not.toBe(first.draftId);
    return validate({ acceptedDraft: final });
  });
  options.validateLens = async (_slot, value) => {
    const row = value as { openingAnalysis?: unknown; transitions?: Array<{ function?: unknown }> };
    const pass = typeof row.openingAnalysis === "object" && typeof row.transitions?.[1]?.function === "string";
    return { pass, errors: pass ? [] : ["openingAnalysis and transitions[1].function are required"] };
  };
  const output = await writeIsolatedBuilderLens(options);
  expect(output.value).toMatchObject({ body: "preserve this prose", openingAnalysis: { note: "observed opening" },
    transitions: [{}, { function: "cut" }] });
  expect(options.emit).toHaveBeenCalledTimes(2);
});

it("keeps cancellation and corrupted draft bytes fail-fast during revision", async () => {
  const base = fixture();
  await expect(writeIsolatedBuilderLens(runOptions(base, "visualEditing", async (_tools, _prompt, _validate, extra) => {
    await named(extra, "read_builder_context").execute({}, signal);
    const first = handle(await named(extra, "stage_builder_lens").execute({ slot: "visualEditing", value: { body: "stable" } }, signal));
    const revise = named(extra, "revise_builder_lens");
    const controller = new AbortController();
    controller.abort(new Error("cancelled by caller"));
    await expect(revise.execute({ slot: "visualEditing", useLatest: true,
      patches: [{ op: "replace", path: "/visualEditing/missing", value: "x" }] }, controller.signal))
      .rejects.toThrow("cancelled by caller");
    const storeRoot = path.join(base.root, "visualEditing", ".builder-lens-visualEditing");
    const instance = fs.readdirSync(storeRoot).find(name => name.startsWith(".validated-drafts-"));
    expect(instance).toBeTruthy();
    fs.writeFileSync(path.join(storeRoot, instance!, `${first.draftId}.json`), '{"body":"tampered"}\n');
    await expect(revise.execute({ slot: "visualEditing", useLatest: true,
      patches: [{ op: "replace", path: "/visualEditing/body", value: "changed" }] }, signal))
      .rejects.toThrow("VALIDATED_DRAFT_FILE_CHANGED");
    return { slot: "visualEditing", value: { body: "stable" }, receipt: first };
  }))).rejects.toThrow("VALIDATED_DRAFT_FILE_CHANGED");
});

it("cannot accept unread pixels, unstaged output, or a model value different from the staged draft", async () => {
  const base = fixture();
  await expect(writeIsolatedBuilderLens(runOptions(base, "directingLogic", async (_tools, _prompt, validate, extra) => {
    const stage = await named(extra, "stage_builder_lens").execute({ slot: "directingLogic", value: { body: "schema valid" } }, signal);
    expect(stage).toMatchObject({ pass: false, errors: ["BUILDER_LENS_UNREAD_EVIDENCE"] });
    expect(() => validate({ acceptedDraft: { draftId: "fake", sha256: "0".repeat(64) } }))
      .toThrow("BUILDER_LENS_UNREAD_EVIDENCE");
    return { slot: "directingLogic", value: { body: "schema valid" }, receipt: { draftId: "fake", sha256: "0".repeat(64) } };
  }))).rejects.toThrow("BUILDER_LENS_UNREAD_EVIDENCE");

  await expect(writeIsolatedBuilderLens(runOptions(base, "visualEditing", async (_tools, _prompt, _validate, extra) => {
    await named(extra, "read_builder_context").execute({}, signal);
    const receipt = handle(await named(extra, "stage_builder_lens").execute({ slot: "visualEditing", value: { body: "staged" } }, signal));
    return { slot: "visualEditing", value: { body: "model altered" }, receipt };
  }))).rejects.toThrow("BUILDER_LENS_MODEL_VALUE_MISMATCH");
});

it("hands the same exact CR and source receipt to two isolated interpretation branches", async () => {
  const base = fixture();
  const contentRestorationHandoff = withSourceReceipt({ summary: "The frame shows a machine indoors",
    blocks: [{ id: "B1", body: "It remains indoors", visuals: [{ ref: "frame", focus: "machine" }],
      evidenceRefs: ["frame"] }], unknowns: [] });
  const seen: Array<{ slot: BuilderLensSlot; copySha256: string; sourceReceipt: unknown; challenges: unknown[] }> = [];
  const run = (slot: "directingLogic" | "visualEditing") => {
    const options = runOptions(base, slot, async (tools, prompt, validate, extra) => {
      expect(prompt).toContain("candidate account, not truth");
      expect(tools.inspectedImages.size).toBe(0);
      expect(tools.fullyRead("builder-content-restoration")).toBe(false);
      const premature = await named(extra, "stage_builder_lens").execute({ slot, value: { body: "schema-valid" } }, signal);
      expect(premature).toMatchObject({ pass: false, errors: ["BUILDER_LENS_UNREAD_EVIDENCE"] });
      const context = await named(extra, "read_builder_context").execute({}, signal) as SiwcVisualToolResult;
      const metadata = (context.value as Record<string, unknown>).contentRestorationHandoff as {
        copySha256: string; sourceReceipt: unknown };
      const text = (context.value as { text: Array<{ ref: string; content: string }> }).text;
      expect(JSON.parse(text.find(item => item.ref === "builder-content-restoration")!.content))
        .toEqual(contentRestorationHandoff.value);
      expect(context.images).toHaveLength(1);
      const challenge = await named(extra, "challenge_builder_fact").execute({
        handoffCopySha256: metadata.copySha256, crPointer: "/blocks/0/body",
        counterObservation: "The original pixel warrants checking the location", evidenceRefs: ["frame"],
        affectedOwnPaths: [`/${slot}/body`],
      }, signal) as { pass: boolean };
      expect(challenge.pass).toBe(true);
      seen.push({ slot, copySha256: metadata.copySha256, sourceReceipt: metadata.sourceReceipt, challenges: [challenge] });
      const receipt = handle(await named(extra, "stage_builder_lens").execute({ slot, value: { body: `${slot} interpretation` } }, signal));
      return validate({ acceptedDraft: receipt });
    });
    return writeIsolatedBuilderLens({ ...options, contentRestorationHandoff });
  };
  const [directing, editing] = await Promise.all([run("directingLogic"), run("visualEditing")]);
  expect(seen).toHaveLength(2);
  expect(seen[0]!.copySha256).toBe(seen[1]!.copySha256);
  expect(seen[0]!.sourceReceipt).toEqual(contentRestorationHandoff.receipt);
  expect(seen[1]!.sourceReceipt).toEqual(contentRestorationHandoff.receipt);
  for (const output of [directing, editing]) {
    expect(output.factChallenges).toHaveLength(1);
    expect(output.factChallenges?.[0]).toMatchObject({ raisedBy: output.slot,
      sourceReceipt: contentRestorationHandoff.receipt, status: "proposed" });
    const sidecar = path.join(base.root, output.slot, "builder-fact-challenges.json");
    expect(sha(fs.readFileSync(sidecar))).toBe(output.factChallengeSidecar?.sha256);
  }
  expect(directing.factChallenges?.[0]?.id).not.toBe(editing.factChallenges?.[0]?.id);
  expect(contentRestorationHandoff.value.blocks[0]!.body).toBe("It remains indoors");
  expect(base.parentTools.readRefs.size).toBe(0);
});

it("cannot stage an interpretation when the bound CR copy changes after delivery", async () => {
  const base = fixture();
  const contentRestorationHandoff = withSourceReceipt({ summary: "Original",
    blocks: [{ id: "B1", body: "Original", visuals: [{ ref: "frame" }] }], unknowns: [] });
  const options = runOptions(base, "visualEditing", async (_tools, _prompt, _validate, extra) => {
    await named(extra, "read_builder_context").execute({}, signal);
    fs.writeFileSync(path.join(base.root, "visualEditing", "builder-content-restoration.json"), '{}\n');
    await expect(named(extra, "stage_builder_lens").execute({ slot: "visualEditing", value: { body: "valid" } }, signal))
      .rejects.toThrow("BUILDER_FACT_HANDOFF_MUTATED");
    throw new Error("stage rejected as expected");
  });
  await expect(writeIsolatedBuilderLens({ ...options, contentRestorationHandoff }))
    .rejects.toThrow("stage rejected as expected");
});

it("requires complete offset reads when an oversized CR makes the context bundle overflow", async () => {
  const base = fixture();
  const contentRestorationHandoff = withSourceReceipt({ summary: "A large accepted restoration",
    blocks: [{ id: "B1", body: "detail".repeat(90_000),
      visuals: [{ ref: "frame", focus: "observed" }] }], unknowns: [] });
  const options = runOptions(base, "directingLogic", async (tools, _prompt, validate, extra) => {
    const context = await named(extra, "read_builder_context").execute({}, signal) as { error: string };
    expect(context.error).toBe("RESPONSES_CONTEXT_BUNDLE_TOO_LARGE");
    const stage = named(extra, "stage_builder_lens");
    expect(await stage.execute({ slot: "directingLogic", value: { body: "valid" } }, signal))
      .toMatchObject({ pass: false, errors: ["BUILDER_LENS_UNREAD_EVIDENCE"] });
    const read = named(extra, "read_evidence");
    await read.execute({ ref: "source" }, signal);
    let offset = 0;
    while (!tools.fullyRead("builder-content-restoration")) {
      const part = await read.execute({ ref: "builder-content-restoration", offset }, signal) as { nextOffset: number };
      expect(part.nextOffset).toBeGreaterThan(offset);
      offset = part.nextOffset;
    }
    expect(tools.inspectedImages.size).toBe(0);
    expect(await stage.execute({ slot: "directingLogic", value: { body: "valid" } }, signal))
      .toMatchObject({ pass: false, errors: ["BUILDER_LENS_UNREAD_EVIDENCE"] });
    await named(extra, "inspect_image").execute({ ref: "frame" }, signal);
    const receipt = handle(await stage.execute({ slot: "directingLogic", value: { body: "valid" } }, signal));
    return validate({ acceptedDraft: receipt });
  });
  const result = await writeIsolatedBuilderLens({ ...options, evidenceTools: (tools: ResponsesEvidenceTools) => tools.tools(),
    contentRestorationHandoff });
  expect(result.value).toEqual({ body: "valid" });
});
