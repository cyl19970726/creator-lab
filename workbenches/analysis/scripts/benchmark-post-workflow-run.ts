#!/usr/bin/env node
import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { defineAgent, runWorkflow, type ArtifactRef } from "@signal-room/workflow";
import { PostgresWorkflowRunStore } from "@signal-room/workflow-postgres";
import { createPostSourceCheckWorkflow, createPostWorkflowSuiteV11, videoReconstructionOutcomeSchema,
  type PostWorkflowValidators } from "../packages/research/index.js";
import type { PostCandidateReceipt, PostEvaluationRepairInput, PostEvaluationRepairReceipt,
  PostEvaluationReceipt, PostWorkflowInput, PostWorkflowStartInput, ResearchAgentDefinitions,
  SourceConsistencyReceipt } from "../packages/research/index.js";
import { AnalysisPgContext } from "../packages/adapters/src/platform/database/analysis-pg-context.js";
import { PostgresCreatorArtifactStore } from "../packages/adapters/src/platform/artifacts/postgres-creator-artifact-store.js";
import { assertPinnedResearchInput, methodSnapshot, pinResearchInput, registerResearchInput,
  skillPackageSnapshot, type PinnedResearchInput } from "../packages/adapters/src/workflow/research-inputs.js";
import { ResponsesResearchRunner } from "../packages/adapters/src/workflow/responses-research-runner.js";
import { artifactPath } from "../packages/adapters/src/core/artifacts.js";
import { projectRoot, runtimeDir } from "../packages/adapters/src/core/config.js";
import { awaitHarnessRunBinding } from "../packages/adapters/src/harness/execution.js";

type Options = { sourceWorkflowRunId: string; candidateArtifactId?: string; caseLabel: string; dryRun: boolean; outputPath?: string };
type CandidatePayload = { kind: "post"; evidence: ArtifactRef; outcome: unknown; reportArtifactRef: string;
  reportSha256: string; relativeRoot: string };
type CandidateSource = { ref: ArtifactRef; payload: CandidatePayload; frozen: PinnedResearchInput };
type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function isArtifactRef(value: unknown): value is ArtifactRef {
  const row = object(value);
  return !!row && typeof row.id === "string" && typeof row.type === "string"
    && typeof row.revision === "string" && typeof row.sha256 === "string";
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40) || "case";
}

export function parseWorkflowArgs(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--dry-run") { dryRun = true; continue; }
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    if (values.has(token)) throw new Error(`Duplicate option: ${token}`);
    values.set(token, value);
    index += 1;
  }
  const allowed = new Set(["--source-workflow-run-id", "--candidate-artifact-id", "--case", "--output"]);
  for (const key of values.keys()) if (!allowed.has(key)) throw new Error(`Unknown option: ${key}`);
  const sourceWorkflowRunId = values.get("--source-workflow-run-id");
  if (!sourceWorkflowRunId) throw new Error("--source-workflow-run-id is required");
  const caseLabel = values.get("--case") ?? "full-post-analysis";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(caseLabel)) throw new Error("--case must be a short safe label");
  return { sourceWorkflowRunId, ...(values.has("--candidate-artifact-id") ? { candidateArtifactId: values.get("--candidate-artifact-id") } : {}),
    ...(values.has("--output") ? { outputPath: path.resolve(values.get("--output")!) } : {}), caseLabel, dryRun };
}

