import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactPayloadSha256, workflowFingerprint, type AgentRunner } from '@signal-room/workflow';
import { SQLiteWorkflowRunStore } from '@signal-room/workflow-sqlite';
import { CreationStore } from '../src/infrastructure/store.js';
import { RecoveryRunStore } from '../src/infrastructure/recovery-run-store.js';
import { CreationWorker } from '../apps/worker/worker.js';
import { frozenWorkflowInput } from '../src/application/job-input.js';
import { createArticleWorkflow } from '../src/workflows/article.js';
import { buildApp } from '../apps/api/app.js';

const opened: { root: string; store: CreationStore }[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'creation-worker-'));
  const store = new CreationStore(root);
  opened.push({ root, store });
  const workspace = store.createWorkspace({ commandId: 'workspace', name: 'Studio', positioning: 'Explain technology' });
  const work = store.createWork({ commandId: 'work', workspaceId: workspace.id, title: 'Article', question: 'How?',
    audience: 'Readers', purpose: 'explanation', medium: 'article', accountPositioning: 'Explain technology', constraints: '', materials: [] });
  const job = store.start(work.id, workspace.id, { commandId: 'start', model: 'test-only', reasoningEffort: 'low', maxRevisions: 0 });
  return { store, workspace, work, job };
}
afterEach(() => { for (const item of opened.splice(0)) { item.store.close(); rmSync(item.root, { recursive: true, force: true }); } });

it('reconciles a native artifact committed before its business row, without running a model', async () => {
  const { store, workspace, work, job } = setup();
  store.claimNext();
  const native = new SQLiteWorkflowRunStore(store.database);
  const run = await native.createRun({ workflowId: 'creation.article', workflowRevision: 'test',
    inputFingerprint: workflowFingerprint(frozenWorkflowInput(store, job.id)), state: 'running' });
  store.bindRun(job.id, run.id);
  const step = await native.createStep({ runId: run.id, key: 'definition', kind: 'publish', workflowId: run.workflowId,
    workflowRevision: run.workflowRevision, inputFingerprint: 'step-input', configFingerprint: 'step-config', state: 'running', validation: 'valid' });
  const attempt = await native.createAttempt({ runId: run.id, stepRunId: step.id, state: 'running' });
  const payload = { kind: 'definition', content: '# Definition', payload: {
    question: 'How?', promise: 'Explain', audienceChange: 'Understand', accountFit: 'Fits', materialRoles: [], scope: 'One article', unknowns: [],
  } };
  const ref = await native.publishArtifact({ type: 'definition', schemaVersion: 'v1', revision: '1',
    sha256: await artifactPayloadSha256(payload), uri: 'workflow://asset', payload,
    producedBy: { workflowRunId: run.id, stepRunId: step.id, attemptId: attempt.id }, dependsOn: [], validation: 'valid', review: 'pending' });
  await native.updateRun(run.id, { state: 'succeeded' });
  const artifactDirectory = join(store.stateRoot, 'artifacts');
  const incomplete = '{"content":"# Def';
  writeFileSync(join(artifactDirectory, `${ref.id}.json`), incomplete);
  store.close();
  const recoveredStore = new CreationStore(store.stateRoot);
  opened[0]!.store = recoveredStore;
  const neverRun = { run: async () => { throw new Error('A model must not run during reconciliation'); } };
  const worker = new CreationWorker({ store: recoveredStore, agentRunner: neverRun });
  const result = await worker.processNext();
  expect(result?.state).toBe('succeeded');
  const detail = recoveredStore.detail(work.id, workspace.id);
  expect(detail.artifacts).toHaveLength(1);
  expect(detail.artifacts[0]?.vendorRef.id).toBe(ref.id);
  expect(detail.artifacts[0]?.payload).toEqual(payload.payload);
  const quarantined = readdirSync(artifactDirectory).filter(name => name.startsWith(`${ref.id}.json.quarantined-`));
  expect(quarantined).toHaveLength(1);
  expect(readFileSync(join(artifactDirectory, quarantined[0]!), 'utf8')).toBe(incomplete);
  expect((await new SQLiteWorkflowRunStore(recoveredStore.database).listArtifacts(run.id))).toHaveLength(1);
});

