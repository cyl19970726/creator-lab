import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recoverHostOcr } from "./video-ocr-host-recovery.js";
import { ocrRecoveryRepairPrompt, recoverOcrWithBuilderContinuation } from "./video-ocr-builder-continuation.js";
import { writeOcrInputManifest } from "./video-ocr-input-manifest.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(): { root: string; targeted: string; ocr: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-ocr-recovery-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "targeted-evidence/frames"), { recursive: true });
  fs.writeFileSync(path.join(root, "capture-protocol.json"), JSON.stringify({ captureActions: [{ mode: "ocr_review" }] }));
  fs.writeFileSync(path.join(root, "targeted-evidence/frames/a.jpg"), "immutable-frame-a");
  const targeted = path.join(root, "targeted-evidence/targeted-evidence.json");
  fs.writeFileSync(targeted, JSON.stringify({ frames: [{ id: "FRAME-1", actionId: "OCR", time: 1, frame: "frames/a.jpg" }] }));
  const ocr = path.join(root, "targeted-evidence/ocr-evidence.json");
  fs.writeFileSync(ocr, JSON.stringify({ frames: [{ frameId: "FRAME-1", status: "failed", error: "nilError", lines: [] }] }));
  return { root, targeted, ocr };
}

function digest(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

describe("host OCR recovery", () => {
  it.each(["modify", "delete"] as const)("rejects %s of the dedicated OCR input manifest during Builder continuation", async mutation => {
    const item = fixture();
    const manifest = path.join(item.root, "ocr-input-manifest.json");
    const video = path.join(item.root, "source.mp4");
    fs.writeFileSync(manifest, '{"schemaVersion":"ocr-input@1"}');
    fs.writeFileSync(video, "source video");
    fs.writeFileSync(path.join(item.root, "reconstruction.json"), '{"before":true}');
    await expect(recoverOcrWithBuilderContinuation({ outputDir: item.root, videoPath: video, skillDir: "/skill",
      recover: async () => ({ attempted: true, recoveredText: true, reason: "recovered_text", receipt: null }),
      continueBuilder: async prompt => {
        expect(prompt).toContain("ocr-input-manifest.json (when present)");
        fs.writeFileSync(path.join(item.root, "reconstruction.json"), '{"after":true}');
        if (mutation === "modify") fs.writeFileSync(manifest, '{"schemaVersion":"changed"}');
        else fs.rmSync(manifest);
      }
    })).rejects.toThrow("OCR_RECOVERY_IMMUTABLE_INPUT_MUTATED");
    expect(JSON.parse(fs.readFileSync(path.join(item.root, "ocr-builder-continuation.json"), "utf8")))
      .toMatchObject({ status: "failed", error: "OCR_RECOVERY_IMMUTABLE_INPUT_MUTATED" });
  });

  it("keeps an older candidate without a dedicated OCR manifest compatible", async () => {
    const item = fixture();
    const video = path.join(item.root, "source.mp4");
    fs.writeFileSync(video, "source video");
    fs.writeFileSync(path.join(item.root, "reconstruction.json"), '{"before":true}');
    expect(ocrRecoveryRepairPrompt(video, item.root)).toContain("ocr-input-manifest.json (when present)");
    const result = await recoverOcrWithBuilderContinuation({ outputDir: item.root, videoPath: video, skillDir: "/skill",
      recover: async () => ({ attempted: true, recoveredText: true, reason: "recovered_text", receipt: null }),
      continueBuilder: async () => {
        fs.writeFileSync(path.join(item.root, "reconstruction.json"), '{"after":true}');
      }
    });
    expect(result.recoveredText).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(item.root, "ocr-builder-continuation.json"), "utf8")))
      .toMatchObject({ status: "completed", error: null });
  });

  it("retries the exact source-plus-TARGET union and rejects incomplete recovery without replacing evidence", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-ocr-union-")); roots.push(root);
    fs.mkdirSync(path.join(root, "evidence/frames/dense"), { recursive: true });
    fs.mkdirSync(path.join(root, "targeted-evidence/frames"), { recursive: true });
    fs.writeFileSync(path.join(root, "evidence/frames/dense/a.jpg"), "source pixels");
    fs.writeFileSync(path.join(root, "targeted-evidence/frames/t.jpg"), "target pixels");
    fs.writeFileSync(path.join(root, "evidence/evidence-pack.json"), JSON.stringify({ frameIndex: [
      { id: "DENSE-001", time: 1, frame: "frames/dense/a.jpg" }] }));
    fs.writeFileSync(path.join(root, "capture-protocol.json"), JSON.stringify({ captureActions: [
      { id: "OCR", mode: "ocr_review", range: { start: 0, end: 2 } }] }));
    fs.writeFileSync(path.join(root, "targeted-evidence/targeted-evidence.json"), JSON.stringify({ frames: [
      { id: "TARGET-0001", actionId: "OCR", time: 1.5, frame: "frames/t.jpg" }],
      actions: [{ id: "OCR", frameIds: ["TARGET-0001"] }] }));
    const input = writeOcrInputManifest(root);
    const ocr = path.join(root, "targeted-evidence/ocr-evidence.json");
    fs.writeFileSync(ocr, JSON.stringify({ schemaVersion: "ocr-evidence-1.0", sourceFrameBase: "candidate-root", frames: [
      { frameId: "TARGET-0001", actionId: "OCR", actionIds: ["OCR"], time: 1.5,
        sourceFrame: "targeted-evidence/frames/t.jpg", status: "processed", lines: [] }] }));
    const before = digest(ocr);
    let calls = 0;
    const invalid = await recoverHostOcr({ outputDir: root, skillDir: "/skill", executeFile: async (_file, args) => {
      calls += 1;
      expect(args[args.indexOf("--manifest") + 1]).toBe(input.path);
      fs.writeFileSync(args[args.indexOf("--out") + 1]!, JSON.stringify({ schemaVersion: "ocr-evidence-1.0", sourceFrameBase: "candidate-root", frames: [
        { frameId: "TARGET-0001", actionId: "OCR", actionIds: ["OCR"], time: 1.5,
          sourceFrame: "targeted-evidence/frames/t.jpg", status: "processed", lines: [{ id: "OCR-1", text: "seen" }] }] }));
      return { stdout: "ok", stderr: "" };
    } });
    expect(invalid).toMatchObject({ attempted: true, recoveredText: false, reason: "host_failed" });
    expect(digest(ocr)).toBe(before);
    expect(calls).toBe(1);
    fs.rmSync(path.join(root, "targeted-evidence/ocr-host-recovery.json"));
    const valid = await recoverHostOcr({ outputDir: root, skillDir: "/skill", executeFile: async (_file, args) => {
      const frames = input.manifest.frames.map(frame => ({ frameId: frame.id, actionId: frame.actionId,
        actionIds: frame.actionIds, time: frame.time, sourceFrame: frame.frame, status: "processed",
        lines: frame.id === "DENSE-001" ? [{ id: "OCR-1", text: "short caption" }] : [] }));
      fs.writeFileSync(args[args.indexOf("--out") + 1]!, JSON.stringify({ schemaVersion: "ocr-evidence-1.0", sourceFrameBase: "candidate-root", frames }));
      return { stdout: "ok", stderr: "" };
    } });
    expect(valid).toMatchObject({ attempted: true, recoveredText: true, reason: "recovered_text" });
    expect(JSON.parse(fs.readFileSync(ocr, "utf8")).frames).toHaveLength(2);
  });

  it("preserves failed evidence and publishes recovered text once for one immutable manifest", async () => {
    const item = fixture();
    const beforeSha = digest(item.ocr);
    let calls = 0;
    const executeFile = async (_file: string, args: string[]) => {
      calls += 1;
      const out = args[args.indexOf("--out") + 1]!;
      fs.writeFileSync(out, JSON.stringify({ frames: [{ frameId: "FRAME-1", status: "processed", error: null,
        lines: [{ id: "OCR-1", text: "readable", confidence: 0.9, boundingBox: [0, 0, 1, 1] }] }] }));
      return { stdout: "ok", stderr: "" };
    };
    const first = await recoverHostOcr({ outputDir: item.root, skillDir: "/skill", executeFile, now: () => new Date(0) });
    expect(first).toMatchObject({ attempted: true, recoveredText: true, reason: "recovered_text" });
    expect(first.receipt?.before.sha256).toBe(beforeSha);
    expect(first.receipt?.before.path && digest(first.receipt.before.path)).toBe(beforeSha);
    expect(first.receipt?.after.lines).toBe(1);
    expect(JSON.parse(fs.readFileSync(item.ocr, "utf8")).frames[0].lines[0].text).toBe("readable");

    const second = await recoverHostOcr({ outputDir: item.root, skillDir: "/skill", executeFile });
    expect(second).toMatchObject({ attempted: false, recoveredText: false, reason: "ocr_not_host_retryable" });
    expect(calls).toBe(1);
  });

  it("records a failed host attempt without replacing evidence or retrying the same frame revision", async () => {
    const item = fixture();
    const beforeSha = digest(item.ocr);
    let calls = 0;
    const executeFile = async () => { calls += 1; throw new Error("vision unavailable"); };
    const first = await recoverHostOcr({ outputDir: item.root, skillDir: "/skill", executeFile });
    expect(first).toMatchObject({ attempted: true, recoveredText: false, reason: "host_failed" });
    expect(digest(item.ocr)).toBe(beforeSha);
    expect(first.receipt).toMatchObject({ status: "host_failed", error: "vision unavailable" });

    const second = await recoverHostOcr({ outputDir: item.root, skillDir: "/skill", executeFile });
    expect(second).toMatchObject({ attempted: false, reason: "host_attempt_already_recorded" });
    expect(calls).toBe(1);
  });

  it("does not retry processed empty text", async () => {
    const item = fixture();
    fs.writeFileSync(item.ocr, JSON.stringify({ frames: [{ frameId: "FRAME-1", status: "processed", error: null, lines: [] }] }));
    const result = await recoverHostOcr({ outputDir: item.root, skillDir: "/skill",
      executeFile: async () => { throw new Error("must not run"); } });
    expect(result).toMatchObject({ attempted: false, reason: "ocr_not_host_retryable" });
  });

  it("recovers a failed OCR artifact even when the capture mode is exact_times", async () => {
    const item = fixture();
    fs.writeFileSync(path.join(item.root, "capture-protocol.json"), JSON.stringify({
      captureActions: [{ mode: "exact_times" }], stoppingRules: ["同一 manifest 仅执行一次 OCR"]
    }));
    let calls = 0;
    const result = await recoverHostOcr({ outputDir: item.root, skillDir: "/skill", executeFile: async (_file, args) => {
      calls += 1;
      fs.writeFileSync(args[args.indexOf("--out") + 1]!, JSON.stringify({ frames: [{ frameId: "FRAME-1",
        status: "processed", error: null, lines: [{ id: "OCR-1", text: "visible" }] }] }));
      return { stdout: "ok", stderr: "" };
    } });
    expect(result).toMatchObject({ attempted: true, recoveredText: true });
    expect(calls).toBe(1);
  });

  it("does not start OCR for exact_times when no prior OCR attempt exists", async () => {
    const item = fixture();
    fs.writeFileSync(path.join(item.root, "capture-protocol.json"), JSON.stringify({ captureActions: [{ mode: "exact_times" }] }));
    fs.rmSync(item.ocr);
    const result = await recoverHostOcr({ outputDir: item.root, skillDir: "/skill",
      executeFile: async () => { throw new Error("must not run"); } });
    expect(result).toMatchObject({ attempted: false, reason: "ocr_not_host_retryable" });
  });

  it("publishes changed OCR text even when the non-empty line count stays equal", async () => {
    const item = fixture();
    fs.writeFileSync(item.ocr, JSON.stringify({ frames: [{ frameId: "FRAME-1", status: "failed", error: "nilError",
      lines: [{ id: "OCR-1", text: "wrong" }] }] }));
    const result = await recoverHostOcr({ outputDir: item.root, skillDir: "/skill", executeFile: async (_file, args) => {
      const out = args[args.indexOf("--out") + 1]!;
      fs.writeFileSync(out, JSON.stringify({ frames: [{ frameId: "FRAME-1", status: "processed", error: null,
        lines: [{ id: "OCR-1", text: "correct" }] }] }));
      return { stdout: "ok", stderr: "" };
    } });
    expect(result).toMatchObject({ recoveredText: true, reason: "recovered_text" });
  });

  it("expects only requested OCR action frames when targeted capture also contains visual frames", async () => {
    const item = fixture();
    fs.writeFileSync(path.join(item.root, "capture-protocol.json"), JSON.stringify({ captureActions: [
      { id: "VISUAL", mode: "exact_times" }, { id: "OCR", mode: "ocr_review" }
    ] }));
    fs.writeFileSync(path.join(item.root, "targeted-evidence/frames/b.jpg"), "immutable-frame-b");
    fs.writeFileSync(item.targeted, JSON.stringify({ frames: [
      { id: "FRAME-0", actionId: "VISUAL", time: 0, frame: "frames/b.jpg" },
      { id: "FRAME-1", actionId: "VISUAL", time: 1, frame: "frames/a.jpg" }
    ], actions: [
      { id: "VISUAL", frameIds: ["FRAME-0", "FRAME-1"] },
      { id: "OCR", frameIds: ["FRAME-1"] }
    ] }));
    fs.writeFileSync(item.ocr, JSON.stringify({ frames: [
      { frameId: "FRAME-1", status: "processed", error: null, lines: [] }
    ] }));
    const complete = await recoverHostOcr({ outputDir: item.root, skillDir: "/skill",
      executeFile: async () => { throw new Error("must not run"); } });
    expect(complete).toMatchObject({ attempted: false, reason: "ocr_not_host_retryable" });

    fs.writeFileSync(item.ocr, JSON.stringify({ frames: [
      { frameId: "FRAME-1", status: "failed", error: "nilError", lines: [] }
    ] }));
    const recovered = await recoverHostOcr({ outputDir: item.root, skillDir: "/skill", executeFile: async (_file, args) => {
      fs.writeFileSync(args[args.indexOf("--out") + 1]!, JSON.stringify({ frames: [
        { frameId: "FRAME-1", status: "processed", error: null, lines: [{ id: "OCR-1", text: "visible" }] }
      ] }));
      return { stdout: "ok", stderr: "" };
    } });
    expect(recovered).toMatchObject({ attempted: true, recoveredText: true });
  });
});
