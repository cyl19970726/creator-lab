import { createHash } from 'node:crypto';
import { runWorkflow, workflowFingerprint, type AgentRunner, type RunRecord, type RunWorkflowResult, type WorkflowTerminal } from '@signal-room/workflow';
import { WorkflowExecutorRegistry, WorkflowExecutionManager, createValidationWorkbench,
  type AssetVersion, type Review, type ReviewDraft,
  type InputManifest, type SpaceCase, type SpaceOverview, type WorkflowSpaceService } from '@signal-room/workflow-spaces';
import { contentAcceptanceFailures, contentInputSchema,
  type ContentDraft, type ContentFactCheck, type ContentInput, type ContentResearch, type ContentReview } from '../stages/content.js';
import type { StageModel } from '../stages/runtime.js';
import { creationSchemaDefinitions } from './contracts.js';
import type { contentSiwcExecutorManifest } from './content-runner.js';
import { contentEntrypoint, contentWorkflowId, createContentDeployment,
  type ContentDeployment, type ContentDeploymentProfile } from './content-method.js';

const sha = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const entrypoint = contentEntrypoint;
const workflowId = contentWorkflowId;

export interface ContentWorkbenchOptions {
  service: WorkflowSpaceService;
  runner: AgentRunner;
  models: { worker: StageModel; judge: StageModel };
  principalId: string;
  executorManifest?: ReturnType<typeof contentSiwcExecutorManifest>;
  authorPrompt?: string;
  retainedProfiles?: ContentDeploymentProfile[];
  retainedDeployments?: ContentDeployment[];
  concurrency?: number;
}
export interface ContentRunHandle {
  runId: string;
  workflowVersionId: string;
  inputManifestId: string;
  completion: Promise<RunWorkflowResult<WorkflowTerminal<never>>>;
}
export interface ContentReviewInput {
  spaceId: string;
  caseId: string;
  runId: string;
  draftVersionId: string;
  id: string;
  standard: Review['standard'];
  answers: Review['answers'];
  baselineReviewId?: string;
  accept?: boolean;
  reason?: string;
  idempotencyKey: string;
}
export interface ContentRerunInput {
  spaceId: string;
  caseId: string;
  workflowVersionId?: string;
  baselineRunId: string;
  baselineDraftVersionId: string;
  baselineReviewId: string;
  feedbackNotes: string[];
  hypothesis: string;
  idempotencyKey: string;
}
export interface ContentExperimentInput {
  spaceId: string;
  caseId: string;
  workflowVersionId?: string;
  baselineRunId: string;
  baselineReviewId: string;
  hypothesis: string;
  idempotencyKey: string;
}

function finalDraftRef(run: RunRecord): { id: string; sha256: string } {
  const output = run.output as { ok?: boolean; state?: string; details?: { draft?: { id?: string; sha256?: string } } } | undefined;
  const ref = output?.details?.draft;
  if (output?.ok !== false || output.state !== 'needs_review' || !ref?.id || !ref.sha256) {
    throw new Error('CONTENT run has no exact final draft receipt');
  }
  return { id: ref.id, sha256: ref.sha256 };
}

function strippedDraft(asset: AssetVersion): ContentDraft {
  const { markdown: _markdown, ...draft } = asset.payload as ContentDraft & { markdown?: string };
  return draft as ContentDraft;
}

function caseRun(overview: SpaceOverview, caseId: string, runId: string) {
  const run = overview.runs.find(item => item.runId === runId && item.caseId === caseId && item.entrypoint === 'content');
  if (!run) throw new Error('CONTENT run is not bound to this case');
  return run;
}

