import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { AgentRunner } from '@signal-room/workflow';
import { mediaFilesForArtifact, validateArtifactAcceptance } from '../src/workbench/acceptance.js';
import { WorkbenchWorker, assertLoadedDefinitionMatches } from '../src/workbench/execution.js';
import { currentWorkflowRevision, fileFingerprint, prepareRun, resolveWorkbenchCodexExecutable } from '../src/workbench/registry.js';
import { WorkbenchStore, workbenchSha256 } from '../src/workbench/store.js';
import type { Actor, CaseInput, CreationCase, RunRequest, StoredArtifact, ControlRun } from '../src/workbench/contracts.js';
import type { PieceBrief } from '../src/stages/brief.js';

const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(path.join(os.tmpdir(), 'creation-wb-exec-')); temporary.push(dir); return dir; };
const actor: Actor = { kind: 'user', id: 'creator' };
const input: CaseInput = {
  title: '看懂训练', opportunity: '观众想看懂公开训练过程', readerGoal: '看懂训练看板与算力投入',
  requiredQuestions: ['看板上的变化意味着什么？'],
  account: { name: '账号', positioning: '解释技术经济', currentAudience: '普通观众', referencePieces: [] },
  form: '竖屏视频', materials: [{ id: 'm1', title: '一手材料', text: '训练看板与投入' }], webResearch: false,
};
const request = (commandId: string): RunRequest => ({ commandId, workflowId: 'creation.content', model: 'test', workerEffort: 'medium', judgeEffort: 'high', maxRevisions: 0, hypothesis: '建立基线' });
function setup() {
  const store = new WorkbenchStore(temp());
  const record = store.createCase({ ...input, commandId: 'case-1' }, actor);
  const run = store.createRun(record.id, request('run-1'), actor, runId => prepareRun(store, record, request('run-1'), runId));
  return { store, record, run };
}
const draft = {
  decision: { workingTitle: '训练过程', coreQuestion: '如何看懂训练？', oneLineAnswer: '尝试、评分和调整', audience: '普通观众',
    audienceChange: '能看懂看板', hook: '看板上是什么？', beats: [{ beat: '看板', says: '训练', evidence: ['m1'], visualIdea: '图' }],
    accountAngle: '算力经济', form: '竖屏视频', notSaying: [], biggestRisk: '指标误读', openQuestions: [], alternativesConsidered: [], changesFromPrevious: '首版' },
  script: { title: '训练过程', coverText: '看懂训练', estimatedSeconds: 180, sourcesUsed: ['m1'], changesFromPrevious: '首版',
    segments: [{ time: '00:00', voiceover: '模型尝试后由评分器反馈，再调整。', onScreenText: '尝试→评分→调整', visual: '看板' }] },
};
function runner(editor: 'pass' | 'revise' | 'throw' = 'pass'): AgentRunner {
  return { async run(request) {
    const role = request.definition.id;
    if (role === 'content-researcher') return { output: { questions: [{ question: input.requiredQuestions[0], answer: '训练任务进展', materialRefs: ['m1'], gap: '' }], notes: [], remainingGaps: [] } };
    if (role === 'content-author') return { output: draft };
    if (role === 'content-cold-reader') return { output: { retell: '尝试和评分', oneLineAnswerAsUnderstood: '调整', unansweredQuestions: [], lostAt: [], boredAt: [], keepWatchingAt3s: { yes: true, why: '好奇' }, keepWatchingAt30s: { yes: true, why: '看懂' }, mostMemorable: '看板' } };
    if (role === 'content-fact-checker') return { output: { issues: [], summary: '核查完成' } };
    if (role === 'content-editor') {
      if (editor === 'throw') throw new Error('Injected editor failure');
      return { output: { verdict: editor === 'pass' ? 'pass' : 'revise', route: editor === 'pass' ? 'pass' : 'rewrite',
        criteria: Array.from({ length: 8 }, (_, i) => ({ id: `C${i + 1}`, result: editor === 'pass' ? 'ok' : 'fail', reason: '审阅' })),
        questionCoverage: [{ question: input.requiredQuestions[0], answerInDraft: editor === 'pass' ? '尝试、评分和调整' : '', missing: editor === 'pass' ? '' : '缺解释', result: editor === 'pass' ? 'ok' : 'fail' }],
        mustChange: editor === 'pass' ? [] : ['补解释'], summary: '审阅总结' } };
    }
    throw new Error(`Unexpected role ${role}`);
  } } as AgentRunner;
}

