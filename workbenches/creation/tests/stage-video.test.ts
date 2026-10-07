import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test } from 'vitest';
import { MemoryRunStore, artifactPayloadSha256, runWorkflow, type AgentRunRequest, type AgentRunResult, type AgentRunner } from '@signal-room/workflow';
import { SQLiteWorkflowRunStore } from '@signal-room/workflow-sqlite';
import { B3_ROLES, createB3Workflow, renderEpisodeVideo, type B3Input } from '../src/stages/b3.js';
import { findRunVideo, saveRunVideo, selectB3ReviewImages } from '../src/stages/video-artifacts.js';

const roots: string[] = [];
const originalPath = process.env.PATH;
const originalCoverYavg = process.env.MOCK_COVER_YAVG;
const originalVideoSpec = process.env.MOCK_VIDEO_SPEC;
const originalDuration = process.env.MOCK_DURATION;
const originalAudio = process.env.MOCK_AUDIO;
const renderScript = fileURLToPath(new URL('../tooling/render-episode.sh', import.meta.url));
const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'creation-video-test-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  process.env.PATH = originalPath;
  if (originalCoverYavg === undefined) delete process.env.MOCK_COVER_YAVG; else process.env.MOCK_COVER_YAVG = originalCoverYavg;
  if (originalVideoSpec === undefined) delete process.env.MOCK_VIDEO_SPEC; else process.env.MOCK_VIDEO_SPEC = originalVideoSpec;
  if (originalDuration === undefined) delete process.env.MOCK_DURATION; else process.env.MOCK_DURATION = originalDuration;
  if (originalAudio === undefined) delete process.env.MOCK_AUDIO; else process.env.MOCK_AUDIO = originalAudio;
  for (const root of roots.splice(0)) execFileSync('rm', ['-rf', root]);
});

function mockRenderTools(root: string, failRender = false): void {
  const bin = path.join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  const commands: Record<string, string> = {
    npx: `#!/bin/bash\nout="${'${@: -1}'}"\nif [[ "$*" == *" render "* ]]; then\n  ${failRender ? 'echo render-error >&2; exit 9' : 'printf current-run > "$out"'}\nelse\n  mkdir -p "$out"\n  printf first > "$out/frame-00.png"\n  printf cover > "$out/frame-01.png"\nfi\n`,
    ffprobe: '#!/bin/bash\ncase "$*" in *format=duration*) echo "${MOCK_DURATION:-11.44}";; *stream=width*) echo "${MOCK_VIDEO_SPEC:-1080,1920,30/1}";; *stream=codec_name*) if [ "${MOCK_AUDIO:-aac}" != missing ]; then echo "${MOCK_AUDIO:-aac}"; fi;; esac\n',
    ffmpeg: '#!/bin/bash\nif [[ "$*" == *frame-00.png* ]]; then echo YAVG=6; else echo YAVG=${MOCK_COVER_YAVG:-7}; fi\n',
  };
  for (const [name, source] of Object.entries(commands)) {
    const file = path.join(bin, name);
    writeFileSync(file, source);
    chmodSync(file, 0o755);
  }
  process.env.PATH = `${bin}:${originalPath}`;
}

function expectRenderFailure(episode: string, expected: string): void {
  try {
    execFileSync('bash', [renderScript, episode, '--cover-at', '2'], { encoding: 'utf8' });
    throw new Error('render unexpectedly succeeded');
  } catch (error) {
    const output = `${(error as { stdout?: string }).stdout ?? ''}\n${(error as { stderr?: string }).stderr ?? ''}`;
    expect(output).toContain(expected);
  }
}

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
    expect(JSON.parse(readFileSync(path.join(runDir, 'video.json'), 'utf8'))).toMatchObject({ producerStepRunId: 'artifact-1', source: rendered.output, bytes: 8, sha256: createHash('sha256').update('this run').digest('hex') });
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

