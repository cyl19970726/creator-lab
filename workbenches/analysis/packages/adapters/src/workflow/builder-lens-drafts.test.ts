import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { builderLensDraftToolParameters, builderLensIndexSchema, builderLensSchema, BuilderLensDrafts, builderLensSlots } from "./builder-lens-drafts.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const schemaPath = path.resolve(".agents/skills/video-content-reconstruction/schemas/reconstruction.schema.json");

it("extracts canonical, reachable schema definitions for an index and each complete lens", () => {
  const index = builderLensIndexSchema(schemaPath);
  expect(index.required).toContain("knowledgeUnits");
  expect(index.required).toContain("summaryContractVersion");
  expect(index.required).not.toContain("builderLenses");
  expect(index.required).not.toContain("transcript");
  expect(index).toMatchObject({ additionalProperties: false });
  expect(index.properties).not.toHaveProperty("transcript");
  expect((index.properties as Record<string, unknown>).builderLenses).toBeUndefined();
  const parameters = builderLensDraftToolParameters(schemaPath) as {
    properties: { reconstruction: { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean };
      finalSummary: Record<string, unknown> };
  };
  expect(parameters.properties.reconstruction.required).not.toContain("transcript");
  expect(parameters.properties.reconstruction.required).not.toContain("builderLenses");
  expect(parameters.properties.reconstruction.required).toContain("summaryContractVersion");
  expect(parameters.properties.finalSummary).toMatchObject({ type: "object", required: expect.arrayContaining([
    "conclusion", "performance"]) });
  expect(parameters.properties.reconstruction.properties).not.toHaveProperty("transcript");
  expect(parameters.properties.reconstruction.additionalProperties).toBe(false);
  const content = builderLensSchema(schemaPath, "contentRestoration");
  expect(content).toMatchObject({ type: "object", required: ["summary", "blocks", "unknowns"] });
  expect((content.$defs as Record<string, unknown>).contentBlock).toBeDefined();
  expect(builderLensSchema(schemaPath, "directingLogic").$ref).toBe("#/$defs/directingLogic");
  expect(builderLensSchema(schemaPath, "visualEditing").$ref).toBe("#/$defs/visualEditing");
  expect(((builderLensSchema(schemaPath, "directingLogic").$defs as Record<string, { required?: string[] }>).directingLogic?.required))
    .toContain("packagingAnalysis");
  expect(((builderLensSchema(schemaPath, "visualEditing").$defs as Record<string, { required?: string[] }>).visualEditing?.required))
    .toContain("openingAnalysis");
});

