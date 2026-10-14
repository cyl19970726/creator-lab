#!/usr/bin/env node
import { join } from "node:path";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { ensureInputFile, extractFrame, parseArgs, probeMedia, readJson, requireArg, round, writeContactSheet, writeJson } from "./lib.mjs";
import { planCaptureProtocol } from "./capture-plan.mjs";

const args = parseArgs(process.argv.slice(2));
const video = requireArg(args, "video");
const protocolPath = requireArg(args, "protocol");
const out = requireArg(args, "out");
ensureInputFile(video, "video");
ensureInputFile(protocolPath, "protocol");
mkdirSync(out, { recursive: true });

const protocol = readJson(protocolPath);
if (!["capture-protocol-1.0", "capture-protocol-2.0"].includes(protocol.schemaVersion)) throw new Error("Unsupported protocol schemaVersion");
const media = probeMedia(video);
const frames = [];
const actionFrameIds = new Map();
const frameByExactTime = new Map();
const frameByContentHash = new Map();
let exactTimeReuses = 0;
let exactContentReuses = 0;
const maxTotalFrames = Number(args["max-total-frames"] || 180);
const maxFramesPerAction = Number(args["max-frames-per-action"] || 60);
const plan = planCaptureProtocol(protocol, media.duration, { maxFramesPerAction, maxTotalFrames });
if (!plan.pass) throw new Error(plan.errors.map(error => `${error.path}: ${error.message}`).join("; "));

function attach(actionId, frameId) {
  const ids = actionFrameIds.get(actionId) || [];
  if (!ids.includes(frameId)) ids.push(frameId);
  actionFrameIds.set(actionId, ids);
}

function timeKey(time) { return round(time, 2).toFixed(2); }

for (const { action, selected } of plan.actions) {
  selected.forEach((time, index) => {
    const existingAtTime = frameByExactTime.get(timeKey(time));
    if (existingAtTime) {
      attach(action.id, existingAtTime.id);
      exactTimeReuses += 1;
      return;
    }
    const id = `TARGET-${String(frames.length + 1).padStart(4, "0")}`;
    const filename = `${action.id}-${String(index + 1).padStart(3, "0")}.jpg`.replace(/[^a-zA-Z0-9._-]/g, "-");
    const frame = `frames/${filename}`;
    const absoluteFrame = join(out, frame);
    extractFrame(video, time, absoluteFrame);
    const contentHash = createHash("sha256").update(readFileSync(absoluteFrame)).digest("hex");
    const existingContent = frameByContentHash.get(contentHash);
    if (existingContent) {
      unlinkSync(absoluteFrame);
      frameByExactTime.set(timeKey(time), existingContent);
      attach(action.id, existingContent.id);
      exactContentReuses += 1;
      return;
    }
    const record = { id, actionId: action.id, time: round(time), frame, carrier: action.carrier, reason: action.reason, contentHash };
    frames.push(record);
    frameByExactTime.set(timeKey(time), record);
    frameByContentHash.set(contentHash, record);
    attach(action.id, id);
  });
}

const contactSheet = "contact-sheet.jpg";
writeContactSheet(frames.map((frame) => join(out, frame.frame)), join(out, contactSheet));
const manifest = {
  schemaVersion: "targeted-evidence-1.0",
  generatedAt: new Date().toISOString(),
  video,
  protocol: protocolPath,
  frames,
  actions: (protocol.captureActions || []).map((action) => ({
    id: action.id,
    frameIds: actionFrameIds.get(action.id) || [],
    consumers: action.consumers ?? [],
    presentationIntent: action.presentationIntent ?? "analysis_only"
  })),
  contactSheet,
  deduplication: { exactTimeReuses, exactContentReuses, uniqueFrames: frames.length }
};
const output = join(out, "targeted-evidence.json");
writeJson(output, manifest);
process.stdout.write(`${JSON.stringify({ output, actions: manifest.actions.length, frames: frames.length })}\n`);
