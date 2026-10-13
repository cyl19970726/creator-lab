import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const OCR_INPUT_FRAME_LIMIT = 512;
type SourceFrame = { id: string; time: number; frame: string };
type CaptureAction = { id: string; index: number; mode: string; range: { start: number; end: number }; times?: number[] };
type TargetFrame = { id: string; time: number; frame: string; actionId: string; contentHash?: string };
type TargetManifest = { frames: TargetFrame[]; actions: Array<{ id: string; frameIds: string[] }> };
export type OcrInputFrame = { id: string; time: number; frame: string; actionId: string; actionIds: string[];
  origin: "source" | "target"; sha256: string };
export type OcrInputManifest = { schemaVersion: "ocr-input-1.0"; protocol: string; protocolSha256: string;
  sourcePack: { path: string; sha256: string }; targetedManifest: { path: string; sha256: string };
  actions: Array<{ id: string; range: { start: number; end: number }; frameIds: string[] }>;
  frames: OcrInputFrame[] };
export type OcrUnionPreflight = { pass: boolean; limit: number; sourceFrames: number; plannedTargetTimes: number;
  upperBound: number; actions: Array<{ id: string; range: { start: number; end: number }; sourceFrames: number;
    plannedTargetTimes: number }>; errors: Array<{ code: "OCR_FRAME_LIMIT" | "OCR_ACTION_TARGET_TIME_OUTSIDE_RANGE"; path: string; message: string }> };

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const imagePath = /^frames\/[A-Za-z0-9._/-]+\.(?:jpg|jpeg|png)$/u;
const idPattern = /^[A-Za-z0-9_-]+$/u;
const plain = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function frameIndex(pack: unknown): SourceFrame[] {
  const rows = (pack as { frameIndex?: unknown } | null)?.frameIndex;
  if (!Array.isArray(rows)) throw new Error("OCR_SOURCE_FRAME_INDEX_INVALID");
  const seen = new Set<string>();
  return rows.map((row, index) => {
    if (!plain(row) || typeof row.id !== "string" || !idPattern.test(row.id)
      || typeof row.time !== "number" || !Number.isFinite(row.time) || row.time < 0
      || typeof row.frame !== "string" || !imagePath.test(row.frame)
      || row.frame.split("/").some((part: string) => part === ".." || part === ".") || seen.has(row.id)) {
      throw new Error(`OCR_SOURCE_FRAME_INDEX_INVALID:${index}`);
    }
    seen.add(row.id);
    return { id: row.id, time: row.time, frame: row.frame };
  });
}

function textActions(protocol: unknown): CaptureAction[] {
  const actions = (protocol as { captureActions?: unknown } | null)?.captureActions;
  if (!Array.isArray(actions)) throw new Error("OCR_PROTOCOL_ACTIONS_INVALID");
  const ids = new Set<string>();
  const selected: CaptureAction[] = [];
  for (const [index, action] of actions.entries()) {
    if (!plain(action) || typeof action.id !== "string" || !idPattern.test(action.id) || ids.has(action.id)) {
      throw new Error(`OCR_PROTOCOL_ACTION_INVALID:${index}`);
    }
    ids.add(action.id);
    if (action.mode !== "ocr_review" && action.mode !== "ui_state_review") continue;
    const range = action.range;
    if (!plain(range) || typeof range.start !== "number" || typeof range.end !== "number"
      || !Number.isFinite(range.start) || !Number.isFinite(range.end)
      || range.start < 0 || range.end < range.start) throw new Error(`OCR_PROTOCOL_RANGE_INVALID:${action.id}`);
    selected.push({ id: action.id, index, mode: action.mode, range: { start: range.start, end: range.end },
      times: Array.isArray(action.times) ? action.times as number[] : undefined });
  }
  return selected;
}

function selectedSource(frames: readonly SourceFrame[], action: CaptureAction): SourceFrame[] {
  return frames.filter(frame => frame.time >= action.range.start && frame.time <= action.range.end);
}