describe('creation render contract', () => {
  test('a visible first frame does not invalidate a nonblack settled cover', () => {
    const { input } = workflowFixture(false);
    writeFileSync(path.join(input.episodeDir, 'assets/voice-minimax/manifest.json'), '{"placeholder":true}');
    const output = execFileSync('bash', [renderScript, input.episodeDir, '--cover-at', '2'], { encoding: 'utf8' });
    expect(output).toContain('cover bright-pixel fraction');
    expect(output).toContain('PLACEHOLDER VOICE');
    expect(existsSync(path.join(input.episodeDir, 'exports/episode.mp4'))).toBe(true);
    expect(existsSync(path.join(input.episodeDir, 'exports/episode.done'))).toBe(false);
  });

  test('a black settled cover, invalid video specs, and a failed renderer all fail verification', () => {
    const { input } = workflowFixture(false);
    process.env.MOCK_COVER_YAVG = '0';
    expectRenderFailure(input.episodeDir, 'FAIL cover bright-pixel fraction');
    expect(existsSync(path.join(input.episodeDir, 'exports/episode.done'))).toBe(false);
    process.env.MOCK_COVER_YAVG = '7';
    process.env.MOCK_VIDEO_SPEC = '720,1280,24/1';
    expectRenderFailure(input.episodeDir, 'FAIL 1080x1920@30');
    process.env.MOCK_VIDEO_SPEC = '1080,1920,30/1';
    mockRenderTools(path.dirname(input.episodeDir), true);
    expectRenderFailure(input.episodeDir, 'render-error');
    expect(existsSync(path.join(input.episodeDir, 'exports/episode.done'))).toBe(false);
  });

  test('duration, audio, and stale frame gates remain active', () => {
    const { input } = workflowFixture(false);
    process.env.MOCK_DURATION = '20';
    expectRenderFailure(input.episodeDir, 'FAIL duration');
    process.env.MOCK_DURATION = '11.44';
    process.env.MOCK_AUDIO = 'missing';
    expectRenderFailure(input.episodeDir, 'FAIL audio stream');
    process.env.MOCK_AUDIO = 'aac';
    const frame = path.join(input.episodeDir, 'compositions/frames/01-hook.html');
    writeFileSync(frame, '<div></div>');
    const future = new Date(Date.now() + 60_000);
    utimesSync(frame, future, future);
    expectRenderFailure(input.episodeDir, 'refuse: 1 frame(s) rebuilt');
    expect(existsSync(path.join(input.episodeDir, 'exports/episode.done'))).toBe(false);
  });
});

