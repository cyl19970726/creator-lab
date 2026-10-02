import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { artifactPayloadSha256 } from '@signal-room/workflow';
import { SQLiteWorkflowRunStore } from '@signal-room/workflow-sqlite';

const creationRoot = fileURLToPath(new URL('..', import.meta.url));
const script = path.join(creationRoot, 'scripts/stage-accept.ts');
const tsx = path.join(creationRoot, 'node_modules/.bin/tsx');
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

function setup() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'creation-stage-accept-'));
  dirs.push(cwd);
  const topic = 'topic';
  const root = path.join(cwd, '.local/stages', topic);
  mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(path.join(root, 'ledger.sqlite'));
  const store = new SQLiteWorkflowRunStore(db);
  const invoke = (runId: string, ...options: string[]) => spawnSync(tsx, [script, topic, runId, '--verdict', 'accept', '--reviewer', 'creator', ...options], { cwd, encoding: 'utf8' });
  const decisions = () => JSON.parse(readFileSync(path.join(root, 'decisions.json'), 'utf8')) as { current: Record<string, string>; runs: Record<string, { review: { verdict: string } }> };
  const latest = () => JSON.parse(readFileSync(path.join(root, 'brief/latest.json'), 'utf8')) as { version: number; sources: Array<{ runId: string }> };
  return { cwd, root, db, store, invoke, decisions, latest };
}

async function addRun(fixture: ReturnType<typeof setup>, stage: 'b1' | 'b2' | 'b3' | 'invalid', input?: object, assets: Record<string, object> = {}) {
  const { store, root } = fixture;
  const run = await store.createRun({ workflowId: `creation.${stage}`, workflowRevision: `${stage}-test`, inputFingerprint: 'test', state: 'needs_review', metadata: { stage, topicId: 'topic' } });
  if (input) {
    const runDir = path.join(root, stage, run.id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, 'input.json'), JSON.stringify(input));
  }
  const step = await store.createStep({ runId: run.id, key: 'publish', kind: 'publish', workflowId: run.workflowId,
    workflowRevision: run.workflowRevision, inputFingerprint: 'test', configFingerprint: 'test', state: 'running', validation: 'valid' });
  const attempt = await store.createAttempt({ runId: run.id, stepRunId: step.id, state: 'running' });
  for (const [type, payload] of Object.entries(assets)) {
    await store.publishArtifact({ type, schemaVersion: 'v1', revision: '1', sha256: await artifactPayloadSha256(payload), uri: `artifact://${type}`,
      payload, producedBy: { workflowRunId: run.id, stepRunId: step.id, attemptId: attempt.id }, dependsOn: [], validation: 'valid', review: 'pending' });
  }
  return run.id;
}

const b1Input = { topicId: 'topic', opportunity: '机会', form: '竖屏', account: { name: '账号', positioning: '科技', currentAudience: '读者', referencePieces: [] }, materials: [{ id: 'm1', title: '材料', text: '内容' }] };
const audience = { questionInAudienceWords: '为什么？', currentIntuition: '原来的想法' };
const decision = { coreQuestion: '问题', oneLineAnswer: '答案', hook: '开头', beats: [{ beat: '节拍', says: '内容', evidence: ['m1'], visualIdea: '图' }] };
const scriptPayload = { title: '标题', coverText: '封面', segments: [{ time: '0-5', voiceover: '口播', onScreenText: '屏幕', visual: '画面' }] };

test('evaluation accepts create distinct immutable briefs without replacing the adopted latest or current run', async () => {
  const f = setup();
  const assets = { 'b1-audience-question': audience, 'b1-content-decision': decision };
  const adopted = await addRun(f, 'b1', b1Input, assets);
  expect(f.invoke(adopted).status).toBe(0);
  const first = f.latest();
  const experiment1 = await addRun(f, 'b1', b1Input, assets);
  const experiment2 = await addRun(f, 'b1', b1Input, assets);
  expect(f.invoke(experiment1, '--keep-current').status).toBe(0);
  expect(f.invoke(experiment2, '--keep-current').status).toBe(0);
  expect(f.latest()).toEqual(first);
  expect(f.decisions().current.b1).toBe(adopted);
  const versions = readdirSync(path.join(f.root, 'brief')).filter(name => /^v\d+\.json$/.test(name)).sort();
  expect(versions).toEqual(['v1.json', 'v2.json', 'v3.json']);
  expect(JSON.parse(readFileSync(path.join(f.root, 'brief/v3.json'), 'utf8')).sources[0].runId).toBe(experiment2);
  f.db.close();
});

test('failed acceptance leaves no verdict or current pointer', async () => {
  const f = setup();
  const missingInput = await addRun(f, 'b1');
  const inputResult = f.invoke(missingInput);
  expect(inputResult.status).not.toBe(0);
  expect(inputResult.stderr).toContain('frozen input is missing');
  expect(existsSync(path.join(f.root, 'decisions.json'))).toBe(false);
  const missingDecision = await addRun(f, 'b1', b1Input, { 'b1-audience-question': audience });
  const assetResult = f.invoke(missingDecision);
  expect(assetResult.status).not.toBe(0);
  expect(assetResult.stderr).toContain('no audience question or content decision');
  expect(existsSync(path.join(f.root, 'decisions.json'))).toBe(false);
  f.db.close();
});

test('ordinary B2 acceptance advances the adopted brief and revise records a verdict without advancing it', async () => {
  const f = setup();
  const b1 = await addRun(f, 'b1', b1Input, { 'b1-audience-question': audience, 'b1-content-decision': decision });
  expect(f.invoke(b1).status).toBe(0);
  const base = f.latest();
  const b2 = await addRun(f, 'b2', { topicId: 'topic', brief: JSON.parse(readFileSync(path.join(f.root, 'brief/latest.json'), 'utf8')) }, { 'b2-script': scriptPayload });
  expect(f.invoke(b2).status).toBe(0);
  expect(f.latest().version).toBe(2);
  expect(f.decisions().current.b2).toBe(b2);
  const revise = await addRun(f, 'b1', b1Input);
  const result = spawnSync(tsx, [script, 'topic', revise, '--verdict', 'revise', '--reviewer', 'creator'], { cwd: f.cwd, encoding: 'utf8' });
  expect(result.status).toBe(0);
  expect(f.decisions().runs[revise]?.review.verdict).toBe('revise');
  expect(f.latest().version).toBe(2);
  expect(base.version).toBe(1);
  f.db.close();
});

test('B3 acceptance records the creator verdict without generating a brief; invalid stage is rejected', async () => {
  const f = setup();
  const b3 = await addRun(f, 'b3');
  expect(f.invoke(b3).status).toBe(0);
  expect(f.decisions().current.b3).toBe(b3);
  expect(existsSync(path.join(f.root, 'brief'))).toBe(false);
  const invalid = await addRun(f, 'invalid');
  const result = f.invoke(invalid);
  expect(result.status).not.toBe(0);
  expect(f.decisions().runs[invalid]).toBeUndefined();
  expect(f.decisions().current.invalid).toBeUndefined();
  f.db.close();
});