async function locateHistoricalCandidate(store: PostgresWorkflowRunStore, options: Options): Promise<CandidateSource> {
  const run = await store.getRun(options.sourceWorkflowRunId);
  if (!run) throw new Error(`Source workflow run not found: ${options.sourceWorkflowRunId}`);
  const candidates = new Map<string, ArtifactRef>();
  for (const ref of await store.listArtifacts(run.id)) if (ref.type === "post-candidate") candidates.set(ref.id, ref);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const row = object(value);
    if (!row) return;
    if (isArtifactRef(row) && row.type === "post-candidate") candidates.set(row.id, row);
    Object.values(row).forEach(visit);
  };
  visit(run.output);
  if (options.candidateArtifactId && !candidates.has(options.candidateArtifactId)) {
    throw new Error("Explicit candidate is not bound by the selected source workflow");
  }
  if (!options.candidateArtifactId && candidates.size !== 1) {
    throw new Error("Source workflow must bind exactly one candidate; pass --candidate-artifact-id when ambiguous");
  }
  const id = options.candidateArtifactId ?? [...candidates.keys()][0]!;
  const bound = candidates.get(id)!;
  const ref = await store.getArtifact(id);
  if (!ref || ref.type !== "post-candidate" || ref.revision !== bound.revision || ref.sha256 !== bound.sha256) {
    throw new Error("Historical candidate binding does not match its stored revision and SHA");
  }
  const payload = object(await store.getArtifactPayload(id)) as CandidatePayload | undefined;
  if (!payload || payload.kind !== "post" || !isArtifactRef(payload.evidence) || typeof payload.reportArtifactRef !== "string"
    || typeof payload.reportSha256 !== "string" || typeof payload.relativeRoot !== "string") {
    throw new Error("Historical post-candidate payload is incomplete");
  }
  if (digest(fs.readFileSync(artifactPath(payload.reportArtifactRef))) !== payload.reportSha256) {
    throw new Error("Historical report bytes do not match the candidate SHA");
  }
  videoReconstructionOutcomeSchema.parse(payload.outcome);
  const actualEvidence = await store.getArtifact(payload.evidence.id);
  if (!actualEvidence || actualEvidence.type !== payload.evidence.type || actualEvidence.revision !== payload.evidence.revision
    || actualEvidence.sha256 !== payload.evidence.sha256) throw new Error("Historical evidence artifact binding mismatch");
  const frozen = object(await store.getArtifactPayload(actualEvidence.id)) as PinnedResearchInput | undefined;
  if (!frozen || frozen.kind !== "post" || !frozen.source) throw new Error("Historical frozen post evidence is missing");
  return { ref, payload, frozen };
}

export function prepareFullWorkflowInput(frozen: PinnedResearchInput): PinnedResearchInput {
  if (frozen.kind !== "post") throw new Error("Full post workflow requires frozen post inputs");
  const source = { ...(frozen.source as PostWorkflowStartInput), candidateMode: "rebuild" as const, evaluationMode: "fresh" as const };
  delete (source as { importedEvaluationArtifactRef?: string }).importedEvaluationArtifactRef;
  const pinned = pinResearchInput("post", source);
  const excluded = new Set([frozen.reuseCandidate?.artifactRef, frozen.reuseEvaluation?.artifactRef]
    .filter((value): value is string => typeof value === "string"));
  const expected = new Map(frozen.files.filter(({ ref }) => !excluded.has(ref)).map(({ ref, sha256 }) => [ref, sha256]));
  const actual = new Map(pinned.files.map(({ ref, sha256 }) => [ref, sha256]));
  const changed = [...expected].filter(([ref, sha256]) => actual.get(ref) !== sha256).map(([ref]) => ref);
  const unexpected = [...actual.keys()].filter((ref) => !expected.has(ref));
  if (changed.length || unexpected.length) throw new Error(`FROZEN_SOURCE_BINDING_MISMATCH: changed=${changed.join(",")}; unexpected=${unexpected.join(",")}`);
  return { ...pinned, methods: methodSnapshot("post"), skillPackages: [skillPackageSnapshot("post")] };
}

