import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createBuilderFactHandoff } from "./builder-fact-handoff.js";
import { ResponsesEvidenceTools } from "./responses-tools.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const draftSha = (value: unknown) => sha(Buffer.from(`${JSON.stringify(JSON.parse(JSON.stringify(value)))}\n`));
const signal = new AbortController().signal;
const pixel = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c636000020000050001a5f645400000000049454e44ae426082", "hex");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "builder-fact-")); roots.push(root);
  const image = path.join(root, "frame.png"); fs.writeFileSync(image, pixel);
  const note = path.join(root, "note.json");
  const noteBytes = Buffer.from('{"observed":"frame is outdoors"}\n'); fs.writeFileSync(note, noteBytes);
  const parent = new ResponsesEvidenceTools([
    { ref: "frame", path: image, sha256: sha(pixel) },
    { ref: "note", path: note, sha256: sha(noteBytes) },
  ], root);
  const cr = { summary: "A person approaches the object", blocks: [{ id: "B1", body: "The object is indoors",
    visuals: [{ ref: "frame", focus: "object" }], beforeFrameRef: "frame", evidenceRefs: ["note"] }],
    unknowns: ["Whether the scene is staged"] };
  const source = { slot: "contentRestoration" as const, value: cr,
    receipt: { draftId: "source-draft", sha256: draftSha(cr) } };
  const directory = path.join(root, "branch"); fs.mkdirSync(directory);
  const tools = parent.fork(directory);
  const handoff = createBuilderFactHandoff({ slot: "visualEditing", directory, tools, source });
  const args = { handoffCopySha256: handoff.copySha256, crPointer: "/blocks/0/body",
    counterObservation: "Original pixels show an outdoor background", evidenceRefs: ["frame"],
    affectedOwnPaths: ["/visualEditing/transitions/0/to"] };
  return { root, image, note, parent, tools, cr, source, directory, handoff, args };
}

it("binds the exact CR value and separate source/copy hashes without inheriting observations", () => {
  const base = fixture();
  expect(base.parent.readRefs.size).toBe(0);
  expect(base.tools.readRefs.size).toBe(0);
  expect(base.handoff.prioritizedImageRefs).toEqual(["frame"]);
  const binding = base.tools.snapshotBindings().find(item => item.ref === base.handoff.ref)!;
  expect(JSON.parse(fs.readFileSync(binding.path, "utf8"))).toEqual(base.cr);
  expect(binding.sha256).toBe(base.handoff.copySha256);
  expect(base.handoff.copySha256).toBe(base.source.receipt.sha256);
  expect(base.handoff.sourceReceipt).toEqual(base.source.receipt);
  expect(base.tools.fullyRead(base.handoff.ref)).toBe(false);
});

it("rejects a source receipt that does not hash-bind the accepted CR value before copying it", () => {
  const base = fixture();
  const wrongShaDir = path.join(base.root, "wrong-sha"); fs.mkdirSync(wrongShaDir);
  expect(() => createBuilderFactHandoff({ slot: "directingLogic", directory: wrongShaDir,
    tools: base.parent.fork(wrongShaDir), source: { ...base.source,
      receipt: { ...base.source.receipt, sha256: "a".repeat(64) } } }))
    .toThrow("BUILDER_FACT_SOURCE_RECEIPT_MISMATCH");
  expect(fs.existsSync(path.join(wrongShaDir, "builder-content-restoration.json"))).toBe(false);
  const changedValueDir = path.join(base.root, "changed-value"); fs.mkdirSync(changedValueDir);
  expect(() => createBuilderFactHandoff({ slot: "visualEditing", directory: changedValueDir,
    tools: base.parent.fork(changedValueDir), source: { ...base.source,
      value: { ...base.cr, summary: "Later substituted summary" } } }))
    .toThrow("BUILDER_FACT_SOURCE_RECEIPT_MISMATCH");
  expect(fs.existsSync(path.join(changedValueDir, "builder-content-restoration.json"))).toBe(false);
});

