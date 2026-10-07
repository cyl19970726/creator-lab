import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runWorkflow, type AgentRunRequest, type AgentRunResult, type AgentRunner } from '@signal-room/workflow';
import { SchemaRegistry, publishStorageContract, verifyStorageContract } from '@signal-room/workflow-space-contracts';
import { PostgresBlobStore, WorkflowSpaceService, migrateWorkflowSpaces } from '@signal-room/workflow-spaces';
import { creationSchemaDefinitions, creationStorageContracts, registerCreationSchemas } from '../src/spaces/contracts.js';
import { createCreationSpaceRuntime } from '../src/spaces/runtime.js';
import { createContentWorkflow, type ContentInput, type ContentDraft } from '../src/stages/content.js';

const url = process.env.WORKFLOW_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const owner = { id: 'creation-space-test-owner', kind: 'human' as const };
const models = { worker: { model: 'deterministic-test', reasoningEffort: 'medium' as const }, judge: { model: 'deterministic-test', reasoningEffort: 'high' as const } };
const contentInput: ContentInput = {
  topicId: 'space-test-topic', opportunity: '观众想理解公开训练过程', readerGoal: '看懂训练看板上的变化',
  requiredQuestions: ['训练过程如何推进？'], account: { name: '测试账号', positioning: '解释技术', currentAudience: '普通观众', referencePieces: [] },
  form: '竖屏视频', materials: [{ id: 'source-1', title: '训练记录', text: '尝试、评分和调整的记录。' }],
  standards: 'C1–C8', webResearch: false, maxRevisions: 0,
};
const draft: ContentDraft = {
  decision: { workingTitle: '训练看板', coreQuestion: '训练过程如何推进？', oneLineAnswer: '系统尝试、评分，再依据结果调整。',
    audience: '普通观众', audienceChange: '能读懂过程变化', hook: '看板上的数字为什么在变？',
    beats: [{ beat: '尝试', says: '系统提交一次尝试', evidence: ['source-1'], visualIdea: '进度变化' }], accountAngle: '解释技术',
    form: '竖屏视频', notSaying: [], biggestRisk: '误读指标', openQuestions: [], alternativesConsidered: [], changesFromPrevious: '首稿' },
  script: { title: '训练看板', coverText: '看懂训练', estimatedSeconds: 30, sourcesUsed: ['source-1'], changesFromPrevious: '首稿',
    segments: [{ time: '00:00', voiceover: '系统先提交一次尝试，再由评分器判断结果，随后调整下一次尝试。', onScreenText: '尝试→评分→调整', visual: '看板上的进度逐步变化' }] },
};
const review = { verdict: 'pass', route: 'pass', criteria: Array.from({ length: 8 }, (_, i) => ({ id: `C${i + 1}`, result: 'ok', reason: '满足要求' })),
  questionCoverage: [{ question: contentInput.requiredQuestions[0], answerInDraft: '尝试、评分、调整的顺序', missing: '', result: 'ok' }], mustChange: [], summary: '稿件解释了过程。' };
const fakeRunner: AgentRunner = {
  async run<Input, Output>(request: AgentRunRequest<Input>): Promise<AgentRunResult<Output>> {
    const outputs: Record<string, unknown> = {
      'content-researcher': { questions: [{ question: contentInput.requiredQuestions[0], answer: '训练任务按尝试和评分推进。', materialRefs: ['source-1'], gap: '' }], notes: [], remainingGaps: [] },
      'content-author': draft,
      'content-cold-reader': { retell: '系统尝试并调整。', oneLineAnswerAsUnderstood: '评分会影响下一次尝试。', unansweredQuestions: [], lostAt: [], boredAt: [],
        keepWatchingAt3s: { yes: true, why: '想知道数字含义' }, keepWatchingAt30s: { yes: true, why: '过程清楚' }, mostMemorable: '尝试→评分→调整' },
      'content-fact-checker': { issues: [], summary: '材料支持稿件内容。' },
      'content-editor': review,
    };
    const output = outputs[request.definition.id];
    if (!output) throw new Error(`Unexpected deterministic role: ${request.definition.id}`);
    return { output: output as Output };
  },
};

