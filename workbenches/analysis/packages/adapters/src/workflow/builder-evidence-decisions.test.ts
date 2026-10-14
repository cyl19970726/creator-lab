import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { DecisionResult } from "@signal-room/workflow";
import { planBuilderEvidenceDecisions, type BuilderEvidenceDecision, type BuilderEvidenceDecisionOptions } from "./builder-evidence-decisions.js";

const roots: string[] = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lU8AAAAASUVORK5CYII=", "base64");
const distinctPng = (label: string) => Buffer.concat([png, Buffer.from(label)]);
const densePng = distinctPng("dense-1");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const strong = (name: string, choice: string) => ({ type: "choice" as const, name, choice,
  confidence: 0.92, probabilities: [
    { value: choice, probability: 0.92 },
    ...["adequate_for_visible_question", "needs_more_visual_evidence", "not_visually_verifiable"]
      .filter(value => value !== choice).map(value => ({ value, probability: 0.04 }))] });
const result = (...answers: DecisionResult["answers"]): DecisionResult => ({ provider: "openai", model: "gpt-6-luna", answers,
  requestId: "decision-test" });

function fixture(count = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "builder-evidence-"));
  roots.push(root);
  const frameBindings = Array.from({ length: count }, (_, index) => {
    const ref = `TARGET-${String(index + 1).padStart(4, "0")}`;
    const file = path.join(root, `${ref}.png`);
    fs.writeFileSync(file, png);
    return { ref, path: file, sha256: hash(png) };
  });
  const sourceFile = path.join(root, "DENSE-0001.png");
  fs.writeFileSync(sourceFile, densePng);
  frameBindings.push({ ref: "DENSE-0001", path: sourceFile, sha256: hash(densePng) });
  const actions = Array.from({ length: count }, (_, index) => ({ id: `CAP-${index + 1}`,
    reason: `Is state ${index + 1} visible?`, expectedObservation: `state ${index + 1} is legible`,
    range: { start: index * 2, end: index * 2 + 2 } }));
  const options: BuilderEvidenceDecisionOptions = { actions,
    manifestActions: actions.map((action, index) => ({ id: action.id, frameIds: [`TARGET-${String(index + 1).padStart(4, "0")}`] })),
    targetFrames: actions.map((_, index) => ({ id: `TARGET-${String(index + 1).padStart(4, "0")}`, time: index * 2 + 0.5 })),
    indexedFrames: [{ ref: "DENSE-0001", timeSeconds: 0.7 }], frameBindings,
    boundRefs: () => frameBindings.map(frame => frame.ref), signal: new AbortController().signal,
    decide: vi.fn(async () => result(strong("action_1", "adequate_for_visible_question"),
      strong("action_2", "not_visually_verifiable"))) };
  return { root, options, frameBindings };
}

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it("uses actual action questions and bound source hashes; adequate pixels still require Builder delivery", async () => {
  const { options } = fixture();
  const plan = await planBuilderEvidenceDecisions(options);
  expect(plan.receipts.map(row => [row.route, row.status])).toEqual([
    ["deliver_supporting_pixels", "sample_adequate"], ["agent_open_exploration", "unknown"]]);
  expect(plan.prioritizedImageRefs).toEqual(["TARGET-0001", "TARGET-0002"]);
  expect(plan.leftoverActionIds).toEqual(["CAP-2"]);
  expect(plan.decisionInputFrameRefs).toEqual(["TARGET-0001", "TARGET-0002"]);
  const [key, definition, input] = vi.mocked(options.decide).mock.calls[0]!;
  expect(key).toBe("builder-evidence-triage");
  expect(definition.maxRetries).toBe(0);
  expect(definition.questions[0]?.instructions).toContain("Is state 1 visible?");
  expect(definition.questions[0]?.instructions).toContain("TARGET-0001@0.5s");
  expect(input.images?.[0]?.sha256).toBe(hash(png));
  expect(input.evidenceRefs?.[0]).toEqual({ artifactId: "TARGET-0001", revision: "frozen-frame-v1", sha256: hash(png) });
});

