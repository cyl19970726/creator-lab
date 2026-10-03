import { describe, expect, test } from 'vitest';
import { MemoryRunStore, runWorkflow, type AgentRunRequest, type AgentRunResult, type AgentRunner } from '@signal-room/workflow';
import { contentAcceptanceFailures, contentInputSchema, createContentWorkflow, CONTENT_REVISION, type ContentDraft, type ContentInput, type ContentReview, type ContentResearch } from '../src/stages/content.js';

const models = { worker: { model: 'test', reasoningEffort: 'medium' as const }, judge: { model: 'test', reasoningEffort: 'high' as const } };
const base: ContentInput = {
  topicId: 'topic', opportunity: '观众想看懂公开训练过程', readerGoal: '看懂训练看板与算力投入',
  requiredQuestions: ['看板上的变化意味着什么？', '钱花在哪里？'],
  account: { name: '账号', positioning: '解释技术经济', currentAudience: '普通观众', referencePieces: [] },
  form: '竖屏视频', materials: [{ id: 'm1', title: '一手材料', text: '训练看板与投入' }],
  standards: 'C1 C2', webResearch: false, maxRevisions: 2,
};
const draft = (version: string, seconds = 180): ContentDraft => ({
  decision: {
    workingTitle: '训练过程', coreQuestion: '如何看懂训练？', oneLineAnswer: '尝试、评分和调整', audience: '普通观众',
    audienceChange: '能看懂看板', hook: '看板上是什么？', beats: [{ beat: '看板', says: '训练', evidence: ['m1'], visualIdea: '图' }],
    accountAngle: '算力经济', form: '竖屏视频', notSaying: [], biggestRisk: '指标误读', openQuestions: [],
    alternativesConsidered: [], changesFromPrevious: version,
  },
  script: { title: '训练过程', coverText: '看懂训练', estimatedSeconds: seconds, sourcesUsed: ['m1'], changesFromPrevious: version,
    segments: [{ time: '00:00', voiceover: `版本${version}：模型尝试后由评分器反馈，再调整。`, onScreenText: '尝试→评分→调整', visual: '看板' }] },
});
const research: ContentResearch = { questions: [{ question: '看板上的变化意味着什么？', answer: '训练任务进展', materialRefs: ['m1'], gap: '' }], notes: [], remainingGaps: [] };
const review = (route: ContentReview['route'], coverage: ContentReview['questionCoverage'] = base.requiredQuestions.map(question => ({ question, answerInDraft: '解释在稿里', missing: '', result: 'ok' as const }))): ContentReview => ({
  verdict: route === 'pass' ? 'pass' : route === 'blocked' ? 'blocked' : 'revise', route,
  criteria: Array.from({ length: 8 }, (_, i) => ({ id: `C${i + 1}`, result: route === 'pass' ? 'ok' as const : 'fail' as const, reason: '审阅' })), questionCoverage: coverage,
  mustChange: route === 'pass' ? [] : ['补完整解释'], summary: '审阅总结',
});
type Plan = { routes: ContentReview['route'][]; drafts?: ContentDraft[]; issues?: Array<{ segment: string; claim: string; problem: 'wrong'; evidence: string; fix: string }> };
function scripted(plan: Plan) {
  const calls: Array<{ id: string; input: unknown }> = [];
  let drafts = 0; let reviews = 0; let researches = 0;
  const runner: AgentRunner = {
    async run<Input, Output>(request: AgentRunRequest<Input>): Promise<AgentRunResult<Output>> {
      calls.push({ id: request.definition.id, input: request.input });
      let output: unknown;
      switch (request.definition.id) {
        case 'content-researcher': output = { ...research, notes: researches++ ? [{ id: 'web-1', title: '新材料', url: 'https://example.com/1', publisher: '官方', date: '2026-10-01', keyPoints: ['训练机制'], fillsGap: '过程', sourceKind: 'primary' }] : [] }; break;
        case 'content-author': output = plan.drafts?.[drafts] ?? draft(String(drafts + 1)); drafts++; break;
        case 'content-cold-reader': output = { retell: '尝试和评分', oneLineAnswerAsUnderstood: '调整', unansweredQuestions: ['看板每列怎么读？'], lostAt: [], boredAt: [], keepWatchingAt3s: { yes: true, why: '好奇' }, keepWatchingAt30s: { yes: true, why: '看懂' }, mostMemorable: '看板' }; break;
        case 'content-fact-checker': output = { issues: plan.issues ?? [], summary: '核查完成' }; break;
        case 'content-editor': output = review(plan.routes[reviews++] ?? 'pass'); break;
        default: throw new Error(`Unexpected role ${request.definition.id}`);
      }
      return { output: output as Output };
    },
  };
  return { runner, calls };
}
async function execute(input: ContentInput, plan: Plan) {
  const store = new MemoryRunStore(); const { runner, calls } = scripted(plan);
  const { run } = await runWorkflow({ workflow: createContentWorkflow(models), input, store, agentRunner: runner });
  return { run, calls, store };
}

