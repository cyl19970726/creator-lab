import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "../../core/config.js";
import { runFile } from "../../core/process.js";
import type { RuntimeThreeLensGateReport } from "../../../../research/index.js";

const skillDir = process.env.SELF_MEDIA_VIDEO_RECONSTRUCTION_SKILL_DIR ??
  path.join(projectRoot, ".agents", "skills", "video-content-reconstruction");
export type GateReport = { ready?: boolean; gates?: Array<{ id?: string; pass?: boolean }>; failedGateIds?: string[] };
const exists = (file: string) => fs.existsSync(file) && fs.statSync(file).isFile();

function failedIds(gate: GateReport): string[] {
  return Array.isArray(gate.failedGateIds)
    ? gate.failedGateIds
    : (gate.gates ?? []).filter((item) => item.pass === false).map((item) => item.id).filter((id): id is string => Boolean(id));
}

/** Combines the deterministic evaluator gate and runtime three-lens gate without promoting unchecked results. */
export function hardEvaluationGateFailures(
  gate: GateReport,
  threeLensGate: Pick<RuntimeThreeLensGateReport, "ready" | "failedGateIds" | "uncheckedGateIds">
): string[] {
  if (gate.ready === true && threeLensGate.ready === true) return [];
  const failures = [...new Set([
    ...failedIds(gate),
    ...threeLensGate.failedGateIds,
    ...threeLensGate.uncheckedGateIds
  ])];
  return failures.length > 0 ? failures : ["evaluation_not_ready"];
}

/** Validates an evaluator output against an immutable Builder candidate without modifying that candidate. */
export async function validateEvaluationArtifacts(candidateDir: string, evaluationDir: string): Promise<GateReport> {
  const evaluationPath = path.join(evaluationDir, "evaluation.json");
  const gatePath = path.join(evaluationDir, "gate-report.json");
  const args = [path.join(skillDir, "scripts/validate-reconstruction.mjs"),
    "--evidence", path.join(candidateDir, "evidence/evidence-pack.json"),
    "--targeted", path.join(candidateDir, "targeted-evidence/targeted-evidence.json"),
    "--probe", path.join(candidateDir, "probe.json"), "--protocol", path.join(candidateDir, "capture-protocol.json"),
    "--reconstruction", path.join(candidateDir, "reconstruction.json"), "--evaluation", evaluationPath, "--out", gatePath];
  const ocrPath = path.join(candidateDir, "targeted-evidence/ocr-evidence.json");
  if (exists(ocrPath)) args.splice(args.length - 2, 0, "--ocr", ocrPath);
  try { await runFile(process.execPath, args, { cwd: evaluationDir, timeout: 10 * 60_000 }); }
  catch { if (!exists(gatePath)) throw new Error("DETERMINISTIC_VALIDATOR_FAILED"); }
  return JSON.parse(fs.readFileSync(gatePath, "utf8")) as GateReport;
}
