import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.ts';
import { digest } from '../../packages/storage/content.ts';
const identity = { id: 'artifact-1', revision: 'r1', sha256: 'a'.repeat(64) };
test('API validates scope, immutable sources, exact-version comments and explicit decisions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workbench-api-'));
  mkdirSync(join(dir, 'content'));
  writeFileSync(join(dir, 'content/source.md'), 'evidence');
  writeFileSync(
    join(dir, 'content/manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      topics: [
        {
          id: 'topic',
          title: 'Topic',
          goal: 'Understand evidence',
          readers: ['readers'],
          sources: [
            {
              id: 's1',
              title: 'Source',
              sha256: digest('evidence'),
              path: 'source.md',
              provenance: 'test',
            },
          ],
        },
      ],
    }),
  );
  let startCount = 0;
  const repairs: any[] = [];
  const service = {
    list: async () => [],
    getRun: () => ({ id: 'run' }),
    start: async (input: any) => {
      assert.equal(input.sources[0].content, 'evidence');
      startCount++;
      return { runId: 'run' };
    },
    artifact: async (_id: string, target: any) => {
      assert.deepEqual(target, identity);
      return {
        ref: { type: 'research-report' },
        payload: { title: 'Report', document: '# Actual report' },
      };
    },
    repair: async (_id: string, input: any) => {
      repairs.push(input);
      return { runId: 'repair' };
    },
  };
  const app = await createApp(
    {
      projectRoot: dir,
      stateRoot: join(dir, 'state'),
      contentRoot: join(dir, 'content'),
      artifactRoot: join(dir, 'assets'),
      port: 4317,
      mediaRoot: undefined,
    },
    service,
  );
  try {
    let r = await app.inject({
      method: 'GET',
      url: '/api/topics',
      headers: { host: 'evil.example' },
    });
    assert.equal(r.statusCode, 403);
    r = await app.inject({
      method: 'POST',
      url: '/api/runs',
      headers: { origin: 'https://evil.example' },
      payload: {},
    });
    assert.equal(r.statusCode, 403);
    const start = {
      topicId: 'topic',
      title: 'Title',
      goal: 'Understand this evidence',
      asOf: '2026-09-22',
      sourceIds: ['s1'],
      idempotencyKey: 'start-001',
    };
    r = await app.inject({ method: 'GET', url: '/api/topics/topic/sources/s1' });
    assert.equal(r.statusCode, 200);
    assert.match(r.body, /evidence/);
    r = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { ...start, model: 'gpt-6-astra' },
    });
    assert.equal(r.statusCode, 400);
    r = await app.inject({ method: 'POST', url: '/api/runs', payload: start });
    assert.equal(r.statusCode, 202);
    assert.equal(startCount, 1);
    writeFileSync(join(dir, 'content/source.md'), 'tampered');
    r = await app.inject({ method: 'POST', url: '/api/runs', payload: start });
    assert.equal(r.statusCode, 409);
    assert.equal(startCount, 1);
    r = await app.inject({
      method: 'POST',
      url: '/api/runs/run/feedback',
      payload: {
        identity,
        body: 'Explain data movement',
        location: 'Diagram',
        idempotencyKey: 'feedback-001',
      },
    });
    assert.equal(r.statusCode, 200);
    const feedback = r.json();
    assert.equal(feedback.actor, 'user');
    r = await app.inject({
      method: 'POST',
      url: '/api/runs/run/repair',
      payload: {
        identity,
        feedbackIds: ['missing'],
        route: 'expression',
        idempotencyKey: 'repair-001',
      },
    });
    assert.equal(r.statusCode, 404);
    r = await app.inject({
      method: 'POST',
      url: '/api/runs/run/repair',
      payload: {
        identity,
        feedbackIds: [feedback.id],
        route: 'expression',
        idempotencyKey: 'repair-002',
      },
    });
    assert.equal(r.statusCode, 202);
    assert.equal(repairs[0].feedback[0].body, 'Explain data movement');
    r = await app.inject({
      method: 'GET',
      url: `/api/runs/run/collaboration?artifactId=${identity.id}&revision=r1&sha256=${identity.sha256}`,
    });
    assert.equal(
      r.json().events.some((e: any) => e.type === 'decision'),
      false,
    );
    r = await app.inject({
      method: 'POST',
      url: '/api/runs/run/decision',
      payload: {
        identity,
        verdict: 'accept',
        scope: 'partial',
        scopeLabel: 'Only diagram',
        idempotencyKey: 'decision-001',
      },
    });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().scope, 'partial');
    r = await app.inject({
      method: 'GET',
      url: `/api/runs/run/artifacts/${identity.id}?revision=r1&sha256=${identity.sha256}`,
    });
    assert.equal(r.statusCode, 200);
    assert.match(r.headers['content-security-policy'] as string, /sandbox/);
    assert.match(r.body, /Actual report/);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
