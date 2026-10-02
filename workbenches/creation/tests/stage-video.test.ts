import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test } from 'vitest';
import { MemoryRunStore, artifactPayloadSha256, runWorkflow, type AgentRunRequest, type AgentRunResult, type AgentRunner } from '@signal-room/workflow';
import { SQLiteWorkflowRunStore } from '@signal-room/workflow-sqlite';
import { createB3Workflow, renderEpisodeVideo, type B3Input } from '../src/stages/b3.js';
import { findRunVideo, saveRunVideo } from '../src/stages/video-artifacts.js';

const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'creation-video-test-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) execFileSync('rm', ['-rf', root]);
});

describe('B3 video identity', () => {
  test('a failed render cannot adopt a pre-existing MP4', () => {
    const episode = fixture();
    mkdirSync(path.join(episode, 'exports'));
    writeFileSync(path.join(episode, 'package.json'), '{"name":"current"}');
    writeFileSync(path.join(episode, 'exports/current.mp4'), 'old');
    writeFileSync(path.join(episode, 'exports/other.mp4'), 'other');
    expect(() => renderEpisodeVideo(episode, () => { throw new Error('render failed'); })).toThrow('render failed');
    expect(() => renderEpisodeVideo(episode, () => 'false success')).toThrow('did not produce a new video');
    expect(readFileSync(path.join(episode, 'exports/current.mp4'), 'utf8')).toBe('old');
  });

  test('a successful render binds only the template-named output and saves it per run', () => {
    const episode = fixture();
    const runDir = path.join(episode, 'run');
    mkdirSync(path.join(episode, 'exports'));
    mkdirSync(runDir);
    writeFileSync(path.join(episode, 'package.json'), '{"name":"current"}');
    writeFileSync(path.join(episode, 'exports/other.mp4'), 'unrelated');
    const rendered = renderEpisodeVideo(episode, () => {
      writeFileSync(path.join(episode, 'exports/current.mp4'), 'this run');
      return 'verified placeholder';
    });
    expect(rendered.output).toBe(path.join(episode, 'exports/current.mp4'));
    saveRunVideo(runDir, rendered.output, 'artifact-1');
    writeFileSync(rendered.output, 'later run');
    expect(findRunVideo(runDir, true)).toBe('video.mp4');
    expect(readFileSync(path.join(runDir, 'video.mp4'), 'utf8')).toBe('this run');
    expect(JSON.parse(readFileSync(path.join(runDir, 'video.json'), 'utf8'))).toMatchObject({ producerStepRunId: 'artifact-1', source: rendered.output });
  });

  test('historical run-scoped file is used only when an artifact exists and the choice is unique', () => {
    const runDir = fixture();
    writeFileSync(path.join(runDir, 'historical.mp4'), 'old run');
    expect(findRunVideo(runDir, true)).toBe('historical.mp4');
    expect(findRunVideo(runDir, false)).toBeUndefined();
    writeFileSync(path.join(runDir, 'other.mp4'), 'ambiguous');
    expect(findRunVideo(runDir, true)).toBeUndefined();
  });
});

function workflowFixture(failRender: boolean): { cwd: string; input: B3Input; oldVideo: string } {
  const cwd = fixture();
  const episode = path.join(cwd, 'episode');
  const reference = path.join(cwd, 'reference');
  for (const dir of [episode, reference]) mkdirSync(path.join(dir, 'frames-spec'), { recursive: true });
  for (const dir of ['scripts', 'exports', 'assets/voice-minimax', 'snapshots/review']) mkdirSync(path.join(episode, dir), { recursive: true });
  writeFileSync(path.join(episode, 'package.json'), '{"name":"episode"}');
  writeFileSync(path.join(reference, 'frames-spec/01.py'), 'SPEC = {}');
  writeFileSync(path.join(episode, 'frames-spec/01.py'), 'SPEC = {}');
  const oldVideo = path.join(episode, 'exports/episode.mp4');
  writeFileSync(oldVideo, 'previous run');
  writeFileSync(path.join(episode, 'scripts/tts-placeholder.sh'), '#!/bin/bash\nprintf \'{"lines":[{"index":1,"durationMs":1000,"text":"hello"}]}\' > assets/voice-minimax/manifest.json\n');
  writeFileSync(path.join(episode, 'scripts/build-frames.py'), 'print("ok")\n');
  writeFileSync(path.join(episode, 'scripts/make-index.mjs'), 'console.log("index")\n');
  writeFileSync(path.join(episode, 'scripts/retime-to-minimax.mjs'), 'console.log("retime")\n');
  writeFileSync(path.join(episode, 'scripts/hf-check.sh'), '#!/bin/bash\necho "→ GREEN"\n');
  writeFileSync(path.join(episode, 'scripts/snapshot-review.sh'), '#!/bin/bash\nmkdir -p snapshots/review\nprintf image > snapshots/review/contact-01.jpg\nprintf 1 > snapshots/settle.txt\n');
  writeFileSync(path.join(episode, 'scripts/render.sh'), failRender
    ? '#!/bin/bash\necho render-error >&2\nexit 9\n'
    : '#!/bin/bash\nprintf current-run > exports/episode.mp4\necho verified-placeholder\n');
  const input: B3Input = {
    topicId: 'fixture', episodeDir: episode, templateDir: cwd, referenceDir: reference,
    scope: 'sample', sampleSegments: 1, voice: 'placeholder', standards: 'V1', maxRevisions: 0,
    brief: {
      schemaVersion: 'brief-v1', topicId: 'fixture', version: 2,
      sources: [{ stage: 'b1', runId: 'b1', revision: 'b1-v7', acceptedAt: '2026-10-03', reviewer: 'human' }],
      creator: { opportunity: 'topic', form: 'video', account: { name: 'account', positioning: 'p', currentAudience: 'a', referencePieces: [] } },
      audienceQuestion: { questionInAudienceWords: 'q' }, decision: { coreQuestion: 'q', oneLineAnswer: 'a', hook: 'h', beats: [] },
      materials: [{ id: 'm1', title: 'source', text: 'fact' }], notesForB2: [], notesForB3: [],
      script: { title: 'script', coverText: 'cover', segments: [{ time: '0-1', voiceover: 'hello', onScreenText: 'hello', visual: 'visual' }] },
    },
  };
  return { cwd, input, oldVideo };
}