suite('Creation workflow space consumer integration', () => {
  let pool: Pool;
  let blobs: PostgresBlobStore;
  beforeAll(async () => {
    pool = new Pool({ connectionString: url!, max: 12 });
    await migrateWorkflowSpaces(pool);
    blobs = new PostgresBlobStore(pool);
    await blobs.migrate();
  });
  afterAll(async () => { await pool?.end(); });

  it('runs the existing CONTENT workflow through the persisted space runtime with restricted cold-reader inputs', async () => {
    const service = new WorkflowSpaceService(pool, blobs, owner);
    const space = await service.createSpace({ purpose: 'Creation workflow traceability integration' });
    const registry = new SchemaRegistry();
    const refs = registerCreationSchemas(registry);
    await service.registerSchemas(space.id, creationSchemaDefinitions());
    const contracts = creationStorageContracts(refs, 'creation-space-test-v1');
    const contentContract = contracts[0]!;
    expect(() => verifyStorageContract(publishStorageContract(registry, contentContract))).not.toThrow();
    const workflowVersion = await service.publishWorkflow(space.id, {
      id: 'creation-space-test-v1', revision: '1', changeReason: 'Exercise actual content stage in persisted runtime', config: { runner: 'deterministic-test' },
      entrypoints: { content: { workflowId: 'creation.content', codeRevision: 'content-v2', storageContract: contentContract } },
    });
    const caseRecord = await service.createCase(space.id, { id: 'content-test-case', title: 'Training process', objective: contentInput.readerGoal, constraints: [] });
    const opportunity = { ...contentInput } as Record<string, unknown>;
    delete opportunity.materials;
    const importedOpportunity = await service.importAsset(space.id, { schema: refs.opportunity, payload: opportunity,
      description: 'Frozen content opportunity and creator brief', idempotencyKey: 'import-opportunity' });
    const importedMaterials = await service.importAsset(space.id, { schema: refs.materials, payload: contentInput.materials,
      description: 'Frozen source material', idempotencyKey: 'import-materials' });
    const manifest = await service.freezeInputs(space.id, caseRecord.id, { opportunity: importedOpportunity.id, materials: importedMaterials.id });
    const runtime = await createCreationSpaceRuntime(service, space.id, {
      workflowVersionId: workflowVersion.id, entrypoint: 'content', inputManifestId: manifest.id,
    }, fakeRunner, refs);
    const result = await runWorkflow({ workflow: createContentWorkflow(models), input: contentInput, ...runtime });
    expect(result.run.state).toBe('needs_review');
    const overview = await service.overview(space.id);
    expect(overview.runs).toHaveLength(1);
    expect(overview.assets.map(asset => asset.schema.namespace)).toEqual(expect.arrayContaining([
      'creation/content-research', 'creation/content-draft', 'creation/content-reader',
      'creation/content-fact-check', 'creation/content-review',
    ]));
    const coldReader = overview.sessions.find(session => session.role === 'coldReader');
    expect(coldReader).toBeDefined();
    const context = overview.assets.find(asset => asset.schema.namespace === 'creation/content-reader')!.source;
    expect(context.kind).toBe('node');
    if (context.kind === 'node') {
      const nodeContext = await service.readContext(space.id, context.contextId);
      expect(nodeContext.inputs.manuscript?.viewVersion).toBe('viewer-view-v1');
      expect(Object.keys(nodeContext.inputs.manuscript?.payload as object).sort()).toEqual(['script']);
      expect(nodeContext.inputs.manuscript?.payload).toMatchObject({ script: { title: draft.script.title, coverText: draft.script.coverText } });
      expect(JSON.stringify(nodeContext.inputs.manuscript?.payload)).not.toContain('oneLineAnswer');
    }
  });

  it('keeps rewrite-round bindings and Agent origins exact when independent reader outputs repeat', async () => {
    const service = new WorkflowSpaceService(pool, blobs, owner);
    const space = await service.createSpace({ purpose: 'Same-run rewrite provenance regression' });
    const registry = new SchemaRegistry();
    const refs = registerCreationSchemas(registry);
    await service.registerSchemas(space.id, creationSchemaDefinitions());
    const [contentContract] = creationStorageContracts(refs, 'rewrite-v1');
    const version = await service.publishWorkflow(space.id, { id: 'rewrite-v1', revision: '1',
      changeReason: 'Check exact round provenance', config: { runner: 'deterministic-test' },
      entrypoints: { content: { workflowId: 'creation.content', codeRevision: 'content-v2', storageContract: contentContract! } } });
    const caseRecord = await service.createCase(space.id, { id: 'rewrite-case', title: 'Rewrite case',
      objective: contentInput.readerGoal, constraints: [] });
    const importedPrior = await service.importAsset(space.id, { schema: refs.draft,
      payload: { ...draft, markdown: '# Frozen prior draft' }, description: 'Synthetic prior draft', idempotencyKey: 'prior-import' });
    const prior = await service.transformAsset(space.id, { assetId: importedPrior.assetId, expectedHead: importedPrior.id,
      schema: refs.draft, payload: importedPrior.payload, dependencies: [importedPrior.id],
      operation: 'prepare-prior-candidate', description: 'Candidate prior draft for the rewrite regression',
      idempotencyKey: 'prior-candidate' });
    const humanFeedback = { reviewer: 'synthetic-creator', notes: ['Clarify the score-to-next-attempt link'] };
    const feedback = await service.importAsset(space.id, { schema: refs.humanFeedback, payload: humanFeedback,
      description: 'Frozen synthetic feedback', idempotencyKey: 'feedback' });
    const input: ContentInput = { ...contentInput, maxRevisions: 1,
      prior: { draft, humanReview: humanFeedback } };
    const { materials: _materials, ...opportunity } = input;
    const importedOpportunity = await service.importAsset(space.id, { schema: refs.opportunity, payload: opportunity,
      description: 'Frozen rewrite opportunity', idempotencyKey: 'opportunity' });
    const importedMaterials = await service.importAsset(space.id, { schema: refs.materials, payload: input.materials,
      description: 'Frozen rewrite material', idempotencyKey: 'materials' });
    const manifest = await service.freezeInputs(space.id, caseRecord.id,
      { opportunity: importedOpportunity.id, materials: importedMaterials.id,
        priorDraft: prior.id, feedback: feedback.id });
    const revisedDraft: ContentDraft = {
      decision: { ...draft.decision, workingTitle: '训练看板：下一次尝试', changesFromPrevious: '明说评分只影响下一次尝试' },
      script: { ...draft.script, title: '训练看板：下一次尝试', changesFromPrevious: '补充评分的作用',
        segments: [{ ...draft.script.segments[0]!, voiceover: '评分是反馈，下一次尝试才依它调整。' }] },
    };
    const sameReader = { retell: '系统尝试并调整。', oneLineAnswerAsUnderstood: '评分影响下一次尝试。',
      unansweredQuestions: [], lostAt: [], boredAt: [],
      keepWatchingAt3s: { yes: true, why: '想知道数字含义' }, keepWatchingAt30s: { yes: true, why: '过程清楚' },
      mostMemorable: '尝试→评分→调整' };
    const sameFactCheck = { issues: [], summary: '材料支持稿件内容。' };
    let authorCalls = 0, editorCalls = 0;
    const runner: AgentRunner = { async run<Input, Output>(request: AgentRunRequest<Input>): Promise<AgentRunResult<Output>> {
      let output: unknown;
      switch (request.definition.id) {
        case 'content-researcher': output = { questions: [{ question: contentInput.requiredQuestions[0],
          answer: '训练任务按尝试和评分推进。', materialRefs: ['source-1'], gap: '' }], notes: [], remainingGaps: [] }; break;
        case 'content-author': output = ++authorCalls === 1 ? draft : revisedDraft; break;
        case 'content-cold-reader': output = sameReader; break;
        case 'content-fact-checker': output = sameFactCheck; break;
        case 'content-editor': output = ++editorCalls === 1
          ? { ...review, verdict: 'revise', route: 'rewrite', mustChange: ['Clarify what the score changes'], summary: 'Rewrite once.' }
          : review; break;
        default: throw new Error(`Unexpected role ${request.definition.id}`);
      }
      return { output: output as Output };
    } };
    const runtime = await createCreationSpaceRuntime(service, space.id,
      { workflowVersionId: version.id, entrypoint: 'content', inputManifestId: manifest.id }, runner, refs);
    const result = await runWorkflow({ workflow: createContentWorkflow(models), input, ...runtime });
    expect(result.run.state).toBe('needs_review');
    expect(authorCalls).toBe(2);
    expect(editorCalls).toBe(2);

    const assets = (await service.overview(space.id)).assets;
    const steps = new Map((await (await service.runtimeLedger(space.id)).listSteps(result.run.id)).map(step => [step.id, step]));
    const byPhase = (namespace: string, phase: string) => {
      const found = assets.filter(asset => asset.schema.namespace === namespace && asset.source.kind === 'node' &&
        asset.source.runId === result.run.id && steps.get(asset.source.stepRunId)?.phasePath?.[0] === phase);
      expect(found).toHaveLength(1);
      return found[0]!;
    };
    const research = byPhase('creation/content-research', 'content-research-0');
    const drafts = [0, 1].map(round => byPhase('creation/content-draft', `content-draft-${round}`));
    const readers = [0, 1].map(round => byPhase('creation/content-reader', `content-check-${round}`));
    const factChecks = [0, 1].map(round => byPhase('creation/content-fact-check', `content-check-${round}`));
    const reviews = [0, 1].map(round => byPhase('creation/content-review', `content-editor-${round}`));
    expect(readers[0]!.payload).toEqual(readers[1]!.payload);
    expect(factChecks[0]!.payload).toEqual(factChecks[1]!.payload);
    expect(readers[0]!.id).not.toBe(readers[1]!.id);
    expect(factChecks[0]!.id).not.toBe(factChecks[1]!.id);
    for (const round of [0, 1] as const) {
      const reader = readers[round]!, fact = factChecks[round]!, currentDraft = drafts[round]!, currentReview = reviews[round]!;
      expect(reader.dependencies).toContain(currentDraft.id);
      expect(fact.dependencies).toEqual(expect.arrayContaining([currentDraft.id, research.id]));
      expect(currentReview.dependencies).toEqual(expect.arrayContaining([currentDraft.id, research.id, reader.id, fact.id]));
      for (const asset of [research, currentDraft, reader, fact, currentReview]) {
        expect(asset.source.kind).toBe('node');
        if (asset.source.kind !== 'node') continue;
        const origin = await service.readContext(space.id, asset.source.generatedByContextId!);
        expect(origin.producer).toBe('agent');
        expect(steps.get(origin.stepRunId)?.phasePath?.[0]).toBe(steps.get(asset.source.stepRunId)?.phasePath?.[0]);
        if (asset.id === reader.id) {
          expect(origin.inputs.manuscript?.assetVersionId).toBe(currentDraft.id);
          expect(origin.inputs.manuscript?.payload).not.toHaveProperty('decision');
        }
        if (asset.id === fact.id) expect(origin.inputs.draft?.assetVersionId).toBe(currentDraft.id);
        if (asset.id === currentReview.id) {
          expect(origin.inputs.reader?.assetVersionId).toBe(reader.id);
          expect(origin.inputs.factCheck?.assetVersionId).toBe(fact.id);
        }
      }
    }
    expect(drafts[1]!.dependencies).toEqual(expect.arrayContaining([drafts[0]!.id, reviews[0]!.id]));
    const firstAuthor = await service.readContext(space.id, (drafts[0]!.source as { generatedByContextId: string }).generatedByContextId);
    const secondAuthor = await service.readContext(space.id, (drafts[1]!.source as { generatedByContextId: string }).generatedByContextId);
    expect(firstAuthor.inputs.priorDraft?.assetVersionId).toBe(prior.id);
    expect(secondAuthor.inputs.priorDraft?.assetVersionId).toBe(drafts[0]!.id);
  }, 60_000);

  it('resumes a failed author, reconciles a pre-commit publish gap, and binds the successful author context', async () => {
    const service = new WorkflowSpaceService(pool, blobs, owner);
    const space = await service.createSpace({ purpose: 'CONTENT failed-author provenance recovery' });
    const registry = new SchemaRegistry();
    const refs = registerCreationSchemas(registry);
    await service.registerSchemas(space.id, creationSchemaDefinitions());
    const versionId = 'failed-author-recovery-v1';
    const [contract] = creationStorageContracts(refs, versionId);
    const version = await service.publishWorkflow(space.id, { id: versionId, revision: '1',
      changeReason: 'Exercise exact author provenance after failed attempt', config: { runner: 'deterministic-test' },
      entrypoints: { content: { workflowId: 'creation.content', codeRevision: 'content-v2', storageContract: contract! } } });
    const caseRecord = await service.createCase(space.id, { id: 'failed-author-case', title: 'Training process',
      objective: contentInput.readerGoal, constraints: [] });
    const input: ContentInput = { ...contentInput, maxRevisions: 2 };
    const { materials: _materials, ...opportunity } = input;
    const importedOpportunity = await service.importAsset(space.id, { schema: refs.opportunity, payload: opportunity,
      description: 'Frozen recovery opportunity', idempotencyKey: 'opportunity' });
    const importedMaterials = await service.importAsset(space.id, { schema: refs.materials, payload: input.materials,
      description: 'Frozen recovery materials', idempotencyKey: 'materials' });
    const manifest = await service.freezeInputs(space.id, caseRecord.id,
      { opportunity: importedOpportunity.id, materials: importedMaterials.id });
    let authorCalls = 0;
    const runner: AgentRunner = { async run<Input, Output>(request: AgentRunRequest<Input>): Promise<AgentRunResult<Output>> {
      let output: unknown;
      switch (request.definition.id) {
        case 'content-researcher': output = { questions: [{ question: contentInput.requiredQuestions[0],
          answer: '训练任务按尝试和评分推进。', materialRefs: ['source-1'], gap: '' }], notes: [], remainingGaps: [] }; break;
        case 'content-author': {
          authorCalls++;
          if (authorCalls === 3) throw new Error('Simulated model stream failure before output');
          output = draft;
          break;
        }
        case 'content-cold-reader': output = { retell: '系统尝试并调整。', oneLineAnswerAsUnderstood: '评分影响下一次尝试。',
          unansweredQuestions: [], lostAt: [], boredAt: [],
          keepWatchingAt3s: { yes: true, why: '想知道数字含义' },
          keepWatchingAt30s: { yes: true, why: '过程清楚' }, mostMemorable: '尝试→评分→调整' }; break;
        case 'content-fact-checker': output = { issues: [], summary: '材料支持稿件内容。' }; break;
        case 'content-editor': output = { ...review, verdict: 'revise', route: 'rewrite',
          mustChange: ['Continue to revise'], summary: 'One more rewrite.' }; break;
        default: throw new Error(`Unexpected role ${request.definition.id}`);
      }
      return { output: output as Output };
    } };
    const binding = { workflowVersionId: version.id, entrypoint: 'content', inputManifestId: manifest.id };
    const firstRuntime = await createCreationSpaceRuntime(service, space.id, binding, runner, refs);
    await expect(runWorkflow({ workflow: createContentWorkflow(models), input, ...firstRuntime }))
      .rejects.toThrow('Simulated model stream failure');
    const run = (await service.overview(space.id)).runs.find(item => item.caseId === caseRecord.id)!;
    const firstSteps = await (await service.runtimeLedger(space.id)).listSteps(run.runId);
    expect(firstSteps.find(step => step.key === 'content-draft-2:write')?.state).toBe('failed');

    const secondRuntime = await createCreationSpaceRuntime(service, space.id, binding, runner, refs);
    const originalCommit = secondRuntime.store.commitStepResult!.bind(secondRuntime.store);
    let interrupted = false;
    secondRuntime.store.commitStepResult = async commit => {
      const step = (await secondRuntime.store.listSteps(run.runId)).find(item => item.id === commit.stepRunId);
      if (!interrupted && commit.artifact?.type === 'content-draft' && step?.key === 'content-draft-2:draft') {
        interrupted = true;
        throw new Error('Simulated pre-commit publish interruption');
      }
      return originalCommit(commit);
    };
    await expect(runWorkflow({ workflow: createContentWorkflow(models), input, ...secondRuntime,
      resumeRunId: run.runId })).rejects.toThrow('Simulated pre-commit publish interruption');
    expect(authorCalls).toBe(4);
    const ledger = await service.runtimeLedger(space.id);
    const steps = await ledger.listSteps(run.runId);
    const hangingPublish = steps.find(step => step.key === 'content-draft-2:draft' && step.state === 'running')!;
    const hangingAttempt = (await ledger.listAttempts(hangingPublish.id)).find(attempt => attempt.state === 'running')!;
    expect(hangingPublish).toBeDefined();
    expect(hangingAttempt).toBeDefined();
    expect((await ledger.listArtifacts(run.runId)).filter(artifact => artifact.producedBy.stepRunId === hangingPublish.id)).toHaveLength(0);
    expect((await service.runtimeContexts(space.id, run.runId)).filter(context => context.stepRunId === hangingPublish.id)).toHaveLength(0);

    // This test has proved the simulated interruption occurred before any commit.
    // Reconcile only that publish attempt; retain all Agent attempts and outputs.
    const running = (await ledger.listSteps(run.runId)).filter(step => step.state === 'running');
    expect(running.map(step => step.key)).toEqual(['content-draft-2:draft']);
    for (const step of running) {
      for (const attempt of (await ledger.listAttempts(step.id)).filter(item => item.state === 'running')) {
        await ledger.updateAttempt(attempt.id, { state: 'failed', error: 'Confirmed pre-commit interruption' });
      }
      await ledger.updateStep(step.id, { state: 'failed', error: 'Confirmed pre-commit interruption' });
    }
    const finalRuntime = await createCreationSpaceRuntime(service, space.id, binding, runner, refs);
    const resumed = await runWorkflow({ workflow: createContentWorkflow(models), input, ...finalRuntime,
      resumeRunId: run.runId });
    expect(resumed.run.state).toBe('needs_review');
    expect(authorCalls).toBe(4);
    const history = (await ledger.listSteps(run.runId)).filter(step => step.key === 'content-draft-2:write');
    expect(history.map(step => step.state).sort()).toEqual(['failed', 'succeeded']);
    const finalRef = (resumed.output as { details?: { draft?: { id?: string } } })?.details?.draft?.id;
    expect(finalRef).toBeTruthy();
    const finalDraft = await service.resolveRuntimeArtifact(space.id, finalRef!);
    expect(finalDraft.source.kind).toBe('node');
    if (finalDraft.source.kind === 'node') {
      const origin = await service.readContext(space.id, finalDraft.source.generatedByContextId!);
      expect(origin.stepRunId).toBe(history.find(step => step.state === 'succeeded')!.id);
    }
  }, 120_000);
});
