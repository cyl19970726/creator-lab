import fs from "node:fs";
import path from "node:path";
import { ValidatedDraftStore, type ValidatedDraftReceipt, type ValidatedDraftRef } from "./validated-draft-store.js";
import { applyReconstructionPatch } from "./reconstruction-patch.js";

export const builderLensSlots = ["contentRestoration", "directingLogic", "visualEditing"] as const;
export type BuilderLensSlot = typeof builderLensSlots[number];
export type BuilderLensHandle = ValidatedDraftRef;
export type BuilderLensIndex = Record<BuilderLensSlot, BuilderLensHandle>;
type Validator = (slot: BuilderLensSlot, value: unknown) => Promise<{ pass: boolean; errors: string[] }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function referencedDefinitions(root: unknown, defs: Record<string, unknown>): Record<string, unknown> {
  const refs = new Set<string>();
  const scan = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(scan); return; }
    if (!isRecord(value)) return;
    if (typeof value.$ref === "string") {
      const match = value.$ref.match(/^#\/\$defs\/([^/]+)$/u);
      if (match) refs.add(match[1]!);
    }
    Object.values(value).forEach(scan);
  };
  scan(root);
  const selected: Record<string, unknown> = {};
  const visited = new Set<string>();
  while (refs.size) {
    const [name] = refs;
    refs.delete(name!);
    if (visited.has(name!)) continue;
    visited.add(name!);
    const definition = defs[name!];
    if (definition === undefined) throw new Error(`BUILDER_LENS_SCHEMA_REF_MISSING:${name}`);
    selected[name!] = definition;
    scan(definition);
  }
  return selected;
}

/** The canonical full-report schema with only the three large lens definitions removed. */
export function builderLensIndexSchema(schemaPath: string): Record<string, unknown> {
  const full = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
  const source = full.properties as Record<string, unknown>;
  const properties = Object.fromEntries(Object.entries(source).filter(([key]) => key !== "builderLenses" && key !== "transcript"));
  const required = Array.isArray(full.required) ? full.required.filter((key): key is string =>
    key !== "transcript" && key !== "builderLenses") : [];
  required.push("summaryContractVersion");
  const root = { type: full.type, required, additionalProperties: false, properties };
  const defs = full.$defs as Record<string, unknown>;
  return { $schema: full.$schema, $id: full.$id, ...root, $defs: referencedDefinitions(root, defs) };
}

/** Tool-call shape allows either a complete legacy report or a lens index, never a model transcript. */
export function builderLensDraftToolParameters(schemaPath: string): Record<string, unknown> {
  const full = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
  const canonicalProperties = full.properties as Record<string, unknown>;
  const reportProperties = Object.fromEntries(Object.keys(canonicalProperties)
    .filter(key => key !== "transcript").map(key => [key, {}]));
  const reportRequired = Array.isArray(full.required)
    ? full.required.filter((key): key is string => key !== "transcript" && key !== "builderLenses") : [];
  reportRequired.push("summaryContractVersion");
  return {
    type: "object", additionalProperties: false, required: ["reconstruction"],
    properties: {
      reconstruction: { type: "object", additionalProperties: false, required: reportRequired, properties: reportProperties },
      useLatestBuilderLenses: { type: "boolean", enum: [true] },
      builderLensDrafts: { type: "object" },
      finalSummary: (full.$defs as Record<string, unknown>).finalSummary
    }
  };
}

/** Build a small, canonical-schema subset for exactly one Builder lens, retaining all referenced $defs. */
export function builderLensSchema(schemaPath: string, slot: BuilderLensSlot): Record<string, unknown> {
  const full = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
  const defs = full.$defs as Record<string, unknown>;
  const lenses = defs.builderLenses as { properties: Record<string, unknown> };
  const root = lenses.properties[slot];
  const selected = referencedDefinitions(root, defs);
  const requiredByDepthContract: Partial<Record<BuilderLensSlot, string>> = {
    directingLogic: "packagingAnalysis", visualEditing: "openingAnalysis"
  };
  const required = requiredByDepthContract[slot];
  if (required && isRecord(selected[slot])) {
    const definition = selected[slot] as Record<string, unknown>;
    const oldRequired = Array.isArray(definition.required) ? definition.required as string[] : [];
    selected[slot] = { ...definition, required: [...new Set([...oldRequired, required])] };
  }
  return { $schema: full.$schema, $defs: selected, ...(
    isRecord(root) && typeof root.$ref === "string" ? { $ref: root.$ref } : { ...root as Record<string, unknown> }
  ) };
}