it("requires this branch to read CR and actual evidence before recording an exact bounded challenge", async () => {
  const base = fixture();
  const tool = base.handoff.challengeTool;
  expect(await tool.execute(base.args, signal)).toMatchObject({ pass: false, errors: ["BUILDER_FACT_HANDOFF_UNREAD"] });
  base.tools.readBundle([base.handoff.ref], []);
  expect(await tool.execute(base.args, signal)).toMatchObject({ pass: false, errors: ["BUILDER_FACT_EVIDENCE_UNREAD"] });
  base.tools.readBundle([], ["frame"]);
  const accepted = await tool.execute(base.args, signal) as { pass: boolean; challenge: Record<string, unknown>; sidecar: { sha256: string } };
  expect(accepted.pass).toBe(true);
  expect(accepted.challenge).toMatchObject({ raisedBy: "visualEditing", claimQuote: base.cr.blocks[0]!.body,
    handoffCopySha256: base.handoff.copySha256, sourceReceipt: base.source.receipt,
    status: "proposed", affectedOwnPaths: ["/visualEditing/transitions/0/to"] });
  expect(base.cr.blocks[0]!.body).toBe("The object is indoors");
  const sidecar = fs.readFileSync(path.join(base.directory, "builder-fact-challenges.json"));
  expect(sha(sidecar)).toBe(accepted.sidecar.sha256);
  expect(JSON.parse(sidecar.toString()).factChallenges).toEqual(base.handoff.factChallenges);
  expect(base.parent.inspectedImages.size).toBe(0);
});

it("rejects stale pointers, other-slot paths and unbound refs without spending a challenge", async () => {
  const base = fixture();
  base.tools.readBundle([base.handoff.ref], ["frame"]);
  const tool = base.handoff.challengeTool;
  expect(await tool.execute({ ...base.args, crPointer: "/blocks/9/body" }, signal))
    .toMatchObject({ pass: false, errors: ["BUILDER_FACT_POINTER_INVALID"] });
  expect(await tool.execute({ ...base.args, crPointer: "/finalSummary/conclusion" }, signal))
    .toMatchObject({ pass: false, errors: ["BUILDER_FACT_POINTER_INVALID"] });
  expect(await tool.execute({ ...base.args, crPointer: "/blocks/0/evidenceRefs/0" }, signal))
    .toMatchObject({ pass: false, errors: ["BUILDER_FACT_POINTER_INVALID"] });
  expect(await tool.execute({ ...base.args, affectedOwnPaths: ["/contentRestoration/blocks/0/body"] }, signal))
    .toMatchObject({ pass: false, errors: ["BUILDER_FACT_OWN_PATH_INVALID"] });
  expect(await tool.execute({ ...base.args, evidenceRefs: ["unknown"] }, signal))
    .toMatchObject({ pass: false, errors: ["BUILDER_FACT_EVIDENCE_NOT_BOUND"] });
  expect(await tool.execute({ ...base.args, evidenceRefs: ["builder-content-restoration"] }, signal))
    .toMatchObject({ pass: false, errors: ["BUILDER_FACT_SELF_CITATION_INVALID"] });
  expect(base.handoff.factChallenges).toHaveLength(0);
});

it("quotes the copied accepted claim even if the caller later mutates its original object", async () => {
  const base = fixture();
  base.cr.blocks[0]!.body = "The caller changed the object";
  base.tools.readBundle([base.handoff.ref], ["frame"]);
  const result = await base.handoff.challengeTool.execute(base.args, signal) as { challenge: { claimQuote: string } };
  expect(result.challenge.claimQuote).toBe("The object is indoors");
  expect(JSON.parse(fs.readFileSync(path.join(base.directory, "builder-content-restoration.json"), "utf8"))
    .blocks[0].body).toBe("The object is indoors");
});

it("treats mismatched hashes, mutated bound bytes and cancellation as fatal", async () => {
  const base = fixture();
  base.tools.readBundle([base.handoff.ref], ["frame"]);
  await expect(base.handoff.challengeTool.execute({ ...base.args, handoffCopySha256: "0".repeat(64) }, signal))
    .rejects.toThrow("BUILDER_FACT_HANDOFF_SHA_MISMATCH");
  const abort = new AbortController(); abort.abort(new Error("cancelled"));
  await expect(base.handoff.challengeTool.execute(base.args, abort.signal)).rejects.toThrow("cancelled");
  fs.writeFileSync(base.image, Buffer.from("changed"));
  await expect(base.handoff.challengeTool.execute(base.args, signal)).rejects.toThrow("BUILDER_FACT_EVIDENCE_MUTATED");
  fs.writeFileSync(path.join(base.directory, "builder-content-restoration.json"), "{}\n");
  await expect(base.handoff.challengeTool.execute(base.args, signal)).rejects.toThrow("BUILDER_FACT_HANDOFF_MUTATED");
});

it("limits proposed challenges to eight even if the model retries", async () => {
  const base = fixture();
  base.tools.readBundle([base.handoff.ref], ["frame"]);
  for (let index = 0; index < 8; index++) {
    expect(await base.handoff.challengeTool.execute({ ...base.args, counterObservation: `conflict ${index}` }, signal))
      .toMatchObject({ pass: true });
  }
  expect(await base.handoff.challengeTool.execute(base.args, signal))
    .toMatchObject({ pass: false, errors: ["BUILDER_FACT_CHALLENGE_LIMIT"] });
  expect(base.handoff.factChallenges).toHaveLength(8);
});