it('reuses the exact native publication after interruption before the publish step succeeds', async () => {
  const { store } = setup();
  const base = new SQLiteWorkflowRunStore(store.database);
  const run = await base.createRun({ workflowId: 'article', workflowRevision: '1', inputFingerprint: 'input', state: 'running' });
  const stepInput = { runId: run.id, key: 'phase/draft', kind: 'publish' as const, workflowId: run.workflowId,
    workflowRevision: run.workflowRevision, inputFingerprint: 'same-input', configFingerprint: 'same-config', state: 'running' as const, validation: 'valid' as const };
  const firstStep = await base.createStep(stepInput);
  const firstAttempt = await base.createAttempt({ runId: run.id, stepRunId: firstStep.id, state: 'running' });
  const payload = { kind: 'draft', content: '# Article', payload: { title: 'Article', body: 'Body', sourceIds: [] } };
  const draft = { type: 'draft', schemaVersion: 'v1', revision: '1', sha256: await artifactPayloadSha256(payload),
    uri: 'workflow://asset', payload, dependsOn: [], validation: 'valid' as const, review: 'pending' as const };
  const first = await base.publishArtifact({ ...draft,
    producedBy: { workflowRunId: run.id, stepRunId: firstStep.id, attemptId: firstAttempt.id } });
  const retryStep = await base.createStep(stepInput);
  const retryAttempt = await base.createAttempt({ runId: run.id, stepRunId: retryStep.id, state: 'running' });
  const recovering = new RecoveryRunStore(store.database, () => {});
  const reused = await recovering.publishArtifact({ ...draft,
    producedBy: { workflowRunId: run.id, stepRunId: retryStep.id, attemptId: retryAttempt.id } });
  expect(reused.id).toBe(first.id);
  expect(await base.listArtifacts(run.id)).toHaveLength(1);
  expect((await base.listEvents(run.id)).some(e => e.type === 'artifact.recovered')).toBe(true);
  const different = await recovering.publishArtifact({ ...draft, sha256: 'b'.repeat(64),
    producedBy: { workflowRunId: run.id, stepRunId: retryStep.id, attemptId: retryAttempt.id } }).catch(error => error);
  expect(String(different)).toContain('SHA-256 mismatch');
});

it('binds the native run before any model call and records a complete article and review', async () => {
  const { store, workspace, work, job } = setup();
  const calls: string[] = [];
  const runner = { async run<Input, Output>(request: Parameters<AgentRunner['run']>[0]) {
    expect(store.getJobAny(job.id)?.runId).toBe(request.runId);
    calls.push(request.definition.id);
    const output = request.definition.id === 'article-definition'
      ? { question: 'How?', promise: 'Explain', audienceChange: 'Understand', accountFit: 'Fits', materialRoles: [], scope: 'One article', unknowns: [] }
      : request.definition.id === 'article-independent-reviewer'
        ? { verdict: 'pass', summary: 'The article fulfills the promise.', findings: [] }
        : { title: 'Article', body: 'This is a complete article.', sourceIds: [] };
    return { output: output as Output };
  } } as AgentRunner;
  const result = await new CreationWorker({ store, agentRunner: runner }).processNext();
  expect(result?.state).toBe('succeeded');
  expect(calls).toEqual(['article-definition', 'article-author', 'article-independent-reviewer']);
  const detail = store.detail(work.id, workspace.id);
  expect(detail.artifacts.map(a => a.kind)).toEqual(['definition', 'draft', 'review']);
  expect(detail.artifacts[2]?.dependencies).toContain(detail.artifacts[1]?.id);
  expect(detail.decisions).toEqual([]);
  const candidate = detail.artifacts[1]!;
  expect(store.decide(work.id, workspace.id, { commandId: 'accept', artifactId: candidate.id, sha256: candidate.sha256,
    action: 'accept', reason: 'I read and accept this exact draft' }).actor).toBe('user');
});

it('propagates a persisted cancellation to an interrupted native run on restart', async () => {
  const { store, workspace, job } = setup();
  store.claimNext();
  const native = new SQLiteWorkflowRunStore(store.database);
  const input = frozenWorkflowInput(store, job.id);
  const run = await native.createRun({ workflowId: 'creation.article', workflowRevision: createArticleWorkflow(input).revision,
    inputFingerprint: workflowFingerprint(input), state: 'running' });
  store.bindRun(job.id, run.id);
  store.cancel(job.id, workspace.id, 'cancel');
  const result = await new CreationWorker({ store, agentRunner: { run: async () => { throw new Error('Model must not run'); } } }).processNext();
  expect(result?.state).toBe('canceled');
  expect((await native.getRun(run.id))?.state).toBe('canceled');
});

it('shows a safe model-unavailable reason while retaining raw SDK detail only in the private ledger', async () => {
  const { store, workspace, work, job } = setup();
  const raw = 'CODEX_SDK_STREAM_ERROR:{"status":400,"error":{"message":"The gpt-6-sol model is not supported when using Codex with a ChatGPT account"},"prompt":"/private/secret.md"}';
  const result = await new CreationWorker({ store, agentRunner: { run: async () => { throw new Error(raw); } } }).processNext();
  expect(result?.state).toBe('failed');
  expect(result?.error).toBe('所选模型当前不可用，请选择可用模型重新开始。');
  expect((await new SQLiteWorkflowRunStore(store.database).getRun(result!.runId!))?.error).toContain(raw);
  const app = buildApp({ store });
  try {
    const detail = await app.inject({ method: 'GET', url: `/api/works/${work.id}?workspaceId=${workspace.id}` });
    const execution = await app.inject({ method: 'GET', url: `/api/jobs/${job.id}/execution?workspaceId=${workspace.id}` });
    expect(detail.json().jobs[0].error).toBe(result?.error);
    expect(execution.json().error).toBe(result?.error);
    expect(`${detail.body}${execution.body}`).not.toContain('/private/');
  } finally { await app.close(); }
});
