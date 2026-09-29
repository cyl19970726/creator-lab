import { describe, expect, test } from 'vitest';
import { MemoryRunStore, runWorkflow, type AgentRunRequest, type AgentRunResult, type AgentRunner } from '@signal-room/workflow';
import { createB2Workflow, type B2Input, type EditorVerdict, type Script } from '../src/stages/b2.js';

const model = { worker: { model: 'test', reasoningEffort: 'medium' as const }, judge: { model: 'test', reasoningEffort: 'high' as const } };
const script = (version: string): Script => ({
  title: 't', coverText: 'c', estimatedSeconds: 90, sourcesUsed: ['m1'], changesFromPrevious: version,
  segments: [1, 2, 3].map(i => ({ time: `${i}`, voiceover: `v${i}`, onScreenText: '', visual: `p${i}` })),
});
const verdict = (value: EditorVerdict['verdict']): EditorVerdict => ({
  verdict: value, criteria: [{ id: 'T1', result: value === 'pass' ? 'ok' : 'fail', reason: 'r' }],
  mustChange: value === 'pass' ? [] : [{ segment: '1', change: '开头直接抛问题' }], rejectedSuggestions: [], secondsBudget: 100, summary: 's',
});
const input: B2Input = {
  topicId: 't', decision: { coreQuestion: 'q' }, account: { name: 'Token 经济猫', positioning: 'p' }, form: '竖屏',
  materials: [{ id: 'm1', title: 'm', text: 'x' }], standards: 'T1', maxSeconds: 120, maxRevisions: 2,
};

function scripted(verdicts: EditorVerdict['verdict'][]) {
  const calls: Array<{ id: string; input: unknown }> = [];
  let writes = 0;
  let edits = 0;
  const runner = {
    async run<Input, Output>(request: AgentRunRequest<Input>): Promise<AgentRunResult<Output>> {
      calls.push({ id: request.definition.id, input: request.input });
      switch (request.definition.id) {
        case 'b2-writer': return { output: script(`v${++writes}`) as Output };
        case 'b2-cold-reader': return { output: {
          retell: 'r', oneLineAnswerAsUnderstood: 'a', lostAt: [], boredAt: [], mostMemorable: 'm',
          keepWatchingAt3s: { yes: true, why: 'w' }, keepWatchingAt30s: { yes: true, why: 'w' },
        } as Output };
        case 'b2-fact-checker': return { output: { issues: [], summary: 'ok' } as Output };
        case 'b2-editor': return { output: verdict(verdicts[edits++] ?? 'pass') as Output };
        default: throw new Error(`Unexpected agent ${request.definition.id}`);
      }
    },
  } satisfies AgentRunner;
  return { runner, calls };
}

describe('B2 stage workflow', () => {
  test('writes, gets reader + fact check, revises once on editor verdict, stops at the human gate', async () => {
    const store = new MemoryRunStore();
    const { runner, calls } = scripted(['revise', 'pass']);
    const { run } = await runWorkflow({ workflow: createB2Workflow(model), input, store, agentRunner: runner });

    expect(calls.map(c => c.id).filter(id => id === 'b2-writer' || id === 'b2-editor')).toEqual(['b2-writer', 'b2-editor', 'b2-writer', 'b2-editor']);
    expect(run.state).toBe('needs_review');
    expect(run.output).toMatchObject({ details: { stage: 'B2', reason: 'awaiting-human-review', rounds: 2 } });
  });

  test('applies the last editor edits once when review rounds run out, then fact-checks that version', async () => {
    const { runner, calls } = scripted(['revise', 'revise']);
    const { run } = await runWorkflow({ workflow: createB2Workflow(model), input: { ...input, maxRevisions: 1 }, store: new MemoryRunStore(), agentRunner: runner });
    expect(calls.map(c => c.id).filter(id => id !== 'b2-cold-reader')).toEqual([
      'b2-writer', 'b2-fact-checker', 'b2-editor', 'b2-writer', 'b2-fact-checker', 'b2-editor', 'b2-writer', 'b2-fact-checker',
    ]);
    expect(run.output).toMatchObject({ details: { reason: 'final-edits-fact-checked', rounds: 2 } });
  });

  test('continuing from a prior script writes new drafts under distinct steps', async () => {
    const store = new MemoryRunStore();
    const { runner, calls } = scripted(['revise']);
    const prior = { script: script('v0') as unknown as Record<string, unknown>, editor: verdict('revise') as unknown as Record<string, unknown>,
      humanReview: { reviewer: 'proxy', notes: ['改成三段结构'] } };
    const { run } = await runWorkflow({ workflow: createB2Workflow(model), input: { ...input, maxRevisions: 0, prior }, store, agentRunner: runner });
    const writes = calls.filter(c => c.id === 'b2-writer');
    expect(writes).toHaveLength(2);
    expect(writes[0].input).toMatchObject({ humanReview: { notes: ['改成三段结构'] } });
    expect(store.artifacts.filter(a => a.type === 'b2-script')).toHaveLength(3);
    expect(run.output).toMatchObject({ details: { reason: 'final-edits-fact-checked' } });
  });

  test('accept-with-edits applies the human edits once and only fact-checks', async () => {
    const { runner, calls } = scripted([]);
    const prior = { script: script('v0') as unknown as Record<string, unknown>, editor: verdict('revise') as unknown as Record<string, unknown>,
      humanReview: { reviewer: 'proxy', notes: ['改一句'] } };
    const { run } = await runWorkflow({ workflow: createB2Workflow(model), input: { ...input, finalize: true, prior }, store: new MemoryRunStore(), agentRunner: runner });
    expect(calls.map(c => c.id)).toEqual(['b2-writer', 'b2-fact-checker']);
    expect(run.output).toMatchObject({ details: { reason: 'final-edits-fact-checked', rounds: 0 } });
  });

  test('the cold reader only sees what a viewer sees', async () => {
    const { runner, calls } = scripted(['pass']);
    await runWorkflow({ workflow: createB2Workflow(model), input, store: new MemoryRunStore(), agentRunner: runner });
    const readerInput = calls.find(c => c.id === 'b2-cold-reader')!.input as Record<string, unknown>;
    expect(Object.keys(readerInput).sort()).toEqual(['coverText', 'segments', 'title']);
    expect(JSON.stringify(readerInput)).not.toContain('coreQuestion');
  });
});