export function makeAgents() {
  const methods = methodSnapshot("post");
  const skillPackages = [skillPackageSnapshot("post")];
  const revision = digest(JSON.stringify({ methods, skillPackages }));
  const model = "gpt-6-luna";
  const reasoningEffort = "medium";
  const config = { delegate: "openai-agents-sdk", methods, skillPackages };
  const define = <Input, Output>(id: string) => defineAgent<Input, Output>({ id, revision: "full-post-benchmark@1", model,
    reasoningEffort, promptRevision: revision, skillsRevision: revision, permissionsRevision: "bound-evidence-tools@1",
    config: { ...config, prompt: "Execute the pinned full post workflow role with evidence-bound official SDK tools." } });
  const agents: Pick<ResearchAgentDefinitions, "postSourceChecker" | "postBuilder" | "postReviewer" | "postRepair" | "postEvaluationRepair"> = {
    postSourceChecker: define<PostWorkflowInput, SourceConsistencyReceipt>("post-source-checker"),
    postBuilder: define<PostWorkflowInput, PostCandidateReceipt>("post-builder"),
    postReviewer: define<unknown, PostEvaluationReceipt>("post-reviewer"),
    postRepair: define<unknown, PostCandidateReceipt>("post-repair"),
    postEvaluationRepair: define<PostEvaluationRepairInput, PostEvaluationRepairReceipt>("post-evaluation-repair"),
  };
  const validators: PostWorkflowValidators = {
    candidate(value) {
      try {
        const payload = value.artifact as CandidatePayload;
        if (!payload || payload.kind !== "post" || digest(fs.readFileSync(artifactPath(payload.reportArtifactRef))) !== payload.reportSha256) {
          return { valid: false, details: "candidate_revision_mismatch" };
        }
        const outcome = videoReconstructionOutcomeSchema.parse(payload.outcome);
        const passed = object(value.validation)?.passed === true;
        return { valid: ["built_unevaluated", "verified", "ready", "evaluated_with_findings"].includes(outcome.state) && passed,
          details: passed ? undefined : "builder_validation_not_passed" };
      } catch (error) { return { valid: false, details: error instanceof Error ? error.message : "candidate_contract_invalid" }; }
    },
    evaluation: () => ({ valid: false, details: "legacy evaluator is not used by V11 simple review" }),
  };
  const sourceCheck = createPostSourceCheckWorkflow("v2", agents);
  const suite = createPostWorkflowSuiteV11(validators, agents, { sourceCheck });
  const promptHashes = methods.filter(({ path: item }) => item.startsWith("prompts/responses-")).map(({ path: item, sha256 }) => ({ path: item, sha256 }));
  const sdkMethod = methods.find(({ path: item }) => item === "../../vendor/agent-workflow/packages/agent-sdk/src/responses.ts");
  const sdkPackageMethod = methods.find(({ path: item }) => item === "../../vendor/agent-workflow/packages/agent-sdk/package.json");
  if (!sdkMethod || !sdkPackageMethod) throw new Error("Agent SDK package and source must be included in method snapshot");
  const sdkManifest = JSON.parse(fs.readFileSync(path.resolve(projectRoot, sdkPackageMethod.path), "utf8")) as { version?: unknown };
  return { suite, agents, validators, methods, skillPackages, methodRevision: revision, model, reasoningEffort, promptHashes,
    sdkVersion: typeof sdkManifest.version === "string" ? sdkManifest.version : "unknown",
    sdkPackageSha256: sdkPackageMethod.sha256, sdkSourceSha256: sdkMethod.sha256 };
}

export function classifyOutcome(outputValue: unknown): { workflowOutcome: string; reviewStatus: string | null; candidateStatus: string | null;
  qualityAccepted: false; qualityDisposition: string } {
  const output = object(outputValue);
  const state = typeof output?.state === "string" ? output.state : null;
  const reviewStatus = typeof output?.reviewStatus === "string" ? output.reviewStatus : null;
  const candidateStatus = typeof output?.candidateStatus === "string" ? output.candidateStatus : null;
  if (state === "blocked") return { workflowOutcome: state, reviewStatus, candidateStatus, qualityAccepted: false,
    qualityDisposition: "blocked-needs-investigation" };
  if (state === "needs_review" || output?.ok !== true) return { workflowOutcome: state ?? "incomplete", reviewStatus, candidateStatus,
    qualityAccepted: false, qualityDisposition: "workflow-incomplete" };
  if (reviewStatus === "completed_no_findings") return { workflowOutcome: "completed", reviewStatus, candidateStatus,
    qualityAccepted: false, qualityDisposition: "empty-findings-require-full-report-quality-audit" };
  if (candidateStatus === "revised_unverified") return { workflowOutcome: "completed", reviewStatus, candidateStatus,
    qualityAccepted: false, qualityDisposition: "revised-candidate-remains-unverified" };
  return { workflowOutcome: "completed", reviewStatus, candidateStatus, qualityAccepted: false,
    qualityDisposition: "full-report-quality-audit-required" };
}

export async function collectWorkflowRunTree(store: PostgresWorkflowRunStore, rootRunId: string) {
  const runs: Array<{ id: string; workflowId: string; events: Array<{ type: string }> }> = [];
  const visited = new Set<string>();
  const visit = async (runId: string): Promise<void> => {
    if (visited.has(runId)) return;
    visited.add(runId);
    const run = await store.getRun(runId);
    if (!run) return;
    const events = await store.listEvents(run.id);
    runs.push({ id: run.id, workflowId: run.workflowId, events });
    for (const child of await store.listRuns({ parentRunId: run.id })) await visit(child.id);
  };
  await visit(rootRunId);
  const allEvents = runs.flatMap((run) => run.events);
  return { runs, requestCount: allEvents.filter((event) => event.type === "siwc.request").length,
    methodEventCount: allEvents.filter((event) => event.type === "responses.method").length };
}

