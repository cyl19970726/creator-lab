import { describe, expect, it } from 'vitest';
import { MemoryRunStore, runWorkflow, type AgentRunRequest, type AgentRunner } from '@signal-room/workflow';
import type { WorkflowSpaceService, WorkflowVersion, WorkflowVersionDraft } from '@signal-room/workflow-spaces';
import { publishProcessContract } from '@signal-room/workflow-spaces';
import { SchemaRegistry, publishStorageContract } from '@signal-room/workflow-space-contracts';
import { createContentWorkbench } from '../src/spaces/content-workbench.js';
import { registerCreationSchemas } from '../src/spaces/contracts.js';
import { contentSiwcExecutorManifest } from '../src/spaces/content-runner.js';
import { createContentDeployment } from '../src/spaces/content-method.js';
import { CONTENT_ROLES, type ContentInput } from '../src/stages/content.js';

function fixture(withSiwc = false) {
  const workflows: WorkflowVersion[] = [];
  const writes: string[] = [];
  const bindings = new Map<string, { presentation: { id: string; revision: string; hash: string } }>();
  let rejectPresentation = false;
  let failBinding = false;
  const models = { worker: { model: 'model-a', reasoningEffort: 'low' as const },
    judge: { model: 'model-b', reasoningEffort: 'medium' as const } };
  const service = {
    async overview() { return { workflows, cases: [], runs: [] }; },
    async registerSchemas() { writes.push('schemas'); return []; },
    async importAsset() { writes.push('asset'); throw new Error('Unexpected asset import'); },
    async publishWorkflow(_spaceId: string, draft: WorkflowVersionDraft) {
      writes.push('workflow');
      const registry = new SchemaRegistry(); registerCreationSchemas(registry);
      const entries = await Promise.all(Object.entries(draft.entrypoints).map(async ([key, value]) => {
        const storageContract = publishStorageContract(registry, value.storageContract);
        return [key, { ...value, storageContract,
          ...(value.process ? { process: await publishProcessContract(value.process, storageContract) } : {}) }];
      }));
      const saved = { ...draft, entrypoints: Object.fromEntries(entries), spaceId: 'space', hash: 'test', createdAt: 'now' } as WorkflowVersion;
      workflows.push(saved);
      return saved;
    },
    async resolvePresentation(_spaceId: string, versionId: string) { return bindings.get(versionId) ?? null; },
    async registerPresentation(_spaceId: string, draft: {id: string; revision: string}) {
      if (rejectPresentation) throw new Error('Published presentation revision is immutable');
      if (!writes.includes('presentation')) writes.push('presentation');
      return { ...draft, hash: 'presentation-hash' };
    },
    async bindPresentation(_spaceId: string, input: {workflowVersionId: string; presentationId: string; revision: string}) {
      if (failBinding) { failBinding = false; throw new Error('Injected presentation binding failure'); }
      writes.push('binding'); bindings.set(input.workflowVersionId,
        { presentation: { id: input.presentationId, revision: input.revision, hash: 'presentation-hash' } });
    },
  } as unknown as WorkflowSpaceService;
  const runner = { async run() { throw new Error('Method preparation must not run an agent'); } } as AgentRunner;
  const workbench = createContentWorkbench({ service, runner, models, principalId: 'owner',
    ...(withSiwc ? { executorManifest: contentSiwcExecutorManifest() } : {}) });
  return { workbench, workflows, writes, models, service, runner,
    rejectPresentation: () => { rejectPresentation = true; },
    allowPresentation: () => { rejectPresentation = false; },
    failNextBinding: () => { failBinding = true; } };
}

