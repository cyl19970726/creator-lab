import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AgentRunner, workflowFingerprint } from '@signal-room/workflow';
import { PostgresBlobStore, WorkflowExecutorRegistry, WorkflowSpaceService, migrateWorkflowSpaces } from '@signal-room/workflow-spaces';
import { SchemaRegistry } from '@signal-room/workflow-space-contracts';
import { createContentWorkbench } from '../src/spaces/content-workbench.js';
import { createContentDeployment } from '../src/spaces/content-method.js';
import { registerCreationSchemas } from '../src/spaces/contracts.js';
import { creationAssetReaders } from '../src/spaces/readers.js';
import { contentInputSchema, type ContentDraft, type ContentInput } from '../src/stages/content.js';

const url = process.env.WORKFLOW_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const owner = { id: 'content-workbench-test', kind: 'human' as const };
const models = { worker: { model: 'deterministic-test', reasoningEffort: 'medium' as const },
  judge: { model: 'deterministic-test', reasoningEffort: 'high' as const } };
const input: ContentInput = {
  topicId: 'content-test', opportunity: '解释一个虚构训练看板', readerGoal: '看懂评分如何改变下一次尝试',
  requiredQuestions: ['评分改变了什么？'], account: { name: '测试账号', positioning: '解释技术',
    currentAudience: '普通读者', referencePieces: [] }, form: '视频口播',
  materials: [{ id: 'source-1', title: '虚构流程记录', text: '系统尝试，收到评分，再改变下一次尝试。评分不是质量保证。' }],
  standards: 'C1-C8 测试标准', webResearch: false, maxRevisions: 0,
};
const draft: ContentDraft = {
  decision: { workingTitle: '看懂评分', coreQuestion: '评分改变了什么？',
    oneLineAnswer: '评分改变下一次尝试，不改变过去。', audience: '普通读者', audienceChange: '能解释下一次尝试如何变',
    hook: '一个分数怎么影响下一步？', beats: [{ beat: '尝试、评分、调整', says: '分数指导下一次尝试',
      evidence: ['source-1'], visualIdea: '三个方框依次亮起' }], accountAngle: '解释过程', form: '视频口播',
    notSaying: ['分数保证质量'], biggestRisk: '把分数当保证', openQuestions: [], alternativesConsidered: [],
    changesFromPrevious: '首稿' },
  script: { title: '看懂评分', coverText: '分数改变下一步', estimatedSeconds: 32, sourcesUsed: ['source-1'],
    changesFromPrevious: '首稿', segments: [{ time: '00:00', voiceover: '系统先尝试，再收到评分；评分让系统改变下一次尝试，不会改变过去，也不保证质量。',
      onScreenText: '尝试 → 评分 → 下一次调整', visual: '三个方框依次亮起，最后一格转向新路径' }] },
};
const editorial = { verdict: 'pass', route: 'pass',
  criteria: Array.from({ length: 8 }, (_, i) => ({ id: `C${i + 1}`, result: 'ok', reason: '已检查' })),
  questionCoverage: [{ question: input.requiredQuestions[0], answerInDraft: '评分改变下一次尝试', missing: '', result: 'ok' }],
  mustChange: [], summary: '虚构流程已讲清。' };
let calls = 0;
const runner: AgentRunner = { async run(request) {
  calls++;
  const output: Record<string, unknown> = {
    'content-researcher': { questions: [{ question: input.requiredQuestions[0], answer: '评分改变下一次尝试。',
      materialRefs: ['source-1'], gap: '' }], notes: [], remainingGaps: [] },
    'content-author': draft,
    'content-cold-reader': { retell: '评分改变下一次尝试。', oneLineAnswerAsUnderstood: '下一次尝试会变。',
      unansweredQuestions: [], lostAt: [], boredAt: [], keepWatchingAt3s: { yes: true, why: '开头直接提问' },
      keepWatchingAt30s: { yes: true, why: '解释清楚' }, mostMemorable: '三个方框' },
    'content-fact-checker': { issues: [], summary: '虚构材料支持稿件。' },
    'content-editor': editorial,
  };
  const value = output[request.definition.id];
  if (!value) throw new Error(`Unknown role ${request.definition.id}`);
  return { output: value as never };
} };

