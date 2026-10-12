export const RECONSTRUCTION_PATCH_ALLOWED_ROOTS = ["builderLenses", "knowledgeUnits", "relations", "scopeStatement",
  "viewerChange", "coverageMatrix", "metaGate", "derivedSources"] as const;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);

type ReplacePatch = { op: "replace"; path: string; value: unknown };

function fail(reason: string): never { throw new Error(`RECONSTRUCTION_PATCH_${reason}`); }

function cloneJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") fail("VALUE_NOT_JSON");
  if (seen.has(value)) fail("CYCLIC_VALUE");
  seen.add(value);
  if (Array.isArray(value)) {
    const copy = value.map((item) => cloneJson(item, seen));
    seen.delete(value);
    return copy;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail("VALUE_NOT_PLAIN_OBJECT");
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (forbidden.has(key)) fail("PROTOTYPE_FIELD");
    copy[key] = cloneJson(item, seen);
  }
  seen.delete(value);
  return copy;
}

function tokens(pointer: string): string[] {
  if (!pointer.startsWith("/") || pointer === "/") fail("PATH_INVALID");
  return pointer.slice(1).split("/").map((part) => {
    if (/~(?![01])/u.test(part)) fail("POINTER_ESCAPE_INVALID");
    const decoded = part.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (!decoded || forbidden.has(decoded)) fail("PATH_FORBIDDEN");
    return decoded;
  });
}

function child(parent: unknown, key: string): unknown {
  if (Array.isArray(parent)) {
    if (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= parent.length) fail("ARRAY_INDEX_INVALID");
    return parent[Number(key)];
  }
  if (!parent || typeof parent !== "object" || !Object.prototype.hasOwnProperty.call(parent, key)) fail("PATH_MISSING");
  return (parent as Record<string, unknown>)[key];
}

function overlap(left: string[], right: string[]): boolean {
  const short = Math.min(left.length, right.length);
  return left.slice(0, short).every((part, index) => part === right[index]);
}

/** Apply a bounded, replace-only JSON Pointer patch to a clone of a reconstruction draft. */
export function applyReconstructionPatch(base: unknown, patches: unknown,
  allowedRoots: readonly string[] = RECONSTRUCTION_PATCH_ALLOWED_ROOTS): unknown {
  if (!Array.isArray(patches) || patches.length > 64) fail("EDIT_COUNT_INVALID");
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0
    || allowedRoots.some((root) => typeof root !== "string" || !root || forbidden.has(root) || root.includes("/"))) {
    fail("ALLOWED_ROOTS_INVALID");
  }
  const edits: Array<{ parts: string[]; value: unknown }> = [];
  for (const item of patches as unknown[]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail("EDIT_INVALID");
    if (Object.getPrototypeOf(item) !== Object.prototype || !Object.prototype.hasOwnProperty.call(item, "op")
      || !Object.prototype.hasOwnProperty.call(item, "path")) fail("EDIT_INVALID");
    const patch = item as Partial<ReplacePatch>;
    if (patch.op !== "replace" || typeof patch.path !== "string" || !Object.prototype.hasOwnProperty.call(item, "value")
      || Object.keys(item).some((key) => !["op", "path", "value"].includes(key))) fail("EDIT_INVALID");
    const parts = tokens(patch.path);
    if (!allowedRoots.includes(parts[0]!)) fail("ROOT_NOT_ALLOWED");
    if (edits.some((existing) => overlap(existing.parts, parts))) fail("PATH_OVERLAP");
    edits.push({ parts, value: cloneJson(patch.value) });
  }
  const result = cloneJson(base);
  for (const { parts } of edits) {
    let cursor: unknown = result;
    for (const part of parts) cursor = child(cursor, part);
  }
  for (const { parts, value } of edits) {
    let parent: unknown = result;
    for (const part of parts.slice(0, -1)) parent = child(parent, part);
    const last = parts.at(-1)!;
    child(parent, last); // A replace target must already exist.
    if (Array.isArray(parent)) parent[Number(last)] = value;
    else (parent as Record<string, unknown>)[last] = value;
  }
  return result;
}
