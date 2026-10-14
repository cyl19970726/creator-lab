import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { SiwcImage, SiwcTool, SiwcVisualToolResult } from "@signal-room/workflow-agent-sdk";
import { artifactPath } from "../core/artifacts.js";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const textExtensions = new Set([".json", ".txt", ".md", ".srt", ".vtt", ".csv"]);
const toolHint = (error: string, ref: string, suggestedTool: string): Record<string, string> => ({ error, ref, suggestedTool });
const unboundRefHint = (unknownRefs: readonly string[], eligibleRefs: readonly string[], suggestedTool: string,
  maxRefs = eligibleRefs.length) => ({
  success: false, error: "RESPONSES_EVIDENCE_NOT_BOUND", unknownRefs: unknownRefs.map(ref => ref.slice(0, 128)),
  eligibleRefs: eligibleRefs.slice(0, maxRefs), eligibleRefCount: eligibleRefs.length,
  eligibleRefsComplete: eligibleRefs.length <= maxRefs, suggestedTool,
  recovery: `Use an exact bound ref from eligibleRefs with ${suggestedTool}; no evidence was read or inspected.`
});

export type BoundEvidence = { ref: string; path: string; sha256: string };
export type CapturedFrame = { id: string; timeSeconds: number; path: string; sha256: string };
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const bundleCharacterLimit = 500_000;
const bundleImageByteLimit = 32 * 1024 * 1024;
// Keep in sync with the official SIWC image transport's per-image base64 limit.
const siwcImageBase64CharacterLimit = 20_000_000;

export type EvidenceBundle = SiwcVisualToolResult & { value: {
  format: "full-field-compact-json-and-exact-text";
  text: Array<{ ref: string; sha256: string; sourceCharacters: number; deliveredCharacters: number;
    format: "json" | "text"; content: string }>;
  imageRefs: Array<{ ref: string; sha256: string; mimeType: SiwcImage["mimeType"]; bytes: number }>;
  coverage: { textRefs: number; imageRefs: number; sourceCharacters: number; deliveredCharacters: number };
} };

function mime(file: string): SiwcImage["mimeType"] | null {
  const extension = path.extname(file).toLowerCase();
  return extension === ".jpg" || extension === ".jpeg" ? "image/jpeg"
    : extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp"
      : extension === ".gif" ? "image/gif" : null;
}

