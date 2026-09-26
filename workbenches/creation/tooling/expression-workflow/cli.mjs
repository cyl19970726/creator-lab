#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { runWorkflow } from "@signal-room/workflow";
import { CodexSdkRunner } from "@signal-room/workflow-codex";
import { SQLiteWorkflowRunStore } from "@signal-room/workflow-sqlite";
import { createExpressionWorkflow } from "./workflow.mjs";

const SNAPSHOT_SCHEMA = "expression-workflow.snapshot.v1";
const STATE_SCHEMA = "expression-workflow.state.v1";
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_ROOT = join(PROJECT_ROOT, "data/local/expression-workflow");

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

async function atomicPrivateJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function snapshotBody(snapshot) {
  const { integrity: _integrity, ...body } = snapshot;
  return body;
}

async function loadSnapshot(snapshotPath) {
  const absolutePath = resolve(snapshotPath);
  const snapshot = JSON.parse(await readFile(absolutePath, "utf8"));
  if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA || !snapshot.integrity?.sha256) {
    throw new Error(`Unsupported or incomplete expression snapshot: ${absolutePath}`);
  }
  const actual = sha256(snapshotBody(snapshot));
  if (actual !== snapshot.integrity.sha256) {
    throw new Error(`Snapshot integrity check failed; prepare a new snapshot instead of editing ${absolutePath}`);
  }
  return { snapshot, snapshotPath: absolutePath, executionDir: dirname(absolutePath), snapshotSha256: actual };
}

async function assertCurrentImplementation(snapshot, deps) {
  const current = deps.getImplementationRevision
    ? await deps.getImplementationRevision()
    : await (await import("./config.mjs")).implementationRevision();
  if (snapshot.implementationRevision !== current) {
    throw new Error("The expression workflow implementation changed after this snapshot was prepared; prepare a new snapshot");
  }
}

async function readState(executionDir) {
  try { return JSON.parse(await readFile(join(executionDir, "state.json"), "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
}

async function saveState(executionDir, snapshotSha256, runId) {
  await atomicPrivateJson(join(executionDir, "state.json"), {
    schemaVersion: STATE_SCHEMA,
    snapshotSha256,
    runId,
    updatedAt: new Date().toISOString(),
  });
}

function openLedger(executionDir) {
  const database = new DatabaseSync(join(executionDir, "ledger.sqlite"));
  database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL");
  return { database, store: new SQLiteWorkflowRunStore(database) };
}

async function resolveRunId(store, state, snapshotSha256) {
  if (state?.snapshotSha256 && state.snapshotSha256 !== snapshotSha256) {
    throw new Error("Run state belongs to a different snapshot");
  }
  if (state?.runId) return state.runId;
  const matches = await store.listRuns({ metadata: { snapshotSha256 } });
  return matches[0]?.id;
}

async function withExecutionLock(executionDir, callback) {
  const lockPath = join(executionDir, "execution.lock");
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`This snapshot is already locked. If no process is running, inspect and remove ${lockPath} manually`);
    }
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    return await callback();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

function installSignalHandlers(controller) {
  const abort = (signal) => controller.abort(new Error(`Received ${signal}`));
  const onInt = () => abort("SIGINT");
  const onTerm = () => abort("SIGTERM");
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onTerm);
  return () => {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  };
}

function parseFlags(args) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (!value.startsWith("--")) { positional.push(value); continue; }
    const key = value.slice(2);
    if (!["model", "effort", "max-revisions", "output"].includes(key)) throw new Error(`Unknown option: ${value}`);
    if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`Missing value for ${value}`);
    flags[key] = args[++index];
  }
  return { positional, flags };
}

async function defaultPrepare(options) {
  const { prepareExpressionRun } = await import("./config.mjs");
  return prepareExpressionRun(options);
}

