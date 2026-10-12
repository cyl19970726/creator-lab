import { MemoryRunStore, artifactPayloadSha256, workflow, workflowFingerprint, type AgentRunRequest, type AgentRunResult,
  type AgentRunner, type ArtifactRef } from "@signal-room/workflow";
import { describe, expect, it, vi } from "vitest";
import { createPostWorkflow } from "../../../research/src/workflows/post.js";
import { createResearchAgentDefinitions } from "../../../research/src/workflows/agents.js";
import type { PostWorkflowInput, PostWorkflowOutput, ResearchWorkflowDefinitions } from "../../../research/src/workflows/contracts.js";
import { ResearchWorkflowExecutorBase, type ExecutionRecord, type ResearchExecutionPersistence,
  type ResearchWorkflowInputFreezer, type WorkflowAdvanceScheduler, type WorkflowDefinitionRegistry } from "./research-workflow-executor.js";

/** Test seam for the durable execution envelope; run/step/event projection stays in MemoryRunStore. */
class MemoryExecutionPersistence implements ResearchExecutionPersistence {
  readonly records = new Map<string, ExecutionRecord>();
  async insert(record: ExecutionRecord): Promise<void> {
    if (this.records.has(record.id)) throw new Error(`duplicate execution: ${record.id}`);
    this.records.set(record.id, structuredClone(record));
  }
  async read(id: string): Promise<ExecutionRecord | undefined> {
    const record = this.records.get(id);
    return record ? structuredClone(record) : undefined;
  }
  async patch(record: ExecutionRecord, patch: Partial<ExecutionRecord>): Promise<ExecutionRecord> {
    const updated = { ...record, ...patch };
    this.records.set(record.id, structuredClone(updated));
    return structuredClone(updated);
  }
  async children(parentRunId: string): Promise<ExecutionRecord[]> {
    return [...this.records.values()].filter((record) => record.parentWorkflowRunId === parentRunId).map((record) => structuredClone(record));
  }
  async byParentStep(parentStepRunId: string): Promise<ExecutionRecord | undefined> {
    const record = [...this.records.values()].find((item) => item.parentStepRunId === parentStepRunId);
    return record ? structuredClone(record) : undefined;
  }
  async byRetryLink(parentRunId: string, workflowId: string, key: string, attempt: 1 | 2): Promise<ExecutionRecord[]> {
    return [...this.records.values()].filter((record) => record.parentWorkflowRunId === parentRunId
      && record.workflowId === workflowId && record.retryLink?.key === key && record.retryLink.attempt === attempt)
      .map((record) => structuredClone(record));
  }
  async byAutomaticKey(key: string): Promise<ExecutionRecord | undefined> {
    const record = [...this.records.values()].find((item) => item.automatic?.operationKey === key);
    return record ? structuredClone(record) : undefined;
  }
  async withAutomaticKey<T>(_key: string, operation: () => Promise<T>): Promise<T> { return operation(); }
}

class ResearchRunner implements AgentRunner {
  readonly calls: string[] = [];
  constructor(private readonly reviewResult: () => boolean) {}
  async run<Input, Output>(request: AgentRunRequest<Input>): Promise<AgentRunResult<Output>> {
    this.calls.push(request.definition.id);
    if (request.definition.id === "post-builder") return { output: { artifact: { report: "candidate" } } as Output };
    if (request.definition.id === "post-reviewer") {
      return { output: { artifact: { review: "evaluation" }, route: "deliver", contractValid: this.reviewResult() } as Output };
    }
    throw new Error(`Unexpected agent: ${request.definition.id}`);
  }
}

