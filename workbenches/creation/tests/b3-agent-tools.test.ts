import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { AgentRunRequest } from '@signal-room/workflow';
import { creationB3AgentTools } from '../src/stages/b3-agent-tools.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jgnsAAAAASUVORK5CYII=', 'base64');
function request(role: string, input: Record<string, unknown>): AgentRunRequest<unknown> {
  return { runId: 'run-1', stepRunId: 'step-1', attemptId: 'attempt-1', definition: { id: role } as AgentRunRequest<unknown>['definition'],
    input, signal: new AbortController().signal, emit: async () => undefined };
}

test('B3 designer gets only bounded shared workspace tools and can check its trusted frame build command', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'creation-b3-tools-')); roots.push(root);
  const episode = path.join(root, 'episode'), reference = path.join(root, 'reference');
  mkdirSync(path.join(episode, 'frames-spec'), { recursive: true }); mkdirSync(path.join(episode, 'scripts')); mkdirSync(reference);
  writeFileSync(path.join(episode, 'scripts', 'build-frames.py'), 'print("frame-check-ok")\n');
  const tools = await creationB3AgentTools(request('b3-designer', { episodeDir: episode, referenceDir: reference }));
  expect(tools.map(tool => tool.name).sort()).toEqual(['exec_allowed', 'list_directory', 'read_file', 'write_file']);
  const write = tools.find(tool => tool.name === 'write_file')!;
  await write.execute({ path: 'frames-spec/01-hook.py', content: 'SPEC = {}\n' }, new AbortController().signal);
  expect(readFileSync(path.join(episode, 'frames-spec', '01-hook.py'), 'utf8')).toBe('SPEC = {}\n');
  await expect(write.execute({ path: 'scripts/changed.py', content: 'print(1)' }, new AbortController().signal)).rejects.toThrow();
  const command = tools.find(tool => tool.name === 'exec_allowed')!;
  const checked = await command.execute({ name: 'check_frame_specs' }, new AbortController().signal);
  expect(JSON.stringify(checked)).toContain('frame-check-ok');
  await expect(command.execute({ name: 'check_frame_specs', args: ['--help'] }, new AbortController().signal)).rejects.toThrow(/Additional arguments/);
});

test('B3 inspector can inspect the exact round images as pixels and no other file', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'creation-b3-inspector-')); roots.push(root);
  const round = path.join(root, 'snapshots', 'round-1'); mkdirSync(round, { recursive: true });
  const image = path.join(round, 'contact-01.png'); writeFileSync(image, png);
  const tools = await creationB3AgentTools(request('b3-inspector', { contactSheets: [image] }));
  expect(tools.map(tool => tool.name)).toEqual(['read_image']);
  const opened = await tools[0]!.execute({ root: 'workspace', path: 'contact-01.png' }, new AbortController().signal);
  expect(opened).toMatchObject({ kind: 'siwc_visual_tool_result', images: [{ mimeType: 'image/png', base64: png.toString('base64') }] });
  await expect(tools[0]!.execute({ root: 'workspace', path: 'other.png' }, new AbortController().signal)).rejects.toThrow(/only this run and round/);
});