describe('content stage', () => {
  test('one accepted loop yields decision and complete script together, with no implicit duration cap', async () => {
    const { run, calls, store } = await execute({ ...base, maxRevisions: 0 }, { routes: ['pass'], drafts: [draft('首版', 420)] });
    expect(run.output).toMatchObject({ details: { stage: 'CONTENT', reason: 'awaiting-human-review', rounds: 1 } });
    expect(store.artifacts.filter(a => a.type === 'content-draft')).toHaveLength(1);
    const readerInput = calls.find(c => c.id === 'content-cold-reader')!.input as Record<string, unknown>;
    expect(Object.keys(readerInput).sort()).toEqual(['coverText', 'profile', 'segments', 'title']);
    expect(readerInput.profile).toBe(base.account.currentAudience);
    expect(calls.find(c => c.id === 'content-editor')!.input).toMatchObject({ coldRead: { unansweredQuestions: ['看板每列怎么读？'] } });
    expect(store.artifacts.some(a => a.type === 'content-reader')).toBe(true);
    expect(calls.find(c => c.id === 'content-author')!.input).toMatchObject({ readerGoal: base.readerGoal, requiredQuestions: base.requiredQuestions });
  });

  test('rewrite changes the draft without a new research call and reviews the revised version', async () => {
    const { run, calls, store } = await execute(base, { routes: ['rewrite', 'pass'] });
    expect(calls.map(c => c.id).filter(id => id === 'content-researcher')).toHaveLength(1);
    expect(calls.map(c => c.id).filter(id => id === 'content-author')).toHaveLength(2);
    expect(calls.filter(c => c.id === 'content-editor')).toHaveLength(2);
    expect(calls.filter(c => c.id === 'content-author')[1].input).toMatchObject({ route: 'rewrite', review: { mustChange: ['补完整解释'] } });
    expect(store.artifacts.filter(a => a.type === 'content-draft')).toHaveLength(2);
    expect(run.output).toMatchObject({ details: { reason: 'awaiting-human-review', rounds: 2 } });
  });

  test.each(['research', 'reframe'] as const)('%s routes back through research with original goal, draft and review', async route => {
    const { run, calls } = await execute(base, { routes: [route, 'pass'] });
    const searches = calls.filter(c => c.id === 'content-researcher');
    expect(searches).toHaveLength(2);
    expect(searches[1].input).toMatchObject({ readerGoal: base.readerGoal, opportunity: base.opportunity,
      previousDraft: { decision: { coreQuestion: '如何看懂训练？' } }, previousReview: { route } });
    expect(calls.filter(c => c.id === 'content-author')[1].input).toMatchObject({ research: { notes: [{ id: 'web-1' }] } });
    expect(run.output).toMatchObject({ details: { reason: 'awaiting-human-review' } });
  });

  test('missing question coverage, unresolved fact issue, or a hard duration cap cannot pass', async () => {
    const cases: Array<[ContentInput, Plan]> = [
      [{ ...base, maxRevisions: 0 }, { routes: ['pass'], issues: [{ segment: '01', claim: '错', problem: 'wrong', evidence: 'm1', fix: '改' }] }],
      [{ ...base, maxRevisions: 0, maxSeconds: 120 }, { routes: ['pass'], drafts: [draft('长稿', 121)] }],
    ];
    for (const [input, plan] of cases) {
      const { run } = await execute(input, plan);
      expect(run.output).toMatchObject({ details: { reason: 'not-converged' } });
    }
    const store = new MemoryRunStore();
    const { runner } = scripted({ routes: ['pass'] });
    const badRunner: AgentRunner = { run: async <I, O>(request: AgentRunRequest<I>): Promise<AgentRunResult<O>> => {
      if (request.definition.id === 'content-editor') return { output: review('pass', [{ question: base.requiredQuestions[0], answerInDraft: '', missing: '未解释', result: 'fail' }]) as O };
      return runner.run(request);
    } };
    const { run } = await runWorkflow({ workflow: createContentWorkflow(models), input: { ...base, maxRevisions: 0 }, store, agentRunner: badRunner });
    expect(run.output).toMatchObject({ details: { reason: 'not-converged' } });
  });

  test('program findings are saved, reach the next author, and prevent a false pass', async () => {
    const store = new MemoryRunStore();
    const { runner, calls } = scripted({ routes: ['pass', 'pass'] });
    let edits = 0;
    const guarded: AgentRunner = { run: async <I, O>(request: AgentRunRequest<I>): Promise<AgentRunResult<O>> => {
      if (request.definition.id === 'content-editor' && edits++ === 0) return {
        output: review('pass', [{ question: base.requiredQuestions[0], answerInDraft: '', missing: '解释没写进稿', result: 'fail' }]) as O,
      };
      return runner.run(request);
    } };
    const { run } = await runWorkflow({ workflow: createContentWorkflow(models), input: { ...base, maxRevisions: 1 }, store, agentRunner: guarded });
    const next = calls.filter(c => c.id === 'content-author')[1].input as { guardFailures: string[] };
    expect(next.guardFailures).toContain(`required question not answered: ${base.requiredQuestions[0]}`);
    const firstReview = store.artifacts.find(a => a.type === 'content-review')!;
    expect(await firstReview.payload).toMatchObject({ guardFailures: next.guardFailures });
    expect(run.output).toMatchObject({ details: { reason: 'awaiting-human-review', rounds: 2 } });
  });

  test.each(['criterion', 'missing criterion', 'mustChange'] as const)('editor %s cannot pass', async kind => {
    const store = new MemoryRunStore();
    const { runner } = scripted({ routes: ['pass'] });
    const guarded: AgentRunner = { run: async <I, O>(request: AgentRunRequest<I>): Promise<AgentRunResult<O>> => {
      if (request.definition.id === 'content-editor') {
        const value = review('pass');
        if (kind === 'criterion') value.criteria[0].result = 'fail';
        if (kind === 'missing criterion') value.criteria.pop();
        if (kind === 'mustChange') value.mustChange = ['仍须解释'];
        return { output: value as O };
      }
      return runner.run(request);
    } };
    const { run } = await runWorkflow({ workflow: createContentWorkflow(models), input: { ...base, maxRevisions: 0 }, store, agentRunner: guarded });
    expect(run.output).toMatchObject({ details: { reason: 'not-converged', guardFailures: expect.any(Array) } });
    expect((run.output as { details: { guardFailures: string[] } }).details.guardFailures.length).toBeGreaterThan(0);
  });

  test('research accumulation keeps new facts on the same URL and remaps question refs to its stable ID', async () => {
    const store = new MemoryRunStore();
    const { runner } = scripted({ routes: ['research', 'pass'] });
    let searches = 0;
    const withSources: AgentRunner = { run: async <I, O>(request: AgentRunRequest<I>): Promise<AgentRunResult<O>> => {
      if (request.definition.id === 'content-researcher') {
        const old = { id: 'web-1', title: '官方', url: 'https://example.com/a', publisher: '官方', date: '2026-10-01',
          keyPoints: ['已有事实'], fillsGap: '过程', sourceKind: 'primary' as const };
        return { output: (searches++ === 0 ? { ...research, notes: [old] } : {
          ...research, questions: [{ ...research.questions[0], materialRefs: ['web-new'] }], notes: [
            { ...old, id: 'web-new', keyPoints: ['补读事实'], fillsGap: '成本' },
            { ...old, id: 'web-2', url: 'https://example.com/b', keyPoints: ['另一个来源'] },
          ],
        }) as O };
      }
      return runner.run(request);
    } };
    await runWorkflow({ workflow: createContentWorkflow(models), input: base, store, agentRunner: withSources });
    const final = store.artifacts.filter(a => a.type === 'content-research').at(-1)!;
    const payload = final.payload as ContentResearch;
    expect(payload.notes).toEqual([
      expect.objectContaining({ id: 'web-1', keyPoints: ['已有事实', '补读事实'], fillsGap: '过程；成本' }),
      expect.objectContaining({ id: 'web-2', url: 'https://example.com/b' }),
    ]);
    expect(payload.questions[0].materialRefs).toEqual(['web-1']);
  });

  test('duplicate input IDs and conflicting research IDs are rejected', async () => {
    expect(contentInputSchema.safeParse({ ...base, materials: [base.materials[0], { ...base.materials[0], title: '别的材料' }] }).success).toBe(false);
    const { runner } = scripted({ routes: ['pass'] });
    const colliding: AgentRunner = { run: async <I, O>(request: AgentRunRequest<I>): Promise<AgentRunResult<O>> => {
      if (request.definition.id === 'content-researcher') return { output: { ...research, notes: [{
        id: 'm1', title: '另一材料', url: 'https://example.com/other', publisher: '官方', date: '2026-10-01',
        keyPoints: ['不同来源'], fillsGap: '问题', sourceKind: 'primary',
      }] } as O };
      return runner.run(request);
    } };
    const { run } = await runWorkflow({ workflow: createContentWorkflow(models), input: base, store: new MemoryRunStore(), agentRunner: colliding });
    expect(run.output).toMatchObject({ details: { reason: 'source-id-conflict' } });
  });

  test('shared acceptance guard finds dangling references even when the editor says pass', async () => {
    const invalid = draft('bad');
    invalid.script.sourcesUsed = ['missing-script'];
    invalid.decision.beats[0].evidence = ['missing-beat'];
    const badResearch = { ...research, questions: [{ ...research.questions[0], materialRefs: ['missing-research'] }] };
    const findings = contentAcceptanceFailures(base, review('pass'), { issues: [], summary: 'ok' }, invalid, badResearch);
    expect(findings).toEqual(expect.arrayContaining([
      'Unknown source id missing-script in script.sourcesUsed',
      'Unknown source id missing-beat in decision.beats[0].evidence',
      'Unknown source id missing-research in research.questions[0].materialRefs',
    ]));
    const store = new MemoryRunStore();
    const { runner } = scripted({ routes: ['pass'], drafts: [invalid] });
    const unknown: AgentRunner = { run: async <I, O>(request: AgentRunRequest<I>): Promise<AgentRunResult<O>> => {
      if (request.definition.id === 'content-researcher') return { output: badResearch as O };
      return runner.run(request);
    } };
    const { run } = await runWorkflow({ workflow: createContentWorkflow(models), input: { ...base, maxRevisions: 0 }, store, agentRunner: unknown });
    expect(run.output).toMatchObject({ details: { reason: 'not-converged', guardFailures: findings } });
  });

  test('revision identity distinguishes v2 code from the earlier real v1 run', () => {
    expect(CONTENT_REVISION).toBe('content-v2');
  });

  test('revision budget ends with not-converged, never a fabricated pass', async () => {
    const { run, calls } = await execute({ ...base, maxRevisions: 1 }, { routes: ['rewrite', 'rewrite'] });
    expect(calls.filter(c => c.id === 'content-author')).toHaveLength(2);
    expect(run.output).toMatchObject({ details: { reason: 'not-converged', rounds: 2 } });
  });

  test('prior feedback is present in research and writing; a new run still re-examines the original goal', async () => {
    const prior = { draft: draft('旧稿'), humanReview: { reviewer: '代理', notes: ['讲清看板'] } };
    const { calls } = await execute({ ...base, maxRevisions: 0, prior }, { routes: ['pass'] });
    expect(calls[0]).toMatchObject({ id: 'content-researcher', input: { opportunity: base.opportunity, readerGoal: base.readerGoal, humanReview: prior.humanReview, previousDraft: prior.draft } });
    expect(calls.find(c => c.id === 'content-author')!.input).toMatchObject({ humanReview: prior.humanReview, previousDraft: prior.draft });
    expect(contentInputSchema.parse({ ...base, prior })).toBeDefined();
  });
});
