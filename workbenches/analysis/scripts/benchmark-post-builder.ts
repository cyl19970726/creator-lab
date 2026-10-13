import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { defineAgent, runWorkflow, type ArtifactRef, type PostCandidateReceipt, type WorkflowEvent } from "@signal-room/workflow";
import { PostgresWorkflowRunStore } from "@signal-room/workflow-postgres";
import { createPostWorkflowSuiteV11, videoReconstructionOutcomeSchema, type PostWorkflowValidators } from "../packages/research/index.js";
import type { PostWorkflowInput, PostWorkflowStartInput, ResearchAgentDefinitions } from "../packages/research/index.js";
import { AnalysisPgContext } from "../packages/adapters/src/platform/database/analysis-pg-context.js";
import { PostgresCreatorArtifactStore } from "../packages/adapters/src/platform/artifacts/postgres-creator-artifact-store.js";
import { ResponsesResearchRunner } from "../packages/adapters/src/workflow/responses-research-runner.js";
import { assertPinnedResearchInput, methodSnapshot, pinResearchInput, registerResearchInput, skillPackageSnapshot,
  type PinnedResearchInput } from "../packages/adapters/src/workflow/research-inputs.js";
import { artifactPath } from "../packages/adapters/src/core/artifacts.js";
import { runtimeDir } from "../packages/adapters/src/core/config.js";

type Options = { sourceWorkflowRunId: string; candidateArtifactId?: string; caseLabel: string; dryRun: boolean; outputPath?: string };
type CandidatePayload = { kind: "post"; evidence: ArtifactRef; outcome: unknown; report: unknown; reportArtifactRef: string;
  reportSha256: string; relativeRoot: string };
type CandidateSource = { ref: ArtifactRef; payload: CandidatePayload; frozen: PinnedResearchInput };
type JsonObject = Record<string, unknown>;

export function assertHistoricalCandidateIntegrity(payload: CandidatePayload): void {
  if (hash(fs.readFileSync(artifactPath(payload.reportArtifactRef))) !== payload.reportSha256) {
    throw new Error("Historical candidate report bytes do not match its bound SHA");
  }
  videoReconstructionOutcomeSchema.parse(payload.outcome);
}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function artifactBinding(value: unknown): value is Pick<ArtifactRef, "id" | "revision" | "sha256"> {
  const row = object(value);
  return !!row && typeof row.id === "string" && typeof row.revision === "string" && typeof row.sha256 === "string";
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40) || "case";
}

function usage(): string {
  return [
    "Usage: pnpm --dir workbenches/analysis exec tsx scripts/benchmark-post-builder.ts",
    "  --source-workflow-run-id ID [--candidate-artifact-id ID] [--case LABEL] [--output PATH] [--dry-run]",
    "Runs only the production post.build workflow with gpt-6-luna / medium, always rebuilding from frozen source inputs.",
  ].join("\n");
}

export function parseBuilderArgs(argv: readonly string[]): Options {
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
  for (const option of values.keys()) if (!allowed.has(option)) throw new Error(`Unknown option: ${option}`);
  const sourceWorkflowRunId = values.get("--source-workflow-run-id");
  if (!sourceWorkflowRunId) throw new Error("--source-workflow-run-id is required");
  const caseLabel = values.get("--case") ?? "builder-quality";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(caseLabel)) throw new Error("--case must be a short safe label");
  return { sourceWorkflowRunId, ...(values.has("--candidate-artifact-id") ? { candidateArtifactId: values.get("--candidate-artifact-id") } : {}),
    ...(values.has("--output") ? { outputPath: path.resolve(values.get("--output")!) } : {}), caseLabel, dryRun };
}

