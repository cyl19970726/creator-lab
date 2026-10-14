import "dotenv/config";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { artifactPayloadSha256, defineAgent, runWorkflow, workflow,
  type ArtifactRef, type AgentRunner, type WorkflowEvent } from "@signal-room/workflow";
import { PostgresWorkflowRunStore } from "@signal-room/workflow-postgres";
import { createPostWorkflowSuiteV11, researchReviewReceiptSchema, videoReconstructionOutcomeSchema,
  type PostWorkflowValidators } from "../packages/research/index.js";
import type { PostWorkflowStartInput, ResearchAgentConfig } from "../packages/research/index.js";
import { AnalysisPgContext } from "../packages/adapters/src/platform/database/analysis-pg-context.js";
import { PostgresCreatorArtifactStore } from "../packages/adapters/src/platform/artifacts/postgres-creator-artifact-store.js";
import { ResponsesResearchRunner } from "../packages/adapters/src/workflow/responses-research-runner.js";
import { assertPinnedResearchInput, methodSnapshot, registerResearchInput, skillPackageSnapshot, type PinnedResearchInput } from "../packages/adapters/src/workflow/research-inputs.js";
import { artifactPath } from "../packages/adapters/src/core/artifacts.js";
import { runArtifactDir, runtimeDir } from "../packages/adapters/src/core/config.js";
import type { ResearchReviewReceipt } from "../packages/research/src/workflows/simple-review-contract.js";

type Options = {
  candidateArtifactId?: string;
  sourceReviewArtifactId?: string;
  sourceWorkflowRunId?: string;
  reportPath?: string;
  caseLabel: string;
  repeat: number;
  dryRun: boolean;
  repairOnFindings: boolean;
  outputPath?: string;
};

type CandidatePayload = {
  kind: "post";
  evidence: ArtifactRef;
  outcome: Record<string, unknown>;
  report: unknown;
  reportArtifactRef: string;
  reportSha256: string;
  relativeRoot: string;
};

type CandidateRecord = { ref: ArtifactRef; payload: CandidatePayload };
type JsonObject = Record<string, unknown>;

const candidateRefShape = (value: unknown): value is Pick<ArtifactRef, "id" | "revision" | "sha256"> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value)
    && typeof (value as JsonObject).id === "string"
    && typeof (value as JsonObject).revision === "string"
    && typeof (value as JsonObject).sha256 === "string");

function usage(): string {
  return [
    "Usage: pnpm --dir workbenches/analysis exec tsx scripts/benchmark-post-reviewer.ts \\",
    "  (--candidate-artifact-id ID [--source-review-artifact-id ID | --source-workflow-run-id ID] \\",
    "   | --source-review-artifact-id ID | --source-workflow-run-id ID) \\",
    "  [--case LABEL] [--repeat COUNT] [--report-path JSON] [--output PATH] [--dry-run] [--repair-on-findings]",
    "Reviewer model is fixed to gpt-6-luna; SELF_MEDIA_EVALUATOR_REASONING_EFFORT sets its effort.",
    "--repair-on-findings runs one bounded post.repair after a valid fresh review with findings; it never registers the result."
  ].join("\n");
}