describe('workbench execution adapter', () => {
  test('runs the real content definition, binds native ledger and validates its exact final draft', async () => {
    const { store, run } = setup();
    const worker = new WorkbenchWorker(store, { agentRunner: runner() });
    await worker.start();
    const finished = await worker.runNext();
    expect(finished?.state).toBe('needs_review');
    expect(finished?.nativeRunId).toBeTruthy();
    const assets = store.listArtifacts(run.id);
    expect(assets.map(a => a.nativeRef.type)).toEqual(expect.arrayContaining(['content-research', 'content-draft', 'content-fact-check', 'content-review']));
    const accepted = validateArtifactAcceptance(store, assets.find(a => a.nativeRef.type === 'content-draft')!, actor.id);
    expect(accepted.brief?.script).toMatchObject({ title: '训练过程' });
    expect(() => validateArtifactAcceptance(store, assets.find(a => a.nativeRef.type === 'content-research')!, actor.id)).toThrow();
    await worker.stop(); store.close();
  });
  test('keeps nonconverged content unaccepted and failed model calls recoverable with partial output', async () => {
    for (const outcome of ['revise', 'throw'] as const) {
      const { store, run } = setup();
      const worker = new WorkbenchWorker(store, { agentRunner: runner(outcome) });
      await worker.start();
      const finished = await worker.runNext();
      expect(finished?.state).toBe(outcome === 'throw' ? 'failed' : 'needs_review');
      expect(finished?.nativeRunId).toBeTruthy();
      expect(store.listArtifacts(run.id).some(a => a.nativeRef.type === 'content-draft')).toBe(true);
      expect(() => validateArtifactAcceptance(store, store.listArtifacts(run.id).find(a => a.nativeRef.type === 'content-draft')!, actor.id)).toThrow();
      await worker.stop(); store.close();
    }
  });
  test('rejects a changed frozen input before creating a native run', async () => {
    const { store, run } = setup();
    writeFileSync(path.join(store.stateRoot, 'runs', run.id, 'input.json'), JSON.stringify({ changed: true }));
    const worker = new WorkbenchWorker(store, { agentRunner: runner() });
    await worker.start();
    expect((await worker.runNext())?.state).toBe('failed');
    expect(store.getRun(run.id).nativeRunId).toBeNull();
    expect(store.listIncidents(run.id)[0]?.error).toMatch(/Frozen run input/);
    await worker.stop(); store.close();
  });
  test('rejects a queued new definition while this worker still holds older imported code', () => {
    const loaded = { workflow: 'old implementation' };
    const newCode = { workflow: 'new implementation' };
    const loadedHash = workbenchSha256(loaded);
    expect(() => assertLoadedDefinitionMatches(newCode, newCode, loadedHash)).toThrow(/loaded workflow definition differs/);
    expect(() => assertLoadedDefinitionMatches(loaded, newCode, loadedHash)).toThrow(/source changed after worker startup/);
    expect(() => assertLoadedDefinitionMatches(loaded, loaded, loadedHash)).not.toThrow();
  });
  test('fingerprints lockfile and the exact executable bytes, including same-path replacements', () => {
    const root = temp();
    const lock = path.join(root, 'pnpm-lock.yaml');
    const binary = path.join(root, 'codex');
    writeFileSync(lock, 'lock A'); writeFileSync(binary, 'code A');
    const firstLock = fileFingerprint(lock);
    const prior = process.env.CREATION_CODEX_BIN; process.env.CREATION_CODEX_BIN = binary;
    try {
      const first = currentWorkflowRevision('creation.content');
      expect((first.code as { dependencyLock: { sha256: string } }).dependencyLock.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect((first.config as { codexExecutable: { sha256: string } }).codexExecutable.sha256).toBe(fileFingerprint(binary).sha256);
      expect(resolveWorkbenchCodexExecutable().path).toBe(binary);
      writeFileSync(lock, 'lock B'); writeFileSync(binary, 'code B');
      expect(fileFingerprint(lock).sha256).not.toBe(firstLock.sha256);
      const second = currentWorkflowRevision('creation.content');
      expect((second.config as { codexExecutable: { sha256: string } }).codexExecutable.sha256)
        .not.toBe((first.config as { codexExecutable: { sha256: string } }).codexExecutable.sha256);
    } finally { if (prior === undefined) delete process.env.CREATION_CODEX_BIN; else process.env.CREATION_CODEX_BIN = prior; }
  });
  test('identifies the installed SDK default executable when no override is set', () => {
    const prior = process.env.CREATION_CODEX_BIN;
    delete process.env.CREATION_CODEX_BIN;
    try {
      const executable = resolveWorkbenchCodexExecutable();
      expect(executable.source).toBe('sdk-bundled');
      if (process.platform === 'darwin' && process.arch === 'arm64') {
        expect(executable.issue).toBeNull();
        expect(executable.path).toMatch(/vendor\/aarch64-apple-darwin\/bin\/codex$/);
        expect(executable.sha256).toBe(fileFingerprint(executable.path!).sha256);
      } else if (executable.issue) {
        expect(executable.sha256).toBeNull();
      } else {
        expect(executable.sha256).toBe(fileFingerprint(executable.path!).sha256);
      }
    } finally { if (prior === undefined) delete process.env.CREATION_CODEX_BIN; else process.env.CREATION_CODEX_BIN = prior; }
  });
  test('freezes exact baseline draft with creator feedback and rejects a changed runtime on resume', async () => {
    const { store, record, run } = setup();
    const worker = new WorkbenchWorker(store, { agentRunner: runner() });
    await worker.start(); await worker.runNext(); await worker.stop();
    const followupRequest = { ...request('run-feedback'), baselineRunId: run.id, feedback: '把评分机制讲得更具体' };
    const followup = store.createRun(record.id, followupRequest, actor,
      runId => prepareRun(store, record, followupRequest, runId));
    expect(followup.input).toMatchObject({ prior: { draft, humanReview: { notes: ['把评分机制讲得更具体'] } } });
    const before = process.env.CREATION_CODEX_BIN;
    process.env.CREATION_CODEX_BIN = '/private/tmp/workbench-changed-codex';
    try {
      const next = new WorkbenchWorker(store, { agentRunner: runner() });
      await next.start();
      expect((await next.runNext())?.state).toBe('failed');
      expect(store.getRun(followup.id).nativeRunId).toBeNull();
      expect(store.listIncidents(followup.id)[0]?.error).toMatch(/configuration changed/);
      await next.stop();
    } finally { if (before === undefined) delete process.env.CREATION_CODEX_BIN; else process.env.CREATION_CODEX_BIN = before; }
    store.close();
  });
  test('stopping an active model call leaves the native run explicitly resumable', async () => {
    const { store, run } = setup();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const waiting: AgentRunner = { async run(request) {
      entered();
      return new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true }));
    } };
    const worker = new WorkbenchWorker(store, { agentRunner: waiting });
    await worker.start();
    const work = worker.runNext();
    await started;
    await worker.stop();
    expect((await work)?.state).toBe('interrupted');
    expect(store.getRun(run.id).nativeRunId).toBeTruthy();
    store.resumeRun(run.id, { commandId: 'resume-1' }, actor);
    const resumed = new WorkbenchWorker(store, { agentRunner: runner() });
    await resumed.start();
    expect((await resumed.runNext())?.state).toBe('needs_review');
    expect(store.getRun(run.id).nativeRunId).toBeTruthy();
    await resumed.stop(); store.close();
  });
  test('sample media is viewable before adoption and acceptance verifies saved byte digests', () => {
    const root = temp(); const runId = 'sample-run';
    const runRoot = path.join(root, 'runs', runId);
    const videoDir = path.join(runRoot, '.local/stages/case/b3/native'); mkdirSync(videoDir, { recursive: true });
    const videoPath = path.join(videoDir, 'video.mp4'); writeFileSync(videoPath, 'video bytes');
    const digest = (data: string) => createHash('sha256').update(data).digest('hex');
    writeFileSync(path.join(videoDir, 'video.json'), JSON.stringify({ file: 'video.mp4', sha256: digest('video bytes'), bytes: 11 }));
    const sheetDir = path.join(runRoot, 'snapshots'); mkdirSync(sheetDir);
    const sheet = path.join(sheetDir, `sheet-${digest('image bytes')}.jpg`); writeFileSync(sheet, 'image bytes');
    const inspectionRef = { id: 'inspection', type: 'b3-inspection', schemaVersion: '1', revision: '1', sha256: 'inspecthash', uri: '',
      producedBy: { workflowRunId: 'native', stepRunId: 'inspect-step', attemptId: 'attempt' }, dependsOn: [], validation: 'valid' as const, review: 'not_applicable' as const };
    const videoRef = { id: 'video', type: 'b3-video', schemaVersion: '1', revision: '1', sha256: 'videohash', uri: '',
      producedBy: { workflowRunId: 'native', stepRunId: 'render-step', attemptId: 'attempt' }, dependsOn: [{ artifactId: 'inspection', revision: '1', sha256: 'inspecthash' }], validation: 'valid' as const, review: 'pending' as const };
    const inspection: StoredArtifact = { id: 'inspection', caseId: 'case', runId, nativeRef: inspectionRef, sha256: 'inspecthash',
      payload: { verdict: 'pass', imagesOpened: [sheet] }, createdAt: '' };
    const video: StoredArtifact = { id: 'video', caseId: 'case', runId, nativeRef: videoRef, sha256: 'videohash', payload: { output: videoPath }, createdAt: '' };
    const run = { id: runId, workflowId: 'creation.b3', nativeRunId: 'native', state: 'needs_review', terminal: { ok: false, state: 'needs_review', details: { stage: 'B3', reason: 'awaiting-human-review', scope: 'sample', video: videoPath, contactSheets: [sheet] } } } as ControlRun;
    const store = { stateRoot: root, getArtifact: (id: string) => id === 'video' ? video : inspection,
      getRun: () => run, listArtifacts: () => [inspection, video] } as unknown as WorkbenchStore;
    expect(mediaFilesForArtifact(store, video).map(file => file.sha256)).toEqual([digest('video bytes'), digest('image bytes')]);
    expect(validateArtifactAcceptance(store, video, actor.id)).toEqual({});
    writeFileSync(videoPath, 'tampered');
    expect(() => mediaFilesForArtifact(store, video)).toThrow(/digest receipt/);
    expect(() => validateArtifactAcceptance(store, video, actor.id)).toThrow(/digest receipt/);
  });
  test('B3 prepares only an accepted brief from configured server roots and snapshots them', () => {
    const root = temp();
    const template = path.join(root, 'template'); const reference = path.join(root, 'reference');
    mkdirSync(path.join(template, 'scripts'), { recursive: true }); mkdirSync(path.join(reference, 'frames-spec'), { recursive: true });
    writeFileSync(path.join(template, 'scripts/new-episode.sh'), '#!/bin/sh\nmkdir -p "$2/$1"\n');
    writeFileSync(path.join(template, 'package.json'), '{"name":"episode"}');
    writeFileSync(path.join(reference, 'frames-spec/01.py'), 'SPEC = {}');
    const priorTemplate = process.env.CREATION_B3_TEMPLATE_DIR; const priorReference = process.env.CREATION_B3_REFERENCE_DIR;
    process.env.CREATION_B3_TEMPLATE_DIR = template; process.env.CREATION_B3_REFERENCE_DIR = reference;
    try {
      const record: CreationCase = { id: 'case-1', input, inputHash: 'hash', createdAt: '' };
      const brief: PieceBrief = { schemaVersion: 'brief-v1', topicId: record.id, version: 1, sources: [{ stage: 'content', runId: 'native', revision: 'content-v2', acceptedAt: '2026-10-03T00:00:00.000Z', reviewer: 'creator' }],
        creator: { opportunity: input.opportunity, account: input.account, form: input.form }, audienceQuestion: { readerGoal: input.readerGoal }, decision: {}, materials: input.materials,
        notesForB2: [], script: draft.script, notesForB3: [] };
      const store = { stateRoot: root, getAcceptedBrief: () => brief };
      const req: RunRequest = { ...request('b3'), workflowId: 'creation.b3', production: { scope: 'full', voice: process.platform === 'darwin' ? 'placeholder' : 'minimax' } };
      const oldKey = process.env.MINIMAX_API_KEY; if (process.platform !== 'darwin') process.env.MINIMAX_API_KEY = 'test';
      try {
        const prepared = prepareRun(store, record, req, 'run-b3');
        expect(prepared.input).toMatchObject({ brief, episodeDir: path.join(root, 'runs/run-b3/episode') });
        expect(readFileSync(path.join(root, 'runs/run-b3/inputs/reference/frames-spec/01.py'), 'utf8')).toBe('SPEC = {}');
        expect(prepared.deployment).toMatchObject({ template: { sha256: expect.any(String) }, reference: { sha256: expect.any(String) } });
      } finally { if (oldKey === undefined) delete process.env.MINIMAX_API_KEY; else process.env.MINIMAX_API_KEY = oldKey; }
      expect(() => prepareRun({ stateRoot: root, getAcceptedBrief: () => undefined }, record, req, 'run-missing')).toThrow(/accepted content brief/);
    } finally {
      if (priorTemplate === undefined) delete process.env.CREATION_B3_TEMPLATE_DIR; else process.env.CREATION_B3_TEMPLATE_DIR = priorTemplate;
      if (priorReference === undefined) delete process.env.CREATION_B3_REFERENCE_DIR; else process.env.CREATION_B3_REFERENCE_DIR = priorReference;
    }
  });
});
