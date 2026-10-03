import { describe, expect, test } from 'vitest';
import { MemoryRunStore, runWorkflow, type AgentRunRequest, type AgentRunResult, type AgentRunner, type ArtifactRef } from '@signal-room/workflow';
import { createArticleWorkflow } from '../src/workflows/article.js';
import type { ContentDefinition, Draft, Review, WorkflowInput } from '../src/contracts/index.js';

const definition: ContentDefinition = {
  question: 'How does a small verifier help training?',
  promise: 'Explain the verifier signal without claiming it alone caused all gains.',
  audienceChange: 'Readers can distinguish a training signal from the final model.',
  accountFit: 'Explains model mechanisms for curious readers.',
  materialRoles: [{ sourceId: 'source_a', use: 'Describes the verifier setup.' }],
  scope: 'One reported mechanism, without generalizing beyond the source.',
  unknowns: ['The source does not establish the full cause of downstream improvement.'],
};
const firstDraft: Draft = { title: 'A verifier as a training signal', body: 'The source describes a verifier. Its broader causal role remains uncertain.', sourceIds: ['source_a'] };
const repairedDraft: Draft = { title: 'How the verifier contributes', body: 'A verifier supplies one training signal, according to the source. The record does not isolate its full effect.', sourceIds: ['source_a'] };
const failingReview: Review = { verdict: 'revise', summary: 'The central distinction needs work.', findings: [{ severity: 'major', message: 'Clarify signal versus final capability.' }] };
const passingReview: Review = { verdict: 'pass', summary: 'The full article meets the stated promise within its evidence boundary.', findings: [] };

function input(override: Partial<WorkflowInput> = {}): WorkflowInput {
  return {
    workId: 'work_1', question: 'How does a small verifier help training?', audience: 'Technically curious readers',
    purpose: 'explanation', medium: 'article', accountPositioning: 'Explain AI mechanisms carefully',
    constraints: 'Do not overstate causality.',
    materials: [{ id: 'source_a', title: 'Source A', text: 'A verifier provides a training signal.' }],
    model: 'test-model', reasoningEffort: 'medium', maxRevisions: 1,
    ...override,
  };
}

function scriptedRunner(options: { reviews?: Review[]; definition?: unknown; drafts?: unknown[] } = {}) {
  const calls: Array<{ id: string; input: unknown }> = [];
  let draftCall = 0;
  let reviewCall = 0;
  const runner = {
    async run<Input, Output>(request: AgentRunRequest<Input>): Promise<AgentRunResult<Output>> {
      calls.push({ id: request.definition.id, input: request.input });
      switch (request.definition.id) {
        case 'article-definition': return { output: (options.definition ?? definition) as Output };
        case 'article-author':
        case 'article-reviser': return { output: (options.drafts?.[draftCall++] ?? (draftCall === 1 ? firstDraft : repairedDraft)) as Output };
        case 'article-independent-reviewer': return { output: (options.reviews?.[reviewCall++] ?? passingReview) as Output };
        default: throw new Error(`Unexpected agent: ${request.definition.id}`);
      }
    },
  } satisfies AgentRunner;
  return { runner, calls };
}

const asset = (store: MemoryRunStore, ref: ArtifactRef) => store.artifacts.find(item => item.id === ref.id)!;

