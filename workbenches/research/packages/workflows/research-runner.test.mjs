import test from 'node:test';
import assert from 'node:assert/strict';
import { researchTools, readPublicResponse } from './research-runner.mjs';

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

test('public transport pins validated IPv4 addresses without a second DNS lookup or IPv6 fallback', async () => {
  let resolutions = 0, options, destroyed = 0;
  const dispatcher = { destroy: async () => { destroyed++; } };
  const result = await readPublicResponse(new URL('https://source.example/article'), new AbortController().signal, {
    resolve: async (host, opts) => {
      assert.equal(host, 'source.example'); assert.equal(opts.family, 4);
      resolutions++;
      // Rebinding would yield a local address on a second resolution.
      return [{ address: resolutions === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }];
    },
    createDispatcher: opts => { options = opts; return dispatcher; },
    fetchPage: async (url, init) => {
      assert.equal(url.hostname, 'source.example'); assert.equal(init.dispatcher, dispatcher);
      assert.equal(init.redirect, 'manual'); assert.equal(options.autoSelectFamily, false);
      assert.equal(options.connect.family, 4);
      for (const all of [false, true]) {
        const pinned = await new Promise((resolve, reject) => options.connect.lookup('source.example', { all }, (err, address, family) => err ? reject(err) : resolve({ address, family })));
        assert.deepEqual(pinned, all ? { address: [{ address: '93.184.216.34', family: 4 }], family: undefined } : { address: '93.184.216.34', family: 4 });
      }
      await assert.rejects(new Promise((resolve, reject) => options.connect.lookup('other.example', {}, err => err ? reject(err) : resolve())), /Unbound/);
      return new Response('public page', { headers: { 'content-type': 'text/html' } });
    },
  });
  assert.equal(result.body, 'public page'); assert.equal(resolutions, 1); assert.equal(destroyed, 1);
});

test('public transport rejects private or unvalidated DNS answers and literal IPv6 URLs before connecting', async () => {
  let connections = 0;
  for (const records of [
    [{ address: '127.0.0.1', family: 4 }],
    [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }],
    [{ address: '93.184.216.34', family: 4 }, { address: '::1', family: 6 }],
    [{ address: '::ffff:7f00:1', family: 6 }],
  ]) await assert.rejects(readPublicResponse(new URL('https://source.example/'), new AbortController().signal, {
    resolve: async () => records, createDispatcher: () => { connections++; },
  }), /public addresses/);
  await assert.rejects(readPublicResponse(new URL('https://[::1]/'), new AbortController().signal, {
    resolve: async () => { throw new Error('DNS must not run'); },
  }), /public HTTPS/);
  assert.equal(connections, 0);
});

test('public transport cancels redirect bodies and destroys dispatchers on size or content-type rejection', async () => {
  let destroyed = 0, canceled = 0;
  const signal = new AbortController().signal;
  const deps = { resolve: async () => [{ address: '93.184.216.34', family: 4 }],
    createDispatcher: () => ({ destroy: async () => { destroyed++; } }) };
  const response = await readPublicResponse(new URL('https://source.example/'), signal, { ...deps,
    fetchPage: async () => new Response(new ReadableStream({ cancel() { canceled++; } }), { status: 302, headers: { location: 'https://other.example/' } }),
  });
  assert.equal(response.status, 302); assert.equal(canceled, 1);
  await assert.rejects(readPublicResponse(new URL('https://source.example/'), signal, { ...deps, limit: 4,
    fetchPage: async () => new Response('too long', { headers: { 'content-type': 'text/plain' } }),
  }), /read limit/);
  await assert.rejects(readPublicResponse(new URL('https://source.example/'), signal, { ...deps,
    fetchPage: async () => new Response('binary', { headers: { 'content-type': 'application/octet-stream' } }),
  }), /HTML or plain text/);
  assert.equal(destroyed, 3);
});