async function locateCandidate(store: PostgresWorkflowRunStore, options: Options): Promise<CandidateSource> {
  const run = await store.getRun(options.sourceWorkflowRunId);
  if (!run) throw new Error(`Source workflow run not found: ${options.sourceWorkflowRunId}`);
  const candidates = new Map<string, ArtifactRef>();
  for (const ref of await store.listArtifacts(run.id)) if (ref.type === "post-candidate") candidates.set(ref.id, ref);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const row = object(value);
    if (!row) return;
    if (artifactBinding(row)) {
      const ref = row as unknown as ArtifactRef;
      if (ref.type === "post-candidate") candidates.set(ref.id, ref);
    }
    Object.values(row).forEach(visit);
  };
  visit(run.output);
  const id = options.candidateArtifactId;
  if (id && !candidates.has(id)) throw new Error("Explicit candidate is not bound by the selected source workflow");
  if (!id && candidates.size !== 1) throw new Error("Source workflow must identify exactly one post candidate; pass --candidate-artifact-id when ambiguous");
  const candidateId = id ?? [...candidates.keys()][0]!;
  const ref = await store.getArtifact(candidateId);
  if (!ref || ref.type !== "post-candidate" || ref.revision !== candidates.get(candidateId)?.revision
    || ref.sha256 !== candidates.get(candidateId)?.sha256) throw new Error("Source candidate artifact binding mismatch");
  const payload = object(await store.getArtifactPayload(ref.id)) as CandidatePayload | undefined;
  if (!payload || payload.kind !== "post" || !artifactBinding(payload.evidence) || typeof payload.reportArtifactRef !== "string"
    || typeof payload.reportSha256 !== "string" || typeof payload.relativeRoot !== "string") {
    throw new Error("Source candidate payload is incomplete");
  }
  assertHistoricalCandidateIntegrity(payload);
  const evidence = await store.getArtifact(payload.evidence.id);
  if (!evidence || evidence.revision !== payload.evidence.revision || evidence.sha256 !== payload.evidence.sha256) {
    throw new Error("Source candidate frozen-input binding mismatch");
  }
  const frozen = object(await store.getArtifactPayload(evidence.id)) as PinnedResearchInput | undefined;
  if (!frozen || frozen.kind !== "post" || !frozen.source) throw new Error("Candidate frozen post inputs are unavailable");
  return { ref, payload, frozen };
}

export function rebuildInput(frozen: PinnedResearchInput): PinnedResearchInput {
  if (frozen.kind !== "post") throw new Error("Only frozen post inputs are supported");
  const source = { ...(frozen.source as PostWorkflowStartInput), candidateMode: "rebuild" as const, evaluationMode: "fresh" as const };
  delete (source as { importedEvaluationArtifactRef?: string }).importedEvaluationArtifactRef;
  const pinned = pinResearchInput("post", source);
  if (pinned.reuseCandidate || pinned.reuseEvaluation) throw new Error("Builder benchmark unexpectedly resolved a reuse input");
  return { ...pinned, methods: methodSnapshot("post"), skillPackages: [skillPackageSnapshot("post")] };
}

export function assertHistoricalEvidenceUnchanged(historical: PinnedResearchInput, rebuilt: PinnedResearchInput): void {
  const excludedReuseRefs = new Set([historical.reuseCandidate?.artifactRef, historical.reuseEvaluation?.artifactRef]
    .filter((ref): ref is string => typeof ref === "string"));
  const expected = new Map(historical.files.filter((file) => !excludedReuseRefs.has(file.ref)).map(({ ref, sha256 }) => [ref, sha256]));
  const actual = new Map(rebuilt.files.map(({ ref, sha256 }) => [ref, sha256]));
  const missingOrChanged = [...expected].filter(([ref, sha256]) => actual.get(ref) !== sha256)
    .map(([ref]) => ref);
  const unexpected = [...actual.keys()].filter((ref) => !expected.has(ref));
  if (missingOrChanged.length || unexpected.length) {
    throw new Error(`FROZEN_SOURCE_BINDING_MISMATCH: missing_or_changed=${missingOrChanged.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}`);
  }
}

function isBuilt(state: string): boolean {
  return ["built_unevaluated", "verified", "ready", "evaluated_with_findings"].includes(state);
}

export function classifyBuilderResult(runState: string, outputValue: unknown, candidateRef: ArtifactRef | undefined,
  candidatePayload: CandidatePayload | undefined): { status: string; completion: string; businessState: string | null } {
  const output = object(outputValue);
  const receipt = object(output?.receipt);
  const validationPassed = object(receipt?.validation)?.passed === true;
  const complete = runState === "succeeded" && output?.ok === true && !!candidateRef && !!candidatePayload && validationPassed;
  return { status: complete ? "completed" : "incomplete",
    completion: complete ? "validated-candidate" : "missing-or-rejected-candidate",
    businessState: typeof output?.state === "string" ? output.state : null };
}

export function failureSummary(prepared: Record<string, unknown>, details: {
  workflowRunId: string | null; runState: string | null; stage: string | null; error: string;
  durationMs: number; requestCount: number; methodEventCount: number;
}): Record<string, unknown> {
  return { ...prepared, mode: "builder-only", status: "failed", completion: "runner-threw", ...details };
}