describe('article workflow', () => {
  test('runs B1, complete draft, exact review, repair and independent re-review', async () => {
    const frozen = input();
    const store = new MemoryRunStore();
    const { runner, calls } = scriptedRunner({ reviews: [failingReview, passingReview] });
    const result = await runWorkflow({ workflow: createArticleWorkflow(frozen), input: frozen, store, agentRunner: runner });

    expect(result.run.state).toBe('succeeded');
    expect(calls.map(call => call.id)).toEqual([
      'article-definition', 'article-author', 'article-independent-reviewer',
      'article-reviser', 'article-independent-reviewer',
    ]);
    const output = result.output;
    expect(output && 'quality' in output && output.quality).toBe('passed');
    if (!output || !('candidate' in output)) throw new Error('Expected successful article output');
    const drafts = store.artifacts.filter(item => item.type === 'draft');
    const reviews = store.artifacts.filter(item => item.type === 'review');
    expect(drafts).toHaveLength(2);
    expect(reviews).toHaveLength(2);
    expect(reviews[0]!.dependsOn).toEqual([{ artifactId: drafts[0]!.id, revision: drafts[0]!.revision, sha256: drafts[0]!.sha256 }]);
    expect(reviews[1]!.dependsOn).toEqual([{ artifactId: drafts[1]!.id, revision: drafts[1]!.revision, sha256: drafts[1]!.sha256 }]);
    expect(drafts[1]!.dependsOn.map(dep => dep.artifactId)).toEqual([output.definition.id, drafts[0]!.id, reviews[0]!.id]);
    expect(asset(store, output.candidate).payload).toMatchObject({ kind: 'draft', content: expect.stringContaining('How the verifier contributes'), payload: repairedDraft });
    expect(asset(store, output.review).payload).toMatchObject({ kind: 'review', payload: passingReview });
    const phaseSteps = store.steps.filter(step => step.kind === 'phase');
    expect(phaseSteps.map(step => step.key)).toEqual(['content-definition', 'article-draft', 'article-review-0', 'article-repair-1', 'article-review-1']);
    expect(phaseSteps.every(step => step.artifactBindings?.length === 1)).toBe(true);
  });

  test('rejects an invented source ID before publishing an unsupported definition', async () => {
    const frozen = input();
    const store = new MemoryRunStore();
    const invalid = { ...definition, materialRoles: [{ sourceId: 'fabricated', use: 'Unsupported' }] };
    const { runner, calls } = scriptedRunner({ definition: invalid });
    const result = await runWorkflow({ workflow: createArticleWorkflow(frozen), input: frozen, store, agentRunner: runner });
    expect(result.run.state).toBe('blocked');
    expect(calls.map(call => call.id)).toEqual(['article-definition']);
    expect(store.artifacts).toHaveLength(0);
  });

  test.each([0, 1, 2])('respects maxRevisions=%i and leaves unresolved quality distinct from acceptance', async maxRevisions => {
    const frozen = input({ maxRevisions });
    const store = new MemoryRunStore();
    const { runner, calls } = scriptedRunner({ reviews: Array.from({ length: 3 }, () => failingReview) });
    const result = await runWorkflow({ workflow: createArticleWorkflow(frozen), input: frozen, store, agentRunner: runner });
    expect(result.run.state).toBe('needs_review');
    expect(result.output).toMatchObject({ ok: false, state: 'needs_review', details: { quality: 'unresolved', reason: 'revision-budget-exhausted' } });
    expect(calls.filter(call => call.id === 'article-reviser')).toHaveLength(maxRevisions);
    expect(calls.filter(call => call.id === 'article-independent-reviewer')).toHaveLength(maxRevisions + 1);
    expect(store.artifacts.filter(item => item.type === 'draft')).toHaveLength(maxRevisions + 1);
    expect(store.artifacts.filter(item => item.type === 'review')).toHaveLength(maxRevisions + 1);
  });

  test('same run and input replay reuses every model step and native artifact', async () => {
    const frozen = input();
    const store = new MemoryRunStore();
    const { runner, calls } = scriptedRunner();
    const flow = createArticleWorkflow(frozen);
    const first = await runWorkflow({ workflow: flow, input: frozen, store, agentRunner: runner });
    const callsBefore = calls.length;
    const artifactsBefore = store.artifacts.length;
    const replay = await runWorkflow({ workflow: flow, input: frozen, store, agentRunner: runner, resumeRunId: first.run.id });
    expect(replay.run.state).toBe('succeeded');
    expect(calls).toHaveLength(callsBefore);
    expect(store.artifacts).toHaveLength(artifactsBefore);
    expect(replay.output).toEqual(first.output);
  });

  test('user feedback starts a related version from the exact parent without redefining the goal', async () => {
    const store = new MemoryRunStore();
    const original = input();
    const parentRun = await runWorkflow({ workflow: createArticleWorkflow(original), input: original, store,
      agentRunner: scriptedRunner().runner });
    if (!parentRun.output || !('candidate' in parentRun.output)) throw new Error('Expected parent draft');
    const parentRef = parentRun.output.candidate;
    const frozen = input({ revision: {
      definition, draft: firstDraft, feedback: 'Make the causal limit clearer.',
      parentAssetId: parentRef.id, parentHash: parentRef.sha256, parentRevision: parentRef.revision,
    } });
    const { runner, calls } = scriptedRunner({ drafts: [repairedDraft] });
    const result = await runWorkflow({ workflow: createArticleWorkflow(frozen), input: frozen, store, agentRunner: runner });
    expect(result.run.state).toBe('succeeded');
    expect(calls.map(call => call.id)).toEqual(['article-reviser', 'article-independent-reviewer']);
    expect(calls[0]!.input).toMatchObject({
      definition, parentDraft: firstDraft, parentAssetId: parentRef.id, parentHash: parentRef.sha256,
      feedback: 'Make the causal limit clearer.',
    });
    const current = store.artifacts.filter(item => item.producedBy.workflowRunId === result.run.id);
    const copiedDefinition = current.find(item => item.type === 'definition')!;
    const newDraft = current.find(item => item.type === 'draft')!;
    expect(copiedDefinition.payload).toMatchObject({ origin: {
      kind: 'copied-from-parent-input', parentArtifactId: parentRef.id, parentHash: parentRef.sha256,
    } });
    expect(newDraft.dependsOn).toContainEqual({ artifactId: parentRef.id,
      revision: parentRef.revision, sha256: parentRef.sha256 });
  });

  test('invalid reviewer output is a blocked run, never a quality pass', async () => {
    const frozen = input();
    const store = new MemoryRunStore();
    const { runner } = scriptedRunner({ reviews: [{ ...passingReview, findings: [{ severity: 'major', message: 'Unresolved problem' }] }] });
    const result = await runWorkflow({ workflow: createArticleWorkflow(frozen), input: frozen, store, agentRunner: runner });
    expect(result.run.state).toBe('blocked');
    expect(store.artifacts.filter(item => item.type === 'review')).toHaveLength(0);
    expect(store.artifacts.filter(item => item.type === 'draft')).toHaveLength(1);
  });
});