function definitions(reviewValid: () => boolean): ResearchWorkflowDefinitions {
  const config = { prompt: "test", promptRevision: "1", skillSnapshotsRevision: "1", permissionsRevision: "1", config: {} };
  const agents = createResearchAgentDefinitions({ postSourceChecker: config, postBuilder: config, postReviewer: config, postRepair: config,
    postEvaluationRepair: config, creatorBuilder: config, creatorReviewer: config, creatorRepair: config });
  return {
    post: createPostWorkflow({
      candidate: (value) => typeof value === "object" && value !== null && "artifact" in value ? { valid: true } : { valid: false },
      evaluation: (value) => ({ valid: reviewValid() && (value as { contractValid?: boolean }).contractValid === true }),
    }, agents),
    creatorSynthesis: workflow("creator.test", { revision: "v1" }, async (ctx, input) => {
      const artifact = await ctx.publish("synthesis", "creator-synthesis", input, { validation: "valid" });
      return { ok: true, synthesis: artifact, evaluation: artifact };
    }),
  };
}

const frozen = { creatorRunId: "creator-1", postExternalId: "post-1", evidenceKind: "video" as const,
  evidence: { id: "evidence-1", revision: "1", sha256: "a" } as unknown as ArtifactRef };
function freezer(evidence: ArtifactRef = frozen.evidence): ResearchWorkflowInputFreezer {
  return {
    post: async (input) => ({ creatorRunId: input.creatorRunId, postExternalId: input.postExternalId,
      evidenceKind: input.evidenceKind ?? "video", evaluationMode: input.evaluationMode,
      importedEvaluationArtifactRef: input.importedEvaluationArtifactRef, evidence }),
    creator: async (input) => ({ creatorRunId: input.creatorRunId, frozenInputs: evidence }),
    analysis: async (input) => ({ creatorRunId: input.creatorRunId, source: evidence,
      posts: input.posts.map((post) => ({ creatorRunId: post.creatorRunId, postExternalId: post.postExternalId,
        evidenceKind: post.evidenceKind ?? "video", evidence })) }),
  };
}

function postStart(postExternalId = "post-1") {
  return { creatorRunId: "creator-1", postExternalId, sourceUrl: `https://example.test/${postExternalId}`,
    sourceMediaArtifactRef: "media", detailArtifactRef: "detail", mediaManifestArtifactRef: "manifest",
    selectionArtifactRef: "selection", reconstructionBatchArtifactRef: "batch" };
}

function createExecutor(persistence: MemoryExecutionPersistence, store = new MemoryRunStore(), runner: AgentRunner = noAgentRunner(),
  configured = definitions(() => true), inputFreezer = freezer(), registry?: WorkflowDefinitionRegistry,
  scheduler?: WorkflowAdvanceScheduler) {
  return new ResearchWorkflowExecutorBase(persistence, store, runner, configured, inputFreezer, registry, scheduler);
}

async function seedEvidence(store: MemoryRunStore): Promise<ArtifactRef> {
  const run = await store.createRun({ workflowId: "seed", workflowRevision: "1", inputFingerprint: "seed", state: "succeeded" });
  const step = await store.createStep({ runId: run.id, key: "evidence", kind: "publish", workflowId: "seed",
    workflowRevision: "1", inputFingerprint: "seed", configFingerprint: "seed", state: "succeeded", validation: "valid" });
  const attempt = await store.createAttempt({ runId: run.id, stepRunId: step.id, state: "succeeded" });
  const payload = { frozen: true };
  return store.publishArtifact({ type: "post-evidence", schemaVersion: "v1", revision: "1", sha256: await artifactPayloadSha256(payload),
    uri: "artifact://evidence", payload, producedBy: { workflowRunId: run.id, stepRunId: step.id, attemptId: attempt.id },
    dependsOn: [], validation: "valid", review: "not_applicable" });
}

function noAgentRunner(): AgentRunner { return { run: async () => { throw new Error("Unexpected agent call"); } }; }
const advance = (receipt: { creatorRunId: string; workflowRunId: string; generation: number }) => ({ ...receipt, signal: new AbortController().signal });