export function parseBenchmarkArgs(argv: readonly string[]): Options {
  const values = new Map<string, string>();
  let dryRun = false;
  let repairOnFindings = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === "--dry-run") { dryRun = true; continue; }
    if (token === "--repair-on-findings") { repairOnFindings = true; continue; }
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
    if (values.has(token)) throw new Error(`Duplicate option: ${token}`);
    values.set(token, value);
    index += 1;
  }
  const allowed = new Set(["--candidate-artifact-id", "--source-review-artifact-id", "--source-workflow-run-id",
    "--report-path", "--case", "--repeat", "--output"]);
  for (const key of values.keys()) if (!allowed.has(key)) throw new Error(`Unknown option: ${key}`);
  const historyCount = ["--source-review-artifact-id", "--source-workflow-run-id"]
    .filter((key) => values.has(key)).length;
  if (historyCount > 1 || (historyCount === 0 && !values.has("--candidate-artifact-id"))) {
    throw new Error("Specify a candidate or exactly one source review/workflow");
  }
  const repeatValue = values.get("--repeat") ?? "1";
  const repeat = Number(repeatValue);
  if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 20) throw new Error("--repeat must be an integer from 1 to 20");
  if (repairOnFindings && repeat !== 1) throw new Error("--repair-on-findings requires --repeat 1");
  const caseLabel = values.get("--case") ?? "baseline";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(caseLabel)) throw new Error("--case must be a short safe label");
  return {
    ...(values.has("--candidate-artifact-id") ? { candidateArtifactId: values.get("--candidate-artifact-id") } : {}),
    ...(values.has("--source-review-artifact-id") ? { sourceReviewArtifactId: values.get("--source-review-artifact-id") } : {}),
    ...(values.has("--source-workflow-run-id") ? { sourceWorkflowRunId: values.get("--source-workflow-run-id") } : {}),
    ...(values.has("--report-path") ? { reportPath: path.resolve(values.get("--report-path")!) } : {}),
    ...(values.has("--output") ? { outputPath: path.resolve(values.get("--output")!) } : {}),
    caseLabel, repeat, dryRun, repairOnFindings,
  };
}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : undefined;
}

function collectArtifactRefs(value: unknown, found = new Map<string, Pick<ArtifactRef, "id" | "revision" | "sha256">>()) {
  if (Array.isArray(value)) value.forEach((item) => collectArtifactRefs(item, found));
  else {
    const record = object(value);
    if (!record) return found;
    if (candidateRefShape(record)) found.set(record.id, record);
    Object.values(record).forEach((item) => collectArtifactRefs(item, found));
  }
  return found;
}

function digest(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

function safeSegment(value: string): string {
  const segment = value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40);
  return segment || "case";
}

async function candidateFromArtifact(store: PostgresWorkflowRunStore, id: string): Promise<CandidateRecord> {
  const ref = await store.getArtifact(id);
  if (!ref || ref.type !== "post-candidate") throw new Error(`Candidate artifact not found or not post-candidate: ${id}`);
  const value = object(await store.getArtifactPayload(id)) as CandidatePayload | undefined;
  if (!value || value.kind !== "post" || !candidateRefShape(value.evidence)
    || typeof value.reportArtifactRef !== "string" || typeof value.reportSha256 !== "string"
    || typeof value.relativeRoot !== "string" || !object(value.outcome)) {
    throw new Error("Post candidate payload is incomplete");
  }
  const evidenceRef = await store.getArtifact(value.evidence.id);
  assertArtifactBinding(value.evidence, evidenceRef, "candidate evidence");
  return { ref, payload: value };
}

export function assertArtifactBinding(expected: Pick<ArtifactRef, "id" | "revision" | "sha256">,
  actual: ArtifactRef | null | undefined, label: string): asserts actual is ArtifactRef {
  if (!actual || actual.id !== expected.id || actual.revision !== expected.revision || actual.sha256 !== expected.sha256) {
    throw new Error(`${label} artifact binding does not match its stored revision and SHA`);
  }
}

export async function resolveCandidateFromReview(store: PostgresWorkflowRunStore, reviewArtifactId: string,
  selectedCandidateId?: string): Promise<CandidateRecord> {
  const source = await store.getArtifact(reviewArtifactId);
  if (!source || source.type !== "post-review") throw new Error(`Review artifact not found or not post-review: ${reviewArtifactId}`);
  const payload = object(await store.getArtifactPayload(source.id));
  const embeddedCandidate = payload?.candidate;
  if (!candidateRefShape(embeddedCandidate)) throw new Error("Review artifact does not bind exactly one candidate");
  const actualCandidate = await store.getArtifact(embeddedCandidate.id);
  if (!actualCandidate || actualCandidate.type !== "post-candidate") {
    throw new Error(`Review-bound candidate is not a stored post-candidate: ${embeddedCandidate.id}`);
  }
  assertArtifactBinding(embeddedCandidate, actualCandidate, "review candidate");
  if (selectedCandidateId && selectedCandidateId !== embeddedCandidate.id) {
    throw new Error("Selected candidate differs from the source review binding");
  }
  return candidateFromArtifact(store, embeddedCandidate.id);
}