it("routes insufficient samples to a short indexed original-frame supplement", async () => {
  const { options } = fixture(1);
  const decide = vi.fn(async () => result(strong("action_1", "needs_more_visual_evidence")));
  const plan = await planBuilderEvidenceDecisions({ ...options, decide });
  expect(plan.receipts[0]).toMatchObject({ choice: "needs_more_visual_evidence", adoption: "confident", route: "deliver_supplemental_pixels",
    status: "more_samples_delivered", supplementalFrames: [{ ref: "DENSE-0001", timeSeconds: 0.7, sha256: hash(densePng) }] });
  expect(plan.prioritizedImageRefs).toEqual(["TARGET-0001", "DENSE-0001"]);
  expect(plan.decisionInputFrameRefs).toEqual(["TARGET-0001"]);
});

it("judges an explicit question without inventing an absent expected observation", async () => {
  const { options } = fixture(1);
  const decide = vi.fn<BuilderEvidenceDecision>(async () => result(strong("action_1", "adequate_for_visible_question")));
  const plan = await planBuilderEvidenceDecisions({ ...options,
    actions: [{ ...options.actions[0]!, expectedObservation: undefined }], decide });
  expect(decide).toHaveBeenCalledTimes(1);
  expect(plan.receipts[0]).toMatchObject({ question: "Is state 1 visible?", expectedObservation: null,
    route: "deliver_supporting_pixels", adoption: "confident" });
  expect(decide.mock.calls[0]?.[1].questions[0]?.instructions)
    .toContain("No expected observation was supplied. Judge only the explicit question");
});

it("leaves an action without an explicit question to the Builder", async () => {
  const { options } = fixture(1);
  const decide = vi.fn<BuilderEvidenceDecision>(async () => result(strong("action_1", "adequate_for_visible_question")));
  const plan = await planBuilderEvidenceDecisions({ ...options,
    actions: [{ ...options.actions[0]!, reason: undefined }], decide });
  expect(decide).not.toHaveBeenCalled();
  expect(plan.receipts[0]).toMatchObject({ question: null, expectedObservation: "state 1 is legible",
    error: "BUILDER_EVIDENCE_QUESTION_INCOMPLETE", adoption: "none", status: "unknown" });
  expect(plan.leftoverActionIds).toEqual(["CAP-1"]);
});

it("labels low-confidence supplementation tentative while keeping the question open", async () => {
  const { options } = fixture(1);
  const plan = await planBuilderEvidenceDecisions({ ...options,
    decide: async () => result({ type: "choice", name: "action_1", choice: "needs_more_visual_evidence",
      confidence: 0.52, probabilities: [
        { value: "needs_more_visual_evidence", probability: 0.52 },
        { value: "adequate_for_visible_question", probability: 0.46 },
        { value: "not_visually_verifiable", probability: 0.02 }] }) });
  expect(plan.receipts[0]).toMatchObject({ adoption: "tentative", route: "deliver_supplemental_pixels",
    status: "more_samples_delivered" });
  expect(plan.prioritizedImageRefs).toEqual(["TARGET-0001", "DENSE-0001"]);
});

it("records TARGET samples excluded by the per-question frame budget", async () => {
  const { options } = fixture(5);
  const plan = await planBuilderEvidenceDecisions({ ...options, actions: options.actions.slice(0, 1),
    manifestActions: [{ id: "CAP-1", frameIds: options.targetFrames.map(frame => frame.id) }],
    decide: async () => result(strong("action_1", "adequate_for_visible_question")) });
  expect(plan.receipts[0]?.selectedFrames.map(frame => frame.ref)).toEqual(["TARGET-0001", "TARGET-0003", "TARGET-0005"]);
  expect(plan.receipts[0]?.unselectedTargetRefs).toEqual(["TARGET-0002", "TARGET-0004"]);
});