async function prepareCommand(args, deps) {
  const { positional, flags } = parseFlags(args);
  if (positional.length !== 1 || !flags.model) throw new Error("Usage: prepare MANIFEST --model MODEL [--effort medium] [--max-revisions 1]");
  const maxRevisions = Number(flags["max-revisions"] ?? 1);
  if (!Number.isInteger(maxRevisions) || maxRevisions < 0) throw new Error("--max-revisions must be a non-negative integer");
  const manifestPath = resolve(positional[0]);
  const prepared = await (deps.prepareExpressionRun ?? defaultPrepare)({
    manifestPath,
    model: flags.model,
    reasoningEffort: flags.effort ?? "medium",
  });
  const executionId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomUUID()}`;
  const dataRoot = resolve(deps.dataRoot ?? DEFAULT_ROOT);
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const executionDir = join(dataRoot, executionId);
  await mkdir(executionDir, { recursive: false, mode: 0o700 });
  await chmod(executionDir, 0o700);
  const body = {
    schemaVersion: SNAPSHOT_SCHEMA,
    executionId,
    createdAt: new Date().toISOString(),
    manifestPath,
    model: flags.model,
    reasoningEffort: flags.effort ?? "medium",
    input: prepared.input,
    agents: prepared.agents,
    revision: prepared.revision,
    maxRevisions,
    implementationRevision: prepared.implementationRevision,
  };
  const snapshot = { ...body, integrity: { algorithm: "sha256", sha256: sha256(body) } };
  const snapshotPath = join(executionDir, "snapshot.json");
  await atomicPrivateJson(snapshotPath, snapshot);
  deps.stdout.write(`${snapshotPath}\n`);
  return { snapshotPath, snapshot };
}

async function runCommand(snapshotArg, deps) {
  const loaded = await loadSnapshot(snapshotArg);
  await assertCurrentImplementation(loaded.snapshot, deps);
  return withExecutionLock(loaded.executionDir, async () => {
    const { database, store } = openLedger(loaded.executionDir);
    const controller = new AbortController();
    const uninstall = deps.installSignalHandlers === false ? () => {} : installSignalHandlers(controller);
    try {
      const state = await readState(loaded.executionDir);
      const resumeRunId = await resolveRunId(store, state, loaded.snapshotSha256);
      if (resumeRunId) await saveState(loaded.executionDir, loaded.snapshotSha256, resumeRunId);
      const workflow = createExpressionWorkflow({
        agents: loaded.snapshot.agents,
        revision: loaded.snapshot.revision,
        maxRevisions: loaded.snapshot.maxRevisions,
      });
      const runner = deps.createRunner
        ? await deps.createRunner({ executionDir: loaded.executionDir, snapshot: loaded.snapshot })
        : new CodexSdkRunner(undefined, join(loaded.executionDir, "private-traces"), { packageRoot: PROJECT_ROOT });
      let result;
      try {
        result = await runWorkflow({
          workflow,
          input: loaded.snapshot.input,
          store,
          agentRunner: runner,
          signal: controller.signal,
          resumeRunId,
          metadata: { executionId: loaded.snapshot.executionId, snapshotSha256: loaded.snapshotSha256 },
        });
      } finally {
        const discovered = await resolveRunId(store, await readState(loaded.executionDir), loaded.snapshotSha256);
        if (discovered) await saveState(loaded.executionDir, loaded.snapshotSha256, discovered);
      }
      await saveState(loaded.executionDir, loaded.snapshotSha256, result.run.id);
      deps.stdout.write(`${result.run.id} ${result.run.state}\n`);
      return result;
    } finally {
      uninstall();
      database.close();
    }
  });
}

function cleanText(value) {
  return String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function fenced(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const ticks = text.match(/`+/g)?.reduce((longest, item) => Math.max(longest, item.length), 2) ?? 2;
  const fence = "`".repeat(ticks + 1);
  return `${fence}\n${cleanText(text)}\n${fence}`;
}

function renderArtifactPayload(artifact, payload) {
  if (artifact.type === "expression-frozen-research" && Array.isArray(payload)) {
    return fenced(payload.map((item) => ({ id: item?.id, sha256: item?.sha256 })));
  }
  if (artifact.type === "expression-core-candidate" || artifact.type === "expression-full-candidate") {
    const sections = [];
    if (payload?.title) sections.push(`#### ${cleanText(payload.title)}`);
    if (payload?.publicDocument) sections.push("#### 观众正文", cleanText(payload.publicDocument));
    if (payload?.document) sections.push("#### 设计与编辑说明", cleanText(payload.document));
    if (payload?.visuals?.length) sections.push("#### Visuals", fenced(payload.visuals));
    if (payload?.materials?.length) sections.push("#### Materials", fenced(payload.materials));
    return sections.join("\n\n");
  }
  return fenced(payload);
}

function safeStoppingReason(output) {
  if (!output || typeof output !== "object") return undefined;
  const detail = output.details && typeof output.details === "object" ? output.details : output;
  const result = {};
  for (const key of ["reason", "stage"]) {
    if (typeof detail[key] === "string") result[key] = cleanText(detail[key]);
  }
  for (const key of ["package", "candidate", "review"]) {
    const value = detail[key];
    if (value && typeof value === "object") {
      result[key] = Object.fromEntries(["id", "revision", "sha256"].filter((field) => typeof value[field] === "string").map((field) => [field, value[field]]));
    }
  }
  return Object.keys(result).length ? result : undefined;
}