async function resolveCandidate(store: PostgresWorkflowRunStore, options: Options): Promise<CandidateRecord> {
  let resolvedId = options.candidateArtifactId;
  if (options.sourceReviewArtifactId) {
    return resolveCandidateFromReview(store, options.sourceReviewArtifactId, resolvedId);
  }
  if (options.sourceWorkflowRunId) {
    const source = await store.getRun(options.sourceWorkflowRunId);
    if (!source) throw new Error(`Source workflow run not found: ${options.sourceWorkflowRunId}`);
    const candidates = new Map<string, ArtifactRef>();
    for (const ref of await store.listArtifacts(source.id)) if (ref.type === "post-candidate") candidates.set(ref.id, ref);
    for (const ref of collectArtifactRefs(source.output).values()) {
      const actual = await store.getArtifact(ref.id);
      if (actual?.type === "post-candidate" && actual.revision === ref.revision && actual.sha256 === ref.sha256) candidates.set(actual.id, actual);
    }
    if (resolvedId && !candidates.has(resolvedId)) {
      throw new Error("Explicit candidate is not bound by the selected source workflow");
    }
    if (!resolvedId) {
      if (candidates.size !== 1) throw new Error("Source workflow must identify one candidate; pass --candidate-artifact-id when ambiguous");
      resolvedId = [...candidates.keys()][0]!;
    }
  }
  if (!resolvedId) throw new Error("No candidate artifact was resolved");
  return candidateFromArtifact(store, resolvedId);
}

export function reviewReceiptForCandidate(runState: string, outputValue: unknown,
  candidate: Pick<ArtifactRef, "id" | "revision" | "sha256">, reportSha256: string): ResearchReviewReceipt | undefined {
  const output = object(outputValue);
  if (runState !== "succeeded" || output?.ok !== true) return undefined;
  const receipt = researchReviewReceiptSchema.parse(output.receipt);
  if (receipt.kind !== "post" || receipt.candidate.id !== candidate.id ||
    receipt.candidate.revision !== candidate.revision || receipt.candidate.sha256 !== candidate.sha256 ||
    receipt.candidateReportSha256 !== reportSha256) throw new Error("Fresh review does not bind the selected candidate and report SHA");
  return receipt;
}

async function boundArtifact(store: PostgresWorkflowRunStore, value: unknown, type: string): Promise<ArtifactRef> {
  const embedded = object(value);
  if (!candidateRefShape(embedded) || embedded.type !== type) throw new Error(`Fresh ${type} artifact receipt is missing`);
  const actual = await store.getArtifact(embedded.id);
  if (actual?.type !== type) throw new Error(`Stored ${type} artifact is missing`);
  assertArtifactBinding(embedded, actual, type);
  return actual;
}

export function benchmarkRepairModel(repairOnFindings: boolean,
  configured = process.env.SELF_MEDIA_BUILDER_MODEL): "gpt-6-luna" {
  if (repairOnFindings && configured && configured !== "gpt-6-luna") {
    throw new Error("--repair-on-findings requires SELF_MEDIA_BUILDER_MODEL=gpt-6-luna");
  }
  return "gpt-6-luna";
}

