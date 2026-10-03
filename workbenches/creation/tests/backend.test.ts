import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../apps/api/app.js';
import { CreationStore, StoreError } from '../src/infrastructure/store.js';
import { publicExecutionError } from '../src/application/public-error.js';

const opened: { root: string; store: CreationStore }[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'creation-backend-'));
  const store = new CreationStore(root);
  opened.push({ root, store });
  const workspace = store.createWorkspace({ commandId: 'workspace-1', name: 'Studio', positioning: 'Explain technology' });
  const work = store.createWork({ commandId: 'work-1', workspaceId: workspace.id, title: 'One article',
    question: 'How does feedback improve a model?', audience: 'Curious readers', purpose: 'explanation', medium: 'article',
    accountPositioning: 'Explain technology', constraints: '', materials: [] });
  return { root, store, workspace, work };
}
afterEach(() => { for (const item of opened.splice(0)) { item.store.close(); rmSync(item.root, { recursive: true, force: true }); } });

describe('business store', () => {
  it('binds command IDs to exact payload and scope, and prevents two active jobs', () => {
    const { store, workspace, work } = setup();
    const first = store.start(work.id, workspace.id, { commandId: 'start-1', model: 'gpt-test', reasoningEffort: 'low', maxRevisions: 0 });
    const replay = store.start(work.id, workspace.id, { commandId: 'start-1', model: 'gpt-test', reasoningEffort: 'low', maxRevisions: 0 });
    expect(replay.id).toBe(first.id);
    expect(() => store.start(work.id, workspace.id, { commandId: 'start-1', model: 'other', reasoningEffort: 'low', maxRevisions: 0 })).toThrow(StoreError);
    expect(() => store.start(work.id, workspace.id, { commandId: 'start-2', model: 'gpt-test', reasoningEffort: 'low', maxRevisions: 0 })).toThrow('active job');
    expect(() => store.getWork(work.id, 'other-workspace')).toThrow('Work not found');
  });

  it('requires exact draft identity for revisions and decisions, and never confuses selection with acceptance', () => {
    const { store, workspace, work } = setup();
    const job = store.start(work.id, workspace.id, { commandId: 'start-1', model: 'gpt-test', reasoningEffort: 'low', maxRevisions: 0 });
    store.claimNext();
    const draft = store.registerArtifact({ workId: work.id, jobId: job.id, kind: 'draft', content: '# Draft',
      payload: { title: 'Draft', body: 'Body', sourceIds: [] }, vendorRef: { id: 'native-draft', revision: '1', sha256: 'a'.repeat(64) }, dependencies: [] });
    expect(() => store.revise(work.id, workspace.id, { commandId: 'revise-1', artifactId: draft.id,
      sha256: 'b'.repeat(64), feedback: 'More detail', model: 'gpt-test', reasoningEffort: 'low', maxRevisions: 0 })).toThrow('stale');
    const selected = store.decide(work.id, workspace.id, { commandId: 'choose-1', artifactId: draft.id, sha256: draft.sha256, action: 'select', reason: 'Read this' });
    expect(selected.actor).toBe('user');
    expect(store.detail(work.id, workspace.id).work.selectedArtifactId).toBe(draft.id);
    expect(() => store.decide(work.id, workspace.id, { commandId: 'accept-1', artifactId: draft.id, sha256: draft.sha256, action: 'accept', reason: 'Good' })).toThrow('completed workflow');
    expect(() => store.decide(work.id, 'other-workspace', { commandId: 'other-choice', artifactId: draft.id, sha256: draft.sha256, action: 'select', reason: 'No' })).toThrow('Work not found');
  });

  it('cancels queued jobs and allows explicit failed-job resume only', () => {
    const { store, workspace, work } = setup();
    const job = store.start(work.id, workspace.id, { commandId: 'start-1', model: 'gpt-test', reasoningEffort: 'low', maxRevisions: 0 });
    expect(store.cancel(job.id, workspace.id, 'cancel-1').state).toBe('canceled');
    expect(store.claimNext()).toBeUndefined();
    expect(() => store.resume(job.id, workspace.id, 'resume-1')).toThrow('Only failed');
    const second = store.start(work.id, workspace.id, { commandId: 'start-2', model: 'gpt-test', reasoningEffort: 'low', maxRevisions: 0 });
    store.claimNext();
    store.finish(second.id, 'failed', 'failure');
    expect(store.resume(second.id, workspace.id, 'resume-2').state).toBe('queued');
  });

  it('accepts only a passing review bound to the exact draft and verifies immutable files', () => {
    const { root, store, workspace, work } = setup();
    const job = store.start(work.id, workspace.id, { commandId: 'start-1', model: 'gpt-test', reasoningEffort: 'low', maxRevisions: 0 });
    store.claimNext();
    const draft = store.registerArtifact({ workId: work.id, jobId: job.id, kind: 'draft', content: '# Draft',
      payload: { title: 'Draft', body: 'Body', sourceIds: [] }, vendorRef: { id: 'draft-1', revision: '1', sha256: 'a'.repeat(64) }, dependencies: [] });
    store.registerArtifact({ workId: work.id, jobId: job.id, kind: 'review', content: '# Review',
      payload: { verdict: 'pass', summary: 'Clear', findings: [] }, vendorRef: { id: 'review-1', revision: '1', sha256: 'b'.repeat(64) }, dependencies: [draft.id] });
    store.finish(job.id, 'succeeded');
    expect(store.decide(work.id, workspace.id, { commandId: 'accept-1', artifactId: draft.id, sha256: draft.sha256,
      action: 'accept', reason: 'I accept this version' }).actor).toBe('user');
    writeFileSync(join(root, 'artifacts', 'review-1.json'), '{"tampered":true}');
    expect(() => store.decide(work.id, workspace.id, { commandId: 'accept-2', artifactId: draft.id, sha256: draft.sha256,
      action: 'accept', reason: 'Repeat' })).toThrow('hash mismatch');
  });
});