/** Conservative upper bound: TARGET content deduplication can reduce this count, never increase it. */
export function preflightOcrInputUnion(pack: unknown, protocol: unknown,
  planned: readonly { id: string; selectedTimes: readonly number[] }[], limit = OCR_INPUT_FRAME_LIMIT): OcrUnionPreflight {
  const frames = frameIndex(pack);
  const actions = textActions(protocol);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("OCR_FRAME_LIMIT_INVALID");
  const plans = new Map<string, readonly number[]>();
  for (const row of planned) {
    if (plans.has(row.id) || !Array.isArray(row.selectedTimes) || row.selectedTimes.some(time =>
      typeof time !== "number" || !Number.isFinite(time) || time < 0)) throw new Error("OCR_PLAN_INVALID");
    plans.set(row.id, row.selectedTimes);
  }
  const source = new Set<string>();
  const targetTimes = new Set<string>();
  const errors: OcrUnionPreflight["errors"] = [];
  const rows = actions.map(action => {
    const times = plans.get(action.id);
    if (!times) throw new Error(`OCR_PLAN_ACTION_MISSING:${action.id}`);
    const sourceRows = selectedSource(frames, action);
    for (const frame of sourceRows) source.add(frame.id);
    for (const time of action.times ?? []) {
      if (time < action.range.start || time > action.range.end) {
        errors.push({ code: "OCR_ACTION_TARGET_TIME_OUTSIDE_RANGE", path: `/captureActions/${action.index}/times`,
          message: `${action.id} explicit TARGET time ${time}s lies outside its requested OCR/UI range ${action.range.start}–${action.range.end}s. Correct action.times or the requested range.` });
      }
    }
    for (const time of times) targetTimes.add(time.toFixed(2));
    return { id: action.id, range: action.range, sourceFrames: sourceRows.length,
      plannedTargetTimes: new Set(times.map(time => time.toFixed(2))).size };
  });
  const upperBound = source.size + targetTimes.size;
  if (upperBound > limit) errors.push({ code: "OCR_FRAME_LIMIT", path: "/captureActions",
    message: `OCR text-action windows include ${source.size} unique frozen source frame IDs and ${targetTimes.size} planned unique TARGET times: upper bound ${upperBound}/${limit} (${upperBound - limit} over). Narrow the requested OCR/UI ranges and/or reduce their explicit times; changing ranges alone will not reduce nonempty action.times. No frames were omitted.` });
  return { pass: errors.length === 0, limit, sourceFrames: source.size, plannedTargetTimes: targetTimes.size,
    upperBound, actions: rows, errors };
}

function verifiedImage(root: string, relative: string): { path: string; sha256: string } {
  if (!imagePath.test(relative) || relative.split("/").some(part => part === "." || part === "..")) {
    throw new Error(`OCR_FRAME_PATH_INVALID:${relative}`);
  }
  const absolute = path.resolve(root, relative);
  const within = path.relative(root, absolute);
  if (within.startsWith(`..${path.sep}`) || within === ".." || path.isAbsolute(within)) {
    throw new Error(`OCR_FRAME_PATH_OUTSIDE_ROOT:${relative}`);
  }
  if (fs.realpathSync(absolute) !== path.resolve(fs.realpathSync(root), relative)
    || !fs.statSync(absolute).isFile()) {
    throw new Error(`OCR_FRAME_PATH_IDENTITY_INVALID:${relative}`);
  }
  return { path: absolute, sha256: hash(fs.readFileSync(absolute)) };
}

function readJson(file: string): unknown { return JSON.parse(fs.readFileSync(file, "utf8")); }
function shaFile(file: string): string { return hash(fs.readFileSync(file)); }