function createReviewerSuite(repairOnFindings: boolean) {
  const methods = methodSnapshot("post");
  const skillPackages = [skillPackageSnapshot("post")];
  const revision = digest(JSON.stringify({ methods, skillPackages }));
  const reasoningEffort = process.env.SELF_MEDIA_EVALUATOR_REASONING_EFFORT ?? "medium";
  const baseConfig = {
    model: "gpt-6-luna", reasoningEffort,
    prompt: "Execute the pinned analysis role with explicit host-bound evidence tools and validated output.",
    promptRevision: revision, skillSnapshotsRevision: revision, permissionsRevision: "bound-evidence-tools@1",
    config: { delegate: "openai-agents-sdk", methods, skillPackages },
  };
  const reviewerConfig: ResearchAgentConfig["postReviewer"] = {
    ...baseConfig, promptRevision: `${revision}:reviewer-v1`,
    config: { ...baseConfig.config, simpleReview: true },
  };
  const repairModel = benchmarkRepairModel(repairOnFindings);
  const repairReasoningEffort = process.env.SELF_MEDIA_BUILDER_REASONING_EFFORT ?? "medium";
  const validator: PostWorkflowValidators = {
    candidate(value) {
      try {
        const payload = value.artifact as CandidatePayload;
        if (!payload || payload.kind !== "post" ||
          digest(fs.readFileSync(artifactPath(payload.reportArtifactRef))) !== payload.reportSha256) {
          return { valid: false, details: "candidate_revision_mismatch" };
        }
        const outcome = videoReconstructionOutcomeSchema.parse(payload.outcome);
        const passed = object(value.validation)?.passed === true;
        return { valid: ["built_unevaluated", "verified", "ready", "evaluated_with_findings"].includes(outcome.state) && passed,
          details: passed ? undefined : "builder_validation_not_passed" };
      } catch (error) { return { valid: false, details: error instanceof Error ? error.message : "candidate_contract_invalid" }; }
    },
    evaluation: () => ({ valid: false, details: "legacy evaluator is outside this benchmark" }),
  };
  const reviewerAgent = defineAgent<unknown, unknown>({
    id: "post-reviewer", revision: "v1", model: "gpt-6-luna", reasoningEffort: baseConfig.reasoningEffort,
    promptRevision: reviewerConfig.promptRevision, skillsRevision: reviewerConfig.skillSnapshotsRevision,
    permissionsRevision: reviewerConfig.permissionsRevision, config: { ...reviewerConfig.config, prompt: reviewerConfig.prompt },
  });
  const repairAgent = defineAgent<unknown, unknown>({
    id: "post-repair", revision: "v1", model: repairModel, reasoningEffort: repairReasoningEffort,
    promptRevision: `${revision}:repair-v1`, skillsRevision: revision,
    permissionsRevision: "bound-evidence-tools@1",
    config: { ...baseConfig.config, prompt: baseConfig.prompt },
  });
  return { suite: createPostWorkflowSuiteV11(validator,
    { postReviewer: reviewerAgent, postRepair: repairAgent } as Parameters<typeof createPostWorkflowSuiteV11>[1], {}),
    reasoningEffort, repairModel, repairReasoningEffort,
    promptSha256: methods.find((method) => method.path === "prompts/responses-reviewer-v1.md")?.sha256 ?? null };
}

async function makeReportVariant(artifacts: PostgresCreatorArtifactStore, source: CandidatePayload,
  creatorRunId: string, reportPath: string, caseLabel: string): Promise<CandidatePayload> {
  const reportBytes = fs.readFileSync(reportPath);
  const report = JSON.parse(reportBytes.toString("utf8")) as unknown;
  const sourceReportFile = artifactPath(source.reportArtifactRef);
  const reportDir = path.dirname(sourceReportFile);
  const creatorRoot = path.resolve(runArtifactDir(creatorRunId));
  const relativeRoot = path.relative(creatorRoot, reportDir);
  if (!relativeRoot || relativeRoot.startsWith("..") || path.isAbsolute(relativeRoot) || relativeRoot.split(path.sep).includes("..")) {
    throw new Error("Candidate report directory is outside its creator-run artifact root");
  }
  const uniqueName = `benchmark-${safeSegment(caseLabel)}-${randomUUID()}.json`;
  const reference = `/artifacts/${creatorRunId}/${relativeRoot.split(path.sep).join("/")}/${uniqueName}`;
  const target = artifactPath(reference);
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await artifacts.ingest(reference, target, uniqueName, [source.reportArtifactRef]);
  return { ...source, report, reportArtifactRef: reference, reportSha256: digest(fs.readFileSync(target)),
    outcome: { ...source.outcome, reconstructionArtifactRef: reference } };
}