function matchesImageType(bytes: Buffer, type: SiwcImage["mimeType"]): boolean {
  if (type === "image/png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (type === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === "image/gif") return bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6));
  return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF"
    && bytes.toString("ascii", 8, 12) === "WEBP";
}

function compactJsonWhitespace(source: string): string {
  JSON.parse(source);
  let inString = false;
  let escaped = false;
  let compact = "";
  for (const character of source) {
    if (inString) {
      compact += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') {
      inString = true;
      compact += character;
    } else if (character !== " " && character !== "\t" && character !== "\n" && character !== "\r") {
      compact += character;
    }
  }
  return compact;
}

/** Exact input refs only. No directory traversal, shell, network or arbitrary artifact lookup. */
export class ResponsesEvidenceTools {
  readonly captures: CapturedFrame[] = [];
  readonly inspectedImages = new Set<string>();
  readonly readRefs = new Set<string>();
  private readonly textCoverage = new Map<string, { total: number; ranges: Array<[number, number]> }>();
  private readonly allowed = new Map<string, BoundEvidence>();
  constructor(evidence: readonly BoundEvidence[], private readonly outputDir: string,
    private readonly mediaPath?: string, private readonly maximumFrames = 16) {
    for (const item of evidence) {
      if (this.allowed.has(item.ref)) throw new Error("RESPONSES_DUPLICATE_EVIDENCE_REF");
      this.allowed.set(item.ref, item);
    }
  }

  addGenerated(ref: string, file: string): void {
    const absolute = path.resolve(file);
    const root = path.resolve(this.outputDir);
    if (!absolute.startsWith(`${root}${path.sep}`) || !fs.statSync(absolute).isFile()) throw new Error("RESPONSES_GENERATED_PATH_INVALID");
    this.allowed.set(ref, { ref, path: absolute, sha256: sha(fs.readFileSync(absolute)) });
  }

  private bound(ref: string): BoundEvidence {
    const item = this.allowed.get(ref);
    if (!item) throw new Error("RESPONSES_EVIDENCE_NOT_BOUND");
    if (sha(fs.readFileSync(item.path)) !== item.sha256) throw new Error("RESPONSES_EVIDENCE_MUTATED");
    return item;
  }

  private boundBytes(ref: string): { item: BoundEvidence; bytes: Buffer } {
    const item = this.allowed.get(ref);
    if (!item) throw new Error("RESPONSES_EVIDENCE_NOT_BOUND");
    const bytes = fs.readFileSync(item.path);
    if (sha(bytes) !== item.sha256) throw new Error("RESPONSES_EVIDENCE_MUTATED");
    return { item, bytes };
  }

  list(): string[] { return [...this.allowed.keys()]; }
  /** Host-only binding metadata copy. Actual reads verify bytes; copying gives no observation credit. */
  snapshotBindings(): BoundEvidence[] { return [...this.allowed.values()].map(item => ({ ...item })); }
  /** Independent Agent contexts never inherit another call's read/image observations. */
  fork(outputDir: string): ResponsesEvidenceTools {
    return new ResponsesEvidenceTools(this.snapshotBindings(), outputDir);
  }
  /** Deliver a bounded prefix, shrinking on aggregate transport overflow without skipping any ref. */
  readImageBatch(refs: readonly string[]): ReturnType<ResponsesEvidenceTools["readBundle"]> {
    let count = Math.min(refs.length, 24);
    while (true) {
      const result = this.readBundle([], refs.slice(0, count));
      if (!("error" in result) || count <= 1) return result;
      count = Math.max(1, Math.floor(count / 2));
    }
  }
  /** A new model call has no memory of observations made by an earlier call. */
  resetObservationTracking(): void {
    this.textCoverage.clear();
    this.readRefs.clear();
    this.inspectedImages.clear();
  }
  fullyRead(ref: string): boolean {
    const record = this.textCoverage.get(ref);
    if (!record) return false;
    return this.readProgress(ref).nextOffset >= record.total;
  }
  /** JSON Pointer citations require a fully observed JSON source and an existing value. */
  jsonPointerProblem(ref: string, pointer: string): string | null {
    const item = this.allowed.get(ref);
    if (!item) return "base ref is not bound";
    if (mime(item.path) || path.extname(item.path).toLowerCase() !== ".json") return "pointer citations require a bound JSON ref";
    if (!this.fullyRead(ref)) return "the referenced JSON ref has not been fully read";
    let root: unknown;
    try { root = JSON.parse(fs.readFileSync(item.path, "utf8")); }
    catch { return "the bound JSON ref cannot be parsed"; }
    return resolveJsonPointer(root, pointer) ? null : "JSON Pointer is invalid or does not resolve to an existing value";
  }
  readProgress(ref: string): { nextOffset: number; totalCharacters: number } {
    const item = this.bound(ref);
    if (mime(item.path) || !textExtensions.has(path.extname(item.path).toLowerCase())) throw new Error("RESPONSES_NON_TEXT_EVIDENCE");
    const record = this.textCoverage.get(ref);
    if (!record) return { nextOffset: 0, totalCharacters: fs.readFileSync(item.path, "utf8").length };
    const sorted = [...record.ranges].sort((a, b) => a[0] - b[0]);
    let covered = 0;
    for (const [start, end] of sorted) {
      if (start > covered) break;
      covered = Math.max(covered, end);
    }
    return { nextOffset: covered, totalCharacters: record.total };
  }

  /** Verify the entire bounded batch before recording any observation. JSON changes only in whitespace. */
  readBundle(textRefs: readonly string[], imageRefs: readonly string[], characterLimit = bundleCharacterLimit): EvidenceBundle | {
    success: false; error: "RESPONSES_CONTEXT_BUNDLE_TOO_LARGE"; requiredCharacters: number; characterLimit: number;
    requiredImageBytes: number; imageByteLimit: number; imageBase64CharacterLimit: number;
    oversizedImageRefs: Array<{ ref: string; encodedCharacters: number }>;
    recovery: string;
  } {
    if (!Number.isSafeInteger(characterLimit) || characterLimit < 1) throw new Error("RESPONSES_CONTEXT_LIMIT_INVALID");
    if (new Set([...textRefs, ...imageRefs]).size !== textRefs.length + imageRefs.length) {
      throw new Error("RESPONSES_CONTEXT_DUPLICATE_REF");
    }
    const text = textRefs.map(ref => {
      const { item, bytes } = this.boundBytes(ref);
      const extension = path.extname(item.path).toLowerCase();
      if (mime(item.path) || !textExtensions.has(extension)) throw new Error("RESPONSES_NON_TEXT_EVIDENCE");
      const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const format = extension === ".json" ? "json" as const : "text" as const;
      const content = format === "json" ? compactJsonWhitespace(source) : source;
      return { ref, sha256: item.sha256, sourceCharacters: source.length, deliveredCharacters: content.length,
        format, content };
    });
    const images = imageRefs.map(ref => {
      const { item, bytes } = this.boundBytes(ref);
      const type = mime(item.path);
      if (!type) throw new Error("RESPONSES_NOT_IMAGE");
      if (!matchesImageType(bytes, type)) throw new Error("RESPONSES_IMAGE_TYPE_MISMATCH");
      return { ref, sha256: item.sha256, mimeType: type, bytes };
    });
    const sourceCharacters = text.reduce((sum, entry) => sum + entry.sourceCharacters, 0);
    const deliveredCharacters = text.reduce((sum, entry) => sum + entry.deliveredCharacters, 0);
    const imageBytes = images.reduce((sum, entry) => sum + entry.bytes.length, 0);
    const oversizedImageRefs = images.map(({ ref, bytes }) => ({ ref, encodedCharacters: Math.ceil(bytes.length / 3) * 4 }))
      .filter(entry => entry.encodedCharacters > siwcImageBase64CharacterLimit);
    if (deliveredCharacters > characterLimit || imageBytes > bundleImageByteLimit || oversizedImageRefs.length) {
      return { success: false, error: "RESPONSES_CONTEXT_BUNDLE_TOO_LARGE", requiredCharacters: deliveredCharacters,
        characterLimit, requiredImageBytes: imageBytes, imageByteLimit: bundleImageByteLimit,
        imageBase64CharacterLimit: siwcImageBase64CharacterLimit, oversizedImageRefs,
        recovery: oversizedImageRefs.length
          ? `Bound image ref(s) ${oversizedImageRefs.map(entry => entry.ref).join(", ")} exceed the SIWC single-image transport limit; provide smaller bound image derivatives and retry. No observations were recorded.`
          : "Use read_evidence with exact offsets and inspect_image for bound refs; call the readiness tool for remaining offsets." };
    }
    for (const entry of text) {
      const coverage = this.textCoverage.get(entry.ref) ?? { total: entry.sourceCharacters, ranges: [] };
      coverage.ranges.push([0, entry.sourceCharacters]);
      this.textCoverage.set(entry.ref, coverage);
      this.readRefs.add(entry.ref);
    }
    for (const entry of images) { this.inspectedImages.add(entry.ref); this.readRefs.add(entry.ref); }
    return { kind: "siwc_visual_tool_result", value: {
      format: "full-field-compact-json-and-exact-text", text,
      imageRefs: images.map(({ ref, sha256, mimeType, bytes }) => ({ ref, sha256, mimeType, bytes: bytes.length })),
      coverage: { textRefs: text.length, imageRefs: images.length, sourceCharacters, deliveredCharacters }
    }, images: images.map(({ mimeType, bytes }) => ({ mimeType, base64: bytes.toString("base64"), detail: "high" })) };
  }

  tools(): SiwcTool[] {
    const textRefs = [...this.allowed.values()].filter(item => textExtensions.has(path.extname(item.path).toLowerCase())).map(item => item.ref);
    const imageRefs = [...this.allowed.values()].filter(item => mime(item.path)).map(item => item.ref);
    const read: SiwcTool = {
      name: "read_evidence", description: `Read bounded chunks of frozen JSON/text only; use offset to continue. Text refs: ${textRefs.join(", ")}. For image refs use inspect_image.`,
      parameters: { type: "object", additionalProperties: false, required: ["ref"], properties: {
        ref: { type: "string" }, offset: { type: "integer", minimum: 0 }, length: { type: "integer", minimum: 1, maximum: 32768 }
      } },
      execute: async (args) => {
        const { ref, offset = 0, length = 32768 } = args as { ref?: unknown; offset?: unknown; length?: unknown };
        if (typeof ref !== "string") throw new Error("RESPONSES_REF_REQUIRED");
        if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(length) || Number(length) < 1 || Number(length) > 32768) {
          throw new Error("RESPONSES_INVALID_READ_RANGE");
        }
        if (!this.allowed.has(ref)) return unboundRefHint([ref], textRefs, "read_evidence");
        const item = this.bound(ref);
        if (mime(item.path)) return toolHint("use_inspect_image", ref, "inspect_image");
        if (!textExtensions.has(path.extname(item.path).toLowerCase())) {
          throw new Error("RESPONSES_NON_TEXT_EVIDENCE");
        }
        const content = fs.readFileSync(item.path, "utf8");
        this.readRefs.add(ref);
        const start = Number(offset);
        const end = Math.min(content.length, start + Number(length));
        const coverage = this.textCoverage.get(ref) ?? { total: content.length, ranges: [] };
        coverage.ranges.push([start, end]);
        this.textCoverage.set(ref, coverage);
        return { ref, sha256: item.sha256, offset: start, nextOffset: end,
          totalCharacters: content.length, text: content.slice(start, end) };
      }
    };
    const image: SiwcTool = {
      name: "inspect_image", description: `Inspect actual pixels of one bound image; the next turn receives input_image. Image refs: ${imageRefs.join(", ")}. For known independent multiple images use inspect_images; for adaptive follow-up use this single-image tool. For JSON/text use read_evidence.`,
      parameters: { type: "object", additionalProperties: false, required: ["ref"], properties: { ref: { type: "string" } } },
      execute: async (args) => {
        const ref = (args as { ref?: unknown })?.ref;
        if (typeof ref !== "string") throw new Error("RESPONSES_REF_REQUIRED");
        if (!this.allowed.has(ref)) return unboundRefHint([ref], imageRefs, "inspect_image", 48);
        const item = this.bound(ref);
        const type = mime(item.path);
        if (!type && textExtensions.has(path.extname(item.path).toLowerCase())) {
          return toolHint("use_read_evidence", ref, "read_evidence");
        }
        if (!type) throw new Error("RESPONSES_NOT_IMAGE");
        const bytes = fs.readFileSync(item.path);
        this.inspectedImages.add(ref);
        this.readRefs.add(ref);
        return { kind: "siwc_visual_tool_result", value: { ref, sha256: item.sha256 },
          images: [{ mimeType: type, base64: bytes.toString("base64"), detail: "high" }] } satisfies SiwcVisualToolResult;
      }
    };
    const imageBatch: SiwcTool = {
      name: "inspect_images",
      description: `Inspect actual pixels of 1–24 known, independent bound image refs in one call, in the exact requested order. Image refs: ${imageRefs.join(", ")}. This records pixel delivery, not semantic coverage. For adaptive follow-up use inspect_image.`,
      parameters: { type: "object", additionalProperties: false, required: ["refs"], properties: {
        refs: { type: "array", minItems: 1, maxItems: 24, items: { type: "string" } }
      } },
      execute: async (args) => {
        const refs = (args as { refs?: unknown })?.refs;
        if (!Array.isArray(refs) || refs.length < 1 || refs.length > 24 ||
          refs.some(ref => typeof ref !== "string" || !ref)) throw new Error("RESPONSES_IMAGE_BATCH_INVALID");
        if (new Set(refs).size !== refs.length) throw new Error("RESPONSES_CONTEXT_DUPLICATE_REF");
        const unknownRefs = (refs as string[]).filter(ref => !this.allowed.has(ref));
        if (unknownRefs.length) {
          for (const ref of refs as string[]) if (this.allowed.has(ref)) this.bound(ref);
          return unboundRefHint(unknownRefs, imageRefs, "inspect_images", 48);
        }
        const result = this.readBundle([], refs as string[]);
        if ("error" in result) return result;
        return { ...result, value: Object.assign({}, result.value, {
          orderedRefs: refs.map((ref, imageIndex) => ({ imageIndex, ref })),
          semanticCoverage: "not_evaluated" }) };
      }
    };
    const capture: SiwcTool = {
      name: "capture_frame", description: "Extract and inspect actual pixels from the bound source video at a timestamp in seconds; max 16 frames.",
      parameters: { type: "object", additionalProperties: false, required: ["timeSeconds"],
        properties: { timeSeconds: { type: "number", minimum: 0 } } },
      execute: async (args, signal) => {
        if (!this.mediaPath || mime(this.mediaPath)) throw new Error("RESPONSES_VIDEO_NOT_BOUND");
        const time = (args as { timeSeconds?: unknown })?.timeSeconds;
        if (typeof time !== "number" || !Number.isFinite(time) || time < 0 || time > 86_400) throw new Error("RESPONSES_INVALID_FRAME_TIME");
        if (this.captures.length >= this.maximumFrames) throw new Error("RESPONSES_FRAME_LIMIT");
        const id = `RF-${String(this.captures.length + 1).padStart(2, "0")}`;
        const file = path.join(this.outputDir, "targeted-evidence", `${id}.jpg`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", time.toFixed(3),
          "-i", this.mediaPath, "-frames:v", "1", "-q:v", "2", file], { timeout: 60_000, signal });
        const bytes = fs.readFileSync(file);
        if (!bytes.length) throw new Error("RESPONSES_FRAME_EMPTY");
        const frame = { id, timeSeconds: time, path: file, sha256: sha(bytes) };
        this.captures.push(frame);
        this.addGenerated(id, file);
        this.inspectedImages.add(id);
        this.readRefs.add(id);
        return { kind: "siwc_visual_tool_result", value: { ref: id, timeSeconds: time, sha256: frame.sha256 },
          images: [{ mimeType: "image/jpeg", base64: bytes.toString("base64"), detail: "high" }] } satisfies SiwcVisualToolResult;
      }
    };
    return this.mediaPath && !mime(this.mediaPath) ? [read, image, imageBatch, capture] : [read, image, imageBatch];
  }
}

function resolveJsonPointer(root: unknown, pointer: string): boolean {
  if (pointer === "") return true;
  if (!pointer.startsWith("/")) return false;
  let current = root;
  for (const raw of pointer.slice(1).split("/")) {
    if (/~(?:[^01]|$)/u.test(raw)) return false;
    const token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(token)) return false;
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index >= current.length) return false;
      current = current[index];
    } else if (current !== null && typeof current === "object"
      && Object.prototype.hasOwnProperty.call(current, token)) {
      current = (current as Record<string, unknown>)[token];
    } else return false;
  }
  return true;
}

export function boundArtifact(ref: string, expectedSha256?: string): BoundEvidence {
  const file = artifactPath(ref);
  const actual = sha(fs.readFileSync(file));
  if (expectedSha256 && actual !== expectedSha256) throw new Error("RESPONSES_PINNED_ARTIFACT_MUTATED");
  return { ref, path: file, sha256: actual };
}
