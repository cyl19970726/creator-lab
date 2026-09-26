import test from 'node:test';
import assert from 'node:assert/strict';
import type { ResearchSnapshot } from '../../../packages/contracts/index.js';
import { mergeSnapshot, readerUrl, selectedArtifact } from './state.js';
const identity = (id: string) => ({ id, revision: 'v1', sha256: 'a'.repeat(64) });
const artifact = (id: string) => ({
  identity: identity(id),
  type: 'report',
  schemaVersion: '1',
  producer: { runId: 'r', stepId: 's', attemptId: 'a' },
  validation: 'valid' as const,
  review: 'pending' as const,
  effectiveReview: 'pending' as const,
});
const base: ResearchSnapshot = {
  schemaVersion: 1,
  rootRunId: 'r',
  cursor: '1',
  runs: [],
  stages: [
    {
      id: 'phase-a3',
      phaseKey: 'phase:uuid:a3-report',
      path: ['a3-report'],
    } as ResearchSnapshot['stages'][number],
  ],
  calls: [],
  artifacts: [artifact('a'), artifact('b')],
  relations: [],
  progress: { registered: 2, completed: 1, closed: false },
  delivery: { state: 'unknown', artifactIds: [] },
  diagnostics: [],
  ui: { assets: { a: { title: 'A' }, b: { title: 'B' } }, primaryByStage: { 'phase-a3': 'a' } },
};
test('incremental changes preserve stable artifacts, remove deleted metadata and replace full aggregates', () => {
  const next = mergeSnapshot(base, {
    resetRequired: false,
    cursor: '2',
    changed: {
      ...base,
      cursor: '2',
      artifacts: [{ ...artifact('a'), validation: 'invalid' }],
      progress: { registered: 3, completed: 2, closed: false },
      relations: [],
      diagnostics: ['new'],
      ui: { assets: { a: { title: 'A2' } }, primaryByStage: { 'phase-a2': 'a' } },
    },
    removed: { runs: [], stages: [], calls: [], artifacts: ['b'] },
  });
  assert.equal(next?.artifacts.length, 1);
  assert.equal(next?.artifacts[0].validation, 'invalid');
  assert.deepEqual(next?.ui.assets, { a: { title: 'A2' } });
  assert.deepEqual(next?.ui.primaryByStage, { 'phase-a2': 'a' });
  assert.deepEqual(next?.diagnostics, ['new']);
});
test('ambiguous delivery never silently selects a report', () => {
  assert.equal(
    selectedArtifact({ ...base, delivery: { state: 'ambiguous', artifactIds: ['a', 'b'] } }),
    undefined,
  );
  assert.equal(selectedArtifact(base)?.identity.id, 'a');
});
test('reader URL carries exact revision and content hash', () => {
  assert.equal(
    readerUrl('run/1', artifact('a')),
    `/api/runs/run%2F1/artifacts/a?revision=v1&sha256=${'a'.repeat(64)}`,
  );
});

test('actual phase paths map into A1, A2 and A3 even with generated phase keys', async () => {
  const { stageGroup } = await import('./state.js');
  assert.equal(stageGroup({ phaseKey: 'phase:some-uuid:a1-brief', path: ['a1-brief'] }), 'A1');
  assert.equal(stageGroup({ phaseKey: 'phase:other:a2-synthesis', path: ['a2-synthesis'] }), 'A2');
  assert.equal(stageGroup({ phaseKey: 'phase:third:a3-report', path: ['a3-report'] }), 'A3');
});
test('decision label retains exact version and partial scope', async () => {
  const { decisionLabel } = await import('./state.js');
  const id = identity('a');
  const events = [
    {
      id: 'e1',
      runId: 'r',
      identity: id,
      type: 'decision' as const,
      actor: 'user' as const,
      createdAt: '2026-09-22',
      verdict: 'accept' as const,
      scope: 'partial' as const,
      scopeLabel: '第二节',
    },
  ];
  assert.equal(decisionLabel(events, id), '局部接受：第二节');
  assert.equal(decisionLabel(events, { ...id, revision: 'v2' }), 'unknown');
});

test('later ordered A2 reader stage replaces plan as default without a timestamp guess', () => {
  const stages = [
    { id: 'plan', phaseKey: 'phase:uuid:a2-plan', path: ['a2-plan'], order: 2, audience: 'reader' },
    {
      id: 'synthesis',
      phaseKey: 'phase:uuid:a2-synthesis',
      path: ['a2-synthesis'],
      order: 4,
      audience: 'reader',
    },
  ] as ResearchSnapshot['stages'];
  const snapshot = {
    ...base,
    stages,
    ui: { ...base.ui, primaryByStage: { plan: 'a', synthesis: 'b' } },
  };
  assert.equal(selectedArtifact(snapshot)?.identity.id, 'b');
  assert.equal(
    selectedArtifact({
      ...snapshot,
      stages: [...stages, { ...stages[1], id: 'other' }],
      ui: { ...snapshot.ui, primaryByStage: { ...snapshot.ui.primaryByStage, other: 'a' } },
    }),
    undefined,
  );
});

test('draft identity separates run and exact artifact versions', async () => {
  const { collaborationDraftKey } = await import('./state.js');
  const current = identity('a');
  const key = collaborationDraftKey('run-1', current);
  assert.notEqual(key, collaborationDraftKey('run-2', current));
  assert.notEqual(key, collaborationDraftKey('run-1', { ...current, revision: 'v2' }));
  assert.notEqual(key, collaborationDraftKey('run-1', { ...current, sha256: 'b'.repeat(64) }));
});

test('known artifact types get reader-facing Chinese labels regardless of case', async () => {
  const { artifactTypeLabel } = await import('./state.js');
  assert.equal(artifactTypeLabel('research-brief'), '研究任务书');
  assert.equal(artifactTypeLabel('RESEARCH-SYNTHESIS'), '研究综合');
  assert.equal(artifactTypeLabel('research-report'), '图文报告');
});