function createSuite() {
  const methods = methodSnapshot("post");
  const skillPackages = [skillPackageSnapshot("post")];
  const reasoningEffort = "medium";
  const model = "gpt-6-luna";
  const revision = hash(JSON.stringify({ methods, skillPackages }));
  const config = { model, reasoningEffort, prompt: "Execute the pinned post analysis Builder with canonical host validation.",
    promptRevision: revision, skillSnapshotsRevision: revision, permissionsRevision: "bound-evidence-tools@1",
    config: { delegate: "openai-agents-sdk", methods, skillPackages } };
  const make = <Input, Output>(id: string) => defineAgent<Input, Output>({ id, revision: "v1", model, reasoningEffort,
    promptRevision: config.promptRevision, skillsRevision: config.skillSnapshotsRevision,
    permissionsRevision: config.permissionsRevision, config: { ...config.config, prompt: config.prompt } });
  const agents = {
    postBuilder: make<PostWorkflowInput, PostCandidateReceipt>("post-builder"),
    postReviewer: make<unknown, unknown>("post-reviewer"),
    postRepair: make<unknown, unknown>("post-repair"),
    postEvaluationRepair: make<unknown, unknown>("post-evaluation-repair"),
  } as Pick<ResearchAgentDefinitions, "postBuilder" | "postReviewer" | "postRepair" | "postEvaluationRepair">;

  const validators: PostWorkflowValidators = {
    candidate(value) {
      try {
        const payload = value.artifact as CandidatePayload;
        if (!payload || payload.kind !== "post" || hash(fs.readFileSync(artifactPath(payload.reportArtifactRef))) !== payload.reportSha256) {
          return { valid: false, details: "candidate_revision_mismatch" };
        }
        const outcome = videoReconstructionOutcomeSchema.parse(payload.outcome);
        const passed = object(value.validation)?.passed === true;
        return { valid: isBuilt(outcome.state) && passed, details: passed ? undefined : "builder_validation_not_passed" };
      } catch (error) { return { valid: false, details: error instanceof Error ? error.message : "candidate_contract_invalid" }; }
    },
    evaluation: () => ({ valid: false, details: "review is outside this Builder-only benchmark" }),
  };
  return { suite: createPostWorkflowSuiteV11(validators, agents, {}), model, reasoningEffort, revision,
    promptSha256: methods.find((method) => method.path === "prompts/responses-post-builder-v1.md")?.sha256 ?? null,
    skillPackages };
}