/** Attempt-local store for complete lens values; slot and exact hash are required when composing. */
export class BuilderLensDrafts {
  private readonly stores: Record<BuilderLensSlot, ValidatedDraftStore<unknown>>;
  private readonly latest = new Map<BuilderLensSlot, ValidatedDraftRef>();

  constructor(directory: string, private readonly validate: Validator) {
    this.stores = Object.fromEntries(builderLensSlots.map(slot => [slot,
      new ValidatedDraftStore(path.join(directory, `.builder-lens-${slot}`), `builder-lens-${slot}`)])) as
      Record<BuilderLensSlot, ValidatedDraftStore<unknown>>;
  }

  async stage(slot: BuilderLensSlot, value: unknown): Promise<ValidatedDraftReceipt> {
    this.assertSlot(slot);
    const validation = await this.validate(slot, value);
    const receipt = this.stores[slot].stage(value, validation);
    this.latest.set(slot, { draftId: receipt.draftId, sha256: receipt.sha256 });
    return receipt;
  }

  latestRef(slot: BuilderLensSlot): ValidatedDraftRef | undefined {
    this.assertSlot(slot);
    const ref = this.latest.get(slot);
    return ref ? { ...ref } : undefined;
  }

  resolve(slot: BuilderLensSlot, ref: ValidatedDraftRef): unknown {
    this.assertLatest(slot, ref);
    return this.stores[slot].resolve(ref, { requireValid: true });
  }

  async revise(slot: BuilderLensSlot, ref: ValidatedDraftRef, patches: unknown): Promise<ValidatedDraftReceipt> {
    this.assertLatest(slot, ref);
    const current = this.stores[slot].resolve(ref, { requireValid: false });
    const patched = applyReconstructionPatch({ [slot]: current }, patches, [slot],
      { allowAddMissingObjectProperty: true }) as Record<string, unknown>;
    return this.stage(slot, patched[slot]);
  }

  compose(index: unknown, handles: unknown, finalSummary?: unknown): Record<string, unknown> {
    if (!isRecord(index) || Object.hasOwn(index, "builderLenses")) {
      throw new Error("BUILDER_LENS_INDEX_INVALID_OR_INLINE_MIXED");
    }
    if (Object.hasOwn(index, "transcript")) throw new Error("BUILDER_LENS_INDEX_HOST_FIELD_PRESENT:transcript");
    if (index.summaryContractVersion === "single-post-summary@1" && !isRecord(finalSummary)) {
      throw new Error("BUILDER_LENS_FINAL_SUMMARY_REQUIRED");
    }
    if (index.summaryContractVersion !== "single-post-summary@1" && finalSummary !== undefined) {
      throw new Error("BUILDER_LENS_FINAL_SUMMARY_CONTRACT_MISSING");
    }
    if (!isRecord(handles) || Object.keys(handles).length !== builderLensSlots.length
      || builderLensSlots.some(slot => !Object.hasOwn(handles, slot))) {
      throw new Error("BUILDER_LENS_HANDLES_INCOMPLETE");
    }
    const builderLenses: Record<string, unknown> = {};
    for (const slot of builderLensSlots) {
      const handle = handles[slot];
      if (!isRecord(handle) || typeof handle.draftId !== "string"
        || typeof handle.sha256 !== "string") throw new Error(`BUILDER_LENS_HANDLE_INVALID:${slot}`);
      const latest = this.latest.get(slot);
      if (!latest || latest.draftId !== handle.draftId || latest.sha256 !== handle.sha256) {
        throw new Error(`BUILDER_LENS_HANDLE_NOT_LATEST:${slot}`);
      }
      builderLenses[slot] = this.stores[slot].resolve(handle as BuilderLensHandle, { requireValid: true });
    }
    return { ...index, builderLenses: finalSummary === undefined ? builderLenses : { ...builderLenses, finalSummary } };
  }

  private assertSlot(slot: BuilderLensSlot): void {
    if (!(builderLensSlots as readonly string[]).includes(slot)) throw new Error("BUILDER_LENS_SLOT_INVALID");
  }

  private assertLatest(slot: BuilderLensSlot, ref: ValidatedDraftRef): void {
    this.assertSlot(slot);
    const latest = this.latest.get(slot);
    if (!latest || !ref || latest.draftId !== ref.draftId || latest.sha256 !== ref.sha256) {
      throw new Error(`BUILDER_LENS_HANDLE_NOT_LATEST:${slot}`);
    }
  }
}
