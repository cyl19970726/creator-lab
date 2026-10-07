import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { artifactPayloadSha256 } from '@signal-room/workflow';
import { SQLiteWorkflowRunStore } from '@signal-room/workflow-sqlite';
import { WorkbenchStore } from '../src/workbench/store.js';
import { issueReviewAssignment } from '../apps/workbench/auth.js';
import { buildWorkbenchApp } from '../apps/workbench/app.js';

const token = 'test-owner-token-not-a-live-secret-123456789';
const origin = 'http://127.0.0.1:4341';
const resources: Array<{ app: ReturnType<typeof buildWorkbenchApp>; store: WorkbenchStore; root: string }> = [];
const actor = { kind: 'user' as const, id: 'creator' };
function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'creator-workbench-api-'));
  const store = new WorkbenchStore(root);
  const app = buildWorkbenchApp({ store, auth: { token, publicOrigin: origin } });
  const resource = { app, store, root }; resources.push(resource);
  return resource;
}
const ownerHeaders = { host: '127.0.0.1:4341', authorization: `Bearer ${token}` };
const caseBody = () => ({ commandId: randomUUID(), title: '测试业务', opportunity: '解释一个实际问题', readerGoal: '理解原理', requiredQuestions: ['为什么会变化？'],
  account: { name: '测试账号', positioning: '解释原理', currentAudience: '普通读者', referencePieces: [] }, form: '视频口播', materials: [{ id: 'source-1', title: '已核对材料', text: '这里是输入材料。' }], webResearch: false });
const startBody = () => ({ commandId: randomUUID(), workflowId: 'creation.content' as const, model: 'gpt-6-sol', workerEffort: 'medium' as const, judgeEffort: 'high' as const, maxRevisions: 0, hypothesis: '建立第一轮基线' });
async function deliveredFixture(store: WorkbenchStore, app: ReturnType<typeof buildWorkbenchApp>, failure = '替身失败记录') {
  const item = store.createCase(caseBody(), actor);
  const response = await app.inject({ method: 'POST', url: `/api/workbench/cases/${item.id}/runs`, headers: ownerHeaders, payload: startBody() });
  expect(response.statusCode).toBe(200);
  const run = response.json();
  expect(store.claimNext()?.id).toBe(run.id);
  const ledger = new SQLiteWorkflowRunStore(store.database);
  const native = await ledger.createRun({ workflowId: 'creation.content', workflowRevision: 'fixture-v1', inputFingerprint: 'fixture', state: 'running' });
  store.bindRun(run.id, native.id);
  const step = await ledger.createStep({ runId: native.id, key: 'fixture-draft', kind: 'publish', workflowId: 'creation.content', workflowRevision: 'fixture-v1', inputFingerprint: 'fixture', configFingerprint: 'fixture', state: 'running', validation: 'valid' });
  const attempt = await ledger.createAttempt({ runId: native.id, stepRunId: step.id, state: 'running' });
  const payload = { script: { title: '测试稿件', segments: [{ voiceover: '这是替身测试产物，不代表模型实跑。' }] } };
  const sha256 = await artifactPayloadSha256(payload);
  const ref = await ledger.publishArtifact({ type: 'content-draft', schemaVersion: '1', revision: 'test-v1', sha256, uri: 'fixture://draft', payload,
    producedBy: { workflowRunId: native.id, stepRunId: step.id, attemptId: attempt.id }, dependsOn: [], validation: 'valid', review: 'not_applicable' });
  const artifact = store.saveArtifact(run.id, ref, payload);
  store.finishRun(run.id, 'failed', null, failure);
  return { item, run, artifact };
}
afterEach(async () => { for (const resource of resources.splice(0)) { await resource.app.close(); resource.store.close(); rmSync(resource.root, { recursive: true, force: true }); } });