function writeSummary(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

export async function runBuilderBenchmark(options: Options): Promise<Record<string, unknown>> {
  const connectionString = process.env.SELF_MEDIA_DATABASE_URL;
  if (!connectionString) throw new Error("SELF_MEDIA_DATABASE_URL is required");
  const pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000 });
  try {
    const store = new PostgresWorkflowRunStore(pool, { workspaceId: process.env.SELF_MEDIA_WORKSPACE_ID ?? "creator-lab-analysis" });
    const candidateSource = await locateCandidate(store, options);
    const pinned = rebuildInput(candidateSource.frozen);
    assertHistoricalEvidenceUnchanged(candidateSource.frozen, pinned);
    assertPinnedResearchInput(pinned);
    const source = pinned.source as PostWorkflowStartInput;
    const mediaPath = artifactPath(source.sourceMediaArtifactRef);
    if (!fs.existsSync(mediaPath)) throw new Error("Frozen source media is not present in the local cache");
    const suite = createSuite();
    if (!suite.promptSha256) throw new Error("Current Builder prompt is missing from method snapshot");
    const outputPath = options.outputPath ?? path.join(runtimeDir(), "benchmarks", "post-builder",
      `${new Date().toISOString().replace(/[:.]/gu, "-")}-${safeSegment(options.caseLabel)}-${randomUUID()}.json`);
    const prepared = {
      mode: options.dryRun ? "dry-run" : "builder-only",
      caseLabel: options.caseLabel,
      sourceWorkflowRunId: options.sourceWorkflowRunId,
      sourceCandidateArtifact: { id: candidateSource.ref.id, revision: candidateSource.ref.revision,
        sha256: candidateSource.ref.sha256, historicalReportSha256: candidateSource.payload.reportSha256 },
      postId: source.postExternalId,
      creatorRunId: source.creatorRunId,
      evidenceKind: source.evidenceKind ?? "video",
      candidateMode: source.candidateMode,
      reuseCandidate: false,
      frozenEvidenceFiles: pinned.files.length,
      methodSnapshotEntries: pinned.methods.length,
      skillPackages: suite.skillPackages,
      promptSha256: suite.promptSha256,
      methodRevision: suite.revision,
      model: suite.model,
      reasoningEffort: suite.reasoningEffort,
      localMediaAvailable: true,
      registrationEnabled: false,
      currentBatchMutation: false,
      summaryPath: outputPath,
    };
    if (options.dryRun) return prepared;
    if (fs.existsSync(outputPath)) throw new Error(`Summary path already exists: ${outputPath}`);

    const evidence = await registerResearchInput(store, pinned);
    const input: PostWorkflowInput = { creatorRunId: source.creatorRunId, postExternalId: source.postExternalId,
      evidenceKind: "video", evaluationMode: "fresh", candidateMode: "rebuild", evidence };
    const context = new AnalysisPgContext(pool);
    const artifacts = new PostgresCreatorArtifactStore(context);
    const runner = new ResponsesResearchRunner(store, artifacts);
    const startedAt = Date.now();
    const benchmarkAttemptId = randomUUID();
    let result;
    try {
      result = await runWorkflow({ workflow: suite.suite.build, input, store, agentRunner: runner,
        metadata: { creatorRunId: source.creatorRunId, postId: source.postExternalId, benchmarkCase: options.caseLabel,
          benchmarkAttemptId, sourceCandidateArtifactId: candidateSource.ref.id, registered: false,
          purpose: "isolated Builder quality comparison" } });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const runs = await store.listRuns({ metadata: { benchmarkAttemptId } });
      const failedRun = runs.at(-1);
      const events = failedRun ? await store.listEvents(failedRun.id) : [];
      const steps = failedRun ? await store.listSteps(failedRun.id) : [];
      const activeStep = [...steps].reverse().find((step) => ["failed", "running", "needs_review"].includes(step.state));
      const failedSummary = failureSummary(prepared, {
        workflowRunId: failedRun?.id ?? null, runState: failedRun?.state ?? null,
        stage: activeStep?.key ?? null, error: errorMessage,
        durationMs: Date.now() - startedAt,
        requestCount: events.filter((event) => event.type === "siwc.request").length,
        methodEventCount: events.filter((event) => event.type === "responses.method").length,
      });
      try { writeSummary(outputPath, { ...failedSummary, summaryPath: outputPath }); }
      catch (summaryError) { throw new Error(`${errorMessage}; benchmark summary could not be written: ${summaryError instanceof Error ? summaryError.message : String(summaryError)}`); }
      throw error;
    }
    const events: WorkflowEvent[] = await store.listEvents(result.run.id);
    const output = object(result.output);
    const candidateRef = artifactBinding(output?.candidate) ? output!.candidate as unknown as ArtifactRef : undefined;
    let candidatePayload: CandidatePayload | undefined;
    if (candidateRef) candidatePayload = object(await store.getArtifactPayload(candidateRef.id)) as CandidatePayload | undefined;
    const classification = classifyBuilderResult(result.run.state, result.output, candidateRef, candidatePayload);
    const summary = { ...prepared, mode: "builder-only", ...classification, runState: result.run.state, workflowRunId: result.run.id,
      durationMs: Date.now() - startedAt,
      requestCount: events.filter((event) => event.type === "siwc.request").length,
      methodEventCount: events.filter((event) => event.type === "responses.method").length,
      validation: object(object(output?.receipt)?.validation) ?? null,
      candidateArtifact: candidateRef ? { id: candidateRef.id, revision: candidateRef.revision, sha256: candidateRef.sha256 } : null,
      candidateReportRef: candidatePayload?.reportArtifactRef ?? null,
      candidateReportSha256: candidatePayload?.reportSha256 ?? null,
      summaryPath: outputPath,
    };
    writeSummary(outputPath, summary);
    return summary;
  } finally { await pool.end(); }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) { process.stdout.write(`${usage()}\n`); return; }
  const options = parseBuilderArgs(argv);
  try {
    const summary = await runBuilderBenchmark(options);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message.replace(/Bearer\s+\S+/giu, "Bearer [redacted]").replace(/\bsk-[A-Za-z0-9_-]+\b/gu, "[redacted]")}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