suite('CONTENT PostgreSQL business service', () => {
  let pool: Pool;
  let service: WorkflowSpaceService;
  beforeAll(async () => {
    pool = new Pool({ connectionString: url!, max: 12 });
    await migrateWorkflowSpaces(pool);
    const blobs = new PostgresBlobStore(pool); await blobs.migrate();
    service = new WorkflowSpaceService(pool, blobs, owner, { readerIds: Object.keys(creationAssetReaders),
      resultRoleIds: ['final-draft', 'research', 'cold-read', 'fact-check', 'editorial-review'] });
  });
  afterAll(async () => { await pool?.end(); });

  it('starts real CONTENT, stores exact PG output/session, reviews, reruns, compares, and deduplicates command', async () => {
    const space = await service.createSpace({ purpose: `CONTENT service ${randomUUID()}` });
    const business = createContentWorkbench({ service, runner, models, principalId: owner.id });
    const method = await business.preview(space.id);
    expect((await service.overview(space.id)).workflows).toHaveLength(0);
    await business.publishMethod(space.id, { expectedVersionId: method.version.id, changeReason: 'Isolated test method' });
    const item = await business.createCase(space.id, { id: randomUUID(), title: '虚构训练看板',
      objective: input.readerGoal, constraints: [] });
    const first = await business.start({ spaceId: space.id, caseId: item.id, input, idempotencyKey: 'first' });
    expect(first.runId).toBeTruthy();
    expect((await first.completion).run.state).toBe('needs_review');
    const status = await business.runStatus(space.id, first.runId);
    expect(status.draftVersionId).toBeTruthy();
    const overview = await service.overview(space.id);
    expect(overview.sessions.some(session => session.role === 'author')).toBe(true);
    expect(overview.assets.some(asset => asset.id === status.draftVersionId && asset.source.kind === 'node' &&
      asset.source.runId === first.runId)).toBe(true);
    const beforeReplay = calls;
    const replay = await business.start({ spaceId: space.id, caseId: item.id, input, idempotencyKey: 'first' });
    expect(replay.runId).toBe(first.runId);
    expect(calls).toBe(beforeReplay);
    await expect(business.start({ spaceId: space.id, caseId: item.id,
      input: { ...input, opportunity: '另一主题' }, idempotencyKey: 'first' })).rejects.toThrow();

    const baseline = await business.review({ spaceId: space.id, caseId: item.id, runId: first.runId,
      draftVersionId: status.draftVersionId!, id: randomUUID(), idempotencyKey: randomUUID(),
      standard: { id: 'four-questions', revision: '1', content: '好、不好、提升、仍不满意' },
      answers: { good: '结构清楚', bad: '例子太少', improvement: '首轮无基线', unresolved: '想知道评分如何计算' } });
    const second = await business.rerun({ spaceId: space.id, caseId: item.id, baselineRunId: first.runId,
      baselineDraftVersionId: status.draftVersionId!, baselineReviewId: baseline.id,
      feedbackNotes: ['把评分改变下一次尝试说得更清楚'], hypothesis: '明确下一次变化会改善理解', idempotencyKey: 'rerun' });
    expect(second.workflowVersionId).toBe(first.workflowVersionId);
    expect((await second.completion).run.state).toBe('needs_review');
    const secondStatus = await business.runStatus(space.id, second.runId);
    const nextManifest = await service.readManifest(space.id, second.inputManifestId);
    expect(nextManifest.assets.priorDraft).toBe(status.draftVersionId);
    expect(nextManifest.assets.feedback).toBeTruthy();
    expect((await service.overview(space.id)).comparisons).toHaveLength(0);
    await expect(business.review({ spaceId: space.id, caseId: item.id, runId: second.runId,
      draftVersionId: secondStatus.draftVersionId!, id: randomUUID(), idempotencyKey: randomUUID(),
      baselineReviewId: randomUUID(), standard: baseline.standard,
      answers: { good: 'a', bad: 'b', improvement: 'c', unresolved: 'd' } }))
      .rejects.toThrow('baseline');
    const candidate = await business.review({ spaceId: space.id, caseId: item.id, runId: second.runId,
      draftVersionId: secondStatus.draftVersionId!, id: randomUUID(), idempotencyKey: randomUUID(),
      standard: baseline.standard,
      answers: { good: '讲得清楚', bad: '例子仍少', improvement: '明确了下一次变化', unresolved: '还想看具体例子' } });
    const completed = await service.overview(space.id);
    expect(completed.comparisons).toHaveLength(1);
    expect(completed.reviews.some(review => review.id === candidate.id && review.baselineReviewId === baseline.id)).toBe(true);
    expect(completed.iterations.some(iteration => iteration.runIds.includes(second.runId) &&
      iteration.reviewIds.includes(baseline.id))).toBe(true);
    expect((await service.readAsset(space.id, status.draftVersionId!)).state).toBe('candidate');
    const experiment = await business.experiment({ spaceId: space.id, caseId: item.id,
      baselineRunId: first.runId, baselineReviewId: baseline.id,
      hypothesis: '原输入下验证当前方法', idempotencyKey: 'experiment' });
    expect((await experiment.completion).run.state).toBe('needs_review');
    const experimentManifest = await service.readManifest(space.id, experiment.inputManifestId);
    expect(experimentManifest.assets.priorDraft).toBeUndefined();
    const experimentStatus = await business.runStatus(space.id, experiment.runId);
    await business.review({ spaceId: space.id, caseId: item.id, runId: experiment.runId,
      draftVersionId: experimentStatus.draftVersionId!, id: randomUUID(), idempotencyKey: randomUUID(),
      standard: baseline.standard,
      answers: { good: '同题可读', bad: '仍需例子', improvement: '方法实验比较', unresolved: '缺具体例子' } });
    expect((await service.overview(space.id)).comparisons).toHaveLength(2);
  }, 90_000);

  it('refuses unsupported web research before calling any Agent', async () => {
    const space = await service.createSpace({ purpose: `CONTENT web preflight ${randomUUID()}` });
    const business = createContentWorkbench({ service, runner, models, principalId: owner.id });
    const method = await business.preview(space.id);
    await business.publishMethod(space.id, { expectedVersionId: method.version.id,
      changeReason: 'Isolated web preflight method' });
    const item = await business.createCase(space.id, { id: randomUUID(), title: '联网请求', objective: input.readerGoal, constraints: [] });
    const before = calls;
    await expect(business.start({ spaceId: space.id, caseId: item.id, input: { ...input, webResearch: true },
      idempotencyKey: 'blocked' })).rejects.toThrow('联网研究尚未接入');
    expect(calls).toBe(before);
    expect((await service.overview(space.id)).runs).toHaveLength(0);
  });

  it('recovers the exact PG receipt when two hosts start one command concurrently', async () => {
    const space = await service.createSpace({ purpose: `CONTENT concurrent receipt ${randomUUID()}` });
    const caseId = randomUUID();
    await service.createCase(space.id, { id: caseId, title: '并发运行', objective: input.readerGoal, constraints: [] });
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const synchronized = new Proxy(service, { get(target, property) {
      if (property === 'enqueueExecution') return async (...args: Parameters<WorkflowSpaceService['enqueueExecution']>) => {
        arrived++;
        if (arrived === 2) release();
        await gate;
        return target.enqueueExecution(...args);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const firstHost = createContentWorkbench({ service: synchronized, runner, models, principalId: owner.id });
    const secondHost = createContentWorkbench({ service: synchronized, runner, models, principalId: owner.id });
    const method = await firstHost.preview(space.id);
    await firstHost.publishMethod(space.id, { expectedVersionId: method.version.id, changeReason: 'Isolated concurrent test method' });
    const before = calls;
    const [first, second] = await Promise.all([firstHost.start({ spaceId: space.id, caseId, input, idempotencyKey: 'same' }),
      secondHost.start({ spaceId: space.id, caseId, input, idempotencyKey: 'same' })]);
    expect(first.runId).toBe(second.runId);
    await Promise.all([first.completion, second.completion]);
    expect((await service.overview(space.id)).runs).toHaveLength(1);
    expect(calls - before).toBe(5);
  }, 90_000);

  it('runs two explicitly deployed versions concurrently and cancels one without stopping the other', async () => {
    const space = await service.createSpace({ purpose: `CONTENT two deployed versions ${randomUUID()}` });
    const modelsA = { worker: { model: 'worker-a', reasoningEffort: 'medium' as const },
      judge: { model: 'judge-a', reasoningEffort: 'high' as const } };
    const modelsB = { worker: { model: 'worker-b', reasoningEffort: 'medium' as const },
      judge: { model: 'judge-b', reasoningEffort: 'high' as const } };
    const entered = new Map<string, {model: string; release: () => void}>();
    const gated: AgentRunner = { async run(request) {
      if (request.definition.id === 'content-researcher') {
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(new Error('Canceled by test'));
          request.signal.addEventListener('abort', abort, { once: true });
          entered.set(request.runId, { model: request.definition.model, release: () => {
            request.signal.removeEventListener('abort', abort); resolve();
          } });
          if (request.signal.aborted) abort();
        });
      }
      return runner.run(request);
    } };
    const firstHost = createContentWorkbench({ service, runner: gated, models: modelsA,
      principalId: owner.id, concurrency: 2 });
    const firstCandidate = await firstHost.preview(space.id);
    await firstHost.publishMethod(space.id, { expectedVersionId: firstCandidate.version.id,
      changeReason: 'First isolated deployment' });
    const host = createContentWorkbench({ service, runner: gated, models: modelsB,
      retainedProfiles: [{ runner: gated, models: modelsA }], principalId: owner.id, concurrency: 2 });
    const secondCandidate = await host.preview(space.id);
    await host.publishMethod(space.id, { expectedVersionId: secondCandidate.version.id,
      predecessorId: firstCandidate.version.id, changeReason: 'Change frozen model profile' });
    expect(await host.methodAvailability(space.id, firstCandidate.version.id, 'content')).toEqual({ available: true });
    const caseIds = [randomUUID(), randomUUID(), randomUUID()];
    for (const caseId of caseIds) await service.createCase(space.id, { id: caseId,
      title: 'Two deployed methods', objective: input.readerGoal, constraints: [] });
    const first = await host.start({ spaceId: space.id, caseId: caseIds[0]!, input,
      workflowVersionId: firstCandidate.version.id, idempotencyKey: 'first' });
    const second = await host.start({ spaceId: space.id, caseId: caseIds[1]!, input,
      workflowVersionId: secondCandidate.version.id, idempotencyKey: 'second' });
    const third = await host.start({ spaceId: space.id, caseId: caseIds[2]!, input,
      workflowVersionId: secondCandidate.version.id, idempotencyKey: 'third' });
    const waitFor = async (predicate: () => boolean, label: string) => {
      const deadline = Date.now() + 10_000;
      while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      if (!predicate()) throw new Error(`Timed out waiting for ${label}`);
    };
    await waitFor(() => entered.has(first.runId) && entered.has(second.runId), 'two admitted runs');
    expect(entered.get(first.runId)?.model).toBe('worker-a');
    expect(entered.get(second.runId)?.model).toBe('worker-b');
    expect((await host.tasks(space.id)).find(task => task.runId === third.runId)?.status).toBe('queued');
    await host.cancel(space.id, first.runId);
    await expect(first.completion).rejects.toThrow();
    await waitFor(() => entered.has(third.runId), 'third queued run admission');
    expect(entered.get(third.runId)?.model).toBe('worker-b');
    entered.get(second.runId)!.release();
    entered.get(third.runId)!.release();
    expect((await second.completion).run.state).toBe('needs_review');
    expect((await third.completion).run.state).toBe('needs_review');
    expect((await host.tasks(space.id)).find(task => task.runId === first.runId)?.status).toBe('canceled');
    await host.stop();
  }, 90_000);

  it('keeps a persisted queued run idle across host construction and status reads until explicit dispatch', async () => {
    const space = await service.createSpace({ purpose: `CONTENT queued restart ${randomUUID()}` });
    const firstHost = createContentWorkbench({ service, runner, models, principalId: owner.id });
    const method = await firstHost.preview(space.id);
    await firstHost.publishMethod(space.id, { expectedVersionId: method.version.id,
      changeReason: 'Queue restart fixture' });
    const caseId = randomUUID();
    await service.createCase(space.id, { id: caseId, title: 'Queued run', objective: input.readerGoal, constraints: [] });
    const parsed = contentInputSchema.parse(input);
    const refs = registerCreationSchemas(new SchemaRegistry());
    const { materials, ...opportunity } = parsed;
    const opportunityAsset = await service.importAsset(space.id, { schema: refs.opportunity,
      payload: opportunity, description: 'Queue fixture', idempotencyKey: randomUUID() });
    const materialsAsset = await service.importAsset(space.id, { schema: refs.materials,
      payload: materials, description: 'Queue fixture', idempotencyKey: randomUUID() });
    const manifest = await service.freezeInputs(space.id, caseId,
      { opportunity: opportunityAsset.id, materials: materialsAsset.id });
    const { task } = await service.enqueueExecution(space.id, { workflowVersionId: method.version.id,
      entrypoint: 'content', inputManifestId: manifest.id }, {
      workflowId: 'creation.content', workflowRevision: method.version.entrypoints.content!.codeRevision,
      inputFingerprint: workflowFingerprint(parsed), state: 'queued',
      metadata: { commandKey: `restart:${randomUUID()}`, commandFingerprint: 'a'.repeat(64) },
    }, { executorKey: WorkflowExecutorRegistry.key(method.version.id, 'content') });
    const before = calls;
    const newHost = createContentWorkbench({ service, runner, models, principalId: owner.id });
    expect((await newHost.tasks(space.id)).find(item => item.runId === task.runId)?.status).toBe('queued');
    expect((await newHost.runStatus(space.id, task.runId)).run.state).toBe('queued');
    expect(calls).toBe(before);
    await newHost.dispatch(space.id);
    await newHost.waitIdle(space.id);
    expect((await newHost.runStatus(space.id, task.runId)).run.state).toBe('needs_review');
    expect(calls - before).toBe(5);
    await newHost.stop();
  }, 45_000);

  it('reconstructs an experiment through the selected historical deployment parser', async () => {
    const space = await service.createSpace({ purpose: `CONTENT retained parser ${randomUUID()}` });
    const originalHost = createContentWorkbench({ service, runner, models, principalId: owner.id });
    const method = await originalHost.preview(space.id);
    await originalHost.publishMethod(space.id, { expectedVersionId: method.version.id,
      changeReason: 'Retained parser fixture' });
    const caseId = randomUUID();
    await service.createCase(space.id, { id: caseId, title: 'Retained parser',
      objective: input.readerGoal, constraints: [] });
    const baseline = await originalHost.start({ spaceId: space.id, caseId, input,
      workflowVersionId: method.version.id, idempotencyKey: 'baseline' });
    expect((await baseline.completion).run.state).toBe('needs_review');
    const status = await originalHost.runStatus(space.id, baseline.runId);
    const review = await originalHost.review({ spaceId: space.id, caseId, runId: baseline.runId,
      draftVersionId: status.draftVersionId!, id: randomUUID(), idempotencyKey: randomUUID(),
      standard: { id: 'four-questions', revision: '1', content: '好、不好、提升、仍不满意' },
      answers: { good: '清楚', bad: '短', improvement: '基线', unresolved: '更多例子' } });
    const baselineManifest = await service.readManifest(space.id, baseline.inputManifestId);
    const baselineOpportunityId = baselineManifest.assets.opportunity!;
    const historicalView = new Proxy(service, { get(target, key) {
      if (key === 'readAsset') return async (spaceId: string, assetId: string) => {
        const asset = await target.readAsset(spaceId, assetId);
        if (assetId !== baselineOpportunityId) return asset;
        const { opportunity, ...rest } = asset.payload as ContentInput;
        return { ...asset, payload: { ...rest, legacyOpportunity: opportunity } };
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const retained = createContentDeployment({ models, runner });
    let historicalParseCount = 0;
    const historical = { ...retained, parseInput(value: unknown) {
      historicalParseCount++;
      const item = value as Record<string, unknown>;
      if (typeof item.legacyOpportunity === 'string') {
        const { legacyOpportunity, ...rest } = item;
        return retained.parseInput({ ...rest, opportunity: legacyOpportunity });
      }
      return retained.parseInput(value);
    } };
    const newModels = { worker: { model: 'future-worker', reasoningEffort: 'medium' as const },
      judge: { model: 'future-judge', reasoningEffort: 'high' as const } };
    const host = createContentWorkbench({ service: historicalView, runner, models: newModels,
      retainedDeployments: [historical], principalId: owner.id });
    const experiment = await host.experiment({ spaceId: space.id, caseId, workflowVersionId: method.version.id,
      baselineRunId: baseline.runId, baselineReviewId: review.id,
      hypothesis: 'Replay through retained input rules', idempotencyKey: 'historical' });
    expect(experiment.workflowVersionId).toBe(method.version.id);
    expect((await experiment.completion).run.state).toBe('needs_review');
    expect(historicalParseCount).toBeGreaterThanOrEqual(2);
    await host.waitIdle(space.id);
    await host.stop();
  }, 60_000);

  it('freezes one input for two accurate deployments and queues idempotent manifest runs', async () => {
    const space = await service.createSpace({ purpose: `CONTENT frozen validation ${randomUUID()}` });
    const caseId = randomUUID();
    await service.createCase(space.id, { id: caseId, title: 'Frozen comparison', objective: input.readerGoal, constraints: [] });
    const seenModels: string[] = [];
    const trackingRunner: AgentRunner = { async run(request) {
      if (request.definition.id === 'content-researcher') seenModels.push(request.definition.model);
      return runner.run(request);
    } };
    const oldModels = { worker: { model: 'frozen-worker-a', reasoningEffort: 'medium' as const },
      judge: { model: 'frozen-judge-a', reasoningEffort: 'high' as const } };
    const newModels = { worker: { model: 'frozen-worker-b', reasoningEffort: 'medium' as const },
      judge: { model: 'frozen-judge-b', reasoningEffort: 'high' as const } };
    const oldHost = createContentWorkbench({ service, runner: trackingRunner, models: oldModels, principalId: owner.id });
    const oldMethod = await oldHost.preview(space.id);
    await oldHost.publishMethod(space.id, { expectedVersionId: oldMethod.version.id, changeReason: 'Frozen A' });
    const host = createContentWorkbench({ service, runner: trackingRunner, models: newModels,
      retainedProfiles: [{ runner: trackingRunner, models: oldModels }], principalId: owner.id });
    const newMethod = await host.preview(space.id);
    await host.publishMethod(space.id, { expectedVersionId: newMethod.version.id,
      predecessorId: oldMethod.version.id, changeReason: 'Frozen B' });
    const manifest = await host.freezeInput({ spaceId: space.id, caseId, input, idempotencyKey: randomUUID() });
    const before = calls;
    const request = { spaceId: space.id, caseId, inputManifestId: manifest.id, dispatch: false as const };
    const first = await host.startFromManifest({ ...request, workflowVersionId: oldMethod.version.id,
      idempotencyKey: 'old' });
    const duplicate = await host.startFromManifest({ ...request, workflowVersionId: oldMethod.version.id,
      idempotencyKey: 'old' });
    const second = await host.startFromManifest({ ...request, workflowVersionId: newMethod.version.id,
      idempotencyKey: 'new' });
    expect(duplicate.runId).toBe(first.runId);
    expect(first.inputManifestId).toBe(manifest.id);
    expect(second.inputManifestId).toBe(manifest.id);
    expect(calls).toBe(before);
    expect((await host.tasks(space.id)).filter(task => [first.runId, second.runId].includes(task.runId))
      .every(task => task.status === 'queued')).toBe(true);
    await host.dispatch(space.id);
    expect((await first.completion).run.state).toBe('needs_review');
    expect((await second.completion).run.state).toBe('needs_review');
    expect(seenModels).toContain('frozen-worker-a');
    expect(seenModels).toContain('frozen-worker-b');
    await host.stop();
  }, 90_000);

  it('rejects foreign cases, altered slots and web research before queuing frozen input', async () => {
    const space = await service.createSpace({ purpose: `CONTENT manifest guards ${randomUUID()}` });
    const host = createContentWorkbench({ service, runner, models, principalId: owner.id });
    const method = await host.preview(space.id);
    await host.publishMethod(space.id, { expectedVersionId: method.version.id, changeReason: 'Manifest guard fixture' });
    const caseId = randomUUID(), otherCaseId = randomUUID();
    for (const id of [caseId, otherCaseId]) await service.createCase(space.id,
      { id, title: 'Manifest guard', objective: input.readerGoal, constraints: [] });
    const manifest = await host.freezeInput({ spaceId: space.id, caseId, input, idempotencyKey: randomUUID() });
    const request = { spaceId: space.id, workflowVersionId: method.version.id,
      inputManifestId: manifest.id, dispatch: false as const, idempotencyKey: randomUUID() };
    await expect(host.startFromManifest({ ...request, caseId: otherCaseId })).rejects.toThrow('another case');
    await expect(host.startFromManifest({ ...request, caseId, entrypoint: 'other' })).rejects.toThrow('entrypoint');
    const foreign = await service.createSpace({ purpose: `Foreign CONTENT manifest ${randomUUID()}` });
    await service.createCase(foreign.id, { id: caseId, title: 'Foreign case', objective: input.readerGoal, constraints: [] });
    const foreignManifest = await host.freezeInput({ spaceId: foreign.id, caseId, input,
      idempotencyKey: randomUUID() });
    await expect(host.startFromManifest({ ...request, caseId, inputManifestId: foreignManifest.id })).rejects.toThrow();
    const swapped = await service.freezeInputs(space.id, caseId,
      { opportunity: manifest.assets.materials!, materials: manifest.assets.opportunity! });
    await expect(host.startFromManifest({ ...request, caseId, inputManifestId: swapped.id })).rejects.toThrow('schema differs');
    await expect(host.freezeInput({ spaceId: space.id, caseId,
      input: { ...input, webResearch: true }, idempotencyKey: randomUUID() })).rejects.toThrow('联网研究尚未接入');
    expect((await host.tasks(space.id))).toHaveLength(0);
    await host.stop();
  }, 45_000);
});
