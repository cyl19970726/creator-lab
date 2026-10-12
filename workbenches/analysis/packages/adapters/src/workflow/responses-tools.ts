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

export type BoundEvidence = { ref: string; path: string; sha256: string };
export type CapturedFrame = { id: string; timeSeconds: number; path: string; sha256: string };
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function mime(file: string): SiwcImage["mimeType"] | null {
  const extension = path.extname(file).toLowerCase();
  return extension === ".jpg" || extension === ".jpeg" ? "image/jpeg"
    : extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp"
      : extension === ".gif" ? "image/gif" : null;
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

  list(): string[] { return [...this.allowed.keys()]; }
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
      name: "inspect_image", description: `Inspect actual pixels of a bound image; the next turn receives input_image. Image refs: ${imageRefs.join(", ")}. For JSON/text use read_evidence.`,
      parameters: { type: "object", additionalProperties: false, required: ["ref"], properties: { ref: { type: "string" } } },
      execute: async (args) => {
        const ref = (args as { ref?: unknown })?.ref;
        if (typeof ref !== "string") throw new Error("RESPONSES_REF_REQUIRED");
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
    return this.mediaPath && !mime(this.mediaPath) ? [read, image, capture] : [read, image];
  }
}

export function boundArtifact(ref: string, expectedSha256?: string): BoundEvidence {
  const file = artifactPath(ref);
  const actual = sha(fs.readFileSync(file));
  if (expectedSha256 && actual !== expectedSha256) throw new Error("RESPONSES_PINNED_ARTIFACT_MUTATED");
  return { ref, path: file, sha256: actual };
}
