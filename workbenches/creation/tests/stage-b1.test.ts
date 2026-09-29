import { describe, expect, test } from 'vitest';
import { MemoryRunStore, runWorkflow, type AgentRunRequest, type AgentRunResult, type AgentRunner } from '@signal-room/workflow';
import { createB1Workflow, type B1Input, type Challenge, type ContentDecision, type EvidenceMap } from '../src/stages/b1.js';

const model = { worker: { model: 'test', reasoningEffort: 'medium' as const }, judge: { model: 'test', reasoningEffort: 'high' as const } };

const audienceQuestion = {
  questionInAudienceWords: '老师没学生强，怎么教出更强的学生？', variants: [], currentIntuition: '训练者必须比被训练者强',
  contradiction: '弱的怎么产生强的', desiredChange: '知道判卷比答题容易', demandSignals: [{ signal: '创作者观察', status: 'creator-judgment' }],
  premisesToCheck: ['弱指什么'],
};
const evidenceMap = (verdict: EvidenceMap['verdict']): EvidenceMap => ({
  whatMaterialsActuallyAnswer: '长任务怎样进入训练', verdict,
  subQuestions: [{ id: 'q1', question: '反馈从哪来', answerSketch: '验证器', support: 'partial', materialRefs: ['m1'], note: '' }],
  decisiveGaps: verdict === 'sufficient' ? [] : [{ gap: '为什么能超过老师', whyDecisive: '核心问题', whereToLook: '论文' }],
});
const decision = (version: string): ContentDecision => ({
  workingTitle: `标题 ${version}`, coreQuestion: 'q', oneLineAnswer: '判卷比答题容易', audience: 'a', audienceChange: 'c', hook: 'h',
  beats: [{ beat: 'b1', says: 's', evidence: ['m1'], visualIdea: 'v' }, { beat: 'b2', says: 's', evidence: ['m1'], visualIdea: 'v' }],
  accountAngle: '钱花在多试', form: '竖屏 2 分钟', notSaying: ['榜单'], biggestRisk: 'r', openQuestions: [], changesFromPrevious: version,
});
const challenge = (verdict: Challenge['verdict']): Challenge => ({
  verdict, criteria: [{ id: 'S1', result: verdict === 'pass' ? 'ok' : 'fail', reason: 'r' }],
  mustChange: verdict === 'pass' ? [] : ['把问题换成观众的话'], niceToChange: [], summary: 's',
});

function input(override: Partial<B1Input> = {}): B1Input {
  return {
    topicId: 't', opportunity: '大家好奇弱模型如何训出强模型', form: '竖屏视频',
    account: { name: 'Token 经济猫', positioning: 'p', currentAudience: 'a', referencePieces: [] },
    materials: [{ id: 'm1', title: 'Kimi', text: 'rollouts' }], standards: 'S1', webResearch: true, maxRevisions: 2,
    ...override,
  };
}

function scripted(options: { verdict?: EvidenceMap['verdict']; challenges?: Challenge['verdict'][] }) {
  const calls: string[] = [];
  let plans = 0;
  let challenges = 0;
  const runner = {
    async run<Input, Output>(request: AgentRunRequest<Input>): Promise<AgentRunResult<Output>> {
      calls.push(request.definition.id);
      switch (request.definition.id) {
        case 'b1-audience': return { output: audienceQuestion as Output };
        case 'b1-evidence': return { output: evidenceMap(options.verdict ?? 'gaps-fillable') as Output };
        case 'b1-research': return { output: { notes: [], remainingGaps: [] } as Output };
        case 'b1-planner': return { output: decision(`v${++plans}`) as Output };
        case 'b1-challenger': return { output: challenge(options.challenges?.[challenges++] ?? 'pass') as Output };
        default: throw new Error(`Unexpected agent ${request.definition.id}`);
      }
    },
  } satisfies AgentRunner;
  return { runner, calls };
}

describe('B1 stage workflow', () => {
  test('fills material gaps, revises on challenge, then stops at the human gate', async () => {
    const store = new MemoryRunStore();
    const { runner, calls } = scripted({ challenges: ['revise', 'pass'] });
    const { run } = await runWorkflow({ workflow: createB1Workflow(model), input: input(), store, agentRunner: runner });

    expect(calls).toEqual(['b1-audience', 'b1-evidence', 'b1-research', 'b1-planner', 'b1-challenger', 'b1-planner', 'b1-challenger']);
    expect(run.state).toBe('needs_review');
    expect(run.output).toMatchObject({ details: { stage: 'B1', reason: 'awaiting-human-review', rounds: 2 } });
    expect(store.artifacts.map(a => a.type)).toEqual([
      'b1-audience-question', 'b1-evidence-map', 'b1-research-notes',
      'b1-content-decision', 'b1-challenge', 'b1-content-decision', 'b1-challenge',
    ]);
  });

  test('skips research when the materials already answer the question', async () => {
    const { runner, calls } = scripted({ verdict: 'sufficient' });
    await runWorkflow({ workflow: createB1Workflow(model), input: input(), store: new MemoryRunStore(), agentRunner: runner });
    expect(calls).not.toContain('b1-research');
  });

  test('reports not-converged when the revision budget runs out', async () => {
    const { runner } = scripted({ challenges: ['revise', 'revise'] });
    const { run } = await runWorkflow({ workflow: createB1Workflow(model), input: input({ maxRevisions: 1 }), store: new MemoryRunStore(), agentRunner: runner });
    expect(run.output).toMatchObject({ details: { reason: 'not-converged', rounds: 2 } });
  });
});

describe('B1 revision after the human gate', () => {
  test('publishes the review, runs the requested research, and revises with the review as top priority', async () => {
    const store = new MemoryRunStore();
    const { runner, calls } = scripted({ challenges: ['pass'] });
    const prior = {
      audienceQuestion: audienceQuestion, evidenceMap: evidenceMap('gaps-fillable'), researchNotes: null,
      decision: decision('v1') as unknown as Record<string, unknown>,
      humanReview: { reviewer: 'proxy', verdict: 'revise' as const, notes: ['不要放弃 Kimi/GLM'], researchRequest: '验证比生成容易' },
    };
    const { run } = await runWorkflow({ workflow: createB1Workflow(model), input: input({ prior }), store, agentRunner: runner });

    expect(calls).toEqual(['b1-research', 'b1-planner', 'b1-challenger']);
    expect(run.output).toMatchObject({ details: { reason: 'awaiting-human-review' } });
    expect(store.artifacts.map(a => a.type).slice(0, 2)).toEqual(['b1-content-decision', 'b1-human-review']);
  });
});