async function publishCandidateVariant(store: PostgresWorkflowRunStore, originalRef: ArtifactRef,
  variant: CandidatePayload, creatorRunId: string, postId: string, caseLabel: string): Promise<ArtifactRef> {
  const definition = workflow<{ payload: CandidatePayload; base: ArtifactRef }, ArtifactRef>(
    "post-review-benchmark.seed", { revision: "1" }, async (ctx, input) => ctx.publish("candidate", "post-candidate", input.payload,
      { schemaVersion: "post-candidate@1", validation: "valid", review: "pending", dependsOn: [
        { artifactId: input.base.id, revision: input.base.revision, sha256: input.base.sha256 },
        { artifactId: variant.evidence.id, revision: variant.evidence.revision, sha256: variant.evidence.sha256 },
      ] }));
  const noAgent: AgentRunner = { async run() { throw new Error("Candidate seeding must not invoke an agent"); } };
  const result = await runWorkflow({ workflow: definition, input: { payload: variant, base: originalRef }, store,
    agentRunner: noAgent, metadata: { creatorRunId, postId, benchmarkCase: caseLabel, purpose: "review-only candidate variant" } });
  if (!result.output) throw new Error("Candidate variant seeding produced no artifact");
  return result.output;
}

export function compactSummary(runId: string, runState: string, candidate: CandidateRecord, review: ResearchReviewReceipt | undefined,
  events: WorkflowEvent[], startedAt: number, caseLabel: string, repeatIndex: number, seedRunId: string | undefined,
  promptSha256: string | null, reasoningEffort: string) {
  return {
    workflowRunId: runId,
    runState,
    completion: review ? "receipt-recorded" : "incomplete-no-receipt",
    reviewStatus: review ? (review.findings.length ? "completed_with_findings" : "completed_no_findings") : "incomplete",
    currentPromptSha256: promptSha256,
    reasoningEffort,
    ...(seedRunId ? { candidateSeedRunId: seedRunId } : {}),
    caseLabel, repeatIndex,
    candidateArtifact: { id: candidate.ref.id, revision: candidate.ref.revision, sha256: candidate.ref.sha256,
      reportSha256: candidate.payload.reportSha256, reportArtifactRef: candidate.payload.reportArtifactRef,
      evidenceArtifactId: candidate.payload.evidence.id },
    model: "gpt-6-luna",
    durationMs: Date.now() - startedAt,
    requestCount: events.filter((event) => event.type === "siwc.request").length,
    methodEventCount: events.filter((event) => event.type === "responses.method").length,
    ...(review ? { review } : {}),
  };
}

export function markSummaryIncomplete(previous: Record<string, unknown>, error: unknown, failedAt = new Date().toISOString()) {
  const results = Array.isArray(previous.results) ? previous.results : [];
  const completedRepeats = typeof previous.completedRepeats === "number" ? previous.completedRepeats : results.length;
  return { ...previous, status: "incomplete", completion: "failed-or-threw", completedRepeats,
    failedAt, error: redactError(error) };
}

export function summarizeReviewResults(prepared: Record<string, unknown>, results: Record<string, unknown>[], expectedRepeats: number) {
  const completedRepeats = results.filter((result) => result.runState === "succeeded" && result.completion === "receipt-recorded").length;
  const repairComplete = prepared.repairOnFindings !== true || results.every((result) =>
    result.repairStatus === "not_needed" || result.repairStatus === "completed");
  const completed = results.length === expectedRepeats && completedRepeats === expectedRepeats && repairComplete;
  return { ...prepared, mode: prepared.repairOnFindings === true ? "review-with-conditional-repair" : "review-only",
    status: completed ? "completed" : "incomplete",
    completion: completed ? prepared.repairOnFindings === true ? "reviews-and-requested-repairs-recorded" : "all-reviews-recorded"
      : repairComplete ? "review-incomplete" : "review-or-repair-incomplete", completedRepeats, results };
}

function writeSummary(file: string, summary: unknown, replace = false): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try {
    if (!replace && fs.existsSync(file)) throw new Error(`Summary path already exists: ${file}`);
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function redactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/Bearer\s+\S+/giu, "Bearer [redacted]").replace(/\bsk-[A-Za-z0-9_-]+\b/gu, "[redacted]");
}

