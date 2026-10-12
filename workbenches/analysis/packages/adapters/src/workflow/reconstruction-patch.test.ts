import { describe, expect, it } from "vitest";
import { applyReconstructionPatch, RECONSTRUCTION_PATCH_ALLOWED_ROOTS } from "./reconstruction-patch.js";

const base = () => ({ schemaVersion: "1.0.0", builderLenses: {
  contentRestoration: { text: "original", unaffected: "retain" }, directingLogic: { cuts: ["a", "b"] } },
  knowledgeUnits: [{ id: "KU-1", evidence: ["frame-1"] }], relations: [],
  derivedSources: [{ id: "SOURCE-1", path: "post-source-input.json", kind: "post_title", producedBy: "host",
    timeRange: { start: 0, end: 0 }, limitations: [] }],
  metaGate: { unknowns: ["not checked"] } });

describe("replace-only reconstruction patch", () => {
  it("replaces existing paths while preserving all other fields and the input", () => {
    const original = base();
    const patched = applyReconstructionPatch(original, [
      { op: "replace", path: "/builderLenses/contentRestoration/text", value: "corrected" },
      { op: "replace", path: "/knowledgeUnits/0/evidence", value: ["frame-2"] },
    ]) as ReturnType<typeof base>;
    expect(patched.builderLenses.contentRestoration).toEqual({ text: "corrected", unaffected: "retain" });
    expect(patched.knowledgeUnits[0]?.evidence).toEqual(["frame-2"]);
    expect(patched.schemaVersion).toBe("1.0.0");
    expect(original.builderLenses.contentRestoration.text).toBe("original");
    expect(original.knowledgeUnits[0]?.evidence).toEqual(["frame-1"]);
  });

  it("honors an explicit wider root list for technical drafts", () => {
    const patched = applyReconstructionPatch(base(), [{ op: "replace", path: "/schemaVersion", value: "1.0.1" }], ["schemaVersion"]);
    expect(patched).toMatchObject({ schemaVersion: "1.0.1" });
  });

  it("allows Builder-owned derived source registration while keeping host-owned roots closed", () => {
    expect(RECONSTRUCTION_PATCH_ALLOWED_ROOTS).toContain("derivedSources");
    const original = base();
    const patched = applyReconstructionPatch(original, [{ op: "replace", path: "/derivedSources/0/id", value: "POST-TITLE" }]) as
      ReturnType<typeof base>;
    expect(patched.derivedSources[0]?.id).toBe("POST-TITLE");
    expect(original.derivedSources[0]?.id).toBe("SOURCE-1");
    for (const path of ["/probe", "/protocol", "/transcript", "/evidencePack"]) {
      expect(() => applyReconstructionPatch(original, [{ op: "replace", path, value: {} }]))
        .toThrow("RECONSTRUCTION_PATCH_ROOT_NOT_ALLOWED");
    }
  });

  it("rejects forbidden roots, missing fields, array overflow and all mutation operations", () => {
    for (const patch of [
      { op: "replace", path: "/schemaVersion", value: "bad" },
      { op: "replace", path: "/builderLenses/missing", value: "bad" },
      { op: "replace", path: "/knowledgeUnits/1/id", value: "bad" },
      { op: "replace", path: "/knowledgeUnits/-/id", value: "bad" },
      { op: "add", path: "/knowledgeUnits/0/id", value: "bad" },
    ]) expect(() => applyReconstructionPatch(base(), [patch])).toThrow("RECONSTRUCTION_PATCH_");
  });

  it("rejects root, prototype, bad escape, duplicates and ancestor overlap", () => {
    const replace = (path: string) => ({ op: "replace", path, value: "bad" });
    for (const path of ["", "/", "/builderLenses/__proto__", "/builderLenses/constructor",
      "/builderLenses/prototype", "/builderLenses/~2", "/builderLenses/contentRestoration/"]) {
      expect(() => applyReconstructionPatch(base(), [replace(path)])).toThrow("RECONSTRUCTION_PATCH_");
    }
    expect(() => applyReconstructionPatch(base(), [replace("/builderLenses/contentRestoration"),
      replace("/builderLenses/contentRestoration")])).toThrow("RECONSTRUCTION_PATCH_PATH_OVERLAP");
    expect(() => applyReconstructionPatch(base(), [replace("/builderLenses"),
      replace("/builderLenses/contentRestoration/text")])).toThrow("RECONSTRUCTION_PATCH_PATH_OVERLAP");
    expect(() => applyReconstructionPatch(base(), Array.from({ length: 65 }, () => replace("/metaGate"))))
      .toThrow("RECONSTRUCTION_PATCH_EDIT_COUNT_INVALID");
    const pollutedValue = JSON.parse('{"__proto__":{"polluted":true}}') as unknown;
    expect(() => applyReconstructionPatch(base(), [{ op: "replace", path: "/metaGate", value: pollutedValue }]))
      .toThrow("RECONSTRUCTION_PATCH_PROTOTYPE_FIELD");
  });
});
