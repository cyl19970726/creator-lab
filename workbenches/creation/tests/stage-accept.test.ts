import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { artifactPayloadSha256, type ArtifactRef } from '@signal-room/workflow';
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

async function addRun(fixture: ReturnType<typeof setup>, stage: 'content' | 'b1' | 'b2' | 'b3' | 'invalid', input?: object, assets: Record<string, object> = {}, output?: object) {
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
  const refs: Record<string, ArtifactRef> = {};
  for (const [type, payload] of Object.entries(assets)) {
    const dependsOn = type === 'content-review' ? ['content-draft', 'content-research', 'content-fact-check'].flatMap(name => refs[name]
      ? [{ artifactId: refs[name].id, revision: refs[name].revision, sha256: refs[name].sha256 }] : []) : [];
    refs[type] = await store.publishArtifact({ type, schemaVersion: 'v1', revision: '1', sha256: await artifactPayloadSha256(payload), uri: `artifact://${type}`,
      payload, producedBy: { workflowRunId: run.id, stepRunId: step.id, attemptId: attempt.id }, dependsOn, validation: 'valid', review: 'pending' });
  }
  if (output) {
    const details = (output as { details?: object }).details ?? {};
    await store.updateRun(run.id, { output: stage === 'content' ? { details: { ...details, draft: refs['content-draft'], research: refs['content-research'], review: refs['content-review'] } } : output });
  }
  return run.id;
}

const b1Input = { topicId: 'topic', opportunity: '机会', form: '竖屏', account: { name: '账号', positioning: '科技', currentAudience: '读者', referencePieces: [] }, materials: [{ id: 'm1', title: '材料', text: '内容' }] };
const audience = { questionInAudienceWords: '为什么？', currentIntuition: '原来的想法' };
const decision = { coreQuestion: '问题', oneLineAnswer: '答案', hook: '开头', beats: [{ beat: '节拍', says: '内容', evidence: ['m1'], visualIdea: '图' }] };
const scriptPayload = { title: '标题', coverText: '封面', segments: [{ time: '0-5', voiceover: '口播', onScreenText: '屏幕', visual: '画面' }] };
const contentInput = { ...b1Input, standards: '内容标准', webResearch: false, maxRevisions: 1,
  readerGoal: '看懂完整过程', requiredQuestions: ['过程如何发生？'] };
const contentDraft = { decision, script: { ...scriptPayload, estimatedSeconds: 30, sourcesUsed: ['m1'], changesFromPrevious: '首版' } };
const contentReview = { verdict: 'pass', route: 'pass', criteria: Array.from({ length: 8 }, (_, index) => ({ id: `C${index + 1}`, result: 'ok', reason: '清楚' })),
  questionCoverage: [{ question: '过程如何发生？', answerInDraft: '稿中讲了过程', missing: '', result: 'ok' }], mustChange: [], summary: '可以交制作' };
const contentFactCheck = { issues: [], summary: '无事实问题' };
const contentResearch = { questions: [{ question: '过程如何发生？', answer: '过程', materialRefs: ['m1'], gap: '' }],
  notes: [{ id: 'r1', title: '研究资料', url: 'https://example.com/research', publisher: '研究机构', date: '2026', keyPoints: ['证据'], fillsGap: '过程', sourceKind: 'primary' }], remainingGaps: [] };
const contentReady = { details: { stage: 'CONTENT', reason: 'awaiting-human-review', rounds: 1, guardFailures: [] } };

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