describe('scoped API', () => {
  it('validates body, scope, host, origin and reads without starting work', async () => {
    const { store, workspace, work } = setup();
    const app = buildApp({ store });
    try {
      const detail = await app.inject({ method: 'GET', url: `/api/works/${work.id}?workspaceId=${workspace.id}` });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().jobs).toEqual([]);
      expect((await app.inject({ method: 'GET', url: `/api/works/${work.id}?workspaceId=other` })).statusCode).toBe(404);
      expect((await app.inject({ method: 'POST', url: `/api/works/${work.id}/start?workspaceId=${workspace.id}`, payload: { commandId: 'start', model: 'x' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'GET', url: '/api/workspaces', headers: { host: 'evil.test' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: '/api/workspaces', headers: { origin: 'http://evil.test' } })).statusCode).toBe(403);
      expect((await app.inject({ method: 'GET', url: '/api/workspaces', headers: { origin: 'http://localhost:4338' } })).statusCode).toBe(200);
      expect(store.detail(work.id, workspace.id).jobs).toEqual([]);
    } finally { await app.close(); }
  });

  it('never projects arbitrary job errors into work or execution responses', async () => {
    const { store, workspace, work } = setup();
    const job = store.start(work.id, workspace.id, { commandId: 'start-1', model: 'gpt-test', reasoningEffort: 'low', maxRevisions: 0 });
    store.claimNext();
    store.finish(job.id, 'failed', 'secret prompt at /private/prompts/article.md');
    const app = buildApp({ store });
    try {
      const detail = await app.inject({ method: 'GET', url: `/api/works/${work.id}?workspaceId=${workspace.id}` });
      const execution = await app.inject({ method: 'GET', url: `/api/jobs/${job.id}/execution?workspaceId=${workspace.id}` });
      expect(detail.json().jobs[0].error).toBe('执行失败，请查看私有运行记录。');
      expect(execution.json().error).toBe('执行失败，请查看私有运行记录。');
      expect(`${detail.body}${execution.body}`).not.toContain('/private/prompts');
    } finally { await app.close(); }
  });
});

it.each([
  ['CODEX_SDK_STREAM_ERROR:{"status":400,"error":{"message":"The gpt-6-sol model is not supported when using Codex with a ChatGPT account"},"prompt":"/private/input"}', '所选模型当前不可用，请选择可用模型重新开始。'],
  ['CODEX_SDK_STREAM_ERROR:{"status":401,"error":{"message":"invalid_api_key at /private/token"}}', '模型服务登录或认证失败，请检查登录状态后重试。'],
  ['CODEX_SDK_TIMEOUT: /private/prompt.md', '模型调用超时，请稍后重试。'],
  ['unexpected failure: private prompt /private/prompt.md', '执行失败，请查看私有运行记录。'],
])('classifies private execution error without copying any raw detail: %s', (raw, expected) => {
  expect(publicExecutionError(raw)).toBe(expected);
  expect(publicExecutionError(raw)).not.toContain('/private/');
});