it("composes exact latest section values and rejects malformed, stale, missing, mixed, or cross-attempt handles", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "builder-lens-drafts-")); roots.push(root);
  const validator = async (slot: string, value: unknown) => {
    const valid = value !== null && typeof value === "object" && !Array.isArray(value)
      && (value as Record<string, unknown>).slot === slot && typeof (value as Record<string, unknown>).body === "string";
    return { pass: valid, errors: valid ? [] : [`schema mismatch for ${slot}`] };
  };
  const drafts = new BuilderLensDrafts(root, validator);
  const values = Object.fromEntries(builderLensSlots.map(slot => [slot, { slot, body: `exact:${slot}`, extra: [1, 2] }])) as
    Record<typeof builderLensSlots[number], { slot: string; body: string; extra: number[] }>;
  const handles = Object.fromEntries(await Promise.all(builderLensSlots.map(async slot => {
    const receipt = await drafts.stage(slot, values[slot]);
    expect(receipt.pass).toBe(true);
    return [slot, { draftId: receipt.draftId, sha256: receipt.sha256 }];
  })));
  const index = { schemaVersion: "fixture", someField: ["unchanged"] };
  expect(drafts.compose(index, handles)).toEqual({ ...index, builderLenses: values });
  const finalSummary = { conclusion: "Builder-authored exact summary", performance: { observedMetrics: [] } };
  const marked = { ...index, summaryContractVersion: "single-post-summary@1" };
  expect(() => drafts.compose(marked, handles)).toThrow("BUILDER_LENS_FINAL_SUMMARY_REQUIRED");
  expect(() => drafts.compose(index, handles, finalSummary)).toThrow("BUILDER_LENS_FINAL_SUMMARY_CONTRACT_MISSING");
  expect(drafts.compose(marked, handles, finalSummary)).toEqual({ ...marked,
    builderLenses: { ...values, finalSummary } });
  expect(drafts.compose(marked, handles, finalSummary).builderLenses).toMatchObject({
    contentRestoration: values.contentRestoration, directingLogic: values.directingLogic,
    visualEditing: values.visualEditing });

  const bad = await drafts.stage("visualEditing", { slot: "directingLogic", body: "wrong slot" });
  expect(bad.pass).toBe(false);
  expect(() => drafts.compose(index, handles)).toThrow("BUILDER_LENS_HANDLE_NOT_LATEST:visualEditing");
  const corrected = await drafts.stage("visualEditing", values.visualEditing);
  const correctedHandles = { ...handles, visualEditing: { draftId: corrected.draftId, sha256: corrected.sha256 } };
  expect(drafts.compose(index, correctedHandles).builderLenses).toEqual(values);
  expect(() => drafts.compose(index, { contentRestoration: handles.contentRestoration,
    directingLogic: handles.directingLogic })).toThrow("BUILDER_LENS_HANDLES_INCOMPLETE");
  expect(() => drafts.compose({ ...index, builderLenses: {} }, correctedHandles)).toThrow("BUILDER_LENS_INDEX_INVALID_OR_INLINE_MIXED");
  expect(() => drafts.compose({ ...index, transcript: { origin: "model" } }, correctedHandles))
    .toThrow("BUILDER_LENS_INDEX_HOST_FIELD_PRESENT:transcript");
  expect(() => drafts.compose(index, { ...correctedHandles, visualEditing: { ...correctedHandles.visualEditing, sha256: "0".repeat(64) } }))
    .toThrow("BUILDER_LENS_HANDLE_NOT_LATEST:visualEditing");
  expect(() => drafts.compose(index, { ...correctedHandles, visualEditing: {
    ...correctedHandles.visualEditing, sha256: corrected.sha256.slice(0, 17) + corrected.sha256.slice(18)
  } })).toThrow("BUILDER_LENS_HANDLE_NOT_LATEST:visualEditing");
  const otherAttempt = new BuilderLensDrafts(path.join(root, "other-attempt"), validator);
  expect(() => otherAttempt.compose(index, correctedHandles)).toThrow("BUILDER_LENS_HANDLE_NOT_LATEST:contentRestoration");
});

it("repairs only patched paths from an invalid latest lens and preserves all untouched text exactly", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "builder-lens-revise-")); roots.push(root);
  const stableBody = `long preserved body ${"x".repeat(12_000)}`;
  const validator = async (_slot: string, value: unknown) => {
    const body = (value as { body?: unknown })?.body;
    const pass = body === "corrected";
    return { pass, errors: pass ? [] : ["body needs correction"] };
  };
  const drafts = new BuilderLensDrafts(root, validator);
  const initial = await drafts.stage("contentRestoration", { body: "incorrect", stableBody, untouched: ["keep", 4] });
  expect(initial.pass).toBe(false);
  const originalRef = { draftId: initial.draftId, sha256: initial.sha256 };
  await expect(drafts.revise("contentRestoration", originalRef, [
    { op: "replace", path: "/contentRestoration/missing", value: "x" }
  ])).rejects.toThrow("RECONSTRUCTION_PATCH_PATH_MISSING");
  expect(drafts.latestRef("contentRestoration")).toEqual(originalRef);
  await expect(drafts.revise("contentRestoration", {
    ...originalRef, draftId: originalRef.draftId.slice(0, 9) + (originalRef.draftId[9] === "9" ? "8" : "9") + originalRef.draftId.slice(10)
  }, [{ op: "replace", path: "/contentRestoration/body", value: "corrected" }]))
    .rejects.toThrow("BUILDER_LENS_HANDLE_NOT_LATEST:contentRestoration");

  const stillInvalid = await drafts.revise("contentRestoration", originalRef, [
    { op: "replace", path: "/contentRestoration/body", value: "still incorrect" }
  ]);
  expect(stillInvalid.pass).toBe(false);
  expect(stillInvalid.errors).toEqual(["body needs correction"]);
  expect(stillInvalid.draftId).not.toBe(initial.draftId);
  expect(drafts.latestRef("contentRestoration")).toEqual({ draftId: stillInvalid.draftId, sha256: stillInvalid.sha256 });

  const revised = await drafts.revise("contentRestoration", { draftId: stillInvalid.draftId, sha256: stillInvalid.sha256 }, [
    { op: "replace", path: "/contentRestoration/body", value: "corrected" }
  ]);
  expect(revised).toMatchObject({ pass: true, errors: [], draftId: expect.any(String), sha256: expect.any(String) });
  expect(revised.draftId).not.toBe(initial.draftId);
  expect(revised).not.toHaveProperty("value");
  await expect(drafts.revise("contentRestoration", originalRef, [
    { op: "replace", path: "/contentRestoration/body", value: "stale" }
  ])).rejects.toThrow("BUILDER_LENS_HANDLE_NOT_LATEST:contentRestoration");
  await expect(drafts.revise("contentRestoration", { draftId: stillInvalid.draftId, sha256: stillInvalid.sha256 }, [
    { op: "replace", path: "/contentRestoration/body", value: "stale" }
  ])).rejects.toThrow("BUILDER_LENS_HANDLE_NOT_LATEST:contentRestoration");

  const directing = await drafts.stage("directingLogic", { body: "corrected" });
  const visual = await drafts.stage("visualEditing", { body: "corrected" });
  await expect(drafts.revise("directingLogic", { draftId: revised.draftId, sha256: revised.sha256 }, [
    { op: "replace", path: "/directingLogic/body", value: "cross-slot" }
  ])).rejects.toThrow("BUILDER_LENS_HANDLE_NOT_LATEST:directingLogic");
  const composed = drafts.compose({ marker: "index" }, {
    contentRestoration: { draftId: revised.draftId, sha256: revised.sha256 },
    directingLogic: { draftId: directing.draftId, sha256: directing.sha256 },
    visualEditing: { draftId: visual.draftId, sha256: visual.sha256 }
  });
  expect(composed.builderLenses).toEqual({
    contentRestoration: { body: "corrected", stableBody, untouched: ["keep", 4] },
    directingLogic: { body: "corrected" }, visualEditing: { body: "corrected" }
  });
});