describe('business workbench API boundary', () => {
  it('requires authentication and same-origin browser mutations, without trusting host or client actor', async () => {
    const { app } = setup();
    expect((await app.inject({ url: '/api/workbench/cases', headers: { host: '127.0.0.1:4341' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/workbench/session', headers: { host: '127.0.0.1:4341' }, payload: { token } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/workbench/session', headers: { host: '127.0.0.1:4341', origin: 'https://foreign.invalid' }, payload: { token } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/workbench/cases', headers: { ...ownerHeaders, host: 'foreign.invalid' } })).statusCode).toBe(403);
    const login = await app.inject({ method: 'POST', url: '/api/workbench/session', headers: { host: '127.0.0.1:4341', origin }, payload: { token } });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']);
    expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Strict'); expect(cookie).not.toContain(token);
    const session = await app.inject({ url: '/api/workbench/session', headers: { host: '127.0.0.1:4341', cookie: cookie.split(';')[0] } });
    expect(session.json().actor).toEqual(actor);
    const forged = await app.inject({ method: 'POST', url: '/api/workbench/cases', headers: ownerHeaders, payload: { ...caseBody(), actor: { kind: 'agent', id: 'forged' } } });
    expect(forged.statusCode).toBe(400);
  });

  it('persists one queued command and reading or refreshing never starts a workflow', async () => {
    const { app, store } = setup();
    const body = caseBody();
    const created = await app.inject({ method: 'POST', url: '/api/workbench/cases', headers: ownerHeaders, payload: body });
    const replay = await app.inject({ method: 'POST', url: '/api/workbench/cases', headers: ownerHeaders, payload: body });
    expect(replay.json().id).toBe(created.json().id);
    const caseId = created.json().id;
    for (const url of ['/api/workbench/workflows', `/api/workbench/cases/${caseId}`, '/api/workbench/cases']) expect((await app.inject({ url, headers: ownerHeaders })).statusCode).toBe(200);
    expect(store.listRuns()).toHaveLength(0);
    const start = startBody();
    const first = await app.inject({ method: 'POST', url: `/api/workbench/cases/${caseId}/runs`, headers: ownerHeaders, payload: start });
    const again = await app.inject({ method: 'POST', url: `/api/workbench/cases/${caseId}/runs`, headers: ownerHeaders, payload: start });
    expect(first.statusCode).toBe(200); expect(again.json().id).toBe(first.json().id);
    expect(store.listRuns()).toHaveLength(1);
    const execution = await app.inject({ url: `/api/workbench/runs/${first.json().id}/execution`, headers: ownerHeaders });
    expect(execution.json().run.state).toBe('queued'); expect(execution.json().nativeRun).toBeNull(); expect(execution.json().steps).toEqual([]);
    expect((await app.inject({ method: 'POST', url: `/api/workbench/cases/${caseId}/runs`, headers: ownerHeaders, payload: { ...start, hypothesis: '改写同一命令' } })).statusCode).toBe(409);
  });

  it('allows an authenticated Agent to review a delivered artifact without reading hidden history or adopting', async () => {
    const { app, store } = setup();
    const { item, run, artifact } = await deliveredFixture(store, app);
    const assigned = await app.inject({ method: 'POST', url: '/api/workbench/review-assignments', headers: ownerHeaders, payload: { artifactId: artifact.id, sha256: artifact.sha256, standardVersion: 'rubric-v1' } });
    expect(assigned.statusCode).toBe(200);
    const agentHeaders = { host: '127.0.0.1:4341', authorization: `Bearer ${assigned.json().bearerToken}` };
    const other = await deliveredFixture(store, app);
    expect((await app.inject({ url: `/api/workbench/artifacts/${other.artifact.id}`, headers: agentHeaders })).statusCode).toBe(403);
    expect((await app.inject({ url: `/api/workbench/artifacts/${other.artifact.id}/media`, headers: agentHeaders })).statusCode).toBe(403);
    for (const url of ['/api/workbench/cases', `/api/workbench/cases/${item.id}`, `/api/workbench/runs/${run.id}/execution`]) expect((await app.inject({ url, headers: agentHeaders })).statusCode).toBe(403);
    expect((await app.inject({ url: `/api/workbench/artifacts/${artifact.id}`, headers: agentHeaders })).statusCode).toBe(200);
    const body = { commandId: randomUUID(), artifactId: artifact.id, sha256: artifact.sha256, standardVersion: 'rubric-v1', good: '第一段直观', bad: '第二段缺机制', improvement: '首次建立基线', unsatisfied: '仍需补解释', verdict: 'uncertain', evaluator: { model: 'external-judge', promptRevision: 'judge-v1', visibleMaterials: [artifact.id] } };
    const response = await app.inject({ method: 'POST', url: `/api/workbench/cases/${item.id}/reviews`, headers: agentHeaders, payload: body });
    expect(response.statusCode).toBe(200); expect(response.json().actor.kind).toBe('agent'); expect(response.json().actor.id).toBe(`agent-a:${assigned.json().assignment.id}`);
    expect(store.detail(item.id).decisions).toHaveLength(0);
    expect((await app.inject({ method: 'POST', url: `/api/workbench/cases/${item.id}/reviews`, headers: agentHeaders, payload: { ...body, commandId: randomUUID(), standardVersion: 'other-rubric' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/api/workbench/cases/${item.id}/reviews`, headers: agentHeaders, payload: { ...body, commandId: randomUUID(), evaluator: { ...body.evaluator, visibleMaterials: [other.artifact.id] } } })).statusCode).toBe(403);
    const expired = issueReviewAssignment({ token, publicOrigin: origin }, { ...assigned.json().assignment, expiresAt: Date.now() - 1 });
    expect((await app.inject({ url: `/api/workbench/artifacts/${artifact.id}`, headers: { ...agentHeaders, authorization: `Bearer ${expired}` } })).statusCode).toBe(401);
    expect((await app.inject({ url: `/api/workbench/artifacts/${artifact.id}`, headers: { ...agentHeaders, authorization: `${agentHeaders.authorization}tampered` } })).statusCode).toBe(401);
    const adopt = await app.inject({ method: 'POST', url: `/api/workbench/cases/${item.id}/decisions`, headers: agentHeaders, payload: { commandId: randomUUID(), kind: 'artifact', action: 'adopt', artifactId: artifact.id, sha256: artifact.sha256, reviewId: response.json().id, reason: '代理不能自行采用' } });
    expect(adopt.statusCode).toBe(403);
  });

  it('redacts failed-run diagnostics without changing stored evidence', async () => {
    const { app, store } = setup();
    const failure = `worker failed with ${token} and Bearer diagnostic-private-token`;
    const { item, run } = await deliveredFixture(store, app, failure);
    const detail = await app.inject({ url: `/api/workbench/cases/${item.id}`, headers: ownerHeaders });
    const execution = await app.inject({ url: `/api/workbench/runs/${run.id}/execution`, headers: ownerHeaders });
    for (const response of [detail, execution]) {
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(token);
      expect(response.body).not.toContain('diagnostic-private-token');
      expect(response.body).toContain('[redacted]');
    }
    expect(store.getRun(run.id).error).toBe(failure);
  });

  it('rejects a review targeting another case or a changed artifact hash', async () => {
    const { app, store } = setup();
    const { item, artifact } = await deliveredFixture(store, app);
    const other = store.createCase(caseBody(), actor);
    const body = { commandId: randomUUID(), artifactId: artifact.id, sha256: artifact.sha256, standardVersion: 'rubric-v1', good: '明确', bad: '待改', improvement: '基线', unsatisfied: '继续观察', verdict: 'uncertain' };
    expect((await app.inject({ method: 'POST', url: `/api/workbench/cases/${other.id}/reviews`, headers: ownerHeaders, payload: body })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/api/workbench/cases/${item.id}/reviews`, headers: ownerHeaders, payload: { ...body, sha256: '0'.repeat(64) } })).statusCode).toBe(409);
    expect(store.detail(item.id).reviews).toHaveLength(0);
  });
});