async function collectCandidateArtifacts(store: PostgresWorkflowRunStore, rootRunId: string) {
  const trace = await collectWorkflowRunTree(store, rootRunId);
  const candidates: Array<Record<string, unknown>> = [];
  const reviews: Array<Record<string, unknown>> = [];
  for (const run of trace.runs) {
    for (const ref of await store.listArtifacts(run.id)) {
      if (ref.type !== "post-candidate" && ref.type !== "post-review") continue;
      const payload = object(await store.getArtifactPayload(ref.id));
      if (ref.type === "post-candidate") {
        candidates.push({ artifact: { id: ref.id, revision: ref.revision, sha256: ref.sha256 },
          producerRunId: run.id, producerWorkflowId: run.workflowId,
          reportArtifactRef: payload?.reportArtifactRef ?? null, reportSha256: payload?.reportSha256 ?? null });
      } else {
        reviews.push({ artifact: { id: ref.id, revision: ref.revision, sha256: ref.sha256 }, producerRunId: run.id,
          producerWorkflowId: run.workflowId,
          findingsCount: Array.isArray(payload?.findings) ? payload.findings.length : null });
      }
    }
  }
  return { candidates, reviews, requestCount: trace.requestCount, methodEventCount: trace.methodEventCount };
}

function writeSummary(file: string, value: unknown, replace = false): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try {
    if (!replace && fs.existsSync(file)) throw new Error(`Summary path already exists: ${file}`);
    fs.renameSync(temporary, file);
  } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
}

function redactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/giu, "Bearer [redacted]").replace(/\bsk-[A-Za-z0-9_-]+\b/gu, "[redacted]");
}