export function createContentWorkbench(options: ContentWorkbenchOptions) {
  const { service } = options;
  if (!options.principalId.trim()) throw new Error('Authenticated CONTENT principal ID is required');
  const current = createContentDeployment({ models: options.models, runner: options.runner,
    ...(options.authorPrompt !== undefined ? { authorPrompt: options.authorPrompt } : {}),
    ...(options.executorManifest ? { executorManifest: options.executorManifest } : {}) });
  const deployments = [current, ...(options.retainedProfiles ?? []).map(createContentDeployment),
    ...(options.retainedDeployments ?? [])];
  const registry = new WorkflowExecutorRegistry<ContentDeployment>();
  const byId = new Map<string, ContentDeployment>();
  const managers = new Map<string, WorkflowExecutionManager>();
  let initialization: Promise<void> | undefined;
  function ready(): Promise<void> {
    return initialization ??= (async () => {
      for (const deployment of deployments) {
        const candidate = deployment.candidate();
        if (byId.has(candidate.version.id)) throw new Error('Duplicate CONTENT deployment version');
        registry.register({ versionId: candidate.version.id, entrypoint,
          config: candidate.version.config, definition: await deployment.frozenDefinition(),
          executor: deployment, verify: deployment.verify });
        byId.set(candidate.version.id, deployment);
      }
    })();
  }

  async function preview(_spaceId: string, versionId?: string) {
    await ready();
    const deployment = versionId ? byId.get(versionId) : current;
    if (!deployment) throw new Error('CONTENT candidate changed since review; exact version is not deployed');
    const { version, entrypoint, presentation } = deployment.candidate();
    await deployment.frozenDefinition();
    return { version, entrypoint, presentation };
  }

  async function publishMethod(spaceId: string, input: { expectedVersionId: string; predecessorId?: string; changeReason: string }) {
    const {version} = await preview(spaceId, input.expectedVersionId);
    if (input.expectedVersionId !== version.id) throw new Error('CONTENT candidate changed since review; preview again');
    if (!input.changeReason?.trim()) throw new Error('CONTENT method publication requires a change reason');
    const published = (await service.overview(spaceId)).workflows.filter(item => item.entrypoints.content?.workflowId === workflowId);
    const existing = published.find(item => item.id === version.id);
    if (existing) {
      if (existing.predecessorId !== input.predecessorId || existing.changeReason !== input.changeReason.trim())
        throw new Error('Published CONTENT method is immutable; predecessor and reason differ');
      const availability = await methodAvailability(spaceId, existing.id, entrypoint);
      if (!availability.available) throw new Error(`Published CONTENT definition differs from deployed candidate: ${availability.reason}`);
      await publishPresentation(spaceId, version.id);
      return { workflowVersionId: existing.id, entrypoint };
    }
    if (published.length && !input.predecessorId) throw new Error('CONTENT method requires an explicit published predecessor');
    if (input.predecessorId && !published.some(item => item.id === input.predecessorId))
      throw new Error('CONTENT predecessor must be a compatible published version in this Space');
    if (input.predecessorId === version.id) throw new Error('CONTENT method cannot precede itself');
    await service.registerSchemas(spaceId, creationSchemaDefinitions());
    const saved = await service.publishWorkflow(spaceId, { ...version,
      ...(input.predecessorId ? { predecessorId: input.predecessorId } : {}), changeReason: input.changeReason.trim() });
    await publishPresentation(spaceId, version.id);
    return { workflowVersionId: saved.id, entrypoint };
  }

  async function publishPresentation(spaceId: string, versionId?: string) {
    const {version, presentation} = await preview(spaceId, versionId);
    const saved = await service.registerPresentation(spaceId, presentation);
    const bound = await service.resolvePresentation(spaceId, version.id, entrypoint);
    if (bound?.presentation.id === saved.id && bound.presentation.revision === saved.revision &&
      bound.presentation.hash === saved.hash) return;
    await service.bindPresentation(spaceId, { workflowVersionId: version.id, entrypoint,
      presentationId: presentation.id, revision: presentation.revision });
  }

  async function methodAvailability(spaceId: string, versionId: string, requestedEntrypoint: string) {
    if (requestedEntrypoint !== entrypoint) return { available: false, reason: 'CONTENT entrypoint is unavailable' };
    await ready();
    const published = (await service.overview(spaceId)).workflows.find(item => item.id === versionId);
    if (!published) return { available: false, reason: 'CONTENT method is not published for this executor' };
    return registry.availability(published, requestedEntrypoint);
  }

  async function selected(spaceId: string, versionId?: string) {
    await ready();
    const id = versionId ?? current.candidate().version.id;
    const published = (await service.overview(spaceId)).workflows.find(item => item.id === id);
    if (!published) throw new Error('CONTENT method is not published; publish its preview before running');
    const deployment = await registry.resolve(published, entrypoint);
    return { deployment, refs: deployment.candidate().refs, versionId: id, published };
  }

  async function exactDraft(spaceId: string, caseId: string, runId: string, versionId: string) {
    const overview = await service.overview(spaceId);
    const binding = caseRun(overview, caseId, runId);
    const ledger = await service.runtimeLedger(spaceId);
    const nativeRun = await ledger.getRun(runId);
    if (!nativeRun) throw new Error('Native CONTENT run is missing');
    const final = finalDraftRef(nativeRun);
    const nativeArtifact = await ledger.getArtifact(final.id);
    if (!nativeArtifact || nativeArtifact.sha256 !== final.sha256 || nativeArtifact.type !== 'content-draft') {
      throw new Error('Final CONTENT draft receipt is inconsistent');
    }
    const asset = await service.resolveRuntimeArtifact(spaceId, final.id);
    if (asset.id !== versionId || asset.source.kind !== 'node' || asset.source.runId !== runId ||
      asset.schema.namespace !== 'creation/content-draft') throw new Error('Draft is not the exact final artifact of this run');
    return { binding, nativeRun, nativeArtifact, asset, overview };
  }

  async function manager(spaceId: string, runId?: string): Promise<WorkflowExecutionManager> {
    await ready();
    const key = JSON.stringify([spaceId, runId ?? null]);
    let value = managers.get(key);
    if (!value) {
      value = new WorkflowExecutionManager({ service, spaceId, concurrency: options.concurrency ?? 2,
        ...(runId ? { runId } : {}),
        executorKeys: () => registry.keys(),
        execute: async (task, signal) => {
          const published = (await service.overview(spaceId)).workflows.find(item => item.id === task.workflowVersionId);
          if (!published) throw new Error('Queued CONTENT method version is missing');
          const deployment = await registry.resolve(published, task.entrypoint);
          const manifest = await service.readManifest(spaceId, task.inputManifestId);
          if (manifest.caseId !== task.caseId || !manifest.assets.opportunity || !manifest.assets.materials)
            throw new Error('Queued CONTENT input manifest is incomplete');
          const opportunity = await service.readAsset(spaceId, manifest.assets.opportunity);
          const materials = await service.readAsset(spaceId, manifest.assets.materials);
          const parsed = deployment.parseInput({ ...opportunity.payload as object, materials: materials.payload });
          if (parsed.webResearch) throw new Error('联网研究尚未接入此工作台；请先提供材料后运行 CONTENT。');
          const ledger = await service.runtimeLedger(spaceId);
          const native = await ledger.getRun(task.runId);
          if (!native || native.state !== 'queued' || native.inputFingerprint !== workflowFingerprint(parsed))
            throw new Error('Queued CONTENT run does not match its frozen input');
          const runtime = await deployment.createRuntime(service, spaceId,
            { workflowVersionId: task.workflowVersionId, entrypoint: task.entrypoint,
              inputManifestId: task.inputManifestId });
          return runWorkflow({ workflow: deployment.workflow(parsed), input: parsed, ...runtime,
            resumeRunId: task.runId, signal });
        },
      });
      managers.set(key, value);
    }
    return value;
  }

  async function execute(spaceId: string, caseId: string, versionId: string,
    manifestId: string, input: ContentInput, commandKey: string,
    experiment?: { baselineRunId: string; baselineReviewId: string; hypothesis?: string },
    commandContext?: unknown, hypothesis?: string, dispatch = true): Promise<ContentRunHandle> {
    const commandFingerprint = sha({ spaceId, caseId, versionId, manifestId, commandKey,
      experiment, commandContext, hypothesis });
    const published = (await service.overview(spaceId)).workflows.find(item => item.id === versionId);
    if (!published) throw new Error('CONTENT method version is not published');
    await registry.resolve(published, entrypoint);
    const draft: Omit<RunRecord, 'id'> = { workflowId: published.entrypoints.content!.workflowId,
      workflowRevision: published.entrypoints.content!.codeRevision,
      inputFingerprint: workflowFingerprint(input), state: 'queued',
      metadata: { spaceId, caseId, inputManifestId: manifestId, workflowVersionId: versionId,
        entrypoint, commandKey, commandFingerprint,
        ...(hypothesis ? { hypothesis } : {}),
        ...(experiment ? { experimentBaselineRunId: experiment.baselineRunId,
          experimentBaselineReviewId: experiment.baselineReviewId,
          ...(experiment.hypothesis ? { experimentHypothesis: experiment.hypothesis } : {}) } : {}),
        ...(commandContext && typeof commandContext === 'object' &&
          'baselineRunId' in commandContext && 'baselineReviewId' in commandContext
          ? { rerunBaselineRunId: commandContext.baselineRunId,
            rerunBaselineReviewId: commandContext.baselineReviewId,
            ...('hypothesis' in commandContext ? { rerunHypothesis: commandContext.hypothesis } : {}) } : {}) } };
    const receipt = await service.enqueueExecution(spaceId,
      { workflowVersionId: versionId, entrypoint, inputManifestId: manifestId }, draft,
      { executorKey: WorkflowExecutorRegistry.key(versionId, entrypoint) });
    const worker = await manager(spaceId);
    if (dispatch) await worker.wake();
    const completion = worker.completion(receipt.run.id);
    // Queue-only callers return just the run receipt; observe their optional completion promise.
    if (!dispatch) void completion.catch(() => undefined);
    return { runId: receipt.run.id, workflowVersionId: versionId, inputManifestId: manifestId,
      completion };
  }

  async function frozenInput(spaceId: string, caseId: string, manifestId: string,
    deployment: ContentDeployment): Promise<{ manifest: InputManifest; parsed: ContentInput }> {
    const manifest = await service.readManifest(spaceId, manifestId);
    if (manifest.caseId !== caseId || manifest.spaceId !== spaceId) throw new Error('CONTENT input manifest belongs to another case or Space');
    const { refs } = deployment.candidate();
    if (!manifest.assets.opportunity || !manifest.assets.materials ||
      Object.keys(manifest.assets).some(slot => !['opportunity', 'materials'].includes(slot))) {
      throw new Error('CONTENT validation requires an original, prior-free input manifest');
    }
    const opportunity = await service.readAsset(spaceId, manifest.assets.opportunity);
    const materials = await service.readAsset(spaceId, manifest.assets.materials);
    for (const [asset, ref] of [[opportunity, refs.opportunity], [materials, refs.materials]] as const) {
      if (asset.schema.namespace !== ref.namespace || asset.schema.revision !== ref.revision || asset.schema.hash !== ref.hash)
        throw new Error('CONTENT input manifest asset schema differs from the selected deployment');
    }
    const parsed = deployment.parseInput({ ...opportunity.payload as object, materials: materials.payload });
    if (parsed.prior) throw new Error('CONTENT validation requires a prior-free input');
    if (parsed.webResearch) throw new Error('联网研究尚未接入此工作台；请先提供材料后运行 CONTENT。');
    return { manifest, parsed };
  }

  async function freezeParsedInput(input: {spaceId: string; caseId: string; idempotencyKey: string},
    parsed: ContentInput, refs: ReturnType<ContentDeployment['candidate']>['refs']): Promise<InputManifest> {
    if (!input.idempotencyKey?.trim()) throw new Error('CONTENT input freeze requires an idempotency key');
    if (parsed.prior) throw new Error('Use rerun for CONTENT input with a prior draft');
    if (parsed.webResearch) throw new Error('联网研究尚未接入此工作台；请先提供材料后运行 CONTENT。');
    const overview = await service.overview(input.spaceId);
    if (!overview.cases.some(item => item.id === input.caseId)) throw new Error('CONTENT case does not exist in this Space');
    // Freezing an input is independent of method publication in this Space.
    await service.registerSchemas(input.spaceId, creationSchemaDefinitions());
    const { materials, ...opportunity } = parsed;
    const prefix = `content:${input.caseId}:${input.idempotencyKey}`;
    const opportunityAsset = await service.importAsset(input.spaceId, { schema: refs.opportunity, payload: opportunity,
      description: 'Frozen CONTENT opportunity and role input', idempotencyKey: `${prefix}:opportunity` });
    const materialsAsset = await service.importAsset(input.spaceId, { schema: refs.materials, payload: materials,
      description: 'Frozen CONTENT source materials', idempotencyKey: `${prefix}:materials` });
    return service.freezeInputs(input.spaceId, input.caseId,
      { opportunity: opportunityAsset.id, materials: materialsAsset.id });
  }

  async function freezeInput(input: {spaceId: string; caseId: string; input: ContentInput;
    idempotencyKey: string}): Promise<InputManifest> {
    return freezeParsedInput(input, current.parseInput(input.input), current.candidate().refs);
  }

  async function startFromManifest(input: {spaceId: string; caseId: string; workflowVersionId: string;
    entrypoint?: string; inputManifestId: string; idempotencyKey: string; dispatch?: boolean}): Promise<ContentRunHandle> {
    if (input.entrypoint !== undefined && input.entrypoint !== entrypoint) throw new Error('CONTENT entrypoint is unavailable');
    if (!input.idempotencyKey?.trim()) throw new Error('CONTENT run requires an idempotency key');
    const { deployment, versionId } = await selected(input.spaceId, input.workflowVersionId);
    const { manifest, parsed } = await frozenInput(input.spaceId, input.caseId, input.inputManifestId, deployment);
    return execute(input.spaceId, input.caseId, versionId, manifest.id, parsed,
      `content:${input.caseId}:${input.idempotencyKey}`, undefined, undefined, undefined, input.dispatch ?? true);
  }

  async function start(input: {spaceId: string; caseId: string; input: ContentInput; idempotencyKey: string;
    workflowVersionId?: string; hypothesis?: string;
    experiment?: {baselineRunId: string; baselineReviewId: string; hypothesis?: string}}): Promise<ContentRunHandle> {
    const { deployment, refs, versionId } = await selected(input.spaceId, input.workflowVersionId);
    const parsed = deployment.parseInput(input.input);
    if (parsed.prior) throw new Error('Use rerun for CONTENT input with a prior draft');
    if (parsed.webResearch) throw new Error('联网研究尚未接入此工作台；请先提供材料后运行 CONTENT。');
    const overview = await service.overview(input.spaceId);
    if (!overview.cases.some(item => item.id === input.caseId)) throw new Error('CONTENT case does not exist in this Space');
    const manifest = await freezeParsedInput(input, parsed, refs);
    return execute(input.spaceId, input.caseId, versionId, manifest.id, parsed,
      `content:${input.caseId}:${input.idempotencyKey}`, input.experiment, undefined, input.hypothesis);
  }

  async function review(input: ContentReviewInput): Promise<Review> {
    const { binding, nativeRun, nativeArtifact, asset, overview } = await exactDraft(input.spaceId, input.caseId, input.runId, input.draftVersionId);
    if (nativeRun.state !== 'needs_review') throw new Error('CONTENT run is not ready for human review');
    const candidateManifest = await service.readManifest(input.spaceId, binding.inputManifestId);
    const linkedByIteration = [...new Set(overview.iterations.filter(item => item.runIds.includes(input.runId))
      .flatMap(item => item.reviewIds))];
    const storedBaselineId = nativeRun.metadata?.rerunBaselineReviewId ??
      nativeRun.metadata?.experimentBaselineReviewId ?? linkedByIteration[0];
    if (linkedByIteration.length > 1 ||
      (linkedByIteration.length === 1 && storedBaselineId !== linkedByIteration[0])) {
      throw new Error('CONTENT candidate has conflicting stored baseline reviews');
    }
    if (storedBaselineId !== undefined && typeof storedBaselineId !== 'string') {
      throw new Error('CONTENT stored baseline review ID is invalid');
    }
    if (input.baselineReviewId && input.baselineReviewId !== storedBaselineId) {
      throw new Error('Provided baseline review does not match the candidate run');
    }
    if (!storedBaselineId && (candidateManifest.assets.priorDraft ||
      nativeRun.metadata?.experimentBaselineRunId || nativeRun.metadata?.rerunBaselineRunId)) {
      throw new Error('CONTENT candidate is missing its stored baseline review');
    }
    const baseline = storedBaselineId ? overview.reviews.find(item => item.id === storedBaselineId) : undefined;
    if (storedBaselineId && !baseline) throw new Error('Stored baseline review is missing');
    if (baseline) {
      caseRun(overview, input.caseId, baseline.runId);
      const experimentBaseline = nativeRun.metadata?.experimentBaselineReviewId === baseline.id &&
        nativeRun.metadata?.experimentBaselineRunId === baseline.runId;
      const rerunBaseline = nativeRun.metadata?.rerunBaselineReviewId === baseline.id &&
        nativeRun.metadata?.rerunBaselineRunId === baseline.runId;
      if (baseline.assetVersionIds.length !== 1 ||
        (!experimentBaseline && candidateManifest.assets.priorDraft !== baseline.assetVersionIds[0]) ||
        (rerunBaseline && candidateManifest.assets.priorDraft !== baseline.assetVersionIds[0])) {
        throw new Error('Candidate review baseline does not match its frozen prior draft');
      }
    }
    if (input.accept) {
      if (!input.reason?.trim()) throw new Error('Accepting a draft requires an explicit reason');
      const details = (nativeRun.output as {details?: {reason?: string; research?: {id?: string}; review?: {id?: string}}}).details;
      if (details?.reason !== 'awaiting-human-review') throw new Error('CONTENT internal gate did not pass');
      const ledger = await service.runtimeLedger(input.spaceId);
      const researchRef = details.research?.id ? await ledger.getArtifact(details.research.id) : undefined;
      const editorRef = details.review?.id ? await ledger.getArtifact(details.review.id) : undefined;
      if (!researchRef || !editorRef || editorRef.type !== 'content-review' || researchRef.type !== 'content-research') throw new Error('Final editorial evidence is missing');
      const editorial = await service.resolveRuntimeArtifact(input.spaceId, editorRef.id);
      const research = await service.resolveRuntimeArtifact(input.spaceId, researchRef.id);
      if (editorial.source.kind !== 'node' || editorial.source.runId !== input.runId ||
        research.source.kind !== 'node' || research.source.runId !== input.runId) throw new Error('Editorial evidence is not from the exact run');
      const factDeps = await Promise.all(editorRef.dependsOn.map(dep => ledger.getArtifact(dep.artifactId)));
      const factRef = factDeps.find(ref => ref?.type === 'content-fact-check');
      if (!factRef || !editorRef.dependsOn.some(dep => dep.artifactId === nativeArtifact.id && dep.sha256 === nativeArtifact.sha256) ||
        !editorRef.dependsOn.some(dep => dep.artifactId === researchRef.id && dep.sha256 === researchRef.sha256) ||
        !editorRef.dependsOn.some(dep => dep.artifactId === factRef.id && dep.sha256 === factRef.sha256) ||
        !factRef.dependsOn.some(dep => dep.artifactId === nativeArtifact.id && dep.sha256 === nativeArtifact.sha256) ||
        !factRef.dependsOn.some(dep => dep.artifactId === researchRef.id && dep.sha256 === researchRef.sha256)) {
        throw new Error('Final editorial review lacks exact draft, research or fact-check evidence');
      }
      const facts = await service.resolveRuntimeArtifact(input.spaceId, factRef.id);
      if (facts.source.kind !== 'node' || facts.source.runId !== input.runId) {
        throw new Error('Fact-check evidence is not from the exact run');
      }
      const manifest = await service.readManifest(input.spaceId, binding.inputManifestId);
      const opportunity = await service.readAsset(input.spaceId, manifest.assets.opportunity!);
      const materials = await service.readAsset(input.spaceId, manifest.assets.materials!);
      const contentInput = contentInputSchema.parse({ ...opportunity.payload as object, materials: materials.payload });
      const verdict = editorial.payload as ContentReview;
      if (verdict.verdict !== 'pass' || verdict.route !== 'pass' || verdict.guardFailures?.length ||
        contentAcceptanceFailures(contentInput, verdict, facts.payload as ContentFactCheck,
          strippedDraft(asset), research.payload as ContentResearch).length) {
        throw new Error('CONTENT final draft does not satisfy its internal acceptance gate');
      }
    }
    const draftReview: ReviewDraft = { id: input.id, runId: input.runId,
      assetVersionIds: [asset.id], ...(baseline ? { baselineReviewId: baseline.id } : {}),
      standard: input.standard, judge: { kind: 'human', id: options.principalId },
      evidence: [asset.id], answers: input.answers };
    const existing = overview.reviews.find(item => item.id === input.id);
    if (existing && sha({ id: existing.id, runId: existing.runId, assetVersionIds: existing.assetVersionIds,
      ...(existing.baselineReviewId ? { baselineReviewId: existing.baselineReviewId } : {}),
      standard: existing.standard, judge: existing.judge, evidence: existing.evidence, answers: existing.answers }) !== sha(draftReview)) {
      throw new Error('Review command ID was reused with different content');
    }
    const value = existing ?? await service.recordReview(input.spaceId, draftReview);
    if (baseline) {
      const comparisonId = `content-comparison-${sha([baseline.id, value.id]).slice(0, 32)}`;
      if (!overview.comparisons.some(item => item.id === comparisonId)) {
        await service.compare(input.spaceId, { id: comparisonId,
          baselineReviewId: baseline.id, candidateReviewId: value.id, conclusion: input.answers.improvement });
      }
    }
    if (input.accept) await service.transition(input.spaceId, { workflowVersionId: binding.workflowVersionId,
      entrypoint: 'content', nodeId: 'creatorDraftGate', assetVersionId: asset.id,
      to: 'accepted', action: 'accept', reason: input.reason!, idempotencyKey: input.idempotencyKey });
    return value;
  }

  async function rerun(input: ContentRerunInput): Promise<ContentRunHandle> {
    if (!input.hypothesis.trim() || !input.feedbackNotes.length || input.feedbackNotes.some(note => !note.trim())) {
      throw new Error('A rerun requires a hypothesis and non-empty feedback notes');
    }
    const { binding, asset, overview } = await exactDraft(input.spaceId, input.caseId,
      input.baselineRunId, input.baselineDraftVersionId);
    const baselineReview = overview.reviews.find(review => review.id === input.baselineReviewId &&
      review.runId === input.baselineRunId && review.assetVersionIds.includes(asset.id));
    if (!baselineReview || baselineReview.assetVersionIds.length !== 1) {
      throw new Error('Rerun requires a saved review of the exact baseline draft');
    }
    const { deployment, refs, versionId } = await selected(input.spaceId, input.workflowVersionId);
    const manifest = await service.readManifest(input.spaceId, binding.inputManifestId);
    const opportunity = await service.readAsset(input.spaceId, manifest.assets.opportunity!);
    const materials = await service.readAsset(input.spaceId, manifest.assets.materials!);
    const feedback = { reviewer: options.principalId, notes: input.feedbackNotes };
    const nextInput = deployment.parseInput({ ...opportunity.payload as object, materials: materials.payload,
      prior: { draft: strippedDraft(asset), humanReview: feedback } });
    if (nextInput.webResearch) throw new Error('联网研究尚未接入此工作台；请先提供材料后运行 CONTENT。');
    const prefix = `content:${input.caseId}:${input.idempotencyKey}`;
    const { materials: _materials, ...nextOpportunity } = nextInput;
    const opportunityAsset = await service.importAsset(input.spaceId, { schema: refs.opportunity, payload: nextOpportunity,
      description: 'Frozen CONTENT rerun input with exact prior draft and feedback', idempotencyKey: `${prefix}:opportunity` });
    const feedbackAsset = await service.importAsset(input.spaceId, { schema: refs.humanFeedback, payload: feedback,
      dependencies: [asset.id], description: `Feedback on exact CONTENT draft ${asset.id} and review ${baselineReview.id}`,
      idempotencyKey: `${prefix}:feedback` });
    const nextManifest = await service.freezeInputs(input.spaceId, input.caseId, {
      opportunity: opportunityAsset.id, materials: manifest.assets.materials!, priorDraft: asset.id, feedback: feedbackAsset.id,
    });
    const handle = await execute(input.spaceId, input.caseId, versionId, nextManifest.id, nextInput,
      `content:${input.caseId}:${input.idempotencyKey}`, undefined,
      { baselineRunId: input.baselineRunId, baselineReviewId: input.baselineReviewId, hypothesis: input.hypothesis });
    const iterationId = `content-iteration-${sha([input.caseId, input.idempotencyKey]).slice(0, 32)}`;
    if (!(await service.overview(input.spaceId)).iterations.some(item => item.id === iterationId)) {
      await service.recordIteration(input.spaceId, { id: iterationId, reviewIds: [baselineReview.id],
        hypothesis: input.hypothesis, workflowVersionId: versionId, caseIds: [input.caseId], runIds: [handle.runId] });
    }
    return handle;
  }

  async function experiment(input: ContentExperimentInput): Promise<ContentRunHandle> {
    if (!input.hypothesis.trim()) throw new Error('Method experiment requires a hypothesis');
    await selected(input.spaceId, input.workflowVersionId);
    const overview = await service.overview(input.spaceId);
    const binding = caseRun(overview, input.caseId, input.baselineRunId);
    const baselineReview = overview.reviews.find(review => review.id === input.baselineReviewId &&
      review.runId === input.baselineRunId && review.assetVersionIds.length === 1);
    if (!baselineReview) throw new Error('Method experiment requires an exact baseline review');
    await exactDraft(input.spaceId, input.caseId, input.baselineRunId, baselineReview.assetVersionIds[0]!);
    const manifest = await service.readManifest(input.spaceId, binding.inputManifestId);
    const { deployment, versionId } = await selected(input.spaceId, input.workflowVersionId);
    const { parsed } = await frozenInput(input.spaceId, input.caseId, manifest.id, deployment);
    const handle = await execute(input.spaceId, input.caseId, versionId, manifest.id, parsed,
      `content:${input.caseId}:${input.idempotencyKey}`,
      { baselineRunId: input.baselineRunId, baselineReviewId: baselineReview.id, hypothesis: input.hypothesis });
    const iterationId = `content-iteration-${sha([input.caseId, input.idempotencyKey]).slice(0, 32)}`;
    if (!(await service.overview(input.spaceId)).iterations.some(item => item.id === iterationId)) {
      await service.recordIteration(input.spaceId, { id: iterationId, reviewIds: [baselineReview.id],
        hypothesis: input.hypothesis, workflowVersionId: handle.workflowVersionId,
        caseIds: [input.caseId], runIds: [handle.runId] });
    }
    return handle;
  }

  async function runStatus(spaceId: string, runId: string) {
    const binding = await service.readRun(spaceId, runId);
    if (binding.entrypoint !== 'content') throw new Error('CONTENT run not found');
    const run = await (await service.runtimeLedger(spaceId)).getRun(runId);
    if (!run) throw new Error('Native CONTENT run not found');
    const output = run.output as { details?: { draft?: { id?: string } } } | undefined;
    const draftVersionId = output?.details?.draft?.id
      ? (await service.resolveRuntimeArtifact(spaceId, finalDraftRef(run).id)).id : undefined;
    return { binding, run, draftVersionId, executionTask: await service.getExecutionTask(spaceId, runId) };
  }

  async function detail(spaceId: string, caseId: string) {
    const overview = await service.overview(spaceId);
    const item = overview.cases.find(value => value.id === caseId);
    if (!item) throw new Error('CONTENT case not found');
    const runs = await Promise.all(overview.runs.filter(value => value.caseId === caseId && value.entrypoint === 'content')
      .map(value => runStatus(spaceId, value.runId)));
    return { case: item, runs, assets: overview.assets.filter(asset => {
      const source = asset.source;
      return source.kind === 'node' && runs.some(run => run.run.id === source.runId);
    }), reviews: overview.reviews.filter(review => runs.some(run => run.run.id === review.runId)) };
  }

  async function stop() { await Promise.all([...managers.values()].map(value => value.stop())); }
  const tasks = (spaceId: string) => service.executionTasks(spaceId);
  const cancel = async (spaceId: string, runId: string) => (await manager(spaceId)).cancel(runId);
  const dispatch = async (spaceId: string) => (await manager(spaceId)).wake();
  // A plan action wakes a permanently scoped manager, including its retry/completion pumps.
  const dispatchRun = async (spaceId: string, runId: string) => (await manager(spaceId, runId)).wake();
  const waitIdle = async (spaceId: string) => (await manager(spaceId)).waitIdle();

  const validation = (spaceId: string) => createValidationWorkbench({ service, spaceId,
    humanJudgeId: options.principalId,
    startRun: async (request: {spaceId:string;caseId:string;workflowVersionId:string;entrypoint:string;
      inputManifestId:string;idempotencyKey:string;dispatch:false}) => {
      const handle = await startFromManifest(request);
      void handle.completion.catch(() => undefined);
      return { runId: handle.runId };
    },
    dispatch: () => dispatch(spaceId),
    availability: (versionId: string, requestedEntrypoint: string) => methodAvailability(spaceId, versionId, requestedEntrypoint),
    isDeliverable: (asset: AssetVersion) => asset.schema.namespace === 'creation/content-draft',
    assertReviewable: async (runId: string, assetVersionIds: string[]) => {
      const status = await runStatus(spaceId, runId);
      if (status.run.state !== 'needs_review' || assetVersionIds.length !== 1 ||
        assetVersionIds[0] !== status.draftVersionId) throw new Error('Validation review requires the exact final CONTENT draft');
    },
  });

  return { createCase: (spaceId: string, input: Omit<SpaceCase, 'spaceId'>) => service.createCase(spaceId, input),
    preview, publishMethod, methodAvailability, tasks, cancel, dispatch, dispatchRun, waitIdle,
    freezeInput, startFromManifest, validation, start, review, rerun, experiment, runStatus, detail, stop };
}