it("accepts a host-bound additional frame only after the indexed window is empty", async () => {
  const { options, root, frameBindings } = fixture(1);
  const file = path.join(root, "EXTRA-0001.png");
  const extraPng = distinctPng("extra-1");
  fs.writeFileSync(file, extraPng);
  const extra = { ref: "EXTRA-0001", path: file, sha256: hash(extraPng), timeSeconds: 0.8 };
  const captureAdditional = vi.fn(async () => { frameBindings.push(extra); return [extra]; });
  const plan = await planBuilderEvidenceDecisions({ ...options, indexedFrames: [], captureAdditional,
    decide: async () => result(strong("action_1", "needs_more_visual_evidence")) });
  expect(captureAdditional).toHaveBeenCalledTimes(1);
  expect(plan.receipts[0]).toMatchObject({ route: "deliver_supplemental_pixels",
    supplementalFrames: [{ ref: "EXTRA-0001", timeSeconds: 0.8, sha256: hash(extraPng) }] });
});

it("does not spend a supplemental slot on B's same-SHA CUE/TARGET alias", async () => {
  const { options, root, frameBindings } = fixture(1);
  const alias = path.join(root, "FRAME-CUE-010.png");
  fs.writeFileSync(alias, png);
  frameBindings.push({ ref: "FRAME-CUE-010", path: alias, sha256: hash(png) });
  const indexedFrames = [{ ref: "FRAME-CUE-010", timeSeconds: 0.5 }, ...options.indexedFrames];
  for (const [ref, timeSeconds] of [["DENSE-0002", 0.6], ["DENSE-0003", 0.8], ["DENSE-0004", 0.9]] as const) {
    const bytes = distinctPng(ref);
    const file = path.join(root, `${ref}.png`);
    fs.writeFileSync(file, bytes);
    frameBindings.push({ ref, path: file, sha256: hash(bytes) });
    indexedFrames.push({ ref, timeSeconds });
  }
  const plan = await planBuilderEvidenceDecisions({ ...options, indexedFrames,
    decide: async () => result(strong("action_1", "needs_more_visual_evidence")) });
  expect(plan.receipts[0]?.supplementalCandidateRefs).toContain("FRAME-CUE-010");
  expect(plan.receipts[0]?.supplementalFrames.map(frame => frame.ref))
    .toEqual(["DENSE-0002", "DENSE-0001", "DENSE-0003", "DENSE-0004"]);
  expect(plan.prioritizedImageRefs).not.toContain("FRAME-CUE-010");
});

it("skips duplicate candidate content and continues to four distinct bound images", async () => {
  const { options, root, frameBindings } = fixture(1);
  const indexedFrames = [...options.indexedFrames];
  for (const [ref, timeSeconds, content] of [
    ["DENSE-0002", 0.6, "same-candidate"], ["DENSE-0003", 0.8, "same-candidate"],
    ["DENSE-0004", 0.9, "four"], ["DENSE-0005", 1.0, "five"],
  ] as const) {
    const bytes = distinctPng(content);
    const file = path.join(root, `${ref}.png`);
    fs.writeFileSync(file, bytes);
    frameBindings.push({ ref, path: file, sha256: hash(bytes) });
    indexedFrames.push({ ref, timeSeconds });
  }
  const plan = await planBuilderEvidenceDecisions({ ...options, indexedFrames,
    decide: async () => result(strong("action_1", "needs_more_visual_evidence")) });
  expect(plan.receipts[0]?.supplementalFrames.map(frame => frame.ref))
    .toEqual(["DENSE-0002", "DENSE-0001", "DENSE-0004", "DENSE-0005"]);
  expect(new Set(plan.receipts[0]?.supplementalFrames.map(frame => frame.sha256)).size).toBe(4);
});

it("rejects a mutated candidate even when its declared SHA matches the selected TARGET", async () => {
  const { options, frameBindings } = fixture(1);
  frameBindings[1]!.sha256 = hash(png);
  const plan = await planBuilderEvidenceDecisions({ ...options,
    decide: async () => result(strong("action_1", "needs_more_visual_evidence")) });
  expect(plan.receipts[0]).toMatchObject({ error: "BUILDER_EVIDENCE_SHA_MISMATCH",
    route: "agent_open_exploration", status: "unknown", supplementalFrames: [] });
  expect(plan.prioritizedImageRefs).toEqual(["TARGET-0001"]);
});