/** Construct exactly one OCR record per frozen frame ID, preserving all requesting text actions. */
export function computeOcrInputManifest(outputDir: string): OcrInputManifest {
  const sourcePath = path.join(outputDir, "evidence/evidence-pack.json");
  const targetedPath = path.join(outputDir, "targeted-evidence/targeted-evidence.json");
  const protocolPath = path.join(outputDir, "capture-protocol.json");
  const sourceFrames = frameIndex(readJson(sourcePath));
  const actions = textActions(readJson(protocolPath));
  const target = readJson(targetedPath) as TargetManifest;
  if (!target || !Array.isArray(target.frames) || !Array.isArray(target.actions)) throw new Error("OCR_TARGET_MANIFEST_INVALID");
  const sourceIds = new Set(sourceFrames.map(frame => frame.id));
  const targetById = new Map<string, TargetFrame>();
  for (const [index, frame] of target.frames.entries()) {
    if (!plain(frame) || typeof frame.id !== "string" || !/^TARGET-\d{4}$/u.test(frame.id)
      || sourceIds.has(frame.id) || targetById.has(frame.id)
      || typeof frame.time !== "number" || !Number.isFinite(frame.time) || frame.time < 0
      || typeof frame.frame !== "string" || !imagePath.test(frame.frame)
      || typeof frame.actionId !== "string") throw new Error(`OCR_TARGET_FRAME_INVALID:${index}`);
    targetById.set(frame.id, frame);
  }
  const targetActionMap = new Map<string, string[]>();
  for (const row of target.actions) {
    if (!plain(row) || typeof row.id !== "string" || !Array.isArray(row.frameIds)
      || targetActionMap.has(row.id) || row.frameIds.some(id => typeof id !== "string" || !targetById.has(id))) {
      throw new Error("OCR_TARGET_ACTION_INVALID");
    }
    targetActionMap.set(row.id, row.frameIds);
  }
  const inputById = new Map<string, OcrInputFrame>();
  const manifestActions: OcrInputManifest["actions"] = [];
  const add = (frame: OcrInputFrame, actionId: string) => {
    const existing = inputById.get(frame.id);
    if (existing) {
      if (existing.origin !== frame.origin || existing.frame !== frame.frame || existing.time !== frame.time
        || existing.sha256 !== frame.sha256) throw new Error(`OCR_FRAME_ID_CONFLICT:${frame.id}`);
      if (!existing.actionIds.includes(actionId)) existing.actionIds.push(actionId);
    } else inputById.set(frame.id, frame);
  };
  for (const action of actions) {
    const frameIds: string[] = [];
    for (const frame of selectedSource(sourceFrames, action)) {
      const checked = verifiedImage(path.join(outputDir, "evidence"), frame.frame);
      add({ id: frame.id, time: frame.time, frame: `evidence/${frame.frame}`, actionId: action.id,
        actionIds: [action.id], origin: "source", sha256: checked.sha256 }, action.id);
      frameIds.push(frame.id);
    }
    const targets = targetActionMap.get(action.id);
    if (!targets?.length) throw new Error(`OCR_TARGET_ACTION_MISSING:${action.id}`);
    for (const id of targets) {
      const frame = targetById.get(id)!;
      // Content-hash reuse can give an action a TARGET whose canonical frame time is earlier.
      // The validated action->frame ID mapping, not that canonical time, selects TARGET pixels.
      const checked = verifiedImage(path.join(outputDir, "targeted-evidence"), frame.frame);
      if (frame.contentHash && frame.contentHash !== checked.sha256) throw new Error(`OCR_TARGET_HASH_MISMATCH:${id}`);
      add({ id, time: frame.time, frame: `targeted-evidence/${frame.frame}`, actionId: action.id,
        actionIds: [action.id], origin: "target", sha256: checked.sha256 }, action.id);
      if (!frameIds.includes(id)) frameIds.push(id);
    }
    manifestActions.push({ id: action.id, range: action.range, frameIds });
  }
  const frames = [...inputById.values()].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  if (frames.length > OCR_INPUT_FRAME_LIMIT) throw new Error(`OCR_FRAME_LIMIT:${frames.length}/${OCR_INPUT_FRAME_LIMIT}:Narrow requested OCR/UI ranges or reduce explicit times; no frames were omitted.`);
  return { schemaVersion: "ocr-input-1.0", protocol: "capture-protocol.json", protocolSha256: shaFile(protocolPath),
    sourcePack: { path: "evidence/evidence-pack.json", sha256: shaFile(sourcePath) },
    targetedManifest: { path: "targeted-evidence/targeted-evidence.json", sha256: shaFile(targetedPath) },
    actions: manifestActions, frames };
}

export function writeOcrInputManifest(outputDir: string): { path: string; manifest: OcrInputManifest } {
  const manifest = computeOcrInputManifest(outputDir);
  const file = path.join(outputDir, "ocr-input-manifest.json");
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { path: file, manifest };
}

/** Rebuild from frozen inputs; fail rather than using a stale or expanded OCR manifest. */
export function readVerifiedOcrInputManifest(outputDir: string): { path: string; manifest: OcrInputManifest } {
  const file = path.join(outputDir, "ocr-input-manifest.json");
  const stored = readJson(file);
  const expected = computeOcrInputManifest(outputDir);
  if (JSON.stringify(stored) !== JSON.stringify(expected)) throw new Error("OCR_INPUT_MANIFEST_CHANGED");
  return { path: file, manifest: expected };
}

export function assertCompleteOcrResult(value: unknown, manifest: OcrInputManifest): void {
  if ((value as { schemaVersion?: unknown } | null)?.schemaVersion !== "ocr-evidence-1.0") {
    throw new Error("OCR_RESULT_SCHEMA_INVALID");
  }
  if ((value as { sourceFrameBase?: unknown } | null)?.sourceFrameBase !== "candidate-root") {
    throw new Error("OCR_RESULT_FRAME_BASE_INVALID");
  }
  const rows = (value as { frames?: unknown } | null)?.frames;
  if (!Array.isArray(rows) || rows.length !== manifest.frames.length) throw new Error("OCR_RESULT_FRAME_SET_INCOMPLETE");
  const expected = new Map(manifest.frames.map(frame => [frame.id, frame]));
  const seen = new Set<string>();
  const lineIds = new Set<string>();
  for (const row of rows) {
    if (!plain(row) || typeof row.frameId !== "string" || seen.has(row.frameId)) throw new Error("OCR_RESULT_FRAME_DUPLICATE_OR_INVALID");
    seen.add(row.frameId);
    const frame = expected.get(row.frameId);
    if (!frame || row.time !== frame.time || row.sourceFrame !== frame.frame
      || row.actionId !== frame.actionId || JSON.stringify(row.actionIds) !== JSON.stringify(frame.actionIds)
      || (row.status !== "processed" && row.status !== "failed") || !Array.isArray(row.lines)) {
      throw new Error(`OCR_RESULT_FRAME_MISMATCH:${row.frameId}`);
    }
    for (const line of row.lines) {
      if (!plain(line) || typeof line.id !== "string" || lineIds.has(line.id)) throw new Error("OCR_RESULT_LINE_ID_INVALID");
      lineIds.add(line.id);
    }
  }
}