describe('CONTENT method publication', () => {
  it('changes only the author instructions when two deployments share models and runner', async () => {
    const f = fixture();
    const prompt = '作者实验版：先解释观众会误解的因果关系。';
    const baseline = await f.workbench.preview('space');
    const candidateWorkbench = createContentWorkbench({ service: f.service, runner: f.runner,
      models: f.models, principalId: 'owner', authorPrompt: prompt });
    const candidate = await candidateWorkbench.preview('space');
    const baselineNodes = baseline.version.entrypoints.content!.nodeDefinitions!;
    const candidateNodes = candidate.version.entrypoints.content!.nodeDefinitions!;
    expect(candidate.version.id).not.toBe(baseline.version.id);
    expect(candidateNodes.author?.instructions).toContain(prompt);
    expect(baselineNodes.author?.instructions).toContain(CONTENT_ROLES.author.prompt);
    expect(candidateNodes.author?.model).toEqual(baselineNodes.author?.model);
    for (const [name, definition] of Object.entries(baselineNodes)) {
      if (name !== 'author') expect(candidateNodes[name]).toEqual(definition);
    }
    expect(candidate.version.config).toMatchObject({ models: baseline.version.config.models });
    expect(f.writes).toEqual([]);
  });

  it('keeps a deployment frozen after its source profile and models are mutated', async () => {
    const f = fixture();
    const models = structuredClone(f.models);
    const executorManifest = contentSiwcExecutorManifest();
    const profile = { models, runner: f.runner, authorPrompt: '冻结的作者指令', executorManifest };
    const deployment = createContentDeployment(profile);
    const before = deployment.candidate();
    profile.authorPrompt = '后来改写的作者指令';
    models.worker.model = 'changed-worker';
    models.judge.model = 'changed-judge';
    executorManifest.tools.push('changed-tool');
    executorManifest.maxTurns = 99;
    const after = deployment.candidate();
    expect(after.version.id).toBe(before.version.id);
    expect(after.version.entrypoints.content?.nodeDefinitions).toEqual(before.version.entrypoints.content?.nodeDefinitions);
    expect(after.version.entrypoints.content?.nodeDefinitions?.author?.instructions).toContain('冻结的作者指令');
    expect(after.version.entrypoints.content?.nodeDefinitions?.author?.instructions).not.toContain('后来改写');
    expect(after.version.entrypoints.content?.nodeDefinitions?.author?.executor)
      .toEqual({ family: 'agent-sdk', adapter: 'SIWC Responses' });
    expect(after.version.entrypoints.content?.nodeDefinitions?.author?.tools).toEqual(['read_bound_asset']);
    expect(after.version.entrypoints.content?.nodeDefinitions?.author?.configuration?.executor)
      .toMatchObject({ maxTurns: 8, tools: ['read_bound_asset'] });
  });

  it('sends the declared author instructions to the runner for default and overridden prompts', async () => {
    const input: ContentInput = {
      topicId: 'topic', opportunity: '解释公开训练过程', readerGoal: '看懂训练看板',
      requiredQuestions: ['看板说明什么？'],
      account: { name: '账号', positioning: '技术解释', currentAudience: '普通观众', referencePieces: [] },
      form: '竖屏视频', materials: [{ id: 'm1', title: '材料', text: '看板数据' }],
      standards: 'C1-C8', webResearch: false, maxRevisions: 0,
    };
    for (const authorPrompt of [undefined, '实验作者：用一步一因的方式讲解。']) {
      let actualPrompt: unknown;
      const runner: AgentRunner = { async run<I, O>(request: AgentRunRequest<I>) {
        if (request.definition.id === 'content-researcher') return { output: {
          questions: [{ question: '看板说明什么？', answer: '训练进度', materialRefs: ['m1'], gap: '' }],
          notes: [], remainingGaps: [],
        } as O };
        if (request.definition.id === 'content-author') {
          actualPrompt = request.definition.config?.prompt;
          return { output: {} as O };
        }
        throw new Error(`Unexpected role ${request.definition.id}`);
      } };
      const deployment = createContentDeployment({ models: {
        worker: { model: 'model-a', reasoningEffort: 'low' },
        judge: { model: 'model-b', reasoningEffort: 'medium' },
      }, runner, ...(authorPrompt === undefined ? {} : { authorPrompt }) });
      const declared = deployment.candidate().version.entrypoints.content?.nodeDefinitions?.author?.instructions;
      await runWorkflow({ workflow: deployment.workflow(input), input, store: new MemoryRunStore(), agentRunner: runner });
      expect(actualPrompt).toBe(declared);
      expect(actualPrompt).toContain(authorPrompt ?? CONTENT_ROLES.author.prompt);
    }
  });

  it('previews and publishes a retained exact version with its own binding', async () => {
    const f = fixture();
    const oldPrompt = '保留版作者指令';
    const currentPrompt = '当前版作者指令';
    const old = createContentWorkbench({ service: f.service, runner: f.runner, models: f.models,
      principalId: 'owner', authorPrompt: oldPrompt });
    const oldCandidate = await old.preview('space');
    const workbench = createContentWorkbench({ service: f.service, runner: f.runner, models: f.models,
      principalId: 'owner', authorPrompt: currentPrompt,
      retainedProfiles: [{ models: f.models, runner: f.runner, authorPrompt: oldPrompt }] });
    const current = await workbench.preview('space');
    const retained = await workbench.preview('space', oldCandidate.version.id);
    expect(current.version.id).not.toBe(retained.version.id);
    expect(retained.version).toEqual(oldCandidate.version);
    expect(retained.version.entrypoints.content?.nodeDefinitions?.author?.instructions).toContain(oldPrompt);
    await expect(workbench.preview('space', 'missing')).rejects.toThrow('exact version is not deployed');
    await expect(workbench.publishMethod('space', { expectedVersionId: 'missing', changeReason: 'Unknown' }))
      .rejects.toThrow('exact version is not deployed');
    expect(f.writes).toEqual([]);
    expect(await workbench.publishMethod('space', { expectedVersionId: retained.version.id,
      changeReason: 'Retained initial method' })).toEqual({ workflowVersionId: retained.version.id, entrypoint: 'content' });
    expect(f.workflows[0]?.id).toBe(retained.version.id);
    expect(f.workflows[0]?.entrypoints.content?.nodeDefinitions?.author?.instructions).toContain(oldPrompt);
    expect(await workbench.methodAvailability('space', retained.version.id, 'content')).toEqual({ available: true });
    expect(f.writes).toEqual(['schemas', 'workflow', 'presentation', 'binding']);
    expect(await workbench.publishMethod('space', { expectedVersionId: current.version.id,
      predecessorId: retained.version.id, changeReason: 'Candidate author method' }))
      .toEqual({ workflowVersionId: current.version.id, entrypoint: 'content' });
    expect(f.workflows[1]?.entrypoints.content?.nodeDefinitions?.author?.instructions).toContain(currentPrompt);
    expect(f.writes.filter(write => write === 'binding')).toHaveLength(2);
  });

  it('previews the complete method without persistence or execution', async () => {
    const f = fixture();
    const first = await f.workbench.preview('space');
    const second = await f.workbench.preview('space');
    expect(first).toEqual(second);
    expect(first.version.entrypoints.content?.process?.nodes).toBeDefined();
    expect(first.version.entrypoints.content?.nodeDefinitions?.author?.instructions).toContain('你是作者');
    expect(first.version.entrypoints.content?.nodeDefinitions?.researcher?.configuration?.webSearchMode).toBe('run-input-dependent');
    expect(first.version.entrypoints.content?.nodeDefinitions?.researcher?.tools).toEqual([]);
    const definitions = first.version.entrypoints.content?.nodeDefinitions ?? {};
    for (const role of ['researcher', 'author', 'coldReader', 'factChecker', 'editor'])
      expect(definitions[role]?.executor).toBeUndefined();
    expect(definitions.route?.executor).toEqual({ family: 'decision' });
    expect(definitions.creatorDraftGate?.executor).toEqual({ family: 'human' });
    expect(definitions.stop?.executor).toEqual({ family: 'program' });
    expect(f.writes).toEqual([]);
    expect(await f.workbench.methodAvailability('space', first.version.id, 'content')).toEqual({
      available: false, reason: 'CONTENT method is not published for this executor',
    });
  });

  it('snapshots declared SIWC tools and instruction mapping for the deployed host', async () => {
    const f = fixture(true);
    const candidate = await f.workbench.preview('space');
    const withoutSiwc = await fixture().workbench.preview('space');
    const author = candidate.version.entrypoints.content?.nodeDefinitions?.author;
    expect(candidate.version.id).not.toBe(withoutSiwc.version.id);
    expect(author?.tools).toEqual(['read_bound_asset']);
    const definitions = candidate.version.entrypoints.content?.nodeDefinitions ?? {};
    for (const role of ['researcher', 'author', 'coldReader', 'factChecker', 'editor'])
      expect(definitions[role]?.executor).toEqual({ family: 'agent-sdk', adapter: 'SIWC Responses' });
    expect(definitions.route?.executor).toEqual({ family: 'decision' });
    expect(definitions.creatorDraftGate?.executor).toEqual({ family: 'human' });
    expect(definitions.stop?.executor).toEqual({ family: 'program' });
    expect(author?.configuration?.executor).toMatchObject({ maxTurns: 8, maxToolCalls: 16,
      instructionMapping: expect.stringContaining('JSON Schema'), outputFormat: 'json' });
    expect(f.writes).toEqual([]);
  });

  it('requires the reviewed candidate and explicit lineage, then reuses the immutable publication', async () => {
    const f = fixture();
    const candidate = await f.workbench.preview('space');
    await expect(f.workbench.publishMethod('space', { expectedVersionId: 'stale', changeReason: 'first' }))
      .rejects.toThrow('changed since review');
    expect(f.writes).toEqual([]);
    const first = await f.workbench.publishMethod('space', {
      expectedVersionId: candidate.version.id, changeReason: 'Initial reviewed method',
    });
    expect(first.workflowVersionId).toBe(candidate.version.id);
    expect(f.writes).toEqual(['schemas', 'workflow', 'presentation', 'binding']);
    f.rejectPresentation();
    await expect(f.workbench.publishMethod('space', {
      expectedVersionId: candidate.version.id, changeReason: 'Initial reviewed method',
    })).rejects.toThrow('presentation revision is immutable');
    f.allowPresentation();
    expect(await f.workbench.publishMethod('space', {
      expectedVersionId: candidate.version.id, changeReason: 'Initial reviewed method',
    })).toEqual(first);
    expect(f.writes).toEqual(['schemas', 'workflow', 'presentation', 'binding']);
    await expect(f.workbench.publishMethod('space', {
      expectedVersionId: candidate.version.id, changeReason: 'Different reason',
    })).rejects.toThrow('immutable');
    expect(await f.workbench.methodAvailability('space', candidate.version.id, 'content')).toEqual({ available: true });

    f.models.worker.model = 'model-c';
    expect((await f.workbench.preview('space')).version.id).toBe(candidate.version.id);
    const nextWorkbench = createContentWorkbench({ service: f.service, runner: f.runner,
      models: f.models, principalId: 'owner' });
    const next = await nextWorkbench.preview('space');
    expect(next.version.id).not.toBe(candidate.version.id);
    await expect(nextWorkbench.publishMethod('space', {
      expectedVersionId: candidate.version.id, predecessorId: first.workflowVersionId, changeReason: 'New model',
    })).rejects.toThrow('changed since review');
    await expect(nextWorkbench.publishMethod('space', {
      expectedVersionId: next.version.id, changeReason: 'New model',
    })).rejects.toThrow('explicit published predecessor');
    await expect(nextWorkbench.publishMethod('space', {
      expectedVersionId: next.version.id, predecessorId: 'missing', changeReason: 'New model',
    })).rejects.toThrow('compatible published version');
    expect(await nextWorkbench.publishMethod('space', {
      expectedVersionId: next.version.id, predecessorId: first.workflowVersionId, changeReason: 'New model',
    })).toEqual({ workflowVersionId: next.version.id, entrypoint: 'content' });
    expect(await nextWorkbench.methodAvailability('space', first.workflowVersionId, 'content')).toMatchObject({ available: false });
  });

  it('retries presentation binding after the immutable method was saved', async () => {
    const f = fixture();
    const candidate = await f.workbench.preview('space');
    f.failNextBinding();
    await expect(f.workbench.publishMethod('space', {
      expectedVersionId: candidate.version.id, changeReason: 'Initial method',
    })).rejects.toThrow('binding failure');
    expect(f.workflows).toHaveLength(1);
    expect(await f.workbench.publishMethod('space', {
      expectedVersionId: candidate.version.id, changeReason: 'Initial method',
    })).toEqual({ workflowVersionId: candidate.version.id, entrypoint: 'content' });
    expect(f.writes).toEqual(['schemas', 'workflow', 'presentation', 'binding']);
  });

  it('rejects unknown and altered published definitions before importing any input', async () => {
    const f = fixture();
    await expect(f.workbench.start({ spaceId: 'space', caseId: 'case', input: {} as ContentInput,
      workflowVersionId: 'missing', idempotencyKey: 'unknown' })).rejects.toThrow('not published');
    expect(f.writes).toEqual([]);
    const candidate = await f.workbench.preview('space');
    await f.workbench.publishMethod('space', { expectedVersionId: candidate.version.id,
      changeReason: 'Initial method' });
    f.workflows[0]!.config = { ...f.workflows[0]!.config, altered: true };
    await expect(f.workbench.start({ spaceId: 'space', caseId: 'case', input: {} as ContentInput,
      workflowVersionId: candidate.version.id, idempotencyKey: 'altered' })).rejects.toThrow('冻结定义不一致');
    expect(f.writes).not.toContain('asset');
  });
});
