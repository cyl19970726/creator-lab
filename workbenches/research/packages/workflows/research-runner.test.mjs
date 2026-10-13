import test from 'node:test';
import assert from 'node:assert/strict';
import { researchTools } from './research-runner.mjs';

test('host tools can read only this attempt’s frozen source and reject local/file URLs', async () => {
  const tools = researchTools({ definition: { id: 'research-researcher' }, input: { sources: [{ id: 's1', title: 'Frozen', sha256: 'a'.repeat(64), content: 'untrusted source text' }] } });
  const read = tools.find(tool => tool.name === 'read_frozen_source');
  assert.deepEqual(await read.execute({ sourceId: 's1' }), { sourceId: 's1', title: 'Frozen', sha256: 'a'.repeat(64), content: 'untrusted source text' });
  await assert.rejects(() => read.execute({ sourceId: 'other' }), /not bound/);
  const open = tools.find(tool => tool.name === 'open_public_page');
  await assert.rejects(() => open.execute({ url: 'file:///etc/passwd' }, new AbortController().signal), /HTTPS/);
  await assert.rejects(() => open.execute({ url: 'https://127.0.0.1/' }, new AbortController().signal), /HTTPS/);
  assert.deepEqual(researchTools({ definition: { id: 'research-reader' }, input: { sources: [{ id: 's1', content: 'secret' }] } }), []);
  assert.deepEqual(researchTools({ definition: { id: 'research-synthesizer' }, input: { sources: [{ id: 's1', content: 'bound' }] } }).map(tool => tool.name), ['read_frozen_source']);
  assert.deepEqual(researchTools({ definition: { id: 'research-planner' }, input: { task: 'brief', sources: [] } }), []);
});
