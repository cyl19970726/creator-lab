import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ValidatedDraftStore } from "./validated-draft-store.js";

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "validated-draft-store-")); });
afterEach(() => { vi.useRealTimers(); fs.rmSync(directory, { recursive: true, force: true }); });

describe("ValidatedDraftStore", () => {
  it("returns a deep clone and accepts only a validated draft from its own instance", () => {
    const store = new ValidatedDraftStore<{ builderLenses: { contentRestoration: string } }>(directory, "phase2");
    const input = { builderLenses: { contentRestoration: "original" } };
    const ref = store.stage(input, { pass: true });
    input.builderLenses.contentRestoration = "later mutation";
    const first = store.resolve(ref);
    expect(first.builderLenses.contentRestoration).toBe("original");
    first.builderLenses.contentRestoration = "returned mutation";
    expect(store.resolve(ref).builderLenses.contentRestoration).toBe("original");
    expect(() => new ValidatedDraftStore(directory, "phase2").resolve(ref)).toThrow("VALIDATED_DRAFT_UNKNOWN_OR_SHA_MISMATCH");
    expect(() => store.resolve({ ...ref, sha256: "0".repeat(64) })).toThrow("VALIDATED_DRAFT_UNKNOWN_OR_SHA_MISMATCH");
  });

  it("keeps failed drafts available for correction but blocks final acceptance", () => {
    const store = new ValidatedDraftStore(directory, "phase2");
    const ref = store.stage({ report: "needs a fix" }, { pass: false, errors: ["missing evidence"] });
    expect(ref).toMatchObject({ pass: false, errors: ["missing evidence"] });
    expect(() => store.resolve(ref)).toThrow("VALIDATED_DRAFT_NOT_VALID");
    expect(store.resolve(ref, { requireValid: false })).toEqual({ report: "needs a fix" });
  });

  it("detects changed body or manifest and rejects expired drafts", () => {
    const store = new ValidatedDraftStore(directory, "phase2");
    const ref = store.stage({ report: "accepted" }, { pass: true });
    const root = fs.readdirSync(directory).map((name) => path.join(directory, name))[0]!;
    const body = path.join(root, `${ref.draftId}.json`);
    fs.writeFileSync(body, '{"report":"tampered"}\n');
    expect(() => store.resolve(ref)).toThrow("VALIDATED_DRAFT_FILE_CHANGED");
    fs.writeFileSync(body, '{"report":"accepted"}\n');
    const manifest = path.join(root, "manifest.json");
    const original = fs.readFileSync(manifest, "utf8");
    fs.writeFileSync(manifest, original.replace("phase2", "other"));
    expect(() => store.resolve(ref)).toThrow("VALIDATED_DRAFT_MANIFEST_CHANGED");
    fs.writeFileSync(manifest, original);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    expect(() => store.resolve(ref)).toThrow("VALIDATED_DRAFT_EXPIRED");
  });

  it("rejects a symlinked draft body even if its bytes match", () => {
    const store = new ValidatedDraftStore(directory, "phase2");
    const ref = store.stage({ report: "accepted" }, { pass: true });
    const root = fs.readdirSync(directory).map((name) => path.join(directory, name))[0]!;
    const body = path.join(root, `${ref.draftId}.json`);
    const target = path.join(directory, "outside.json");
    fs.copyFileSync(body, target);
    fs.rmSync(body);
    fs.symlinkSync(target, body);
    expect(() => store.resolve(ref)).toThrow("VALIDATED_DRAFT_FILE_CHANGED");
  });
});