const model = { worker: { model: 'test', reasoningEffort: 'medium' as const }, judge: { model: 'test', reasoningEffort: 'high' as const } };
const agentRunner = {
  async run<Input, Output>(request: AgentRunRequest<Input>): Promise<AgentRunResult<Output>> {
    if (request.definition.id === 'b3-designer') return { output: { files: ['frames-spec/01.py'], buildCheckPassed: true, notes: '' } as Output };
    if (request.definition.id === 'b3-inspector') return { output: { imagesOpened: [path.join((request.input as { contactSheets: string[] }).contactSheets[0])], verdict: 'pass', criteria: [{ id: 'V1', result: 'ok', reason: 'ok' }], issues: [], summary: 'ok' } as Output };
    throw new Error(`Unexpected agent ${request.definition.id}`);
  },
} satisfies AgentRunner;

test('the B3 workflow publishes the run copy only after a successful render', async () => {
  const original = process.cwd();
  const { cwd, input, oldVideo } = workflowFixture(false);
  process.chdir(cwd);
  try {
    const store = new MemoryRunStore();
    const { run } = await runWorkflow({ workflow: createB3Workflow(input, model), input, store, agentRunner });
    expect(run.state).toBe('needs_review');
    const artifact = (await store.listArtifacts(run.id)).find(a => a.type === 'b3-video')!;
    const payload = store.artifacts.find(a => a.id === artifact.id)!.payload as { output: string; exports: string[] };
    expect(payload.output).toBe(path.join(realpathSync(cwd), '.local/stages/fixture/b3', run.id, 'video.mp4'));
    expect(payload.exports).toEqual([payload.output]);
    expect(readFileSync(payload.output, 'utf8')).toBe('current-run');
    expect(readFileSync(oldVideo, 'utf8')).toBe('current-run');
  } finally { process.chdir(original); }
});

test('the B3 workflow fails instead of publishing a pre-existing video after render fails', async () => {
  const original = process.cwd();
  const { cwd, input, oldVideo } = workflowFixture(true);
  process.chdir(cwd);
  try {
    const store = new MemoryRunStore();
    await expect(runWorkflow({ workflow: createB3Workflow(input, model), input, store, agentRunner })).rejects.toThrow();
    const [run] = await store.listRuns();
    expect(run.state).toBe('failed');
    expect((await store.listArtifacts(run.id)).some(a => a.type === 'b3-video')).toBe(false);
    expect(readFileSync(oldVideo, 'utf8')).toBe('previous run');
  } finally { process.chdir(original); }
});

test('stage and workbench pages link the same run-scoped video', async () => {
  const cwd = fixture();
  const topic = 'fixture';
  const root = path.join(cwd, '.local/stages', topic);
  mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(path.join(root, 'ledger.sqlite'));
  const store = new SQLiteWorkflowRunStore(db);
  const run = await store.createRun({ workflowId: 'creation.b3', workflowRevision: 'b3-v10', inputFingerprint: 'fixture', state: 'needs_review', metadata: { topicId: topic, stage: 'b3' } });
  const step = await store.createStep({ runId: run.id, key: 'video', kind: 'publish', workflowId: 'creation.b3', workflowRevision: 'b3-v10', inputFingerprint: 'fixture', configFingerprint: 'fixture', state: 'succeeded', validation: 'valid' });
  const attempt = await store.createAttempt({ runId: run.id, stepRunId: step.id, state: 'succeeded' });
  const source = path.join(cwd, 'episode', 'exports', 'current.mp4');
  mkdirSync(path.dirname(source), { recursive: true });
  writeFileSync(source, 'current run');
  const payload = { output: source, log: 'verified' };
  const ref = await store.publishArtifact({ type: 'b3-video', schemaVersion: '1', revision: '1', sha256: await artifactPayloadSha256(payload), uri: 'artifact://video', payload,
    producedBy: { workflowRunId: run.id, stepRunId: step.id, attemptId: attempt.id }, dependsOn: [], validation: 'valid', review: 'pending' });
  const runDir = path.join(root, 'b3', run.id);
  mkdirSync(runDir, { recursive: true });
  saveRunVideo(runDir, source, ref.id);
  db.close();
  const creation = fileURLToPath(new URL('..', import.meta.url));
  const loader = path.join(creation, 'node_modules/tsx/dist/loader.mjs');
  execFileSync(process.execPath, ['--import', loader, path.join(creation, 'scripts/render-stage.ts'), topic, run.id], { cwd });
  const stageHtml = readFileSync(path.join(runDir, 'index.html'), 'utf8');
  expect(stageHtml).toContain('<video controls preload="metadata" src="video.mp4"');
  mkdirSync(path.join(cwd, 'docs/03-architecture'), { recursive: true });
  writeFileSync(path.join(cwd, 'docs/03-architecture/brief-and-handoff.md'), '# Fixture flow');
  execFileSync(process.execPath, ['--import', loader, path.join(creation, 'scripts/stage-workbench.ts'), topic], { cwd });
  const workbenchHtml = readFileSync(path.join(root, 'index.html'), 'utf8');
  expect(workbenchHtml).toContain(`src="b3/${run.id}/video.mp4"`);
});