export async function runBenchmark(options: Options): Promise<Record<string, unknown>> {
  const connectionString = process.env.SELF_MEDIA_DATABASE_URL;
  if (!connectionString) throw new Error("SELF_MEDIA_DATABASE_URL is required");
  const pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000 });
  try {
    const workspaceId = process.env.SELF_MEDIA_WORKSPACE_ID ?? "creator-lab-analysis";
    const store = new PostgresWorkflowRunStore(pool, { workspaceId });
    const context = new AnalysisPgContext(pool);
    const creatorArtifacts = new PostgresCreatorArtifactStore(context);
    const candidate = await resolveCandidate(store, options);
    if (candidate.payload.reportSha256 !== digest(fs.readFileSync(artifactPath(candidate.payload.reportArtifactRef)))) {
      throw new Error("Candidate report hash does not match its frozen payload");
    }
    const frozen = object(await store.getArtifactPayload(candidate.payload.evidence.id)) as PinnedResearchInput | undefined;
    if (!frozen || frozen.kind !== "post" || !frozen.source) {
      throw new Error("Frozen post evidence artifact is missing or has the wrong kind");
    }
    // Keep the exact historical source/evidence bytes, but bind them to the
    // current reviewer method snapshot so this benchmark can test a new prompt.
    const benchmarkFrozen: PinnedResearchInput = { ...frozen, methods: methodSnapshot("post"), skillPackages: [skillPackageSnapshot("post")] };
    assertPinnedResearchInput(benchmarkFrozen);
    const source = frozen.source as PostWorkflowStartInput;
    const postId = source.postExternalId;
    const creatorRunId = source.creatorRunId;
    const reviewer = createReviewerSuite(options.repairOnFindings);
    if (reviewer.promptSha256 !== benchmarkFrozen.methods.find((method) => method.path === "prompts/responses-reviewer-v1.md")?.sha256) {
      throw new Error("Current reviewer prompt hash is missing from the pinned method snapshot");
    }
    const outputPath = options.outputPath ?? path.join(runtimeDir(), "benchmarks", "post-reviewer",
      `${new Date().toISOString().replace(/[:.]/gu, "-")}-${safeSegment(options.caseLabel)}-${randomUUID()}.json`);
    const prepared = {
      mode: options.dryRun ? "dry-run" : options.repairOnFindings ? "review-with-conditional-repair" : "review-only",
      caseLabel: options.caseLabel,
      repeat: options.repeat,
      repairOnFindings: options.repairOnFindings,
      postId,
      creatorRunId,
      sourceReviewArtifactId: options.sourceReviewArtifactId ?? null,
      sourceWorkflowRunId: options.sourceWorkflowRunId ?? null,
      candidateArtifact: { id: candidate.ref.id, revision: candidate.ref.revision, sha256: candidate.ref.sha256,
        reportSha256: candidate.payload.reportSha256, reportArtifactRef: candidate.payload.reportArtifactRef,
        evidenceArtifactId: candidate.payload.evidence.id },
      currentMethodSnapshotEntries: benchmarkFrozen.methods.length,
      currentPromptSha256: reviewer.promptSha256,
      reasoningEffort: reviewer.reasoningEffort,
      reportOverride: options.reportPath ? { path: options.reportPath, sha256: digest(fs.readFileSync(options.reportPath)) } : null,
      model: "gpt-6-luna",
      ...(options.repairOnFindings ? { repairModel: reviewer.repairModel,
        repairReasoningEffort: reviewer.repairReasoningEffort } : {}),
      summaryPath: outputPath,
      registrationEnabled: false,
      currentBatchMutation: false,
      fullWorkflowSpeedMeasurement: false,
    };
    if (options.dryRun) return prepared;

    if (fs.existsSync(outputPath)) throw new Error(`Summary path already exists: ${outputPath}`);
    const results: Record<string, unknown>[] = [];
    writeSummary(outputPath, { ...prepared, status: "incomplete", completedRepeats: 0, results });

    const responses = new ResponsesResearchRunner(store, creatorArtifacts);
    const benchmarkEvidence = await registerResearchInput(store, benchmarkFrozen);
    for (let index = 0; index < options.repeat; index += 1) {
      const label = options.repeat === 1 ? options.caseLabel : `${options.caseLabel}-${index + 1}`;
      const currentCandidatePayload = { ...candidate.payload, evidence: benchmarkEvidence };
      const variantPayload = options.reportPath
        ? await makeReportVariant(creatorArtifacts, currentCandidatePayload, creatorRunId, options.reportPath, label)
        : currentCandidatePayload;
      const variantRef = await publishCandidateVariant(store, candidate.ref, variantPayload, creatorRunId, postId, label);
      const seedRunId = variantRef.producedBy.workflowRunId;
      const selected = { ref: variantRef, payload: variantPayload };
      const startedAt = Date.now();
      const reviewAttemptId = randomUUID();
      let run: Awaited<ReturnType<typeof runWorkflow>>;
      try {
        run = await runWorkflow({ workflow: reviewer.suite.review,
          input: { candidate: selected.ref, evidence: selected.payload.evidence }, store, agentRunner: responses,
          metadata: { creatorRunId, postId, benchmarkCase: label, benchmarkAttemptId: reviewAttemptId,
            sourceCandidateArtifactId: candidate.ref.id, candidateArtifactId: selected.ref.id, registered: false } });
      } catch (error) {
        const startedRuns = await store.listRuns({ metadata: { benchmarkAttemptId: reviewAttemptId } });
        const failedRun = startedRuns.at(-1);
        const failedEvents = failedRun ? await store.listEvents(failedRun.id) : [];
        results.push({ ...compactSummary(failedRun?.id ?? "unknown", failedRun?.state ?? "failed", selected,
          undefined, failedEvents, startedAt, label, index + 1, seedRunId, reviewer.promptSha256,
          reviewer.reasoningEffort), repairStatus: "not_started" });
        writeSummary(outputPath, summarizeReviewResults(prepared, results, options.repeat), true);
        throw error;
      }
      const events = await store.listEvents(run.run.id);
      const raw = object(run.output);
      const result = { ...compactSummary(run.run.id, run.run.state, selected, undefined, events, startedAt, label, index + 1, seedRunId,
        reviewer.promptSha256, reviewer.reasoningEffort), repairStatus: "not_started" } as Record<string, unknown>;
      results.push(result);
      writeSummary(outputPath, summarizeReviewResults(prepared, results, options.repeat), true);
      const review = reviewReceiptForCandidate(run.run.state, raw, selected.ref, selected.payload.reportSha256);
      Object.assign(result, compactSummary(run.run.id, run.run.state, selected, review, events, startedAt, label, index + 1,
        seedRunId, reviewer.promptSha256, reviewer.reasoningEffort), {
        repairStatus: options.repairOnFindings ? review ? review.findings.length ? "pending" : "not_needed" : "not_started" : "not_requested" });
      writeSummary(outputPath, summarizeReviewResults(prepared, results, options.repeat), true);
      if (options.repairOnFindings && review?.findings.length) {
        const reviewRef = await boundArtifact(store, raw?.review, "post-review");
        const storedReview = researchReviewReceiptSchema.parse(await store.getArtifactPayload(reviewRef.id));
        if (await artifactPayloadSha256(storedReview) !== await artifactPayloadSha256(review)) {
          throw new Error("Stored review differs from the fresh review receipt");
        }
        const repairStartedAt = Date.now();
        const repairAttemptId = randomUUID();
        let repaired: Awaited<ReturnType<typeof runWorkflow>>;
        try {
          repaired = await runWorkflow({ workflow: reviewer.suite.repair,
            input: { candidate: selected.ref, evidence: selected.payload.evidence,
              findings: storedReview.findings, review: reviewRef }, store, agentRunner: responses,
            metadata: { creatorRunId, postId, benchmarkCase: label, benchmarkAttemptId: repairAttemptId,
              sourceCandidateArtifactId: candidate.ref.id, candidateArtifactId: selected.ref.id,
              reviewArtifactId: reviewRef.id, registered: false,
              purpose: "standalone review finding repair; not a full workflow benchmark" } });
        } catch (error) {
          const startedRuns = await store.listRuns({ metadata: { benchmarkAttemptId: repairAttemptId } });
          const failedRun = startedRuns.at(-1);
          result.repairStatus = "incomplete";
          result.repair = { workflowRunId: failedRun?.id ?? null, runState: failedRun?.state ?? null,
            durationMs: Date.now() - repairStartedAt, candidateStatus: "revision_incomplete",
            sourceReview: { id: reviewRef.id, revision: reviewRef.revision, sha256: reviewRef.sha256 } };
          writeSummary(outputPath, summarizeReviewResults(prepared, results, options.repeat), true);
          throw error;
        }
        const repairOutput = object(repaired.output);
        const repairEvents = await store.listEvents(repaired.run.id);
        const repairSucceeded = repaired.run.state === "succeeded" && repairOutput?.ok === true;
        result.repairStatus = "incomplete";
        result.repair = { workflowRunId: repaired.run.id, runState: repaired.run.state,
          durationMs: Date.now() - repairStartedAt,
          requestCount: repairEvents.filter(event => event.type === "siwc.request").length,
          sourceCandidate: { id: selected.ref.id, revision: selected.ref.revision, sha256: selected.ref.sha256 },
          sourceReview: { id: reviewRef.id, revision: reviewRef.revision, sha256: reviewRef.sha256 },
          candidateStatus: "revision_incomplete", candidateArtifact: null, revisionRecord: null };
        writeSummary(outputPath, summarizeReviewResults(prepared, results, options.repeat), true);
        let repairedCandidate: CandidateRecord | undefined;
        let revisionRecord: ArtifactRef | undefined;
        if (repairSucceeded) {
          const repairedRef = await boundArtifact(store, repairOutput.candidate, "post-candidate");
          repairedCandidate = await candidateFromArtifact(store, repairedRef.id);
          if (digest(fs.readFileSync(artifactPath(repairedCandidate.payload.reportArtifactRef))) !== repairedCandidate.payload.reportSha256) {
            throw new Error("Repaired candidate report bytes do not match its SHA");
          }
          revisionRecord = await boundArtifact(store, repairOutput.revisionRecord, "research-revision");
        }
        result.repairStatus = repairSucceeded ? "completed" : "incomplete";
        result.repair = { ...(result.repair as Record<string, unknown>),
          candidateStatus: repairSucceeded ? "revised_unverified" : "revision_incomplete",
          candidateArtifact: repairedCandidate ? { id: repairedCandidate.ref.id, revision: repairedCandidate.ref.revision,
            sha256: repairedCandidate.ref.sha256, reportSha256: repairedCandidate.payload.reportSha256,
            reportArtifactRef: repairedCandidate.payload.reportArtifactRef } : null,
          revisionRecord: revisionRecord ? { id: revisionRecord.id, revision: revisionRecord.revision,
            sha256: revisionRecord.sha256 } : null };
        writeSummary(outputPath, summarizeReviewResults(prepared, results, options.repeat), true);
      }
    }
    const summary = summarizeReviewResults(prepared, results, options.repeat);
    writeSummary(outputPath, summary, true);
    return summary;
  } finally {
    await pool.end();
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) { process.stdout.write(`${usage()}\n`); return; }
  const parsedOptions = parseBenchmarkArgs(argv);
  const options = { ...parsedOptions, outputPath: parsedOptions.outputPath ?? path.join(runtimeDir(), "benchmarks", "post-reviewer",
    `${new Date().toISOString().replace(/[:.]/gu, "-")}-${safeSegment(parsedOptions.caseLabel)}-${randomUUID()}.json`) };
  const outputExistedBeforeRun = fs.existsSync(options.outputPath);
  try {
    const summary = await runBenchmark(options);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } catch (error) {
    const failedAt = new Date().toISOString();
    const failure = { mode: options.repairOnFindings ? "review-with-conditional-repair" : "review-only",
      caseLabel: options.caseLabel, model: "gpt-6-luna", repeat: options.repeat,
      repairOnFindings: options.repairOnFindings,
      status: "incomplete", completion: "failed-or-threw", completedRepeats: 0, failedAt, error: redactError(error), summaryPath: options.outputPath };
    if (!outputExistedBeforeRun) {
      let prior: Record<string, unknown> = failure;
      if (fs.existsSync(options.outputPath)) {
        try { prior = object(JSON.parse(fs.readFileSync(options.outputPath, "utf8"))) ?? failure; } catch { prior = failure; }
      }
      try { writeSummary(options.outputPath, markSummaryIncomplete(prior, error, failedAt), true); } catch { /* preserve the original error on stderr */ }
    }
    process.stderr.write(`${JSON.stringify(failure)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