it("uses the capture hook when nearby indexed refs only duplicate selected bytes", async () => {
  const { options, root, frameBindings } = fixture(1);
  fs.writeFileSync(frameBindings[1]!.path, png);
  frameBindings[1]!.sha256 = hash(png);
  const extraPng = distinctPng("hook-extra");
  const file = path.join(root, "EXTRA-0001.png");
  fs.writeFileSync(file, extraPng);
  const extra = { ref: "EXTRA-0001", path: file, sha256: hash(extraPng), timeSeconds: 0.8 };
  const captureAdditional = vi.fn(async () => { frameBindings.push(extra); return [extra]; });
  const plan = await planBuilderEvidenceDecisions({ ...options, captureAdditional,
    decide: async () => result(strong("action_1", "needs_more_visual_evidence")) });
  expect(captureAdditional).toHaveBeenCalledTimes(1);
  expect(plan.receipts[0]?.supplementalCandidateRefs).toEqual(["DENSE-0001", "EXTRA-0001"]);
  expect(plan.receipts[0]?.supplementalFrames.map(frame => frame.ref)).toEqual(["EXTRA-0001"]);
});

it("keeps refusal and competing probabilities open without declaring a capture resolved", async () => {
  const { options } = fixture();
  const plan = await planBuilderEvidenceDecisions({ ...options,
    decide: async () => result({ type: "refusal", name: "action_1" }, {
      type: "choice", name: "action_2", choice: "adequate_for_visible_question", confidence: 0.51,
      probabilities: [{ value: "adequate_for_visible_question", probability: 0.51 },
        { value: "needs_more_visual_evidence", probability: 0.47 },
        { value: "not_visually_verifiable", probability: 0.02 }] }) });
  expect(plan.receipts.map(row => [row.refusal, row.route, row.status])).toEqual([
    [true, "agent_open_exploration", "unknown"], [false, "agent_open_exploration", "unknown"]]);
  expect(plan.leftoverActionIds).toEqual(["CAP-1", "CAP-2"]);
});

it("reports missing target mappings and SHA mutation without calling a decision for those actions", async () => {
  const { options, frameBindings } = fixture();
  fs.writeFileSync(frameBindings[0]!.path, Buffer.concat([png, Buffer.from("mutated")]));
  const decide = vi.fn(async () => result(strong("action_1", "adequate_for_visible_question")));
  const plan = await planBuilderEvidenceDecisions({ ...options,
    manifestActions: [{ id: "CAP-1", frameIds: ["TARGET-0001"] },
      { id: "CAP-2", frameIds: ["TARGET-9999"] }], decide });
  expect(decide).not.toHaveBeenCalled();
  expect(plan.receipts.map(row => row.error)).toEqual(["BUILDER_EVIDENCE_SHA_MISMATCH", "BUILDER_EVIDENCE_TARGET_MISSING"]);
  expect(plan.leftoverActionIds).toEqual(["CAP-1", "CAP-2"]);
  expect(plan.prioritizedImageRefs).toEqual([]);
});

it("leaves over-budget actions explicit and routes a failed decision to open exploration", async () => {
  const { options } = fixture(3);
  const decide = vi.fn(async () => { throw new Error("private provider error"); });
  const plan = await planBuilderEvidenceDecisions({ ...options, decide, maxQuestions: 1 });
  expect(decide).toHaveBeenCalledTimes(1);
  expect(plan.receipts.map(row => row.error)).toEqual([
    "BUILDER_EVIDENCE_ERROR", "BUILDER_EVIDENCE_QUESTION_LIMIT", "BUILDER_EVIDENCE_QUESTION_LIMIT"]);
  expect(plan.leftoverActionIds).toEqual(["CAP-1", "CAP-2", "CAP-3"]);
  expect(plan.prioritizedImageRefs).toEqual(["TARGET-0001"]);
});

it("does not emit a plan after cancellation during the shared decision call", async () => {
  const { options } = fixture(1);
  const controller = new AbortController();
  await expect(planBuilderEvidenceDecisions({ ...options, signal: controller.signal,
    decide: async () => { controller.abort(new Error("cancelled by caller"));
      return result(strong("action_1", "adequate_for_visible_question")); } }))
    .rejects.toThrow("cancelled by caller");
});