export async function runFullPostBenchmark(options: Options): Promise<Record<string, unknown>> {
  const connectionString = process.env.SELF_MEDIA_DATABASE_URL;
  if (!connectionString) throw new Error("SELF_MEDIA_DATABASE_URL is required");
  const pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000 });
  try {
    const store = new PostgresWorkflowRunStore(pool, { workspaceId: process.env.SELF_MEDIA_WORKSPACE_ID ?? "creator-lab-analysis" });
    const historical = await locateHistoricalCandidate(store, options);
    const pinned = prepareFullWorkflowInput(historical.frozen);
    assertPinnedResearchInput(pinned);
    const source = pinned.source as PostWorkflowStartInput;
    if (!fs.existsSync(artifactPath(source.sourceMediaArtifactRef))) throw new Error("Frozen source media is not present in the local cache");
    const workflow = makeAgents();
    const outputPath = options.outputPath ?? path.join(runtimeDir(), "benchmarks", "post-full-workflow",
      `${new Date().toISOString().replace(/[:.]/gu, "-")}-${safeSegment(options.caseLabel)}-${randomUUID()}.json`);
    const prepared = {
      mode: options.dryRun ? "dry-run" : "full-post-analyze",
      caseLabel: options.caseLabel,
      sourceWorkflowRunId: options.sourceWorkflowRunId,
      sourceCandidateArtifact: { id: historical.ref.id, revision: historical.ref.revision, sha256: historical.ref.sha256,
        reportArtifactRef: historical.payload.reportArtifactRef, reportSha256: historical.payload.reportSha256 },
      sourceWorkspaceId: process.env.SELF_MEDIA_WORKSPACE_ID ?? "creator-lab-analysis",
      frozenInputSha256: digest(JSON.stringify(pinned)),
      methodSnapshotSha256: digest(JSON.stringify({ methods: pinned.methods, skillPackages: pinned.skillPackages })),
      postId: source.postExternalId, creatorRunId: source.creatorRunId, candidateMode: source.candidateMode,
      evaluationMode: source.evaluationMode, frozenEvidenceFiles: pinned.files.length,
      methodSnapshotEntries: pinned.methods.length, skillPackages: workflow.skillPackages,
      promptHashes: workflow.promptHashes, methodRevision: workflow.methodRevision,
      sdk: { version: workflow.sdkVersion, packageSha256: workflow.sdkPackageSha256, sourceSha256: workflow.sdkSourceSha256 },
      model: workflow.model, reasoningEffort: workflow.reasoningEffort,
      plannedWorkflow: workflow.suite.analyze.id, plannedRevision: workflow.suite.analyze.revision,
      stages: ["source-check", "builder", "reviewer", "conditional-repair"],
      registrationEnabled: false, candidateRegistrationCallback: false, currentBatchMutation: false,
      qualityAcceptedByHarness: false, emptyReviewFindingsAreNotQualityAcceptance: true,
      repairedCandidateRequiresIndependentQualityAudit: true, summaryPath: outputPath,
    };
    if (options.dryRun) return prepared;
    if (fs.existsSync(outputPath)) throw new Error(`Summary path already exists: ${outputPath}`);
    writeSummary(outputPath, { ...prepared, mode: "full-post-analyze", status: "incomplete", workflowRunId: null });
    const benchmarkAttemptId = randomUUID();
    const startedAt = Date.now();
    const evidence = await registerResearchInput(store, pinned);
    const artifacts = new PostgresCreatorArtifactStore(new AnalysisPgContext(pool));
    const runner = new ResponsesResearchRunner(store, artifacts);
    const input: PostWorkflowInput = { creatorRunId: source.creatorRunId, postExternalId: source.postExternalId,
      evidenceKind: "video", candidateMode: "rebuild", evaluationMode: "fresh", evidence };
    const createRun = store.createRun.bind(store);
    store.createRun = async (record) => {
      const run = await createRun(record);
      if (!record.parentRunId && record.workflowId === workflow.suite.analyze.id) {
        await awaitHarnessRunBinding(run.id, run.workflowId, input);
      }
      return run;
    };
    let result;
    try {
      result = await runWorkflow({ workflow: workflow.suite.analyze, input, store, agentRunner: runner,
        metadata: { creatorRunId: source.creatorRunId, postId: source.postExternalId, benchmarkCase: options.caseLabel,
          sourceCandidateArtifactId: historical.ref.id, benchmarkAttemptId, registered: false,
          purpose: "isolated full post-analyze quality comparison" } });
    } catch (error) {
      const runs = await store.listRuns({ metadata: { benchmarkAttemptId } });
      const failed = runs.at(-1);
      const trace = failed ? await collectWorkflowRunTree(store, failed.id) : { requestCount: 0, methodEventCount: 0 };
      const steps = failed ? await store.listSteps(failed.id) : [];
      const activeStep = [...steps].reverse().find((step) => ["failed", "running", "needs_review", "blocked"].includes(step.state));
      writeSummary(outputPath, { ...prepared, mode: "full-post-analyze", status: "failed", completion: "runner-threw",
        workflowRunId: failed?.id ?? null, runState: failed?.state ?? null, stage: activeStep?.key ?? null,
        error: redactError(error), durationMs: Date.now() - startedAt,
        requestCount: trace.requestCount, methodEventCount: trace.methodEventCount,
        candidateArtifact: null, candidateReportRef: null, candidateReportSha256: null, qualityAccepted: false,
        summaryPath: outputPath }, true);
      throw error;
    }
    const output = object(result.output);
    const disposition = classifyOutcome(result.output);
    const candidate = isArtifactRef(output?.candidate) ? output.candidate : undefined;
    const evaluation = isArtifactRef(output?.evaluation) ? output.evaluation : undefined;
    const candidatePayload = candidate ? object(await store.getArtifactPayload(candidate.id)) as CandidatePayload | undefined : undefined;
    const reviewPayload = evaluation ? object(await store.getArtifactPayload(evaluation.id)) : undefined;
    const persisted = await collectCandidateArtifacts(store, result.run.id);
    const summary = { ...prepared, mode: "full-post-analyze",
      status: result.run.state === "succeeded" && output?.ok === true ? "completed" : result.run.state === "succeeded" ? "incomplete" : result.run.state,
      workflowRunId: result.run.id, runState: result.run.state, ...disposition,
      durationMs: Date.now() - startedAt, requestCount: persisted.requestCount,
      methodEventCount: persisted.methodEventCount,
      candidateArtifact: candidate ? { id: candidate.id, revision: candidate.revision, sha256: candidate.sha256 } : null,
      candidateReportRef: candidatePayload?.reportArtifactRef ?? null, candidateReportSha256: candidatePayload?.reportSha256 ?? null,
      evaluationArtifact: evaluation ? { id: evaluation.id, revision: evaluation.revision, sha256: evaluation.sha256 } : null,
      reviewFindingsCount: Array.isArray(reviewPayload?.findings) ? reviewPayload.findings.length : null,
      persistedCandidateArtifacts: persisted.candidates, persistedReviewArtifacts: persisted.reviews,
      summaryPath: outputPath };
    writeSummary(outputPath, summary, true);
    return summary;
  } finally { await pool.end(); }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write("Usage: tsx scripts/benchmark-post-workflow-run.ts --source-workflow-run-id ID [--candidate-artifact-id ID] [--case LABEL] [--output PATH] [--dry-run]\\n");
    return;
  }
  const options = parseWorkflowArgs(argv);
  try { process.stdout.write(`${JSON.stringify(await runFullPostBenchmark(options), null, 2)}\n`); }
  catch (error) { process.stderr.write(`${redactError(error)}\n`); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