test('content acceptance freezes decision and complete script in one brief; evaluation versions do not move current', async () => {
  const f = setup();
  const assets = { 'content-draft': contentDraft, 'content-research': contentResearch, 'content-fact-check': contentFactCheck, 'content-review': contentReview };
  const adopted = await addRun(f, 'content', contentInput, assets, contentReady);
  const step = await f.store.createStep({ runId: adopted, key: 'research-update', kind: 'publish', workflowId: 'creation.content', workflowRevision: 'content-test', inputFingerprint: 'test', configFingerprint: 'test', state: 'running', validation: 'valid' });
  const attempt = await f.store.createAttempt({ runId: adopted, stepRunId: step.id, state: 'running' });
  const draftRef = (await f.store.listArtifacts(adopted)).find(a => a.type === 'content-draft')!;
  const dependency = (ref: ArtifactRef) => ({ artifactId: ref.id, revision: ref.revision, sha256: ref.sha256 });
  const publish = async (type: string, payload: object, dependsOn: ReturnType<typeof dependency>[]) => f.store.publishArtifact({ type, schemaVersion: 'v1', revision: '2', sha256: await artifactPayloadSha256(payload), uri: `artifact://${type}-updated`, payload,
    producedBy: { workflowRunId: adopted, stepRunId: step.id, attemptId: attempt.id }, dependsOn, validation: 'valid', review: 'pending' });
  const correctedResearch = { ...contentResearch, notes: [{ ...contentResearch.notes[0], keyPoints: ['修正后的证据'] }] };
  const researchRef = await publish('content-research', correctedResearch, []);
  const factRef = await publish('content-fact-check', contentFactCheck, [dependency(draftRef), dependency(researchRef)]);
  const reviewRef = await publish('content-review', contentReview, [dependency(draftRef), dependency(researchRef), dependency(factRef)]);
  await f.store.updateRun(adopted, { output: { details: { ...contentReady.details, draft: draftRef, research: researchRef, review: reviewRef } } });
  expect(f.invoke(adopted).status).toBe(0);
  const brief = f.latest() as ReturnType<typeof f.latest> & { decision: object; script: object; materials: Array<{ id: string; text: string }>; audienceQuestion: { readerGoal: string; requiredQuestions: string[] } };
  expect(brief.sources).toMatchObject([{ stage: 'content', runId: adopted }]);
  expect(brief).toMatchObject({ decision, script: contentDraft.script, audienceQuestion: { readerGoal: '看懂完整过程', requiredQuestions: ['过程如何发生？'] } });
  expect(brief.materials.map(m => m.id)).toEqual(['m1', 'r1']);
  expect(brief.materials[1].text).toContain('修正后的证据');
  const experiment = await addRun(f, 'content', contentInput, assets, contentReady);
  expect(f.invoke(experiment, '--keep-current').status).toBe(0);
  expect(f.decisions().current.content).toBe(adopted);
  expect(f.latest()).toEqual(brief);
  expect(existsSync(path.join(f.root, 'brief/v2.json'))).toBe(true);
  f.db.close();
});

test('content cannot be accepted from blocked, failed, or unreviewed output; revise remains recordable', async () => {
  const f = setup();
  const assets = { 'content-draft': contentDraft, 'content-review': contentReview };
  for (const reason of ['blocked', 'not-converged']) {
    const run = await addRun(f, 'content', contentInput, assets, { details: { stage: 'CONTENT', reason } });
    const result = f.invoke(run);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('not ready for acceptance');
  }
  const failed = await addRun(f, 'content', contentInput, assets, contentReady);
  await f.store.updateRun(failed, { state: 'failed' });
  expect(f.invoke(failed).status).not.toBe(0);
  const noReview = await addRun(f, 'content', contentInput, { 'content-draft': contentDraft }, contentReady);
  expect(f.invoke(noReview).status).not.toBe(0);
  const wrongRoute = await addRun(f, 'content', contentInput, { ...assets, 'content-review': { ...contentReview, route: 'rewrite' } }, contentReady);
  expect(f.invoke(wrongRoute).status).not.toBe(0);
  expect(existsSync(path.join(f.root, 'decisions.json'))).toBe(false);
  const revise = spawnSync(tsx, [script, 'topic', noReview, '--verdict', 'revise', '--reviewer', 'creator'], { cwd: f.cwd, encoding: 'utf8' });
  expect(revise.status).toBe(0);
  expect(f.decisions().runs[noReview].review.verdict).toBe('revise');
  expect(f.decisions().current.content).toBeUndefined();
  f.db.close();
});

test('content acceptance rechecks final reviewer guards and terminal artifact identity', async () => {
  const f = setup();
  const validAssets = { 'content-draft': contentDraft, 'content-research': contentResearch, 'content-fact-check': contentFactCheck, 'content-review': contentReview };
  const guarded = await addRun(f, 'content', contentInput, validAssets, contentReady);
  const guardedOutput = (await f.store.getRun(guarded))!.output as { details: object };
  await f.store.updateRun(guarded, { output: { details: { ...guardedOutput.details, guardFailures: ['未通过'] } } });
  expect(f.invoke(guarded).status).not.toBe(0);

  const wrongRef = await addRun(f, 'content', contentInput, validAssets, contentReady);
  const wrongOutput = (await f.store.getRun(wrongRef))!.output as { details: object };
  await f.store.updateRun(wrongRef, { output: { details: { ...wrongOutput.details, review: { id: 'another-run' } } } });
  const refResult = f.invoke(wrongRef);
  expect(refResult.status).not.toBe(0);
  expect(refResult.stderr).toContain('terminal references do not match');

  const missingCriterion = await addRun(f, 'content', contentInput, { ...validAssets, 'content-review': { ...contentReview, criteria: contentReview.criteria.slice(0, 1) } }, contentReady);
  const criterionResult = f.invoke(missingCriterion);
  expect(criterionResult.status).not.toBe(0);
  expect(criterionResult.stderr).toContain('acceptance guards failed');
  expect(existsSync(path.join(f.root, 'decisions.json'))).toBe(false);
  f.db.close();
});

test('the CLI directs historical B1/B2 invocations to the combined content loop', () => {
  const runStage = path.join(creationRoot, 'scripts/run-stage.ts');
  for (const stage of ['b1', 'b2']) {
    const result = spawnSync(tsx, [runStage, stage, 'missing.json'], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Use "pnpm stage content <input.json>"');
  }
});