describe("ResearchWorkflowExecutorBase", () => {
  it("freezes input and retries only the invalid review node after executor recreation", async () => {
    const persistence = new MemoryExecutionPersistence();
    const store = new MemoryRunStore();
    const evidence = await seedEvidence(store);
    let reviewValid = false;
    const runner = new ResearchRunner(() => reviewValid);
    const configured = definitions(() => reviewValid);
    let executor = createExecutor(persistence, store, runner, configured, freezer(evidence));
    const created = await executor.createPost(postStart());
    expect((await store.getRun(created.workflowRunId))?.metadata).toMatchObject({ postId: "post-1", sourceWorkflowRunId: evidence.producedBy.workflowRunId });
    expect(await executor.advance(advance(created))).toMatchObject({ state: "needs_review" });
    expect(runner.calls.filter((id) => id === "post-builder")).toHaveLength(1);

    executor = createExecutor(persistence, store, runner, configured, freezer(evidence));
    const retry = await executor.prepareRetry({ creatorRunId: "creator-1", workflowRunId: created.workflowRunId, stepKey: "review:0" });
    reviewValid = true;
    expect(await executor.advance(advance(retry))).toMatchObject({ state: "succeeded" });
    expect(runner.calls.filter((id) => id === "post-builder")).toHaveLength(1);
    expect(runner.calls.filter((id) => id === "post-reviewer")).toHaveLength(2);
  });

  it("rejects stale generations and keeps cancellation durable in the envelope and run projection", async () => {
    const persistence = new MemoryExecutionPersistence();
    const store = new MemoryRunStore();
    const executor = createExecutor(persistence, store);
    const created = await executor.createPost(postStart());
    await executor.cancel(created.workflowRunId);
    expect(await executor.snapshot("creator-1", created.workflowRunId)).toMatchObject({ state: "canceled" });
    expect(await store.getRun(created.workflowRunId)).toMatchObject({ state: "canceled" });
    expect(await executor.advance(advance(created))).toMatchObject({ state: "canceled" });
    await expect(executor.advance({ ...advance(created), generation: 0 })).rejects.toThrow("Stale workflow generation");
  });

  it("cancels queued retried descendants through a failed parent without deleting prior failure evidence", async () => {
    const persistence = new MemoryExecutionPersistence();
    const store = new MemoryRunStore();
    const root = await store.createRun({ workflowId: "post.analyze", workflowRevision: "v11", inputFingerprint: "root", state: "waiting" });
    const failedParent = await store.createRun({ workflowId: "nested-parent", workflowRevision: "v1", inputFingerprint: "parent",
      state: "failed", parentRunId: root.id, error: "nested child failed" });
    const parentStep = await store.createStep({ runId: failedParent.id, key: "nested", kind: "workflow", workflowId: "nested-parent",
      workflowRevision: "v1", inputFingerprint: "nested", configFingerprint: "nested", state: "failed", validation: "invalid" });
    const parentAttempt = await store.createAttempt({ runId: failedParent.id, stepRunId: parentStep.id, state: "failed", error: "nested child failed" });
    const failedChild = await store.createRun({ workflowId: "nested-child", workflowRevision: "v1", inputFingerprint: "child",
      state: "failed", parentRunId: failedParent.id, error: "generation one failed" });
    const childStep = await store.createStep({ runId: failedChild.id, key: "work", kind: "task", workflowId: "nested-child",
      workflowRevision: "v1", inputFingerprint: "work", configFingerprint: "work", state: "failed", validation: "invalid" });
    const childAttempt = await store.createAttempt({ runId: failedChild.id, stepRunId: childStep.id, state: "failed", error: "generation one failed" });
    const priorFailure = { priorFailureEvidence: true };
    const failureArtifact = await store.publishArtifact({ type: "failure-evidence", schemaVersion: "v1", revision: "1",
      sha256: await artifactPayloadSha256(priorFailure), uri: "artifact://prior-failure", payload: priorFailure,
      producedBy: { workflowRunId: failedChild.id, stepRunId: childStep.id, attemptId: childAttempt.id },
      dependsOn: [], validation: "valid", review: "not_applicable" });
    const executor = createExecutor(persistence, store);
    await persistence.insert({ id: root.id, creatorRunId: "creator-1", kind: "post", workflowId: root.workflowId,
      definitionRevision: root.workflowRevision, generation: 1, state: "waiting", frozenInput: {} });
    await persistence.insert({ id: failedParent.id, creatorRunId: "creator-1", kind: "child", workflowId: failedParent.workflowId,
      definitionRevision: failedParent.workflowRevision, generation: 1, state: "failed", frozenInput: {}, parentWorkflowRunId: root.id });
    await persistence.insert({ id: failedChild.id, creatorRunId: "creator-1", kind: "child", workflowId: failedChild.workflowId,
      definitionRevision: failedChild.workflowRevision, generation: 2, state: "queued", frozenInput: {}, parentWorkflowRunId: failedParent.id });

    await executor.cancel(root.id);

    expect((await persistence.read(failedParent.id))?.state).toBe("failed");
    expect((await persistence.read(failedChild.id))?.state).toBe("canceled");
    expect(await store.listArtifacts(failedChild.id)).toEqual([expect.objectContaining({ id: failureArtifact.id, payload: priorFailure })]);
    expect(await store.listAttempts(childStep.id)).toEqual([expect.objectContaining({ id: childAttempt.id, state: "failed", error: "generation one failed" })]);
    expect(await store.listAttempts(parentStep.id)).toEqual([expect.objectContaining({ id: parentAttempt.id, state: "failed", error: "nested child failed" })]);
  });

  it("projects initialization failures and reconciles historical terminal envelopes", async () => {
    const persistence = new MemoryExecutionPersistence();
    const store = new MemoryRunStore();
    const executor = createExecutor(persistence, store);
    const created = await executor.createPost(postStart());
    const record = await persistence.read(created.workflowRunId);
    await persistence.patch(record!, { workflowId: "unregistered.workflow", definitionRevision: "missing" });
    expect(await executor.advance(advance(created))).toMatchObject({ state: "failed" });
    expect(await store.getRun(created.workflowRunId)).toMatchObject({ state: "failed", error: expect.stringContaining("not registered") });
    expect((await store.listEvents(created.workflowRunId)).at(-1)).toMatchObject({ type: "workflow.failed" });

    const historical = await executor.createPost(postStart("historical"));
    const historicalRecord = await persistence.read(historical.workflowRunId);
    await persistence.patch(historicalRecord!, { state: "failed", error: "historical fingerprint mismatch" });
    expect(await executor.snapshot("creator-1", historical.workflowRunId)).toMatchObject({ state: "failed" });
    expect(await store.getRun(historical.workflowRunId)).toMatchObject({ state: "failed", error: "historical fingerprint mismatch" });
    await executor.cancel(historical.workflowRunId);
    expect((await store.listEvents(historical.workflowRunId)).filter((event) => event.type === "workflow.projection_reconciled")).toHaveLength(1);
  });

  it("recovers a registered historical definition without discarding durable steps", async () => {
    const persistence = new MemoryExecutionPersistence();
    const store = new MemoryRunStore();
    const legacy = workflow("post.analyze", { revision: "v2" }, async (ctx) => ctx.blocked({ kind: "legacy-v2" }));
    const current = workflow<PostWorkflowInput, PostWorkflowOutput>("post.analyze", { revision: "v3" }, async (ctx) =>
      ctx.blocked({ kind: "current-v3" }) as PostWorkflowOutput);
    const registry: WorkflowDefinitionRegistry = { resolve: (id, revision) => id === legacy.id && revision === legacy.revision ? legacy : undefined };
    const configured = { ...definitions(() => true), post: current };
    const executor = createExecutor(persistence, store, noAgentRunner(), configured, freezer(), registry);
    const frozenInput = { creatorRunId: "creator-1", postExternalId: "legacy", evidenceKind: "video" as const, evidence: frozen.evidence };
    const run = await store.createRun({ workflowId: legacy.id, workflowRevision: legacy.revision,
      inputFingerprint: workflowFingerprint(frozenInput), state: "failed", error: "WORKFLOW_DEFINITION_REVISION_MISMATCH" });
    const step = await store.createStep({ runId: run.id, key: "preserved", kind: "task", workflowId: legacy.id,
      workflowRevision: legacy.revision, inputFingerprint: "frozen-step", configFingerprint: "v1", state: "succeeded", validation: "valid",
      output: { preserved: true } });
    const attempt = await store.createAttempt({ runId: run.id, stepRunId: step.id, state: "succeeded" });
    await persistence.insert({ id: run.id, creatorRunId: "creator-1", kind: "post", workflowId: legacy.id,
      definitionRevision: legacy.revision, generation: 1, state: "failed", error: "WORKFLOW_DEFINITION_REVISION_MISMATCH", frozenInput });
    const recovered = await executor.recoverPreExecutionDefinitionMismatch({ creatorRunId: "creator-1", workflowRunId: run.id });
    expect(recovered).toMatchObject({ state: "queued", generation: 2 });
    expect(await store.listSteps(run.id)).toEqual([expect.objectContaining({ id: step.id, state: "succeeded", output: { preserved: true } })]);
    expect(await store.listAttempts(step.id)).toEqual([expect.objectContaining({ id: attempt.id, state: "succeeded" })]);
    expect(await executor.advance(advance(recovered))).toMatchObject({ state: "blocked" });
  });

  it("keeps the core-evidence recovery gate narrow and preserves the failed attempt", async () => {
    const persistence = new MemoryExecutionPersistence();
    const store = new MemoryRunStore();
    const evidence = await seedEvidence(store);
    const frozenInput = { creatorRunId: "creator-1", postExternalId: "post-core-count", evidenceKind: "video", evidence };
    const error = `POST_CANDIDATE_INCOMPLETE:${JSON.stringify({ state: "not_ready", failedGateIds: ["builder_integrity_core_evidence_count"] })}`;
    const run = await store.createRun({ workflowId: "post.build", workflowRevision: "v1", inputFingerprint: workflowFingerprint(frozenInput), state: "failed", error });
    const step = await store.createStep({ runId: run.id, key: "builder", kind: "agent", workflowId: "post.build",
      workflowRevision: "v1", inputFingerprint: workflowFingerprint(frozenInput), configFingerprint: "post-builder:v1",
      state: "failed", validation: "invalid", error });
    const attempt = await store.createAttempt({ runId: run.id, stepRunId: step.id, state: "failed", error });
    await persistence.insert({ id: run.id, creatorRunId: "creator-1", kind: "child", workflowId: "post.build",
      definitionRevision: "v1", generation: 1, state: "failed", frozenInput, error });
    const executor = createExecutor(persistence, store, noAgentRunner(), definitions(() => true), freezer(evidence));
    await expect(executor.prepareCoreEvidenceCountBuilderRecovery({ creatorRunId: "creator-1", workflowRunId: run.id }))
      .resolves.toMatchObject({ generation: 2, state: "queued", stepKey: "builder" });
    expect(await store.listSteps(run.id)).toEqual([expect.objectContaining({ id: step.id, state: "failed", error })]);
    expect(await store.listAttempts(step.id)).toEqual([expect.objectContaining({ id: attempt.id, state: "failed", error })]);
    expect(await store.listEvents(run.id)).toEqual(expect.arrayContaining([expect.objectContaining({
      type: "workflow.core_evidence_recovery_queued", data: expect.objectContaining({ gateId: "builder_integrity_core_evidence_count" }),
    })]));
    const invalid = await persistence.read(run.id);
    await persistence.patch(invalid!, { error: `POST_CANDIDATE_INCOMPLETE:${JSON.stringify({ failedGateIds: ["builder_integrity_core_evidence_count", "other"] })}` });
    await expect(executor.prepareCoreEvidenceCountBuilderRecovery({ creatorRunId: "creator-1", workflowRunId: run.id }))
      .rejects.toThrow("CORE_EVIDENCE_RECOVERY_REQUIRES_ONLY_CORE_EVIDENCE_COUNT_FAILURE");
  });

  it("aborts a running runner when another executor instance requests cancellation", async () => {
    const persistence = new MemoryExecutionPersistence();
    const store = new MemoryRunStore();
    const evidence = await seedEvidence(store);
    let started = false;
    const runner: AgentRunner = { run: <Input, Output>(request: AgentRunRequest<Input>) => new Promise<AgentRunResult<Output>>((_resolve, reject) => {
      started = true;
      request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
    }) };
    const configured = definitions(() => true);
    const executor = createExecutor(persistence, store, runner, configured, freezer(evidence));
    const created = await executor.createPost(postStart());
    const advancing = executor.advance(advance(created));
    await vi.waitFor(() => expect(started).toBe(true));
    const secondProcess = createExecutor(persistence, store, runner, configured, freezer(evidence));
    await secondProcess.cancel(created.workflowRunId);
    await expect(advancing).resolves.toMatchObject({ state: "canceled" });
  });

  it("durably dispatches a child, wakes its parent, retries the child, and cancels live descendants", async () => {
    const persistence = new MemoryExecutionPersistence();
    const store = new MemoryRunStore();
    const evidence = await seedEvidence(store);
    let repaired = false;
    const child = workflow("durable-child", { revision: "v1" }, async (ctx, input: { value: string; postExternalId: string }) => {
      await ctx.publish("child-artifact", "child-output", input, { validation: "valid" });
      return ctx.task("child-work", (value) => {
        if (value.value === "fail" && !repaired) throw new Error("child failed after artifact");
        return { child: value.value };
      }, input);
    });
    const parent = workflow("post.analyze", { revision: "v11" }, async (ctx, input: { postExternalId: string }) =>
      ({ ok: true, result: await ctx.call("durable", child, { value: input.postExternalId === "post-1" ? "saved" : "fail", postExternalId: input.postExternalId }) }));
    const configured = { ...definitions(() => true), post: parent as unknown as ResearchWorkflowDefinitions["post"] };
    const scheduled: Array<{ creatorRunId: string; workflowRunId: string; workflowId: string; workflowRevision: string; generation: number; idempotencyKey: string }> = [];
    const seen = new Set<string>();
    const scheduler: WorkflowAdvanceScheduler = { enqueue: async (item) => {
      if (!seen.has(item.idempotencyKey)) { seen.add(item.idempotencyKey); scheduled.push(item); }
    } };
    const registry: WorkflowDefinitionRegistry = { resolve: (id, revision) => id === child.id && revision === child.revision
      ? child as unknown as ReturnType<WorkflowDefinitionRegistry["resolve"]> : undefined };
    let executor = createExecutor(persistence, store, noAgentRunner(), configured, freezer(evidence), registry, scheduler);
    const created = await executor.createPost(postStart());
    expect(await executor.advance(advance(created))).toMatchObject({ state: "waiting" });
    const childJob = scheduled.find((item) => item.idempotencyKey.startsWith("workflow-child:"))!;
    expect(childJob.workflowId).toBe(child.id);
    expect((await store.getRun(childJob.workflowRunId))?.metadata).toMatchObject({ postId: "post-1" });

    executor = createExecutor(persistence, store, noAgentRunner(), configured, freezer(evidence), registry, scheduler);
    expect(await executor.advance(advance(childJob))).toMatchObject({ state: "succeeded" });
    const wake = scheduled.find((item) => item.idempotencyKey.startsWith("workflow-wake:"))!;
    expect(wake.workflowId).toBe(parent.id);
    expect(await executor.advance(advance(wake))).toMatchObject({ state: "succeeded" });
    expect((await store.getRun(created.workflowRunId))?.output).toMatchObject({ ok: true, result: { child: "saved" } });

    const failingParent = await executor.createPost(postStart("post-fail"));
    expect(await executor.advance(advance(failingParent))).toMatchObject({ state: "waiting" });
    const failingChildJob = scheduled.filter((item) => item.idempotencyKey.startsWith("workflow-child:")).at(-1)!;
    expect(await executor.advance(advance(failingChildJob))).toMatchObject({ state: "failed" });
    expect(await store.listArtifacts(failingChildJob.workflowRunId)).toHaveLength(1);
    const failingWake = scheduled.filter((item) => item.idempotencyKey.startsWith("workflow-wake:")).at(-1)!;
    expect(await executor.advance(advance(failingWake))).toMatchObject({ state: "failed" });
    await expect(executor.prepareRetry({ creatorRunId: "creator-1", workflowRunId: failingParent.workflowRunId, stepKey: "durable" }))
      .rejects.toThrow("CHILD_WORKFLOW_RETRY_REQUIRED");
    const childRetry = await executor.prepareRetry({ creatorRunId: "creator-1", workflowRunId: failingChildJob.workflowRunId, stepKey: "child-work" });
    repaired = true;
    expect(await executor.advance(advance(childRetry))).toMatchObject({ state: "succeeded" });
    const parentRetry = await executor.prepareRetry({ creatorRunId: "creator-1", workflowRunId: failingParent.workflowRunId, stepKey: "durable" });
    expect(await executor.advance(advance(parentRetry))).toMatchObject({ state: "succeeded" });
    expect(await store.listRuns({ parentRunId: failingParent.workflowRunId })).toHaveLength(1);
    const durableStep = (await store.listSteps(failingParent.workflowRunId)).find((step) => step.key === "durable")!;
    expect(await store.listAttempts(durableStep.id)).toHaveLength(2);

    const canceledParent = await executor.createPost(postStart("post-cancel"));
    expect(await executor.advance(advance(canceledParent))).toMatchObject({ state: "waiting" });
    const canceledChild = scheduled.filter((item) => item.idempotencyKey.startsWith("workflow-child:")).at(-1)!;
    await executor.cancel(canceledParent.workflowRunId);
    expect(await executor.snapshot("creator-1", canceledParent.workflowRunId)).toMatchObject({ state: "canceled" });
    expect(await executor.snapshot("creator-1", canceledChild.workflowRunId)).toMatchObject({ state: "canceled" });
  });

  it("keeps parents suspended during child retry and restores retry-link events idempotently", async () => {
    const persistence = new MemoryExecutionPersistence();
    const store = new MemoryRunStore();
    const evidence = await seedEvidence(store);
    let childRepaired = false;
    const child = workflow("durable-child", { revision: "v1" }, async (ctx, input: { postExternalId: string }) =>
      ctx.task("child-work", () => { if (!childRepaired) throw new Error("child generation one failed"); return { child: input.postExternalId }; }, input));
    const parent = workflow("post.analyze", { revision: "v11" }, async (ctx, input: { postExternalId: string }) =>
      ({ ok: true, result: await ctx.call("durable", child, input) }));
    const configured = { ...definitions(() => true), post: parent as unknown as ResearchWorkflowDefinitions["post"] };
    const scheduled: Array<{ creatorRunId: string; workflowRunId: string; workflowId: string; workflowRevision: string; generation: number; idempotencyKey: string }> = [];
    const seen = new Set<string>();
    const scheduler: WorkflowAdvanceScheduler = { enqueue: async (item) => {
      if (!seen.has(item.idempotencyKey)) { seen.add(item.idempotencyKey); scheduled.push(item); }
    } };
    const registry: WorkflowDefinitionRegistry = { resolve: (id, revision) => id === child.id && revision === child.revision
      ? child as unknown as ReturnType<WorkflowDefinitionRegistry["resolve"]> : undefined };
    const executor = createExecutor(persistence, store, noAgentRunner(), configured, freezer(evidence), registry, scheduler);
    const parentRun = await executor.createPost(postStart("post-race"));
    expect(await executor.advance(advance(parentRun))).toMatchObject({ state: "waiting" });
    const childJob = scheduled.find((item) => item.idempotencyKey.startsWith("workflow-child:"))!;
    expect(await executor.advance(advance(childJob))).toMatchObject({ state: "failed" });
    const staleWake = scheduled.find((item) => item.idempotencyKey.startsWith("workflow-wake:"))!;
    const retry = await executor.prepareRetry({ creatorRunId: "creator-1", workflowRunId: childJob.workflowRunId, stepKey: "child-work" });
    expect(await executor.advance(advance(staleWake))).toMatchObject({ state: "waiting" });
    expect(await store.getRun(parentRun.workflowRunId)).toMatchObject({ state: "waiting" });
    childRepaired = true;
    expect(await executor.advance(advance(retry))).toMatchObject({ state: "succeeded" });
    const freshWake = scheduled.find((item) => item.idempotencyKey.includes(`${childJob.workflowRunId}:2:succeeded`))!;
    expect(await executor.advance(advance(freshWake))).toMatchObject({ state: "succeeded" });

    const retryChild = workflow("post.review", { revision: "v3" }, async () => ({ ok: true }));
    const retryRegistry: WorkflowDefinitionRegistry = { resolve: (id, revision) => id === retryChild.id && revision === retryChild.revision
      ? retryChild as unknown as ReturnType<WorkflowDefinitionRegistry["resolve"]> : undefined };
    const retryExecutor = createExecutor(persistence, store, noAgentRunner(), definitions(() => true), freezer(evidence), retryRegistry, scheduler);
    const retryParent = await store.createRun({ workflowId: "post.analyze", workflowRevision: "v11", inputFingerprint: "retry-parent", state: "waiting" });
    await persistence.insert({ id: retryParent.id, creatorRunId: "creator-1", kind: "post", workflowId: "post.analyze",
      definitionRevision: "v11", generation: 1, state: "waiting", frozenInput: { creatorRunId: "creator-1", postExternalId: "retry", evidence } });
    const makeStep = (key: string) => store.createStep({ runId: retryParent.id, key, kind: "workflow", workflowId: "post.analyze",
      workflowRevision: "v11", inputFingerprint: key, configFingerprint: key, state: "running", validation: "pending" });
    const first = await makeStep("simple-review/review:1");
    const second = await makeStep("simple-review/review:2");
    const link = { key: "simple-review:candidate:1:sha", attempt: 1 as const };
    await retryExecutor.ensureChild({ parentRunId: retryParent.id, parentStepRunId: first.id, key: first.key,
      definition: { id: retryChild.id, revision: retryChild.revision }, input: { retryLink: link }, metadata: {} });
    const retryRequest = { parentRunId: retryParent.id, parentStepRunId: second.id, key: second.key,
      definition: { id: retryChild.id, revision: retryChild.revision }, input: { retryLink: { ...link, attempt: 2 as const,
        reason: "SIMPLE_REVIEW_LOCATION_MISSING:FINDING-001" } }, metadata: {} };
    await retryExecutor.ensureChild(retryRequest);
    const duplicateExecutor = createExecutor(persistence, store, noAgentRunner(), definitions(() => true), freezer(evidence), retryRegistry, scheduler);
    await duplicateExecutor.ensureChild(retryRequest);
    const retries = (await store.listEvents(retryParent.id)).filter((event) => event.type === "read-model.retry");
    expect(retries).toHaveLength(1);
    expect(retries[0]).toMatchObject({ stepRunId: second.id, data: { retryOf: first.id, reason: "SIMPLE_REVIEW_LOCATION_MISSING:FINDING-001" } });
  });
});