it("adds only a missing property inside the latest staged lens and keeps failed edits non-mutating", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "builder-lens-add-")); roots.push(root);
  const stableBody = `original lens body ${"x".repeat(8_000)}`;
  const drafts = new BuilderLensDrafts(root, async (slot, value) => {
    const firstFrame = (value as { packagingAnalysis?: { firstFrame?: { searchTerms?: string[] } } })
      .packagingAnalysis?.firstFrame;
    const pass = slot !== "directingLogic" || Array.isArray(firstFrame?.searchTerms);
    return { pass, errors: pass ? [] : ["searchTerms required"] };
  });
  const staged = await drafts.stage("directingLogic", {
    packagingAnalysis: { firstFrame: { title: "preserved" } }, stableBody, frames: ["one", "two"]
  });
  expect(staged.pass).toBe(false);
  const ref = { draftId: staged.draftId, sha256: staged.sha256 };
  for (const patch of [
    { op: "add", path: "/directingLogic/frames/2", value: "array append" },
    { op: "add", path: "/directingLogic/packagingAnalysis/firstFrame/title", value: "overwrite" },
    { op: "add", path: "/directingLogic/packagingAnalysis/missing/searchTerms", value: [] },
    { op: "add", path: "/visualEditing/packagingAnalysis/firstFrame/searchTerms", value: [] },
    { op: "add", path: "/directingLogic/packagingAnalysis/firstFrame/__proto__", value: {} }
  ]) {
    await expect(drafts.revise("directingLogic", ref, [patch])).rejects.toThrow(/^RECONSTRUCTION_PATCH_/);
    expect(drafts.latestRef("directingLogic")).toEqual(ref);
  }
  const accepted = await drafts.revise("directingLogic", ref, [{ op: "add",
    path: "/directingLogic/packagingAnalysis/firstFrame/searchTerms", value: ["zipper"] }]);
  expect(accepted.pass).toBe(true);
  expect(drafts.latestRef("directingLogic")).toEqual({ draftId: accepted.draftId, sha256: accepted.sha256 });
  const content = await drafts.stage("contentRestoration", { body: "content" });
  const visual = await drafts.stage("visualEditing", { body: "visual" });
  const composed = drafts.compose({ marker: "index" }, {
    contentRestoration: { draftId: content.draftId, sha256: content.sha256 },
    directingLogic: { draftId: accepted.draftId, sha256: accepted.sha256 },
    visualEditing: { draftId: visual.draftId, sha256: visual.sha256 }
  });
  expect((composed.builderLenses as Record<string, unknown>).directingLogic).toEqual({
    packagingAnalysis: { firstFrame: { title: "preserved", searchTerms: ["zipper"] } }, stableBody,
    frames: ["one", "two"]
  });
});