async function buildReport(loaded) {
  const { database, store } = openLedger(loaded.executionDir);
  try {
    const state = await readState(loaded.executionDir);
    const runId = await resolveRunId(store, state, loaded.snapshotSha256);
    if (!runId) throw new Error("This snapshot has not been run yet");
    const run = await store.getRun(runId);
    if (!run) throw new Error(`Run ledger is missing ${runId}`);
    const steps = await store.listSteps(runId);
    const artifacts = await store.listArtifacts(runId);
    const lines = [
      `# Expression workflow ${cleanText(run.state)}`,
      "",
      `- Run: ${run.id}`,
      `- Workflow: ${cleanText(run.workflowId)} @ ${cleanText(run.workflowRevision)}`,
      `- Snapshot SHA-256: ${loaded.snapshotSha256}`,
      `- State: ${cleanText(run.state)}`,
    ];
    const stoppingReason = safeStoppingReason(run.output);
    if (stoppingReason) lines.push(`- Stopping reason: ${cleanText(stoppingReason.reason ?? "workflow terminal")}`,
      ...(stoppingReason.stage ? [`- Stage: ${stoppingReason.stage}`] : []), "", "## Terminal detail", "", fenced(stoppingReason), "");
    else lines.push("");
    lines.push(
      "## Phases",
      "",
    );
    const phases = steps.filter((step) => step.kind === "phase");
    if (!phases.length) lines.push("No phases have been recorded.", "");
    for (const phase of phases) {
      lines.push(`### ${cleanText(phase.phaseDefinition?.title ?? phase.key)}`, "", `- State: ${cleanText(phase.state)}`, `- Validation: ${cleanText(phase.validation)}`);
      if (phase.phaseDefinition?.purpose) lines.push(`- Purpose: ${cleanText(phase.phaseDefinition.purpose)}`);
      lines.push("");
    }
    lines.push("## Artifacts", "");
    if (!artifacts.length) lines.push("No artifacts have been published.", "");
    for (const artifact of artifacts) {
      const payload = await store.getArtifactPayload(artifact.id);
      lines.push(`### ${cleanText(artifact.type)}`, "",
        `- Artifact: ${artifact.id}`,
        `- Revision: ${cleanText(artifact.revision)}`,
        `- SHA-256: ${artifact.sha256}`,
        `- Validation: ${cleanText(artifact.validation)}`,
        `- Review: ${cleanText(artifact.review)}`,
        `- Producer run: ${artifact.producedBy.workflowRunId}`,
        `- Producer step: ${artifact.producedBy.stepRunId}`,
        `- Producer attempt: ${artifact.producedBy.attemptId}`);
      if (artifact.dependsOn.length) lines.push(`- Dependencies: ${artifact.dependsOn.map((item) => `${item.artifactId}@${item.revision} (${item.sha256})`).join(", ")}`);
      lines.push("", renderArtifactPayload(artifact, payload), "");
    }
    return { markdown: `${lines.join("\n")}\n`, run };
  } finally { database.close(); }
}

async function reportCommand(command, args, deps) {
  const { positional, flags } = parseFlags(args);
  if (positional.length !== 1) throw new Error(`Usage: ${command} SNAPSHOT${command === "export" ? " [--output FILE]" : ""}`);
  if (command === "status" && Object.keys(flags).length) throw new Error("status does not accept options");
  if (command === "export" && Object.keys(flags).some((key) => key !== "output")) throw new Error("export only accepts --output");
  const loaded = await loadSnapshot(positional[0]);
  const report = await buildReport(loaded);
  if (command === "status") {
    deps.stdout.write(report.markdown);
    return report;
  }
  const outputPath = resolve(flags.output ?? join(loaded.executionDir, "export.md"));
  if (!isAbsolute(outputPath)) throw new Error("Export path must resolve to an absolute path");
  await writeFile(outputPath, report.markdown, { mode: 0o600 });
  await chmod(outputPath, 0o600);
  deps.stdout.write(`${outputPath}\n`);
  return { ...report, outputPath };
}

export async function runCli(argv, dependencies = {}) {
  const deps = { stdout: process.stdout, stderr: process.stderr, ...dependencies };
  const [command, ...args] = argv;
  if (command === "prepare") return prepareCommand(args, deps);
  if (command === "run" || command === "resume") {
    if (args.length !== 1) throw new Error(`Usage: ${command} SNAPSHOT`);
    return runCommand(args[0], deps);
  }
  if (command === "status" || command === "export") return reportCommand(command, args, deps);
  throw new Error("Usage: expression <prepare|run|resume|status|export> ...");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`expression: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