function workflowFixture(failRender: boolean): { cwd: string; input: B3Input; oldVideo: string } {
  const cwd = fixture();
  mockRenderTools(cwd, failRender);
  const episode = path.join(cwd, 'episode');
  const reference = path.join(cwd, 'reference');
  for (const dir of [episode, reference]) mkdirSync(path.join(dir, 'frames-spec'), { recursive: true });
  for (const dir of ['scripts', 'exports', 'assets/voice-minimax', 'snapshots/review', 'compositions/frames']) mkdirSync(path.join(episode, dir), { recursive: true });
  writeFileSync(path.join(episode, 'package.json'), '{"name":"episode"}');
  writeFileSync(path.join(episode, 'retime-report.json'), '{"total":11.44,"names":["01-hook"],"settle":[2]}');
  writeFileSync(path.join(episode, 'assets/voice-minimax/manifest.json'), '{"placeholder":true}');
  writeFileSync(path.join(reference, 'frames-spec/01.py'), 'SPEC = {}');
  writeFileSync(path.join(episode, 'frames-spec/01.py'), 'SPEC = {}');
  const oldVideo = path.join(episode, 'exports/episode.mp4');
  writeFileSync(oldVideo, 'previous run');
  writeFileSync(path.join(episode, 'scripts/tts-placeholder.sh'), '#!/bin/bash\nprintf \'{"placeholder":true,"lines":[{"index":1,"durationMs":1000,"text":"hello"}]}\' > assets/voice-minimax/manifest.json\n');
  writeFileSync(path.join(episode, 'scripts/build-frames.py'), 'print("ok")\n');
  writeFileSync(path.join(episode, 'scripts/make-index.mjs'), 'console.log("index")\n');
  writeFileSync(path.join(episode, 'scripts/retime-to-minimax.mjs'), 'console.log("retime")\n');
  writeFileSync(path.join(episode, 'scripts/hf-check.sh'), '#!/bin/bash\necho "→ GREEN"\n');
  writeFileSync(path.join(episode, 'scripts/snapshot-review.sh'), '#!/bin/bash\nmkdir -p snapshots/review\nprintf image > snapshots/review/contact-01.jpg\nprintf 1 > snapshots/settle.txt\n');
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

test('B3 accepts no frame-spec edits only when existing specs cover every rendered line', async () => {
  const original = process.cwd();
  const { cwd, input } = workflowFixture(false);
  const noFrameEdits: AgentRunner = {
    ...agentRunner,
    async run<Input, Output>(request: AgentRunRequest<Input>): Promise<AgentRunResult<Output>> {
      if (request.definition.id === 'b3-designer') return { output: { files: [], buildCheckPassed: true, notes: 'Only the shared composition changed' } as Output };
      return agentRunner.run(request);
    },
  };
  process.chdir(cwd);
  try {
    const store = new MemoryRunStore();
    const valid = await runWorkflow({ workflow: createB3Workflow(input, model), input, store, agentRunner: noFrameEdits });
    expect((await store.listArtifacts(valid.run.id)).some(a => a.type === 'b3-video')).toBe(true);
    rmSync(path.join(input.episodeDir, 'frames-spec/01.py'));
    const missing = await runWorkflow({ workflow: createB3Workflow(input, model), input, store, agentRunner: noFrameEdits });
    expect((await store.listArtifacts(missing.run.id)).some(a => a.type === 'b3-video')).toBe(false);
    expect(JSON.stringify(missing.run.output)).toContain('missing-frame-specs');
  } finally { process.chdir(original); }
});

test('B3 roles receive the current render scope, accepted-script boundary, and current creator review', async () => {
  const original = process.cwd();
  const { cwd, input } = workflowFixture(false);
  input.brief.script = { title: 'script', coverText: 'cover', segments: [
    { time: '0-1', voiceover: 'first', onScreenText: 'first', visual: 'first' },
    { time: '1-2', voiceover: 'second', onScreenText: 'second', visual: 'second' },
  ] };
  input.brief.creator.account.name = 'Token经济猫';
  input.brief.notesForB3 = [{ from: 'B2', note: '后续段落展开流程，本次先不展开' }];
  input.humanReview = { reviewer: 'main-agent-proxy', notes: [{ line: '01', fix: '修正账号文字' }] };
  input.maxRevisions = 1;
  const seen: Record<string, Array<Record<string, unknown>>> = { design: [], inspect: [] };
  const observingRunner: AgentRunner = {
    ...agentRunner,
    async run<Input, Output>(request: AgentRunRequest<Input>): Promise<AgentRunResult<Output>> {
      if (request.definition.id === 'b3-designer') seen.design.push(request.input as Record<string, unknown>);
      if (request.definition.id === 'b3-inspector') {
        seen.inspect.push(request.input as Record<string, unknown>);
        if (seen.inspect.length === 1) return { output: {
          imagesOpened: (request.input as { contactSheets: string[] }).contactSheets,
          verdict: 'revise', criteria: [{ id: 'V1', result: 'weak', reason: 'fixture' }],
          issues: [{ line: '01', standard: 'V1', problem: 'fixture', fix: '调整画面' }], summary: 'fixture',
        } as Output };
      }
      return agentRunner.run(request);
    },
  };
  process.chdir(cwd);
  try {
    const store = new MemoryRunStore();
    await runWorkflow({ workflow: createB3Workflow(input, model), input, store, agentRunner: observingRunner });
    expect(seen.design[0]).toMatchObject({ scope: 'sample', renderSegmentCount: 1, lines: [{ line: '01' }], humanReview: input.humanReview });
    expect(seen.design[1]).toMatchObject({ scope: 'sample', renderSegmentCount: 1, humanReview: input.humanReview, fixRequest: [{ fix: '调整画面' }] });
    expect(seen.inspect[0]).toMatchObject({ scope: 'sample', renderSegmentCount: 1, lines: [{ line: '01' }], account: { name: 'Token经济猫' }, humanReview: input.humanReview, notesForB3: input.brief.notesForB3 });
    writeFileSync(path.join(input.episodeDir, 'frames-spec/02.py'), 'SPEC = {}');
    const full = { ...input, scope: 'full' as const };
    await runWorkflow({ workflow: createB3Workflow(full, model), input: full, store, agentRunner: observingRunner });
    expect(seen.design[2]).toMatchObject({ scope: 'full', renderSegmentCount: 2, lines: [{ line: '01' }, { line: '02' }], humanReview: input.humanReview });
    expect(seen.inspect[2]).toMatchObject({ scope: 'full', renderSegmentCount: 2, lines: [{ line: '01' }, { line: '02' }] });
    expect(B3_ROLES.designer.prompt).toContain('样片的页脚总数按当前样片段数');
    expect(B3_ROLES.inspector.prompt).toContain('只要求 B3 修改画面');
    expect(B3_ROLES.inspector.prompt).toContain('真实冲突仍须指出');
  } finally { process.chdir(original); }
});

const imageHash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
const changingSnapshots = '#!/bin/bash\nmkdir -p snapshots/review\nn=$(cat snapshots/counter 2>/dev/null || echo 0)\nn=$((n+1))\nprintf %s "$n" > snapshots/counter\nprintf "image-%s" "$n" > snapshots/review/contact-01.jpg\nprintf 1 > snapshots/settle.txt\n';

test('B3 chooses a native contact sheet before a low-resolution review fallback', () => {
  const episode = fixture();
  mkdirSync(path.join(episode, 'snapshots/settle'), { recursive: true });
  mkdirSync(path.join(episode, 'snapshots/review'), { recursive: true });
  writeFileSync(path.join(episode, 'snapshots/settle/contact-sheet.jpg'), 'native');
  writeFileSync(path.join(episode, 'snapshots/review/contact-1.jpg'), 'fallback');
  expect(selectB3ReviewImages(episode)).toEqual([path.join(episode, 'snapshots/settle/contact-sheet.jpg')]);
});

test('B3 inspects full-resolution frames in numeric order when native and fallback sheets coexist', async () => {
  const original = process.cwd();
  const { cwd, input } = workflowFixture(false);
  writeFileSync(path.join(input.episodeDir, 'scripts/snapshot-review.sh'), '#!/bin/bash\nmkdir -p snapshots/review snapshots/settle\nn=$(cat snapshots/counter 2>/dev/null || echo 0)\nn=$((n+1))\nprintf %s "$n" > snapshots/counter\nfor i in 00 02 10; do printf "full-%s-run-%s" "$i" "$n" > "snapshots/settle/frame-${i}-at-1s.png"; done\nprintf native > snapshots/settle/contact-sheet.jpg\nprintf fallback > snapshots/review/contact-1.jpg\nprintf 1 > snapshots/settle.txt\n');
  const inspectingAll: AgentRunner = {
    ...agentRunner,
    async run<Input, Output>(request: AgentRunRequest<Input>): Promise<AgentRunResult<Output>> {
      if (request.definition.id !== 'b3-inspector') return agentRunner.run(request);
      return { output: { imagesOpened: (request.input as { contactSheets: string[] }).contactSheets, verdict: 'pass', criteria: [{ id: 'V1', result: 'ok', reason: 'ok' }], issues: [], summary: 'ok' } as Output };
    },
  };
  process.chdir(cwd);
  try {
    const store = new MemoryRunStore();
    const first = await runWorkflow({ workflow: createB3Workflow(input, model), input, store, agentRunner: inspectingAll });
    const firstSheets = (store.artifacts.find(a => a.type === 'b3-assembly' && a.producedBy.workflowRunId === first.run.id)!.payload as { sheets: string[] }).sheets;
    expect(firstSheets.map(s => path.basename(s).split('-at-')[0])).toEqual(['frame-00', 'frame-02', 'frame-10']);
    expect(firstSheets.every(s => s.endsWith('.png'))).toBe(true);
    const hashes = firstSheets.map(imageHash);
    expect(firstSheets.map(s => readFileSync(s, 'utf8'))).toEqual(['full-00-run-1', 'full-02-run-1', 'full-10-run-1']);
    const second = await runWorkflow({ workflow: createB3Workflow(input, model), input, store, agentRunner: inspectingAll });
    const secondSheets = (store.artifacts.find(a => a.type === 'b3-assembly' && a.producedBy.workflowRunId === second.run.id)!.payload as { sheets: string[] }).sheets;
    expect(firstSheets.map(imageHash)).toEqual(hashes);
    expect(secondSheets.map(s => readFileSync(s, 'utf8'))).toEqual(['full-00-run-2', 'full-02-run-2', 'full-10-run-2']);
    expect((first.run.output as { details: { contactSheets: string[] } }).details.contactSheets).toEqual(firstSheets);
  } finally { process.chdir(original); }
});

test('B3 rejects a snapshot step that produces no images', async () => {
  const original = process.cwd();
  const { cwd, input } = workflowFixture(false);
  writeFileSync(path.join(input.episodeDir, 'scripts/snapshot-review.sh'), '#!/bin/bash\nprintf 1 > snapshots/settle.txt\n');
  process.chdir(cwd);
  try {
    const store = new MemoryRunStore();
    await expect(runWorkflow({ workflow: createB3Workflow(input, model), input, store, agentRunner })).rejects.toThrow('no contact sheets');
  } finally { process.chdir(original); }
});

test('B3 contact sheets remain bound to each run sharing an episode', async () => {
  const original = process.cwd();
  const { cwd, input } = workflowFixture(false);
  writeFileSync(path.join(input.episodeDir, 'scripts/snapshot-review.sh'), changingSnapshots);
  process.chdir(cwd);
  try {
    const store = new MemoryRunStore();
    const first = await runWorkflow({ workflow: createB3Workflow(input, model), input, store, agentRunner });
    const firstAssembly = store.artifacts.find(a => a.type === 'b3-assembly')!.payload as { sheets: string[] };
    const firstSheet = firstAssembly.sheets[0];
    const firstHash = imageHash(firstSheet);
    const firstInspection = store.artifacts.find(a => a.type === 'b3-inspection' && a.producedBy.workflowRunId === first.run.id)!.payload as { imagesOpened: string[] };
    expect(firstInspection.imagesOpened).toEqual(firstAssembly.sheets);
    expect((first.run.output as { details: { contactSheets: string[] } }).details.contactSheets).toEqual(firstAssembly.sheets);
    const second = await runWorkflow({ workflow: createB3Workflow({ ...input, scope: 'full' }, model), input: { ...input, scope: 'full' }, store, agentRunner });
    const secondAssembly = store.artifacts.find(a => a.type === 'b3-assembly' && a.producedBy.workflowRunId === second.run.id)!.payload as { sheets: string[] };
    expect(first.run.id).not.toBe(second.run.id);
    expect(firstSheet).not.toBe(secondAssembly.sheets[0]);
    expect(imageHash(firstSheet)).toBe(firstHash);
    expect(imageHash(secondAssembly.sheets[0])).not.toBe(firstHash);
    expect((second.run.output as { details: { contactSheets: string[] } }).details.contactSheets).toEqual(secondAssembly.sheets);
  } finally { process.chdir(original); }
});

test('B3 contact sheets remain bound to each revision round', async () => {
  const original = process.cwd();
  const { cwd, input } = workflowFixture(false);
  writeFileSync(path.join(input.episodeDir, 'scripts/snapshot-review.sh'), changingSnapshots);
  process.chdir(cwd);
  try {
    let inspections = 0;
    const revisingRunner: AgentRunner = {
      ...agentRunner,
      async run<Input, Output>(request: AgentRunRequest<Input>): Promise<AgentRunResult<Output>> {
        if (request.definition.id !== 'b3-inspector') return agentRunner.run(request);
        inspections++;
        return { output: {
          imagesOpened: (request.input as { contactSheets: string[] }).contactSheets,
          verdict: inspections === 1 ? 'revise' : 'pass',
          criteria: [{ id: 'V1', result: inspections === 1 ? 'weak' : 'ok', reason: 'fixture' }],
          issues: inspections === 1 ? [{ line: '01', standard: 'V1', problem: 'fixture', fix: 'fixture' }] : [],
          summary: 'fixture',
        } as Output };
      },
    };
    const store = new MemoryRunStore();
    const { run } = await runWorkflow({ workflow: createB3Workflow({ ...input, maxRevisions: 1 }, model), input: { ...input, maxRevisions: 1 }, store, agentRunner: revisingRunner });
    const assemblies = store.artifacts.filter(a => a.type === 'b3-assembly' && a.producedBy.workflowRunId === run.id).map(a => a.payload as { sheets: string[] });
    expect(assemblies).toHaveLength(2);
    expect(assemblies[0].sheets[0]).not.toBe(assemblies[1].sheets[0]);
    expect(imageHash(assemblies[0].sheets[0])).toBe(createHash('sha256').update('image-1').digest('hex'));
    expect(imageHash(assemblies[1].sheets[0])).toBe(createHash('sha256').update('image-2').digest('hex'));
  } finally { process.chdir(original); }
});

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

test('stage and workbench pages link the run video and name the recorded reviewer', async () => {
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
  writeFileSync(path.join(root, 'decisions.json'), JSON.stringify({ title: 'fixture', current: { b3: run.id }, runs: { [run.id]: { purpose: 'fixture', review: { reviewer: 'main-agent-proxy', verdict: 'accept', notes: ['fixture'], at: '2026-10-03' } } } }));
  db.close();
  const creation = fileURLToPath(new URL('..', import.meta.url));
  const loader = path.join(creation, 'node_modules/tsx/dist/loader.mjs');
  execFileSync(process.execPath, ['--import', loader, path.join(creation, 'scripts/render-stage.ts'), topic, run.id], { cwd });
  let stageHtml = readFileSync(path.join(runDir, 'index.html'), 'utf8');
  expect(stageHtml).toContain('<video controls preload="metadata" src="video.mp4"');
  expect(stageHtml).toContain('<section><h2>视频</h2>');
  expect(stageHtml).toContain('审阅记录 · main-agent-proxy');
  expect(stageHtml).toContain('审阅通过 · main-agent-proxy');
  mkdirSync(path.join(cwd, 'docs/03-architecture'), { recursive: true });
  writeFileSync(path.join(cwd, 'docs/03-architecture/brief-and-handoff.md'), '# Fixture flow');
  execFileSync(process.execPath, ['--import', loader, path.join(creation, 'scripts/stage-workbench.ts'), topic], { cwd });
  let workbenchHtml = readFileSync(path.join(root, 'index.html'), 'utf8');
  expect(workbenchHtml).toContain(`src="b3/${run.id}/video.mp4"`);
  expect(workbenchHtml).toContain('<div class="asset asset-video"><p class="sub">视频</p>');
  expect(workbenchHtml).toContain('审阅记录 · main-agent-proxy');

  for (const [scope, label] of [['sample', '样片'], ['full', '全片']] as const) {
    const writableDb = new DatabaseSync(path.join(root, 'ledger.sqlite'));
    await new SQLiteWorkflowRunStore(writableDb).updateRun(run.id, { output: { details: { scope, voice: 'placeholder' } } });
    writableDb.close();
    execFileSync(process.execPath, ['--import', loader, path.join(creation, 'scripts/render-stage.ts'), topic, run.id], { cwd });
    execFileSync(process.execPath, ['--import', loader, path.join(creation, 'scripts/stage-workbench.ts'), topic], { cwd });
    stageHtml = readFileSync(path.join(runDir, 'index.html'), 'utf8');
    workbenchHtml = readFileSync(path.join(root, 'index.html'), 'utf8');
    expect(stageHtml).toContain(`<section><h2>${label}</h2>`);
    expect(workbenchHtml).toContain(`<div class="asset asset-video"><p class="sub">${label}</p>`);
    expect(workbenchHtml).toContain('占位配音（macOS 语音），正式配音待定');
  }
});

test('content pages show the complete draft and question coverage while keeping legacy B1 in history', async () => {
  const cwd = fixture();
  const topic = 'fixture';
  const root = path.join(cwd, '.local/stages', topic);
  mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(path.join(root, 'ledger.sqlite'));
  const store = new SQLiteWorkflowRunStore(db);
  const old = await store.createRun({ workflowId: 'creation.b1', workflowRevision: 'b1-v7', inputFingerprint: 'old', state: 'needs_review', metadata: { topicId: topic, stage: 'b1' } });
  const legacy = await store.createRun({ workflowId: 'creation.b1', workflowRevision: 'b1-v7', inputFingerprint: 'legacy', state: 'needs_review', metadata: { topicId: topic } });
  const run = await store.createRun({ workflowId: 'creation.content', workflowRevision: 'content-v1', inputFingerprint: 'new', state: 'needs_review', metadata: { topicId: topic, stage: 'content' } });
  await store.updateRun(run.id, { output: { details: { stage: 'CONTENT', reason: 'awaiting-human-review', rounds: 1 } } });
  const step = await store.createStep({ runId: run.id, key: 'publish', kind: 'publish', workflowId: run.workflowId, workflowRevision: run.workflowRevision, inputFingerprint: 'new', configFingerprint: 'new', state: 'succeeded', validation: 'valid' });
  const attempt = await store.createAttempt({ runId: run.id, stepRunId: step.id, state: 'succeeded' });
  const publish = async (type: string, payload: object) => store.publishArtifact({ type, schemaVersion: '1', revision: '1', sha256: await artifactPayloadSha256(payload), uri: `artifact://${type}`, payload,
    producedBy: { workflowRunId: run.id, stepRunId: step.id, attemptId: attempt.id }, dependsOn: [], validation: 'valid', review: 'pending' });
  await publish('content-draft', { decision: { workingTitle: '怎样训练', coreQuestion: '机制是什么？', oneLineAnswer: '通过反馈迭代', hook: '训练现场', beats: [] },
    script: { title: '训练全过程', coverText: '训练', estimatedSeconds: 40, segments: [
      { time: '0–5', voiceover: '第一段完整口播', onScreenText: '第一段', visual: '画面一' },
      { time: '5–10', voiceover: '第二段完整口播', onScreenText: '第二段', visual: '画面二' },
    ] }, markdown: '# 完整稿' });
  await publish('content-review', { verdict: 'pass', route: 'pass', summary: '内容可交制作', criteria: [{ id: 'C1', result: 'ok', reason: '完整' }],
    questionCoverage: [{ question: '机制是什么？', answerInDraft: '反馈迭代', missing: '', result: 'ok' }] });
  const contentDir = path.join(root, 'content', run.id);
  mkdirSync(contentDir, { recursive: true });
  writeFileSync(path.join(contentDir, 'input.json'), JSON.stringify({ opportunity: '公开训练', account: { name: '测试账号', positioning: '科技' }, form: '视频', readerGoal: '看懂机制', requiredQuestions: ['机制是什么？'], materials: [] }));
  writeFileSync(path.join(root, 'decisions.json'), JSON.stringify({ current: { b1: old.id, content: run.id }, runs: { [old.id]: { purpose: '历史', review: { reviewer: 'proxy', verdict: 'accept', notes: [], at: '2026-10-03' } }, [run.id]: { purpose: '生产', review: { reviewer: 'proxy', verdict: 'accept', notes: [], at: '2026-10-03' } } } }));
  db.close();
  const creation = fileURLToPath(new URL('..', import.meta.url));
  const loader = path.join(creation, 'node_modules/tsx/dist/loader.mjs');
  execFileSync(process.execPath, ['--import', loader, path.join(creation, 'scripts/render-stage.ts'), topic, run.id], { cwd });
  const stageHtml = readFileSync(path.join(contentDir, 'index.html'), 'utf8');
  for (const expected of ['<title>CONTENT · 训练全过程</title>', '内容决定与完整稿', '第一段完整口播', '第二段完整口播', '必答问题覆盖', '机制是什么？', '反馈迭代', '内容可交制作', '程序终态']) expect(stageHtml).toContain(expected);
  mkdirSync(path.join(cwd, 'docs/03-architecture'), { recursive: true });
  writeFileSync(path.join(cwd, 'docs/03-architecture/brief-and-handoff.md'), '# Fixture flow');
  execFileSync(process.execPath, ['--import', loader, path.join(creation, 'scripts/stage-workbench.ts'), topic], { cwd });
  const workbenchHtml = readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const expected of ['<title>作品工作台 · 训练全过程</title>', 'id="content"', 'id="b3"', '训练全过程', '第一段完整口播', '第二段完整口播', '机制是什么？：反馈迭代 <span class="pill good">通过</span>', '内容可交制作']) expect(workbenchHtml).toContain(expected);
  expect(workbenchHtml).not.toContain('id="b1"');
  expect(workbenchHtml).toContain(`href="b1/${old.id}/index.html"`);
  expect(workbenchHtml.match(/<span class="tag">当前采用<\/span>/g)).toHaveLength(1); // Historical B1 is not adopted as the new flow.

  const writableDb = new DatabaseSync(path.join(root, 'ledger.sqlite'));
  await new SQLiteWorkflowRunStore(writableDb).updateRun(run.id, { output: { details: { stage: 'CONTENT', reason: 'not-converged', rounds: 1, guardFailures: ['必答问题未覆盖'] } } });
  writableDb.close();
  execFileSync(process.execPath, ['--import', loader, path.join(creation, 'scripts/render-stage.ts'), topic, legacy.id], { cwd });
  const legacyHtml = readFileSync(path.join(root, 'b1', legacy.id, 'index.html'), 'utf8');
  expect(legacyHtml).toContain('<title>B1 · fixture</title>');
  expect(legacyHtml).not.toContain('内容决定与完整稿');
  execFileSync(process.execPath, ['--import', loader, path.join(creation, 'scripts/render-stage.ts'), topic, run.id], { cwd });
  const guardedHtml = readFileSync(path.join(contentDir, 'index.html'), 'utf8');
  expect(guardedHtml).toContain('内部没审过，等你决定');
  expect(guardedHtml).toContain('必答问题未覆盖');
  expect(guardedHtml).toContain('内容可交制作'); // The model's opinion remains visible alongside the program refusal.
  execFileSync(process.execPath, ['--import', loader, path.join(creation, 'scripts/stage-workbench.ts'), topic], { cwd });
  const guardedWorkbench = readFileSync(path.join(root, 'index.html'), 'utf8');
  expect(guardedWorkbench).toContain('程序终态：not-converged');
  expect(guardedWorkbench).toContain('必答问题未覆盖');
});
