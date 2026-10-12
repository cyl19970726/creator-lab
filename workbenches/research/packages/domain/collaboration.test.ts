import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { collaborationRepository, migrateResearchCollaboration } from './collaboration.ts';

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
test('collaboration events persist by exact artifact version and reject idempotency conflicts', { skip: !databaseUrl }, async t => {
  const pool = new Pool({ connectionString: databaseUrl, application_name: 'research-collaboration-test' });
  const workspaceId = `research-collab-test-${randomUUID()}`;
  await migrateResearchCollaboration(pool);
  const a = collaborationRepository(pool, workspaceId);
  const b = collaborationRepository(pool, workspaceId);
  const identity = { id: 'artifact', revision: 'r1', sha256: 'a'.repeat(64) };
  const fields = { type: 'feedback' as const, body: 'Explain', location: 'figure' };
  t.after(async () => {
    await pool.query('DELETE FROM research_collaboration_events WHERE workspace_id=$1', [workspaceId]);
    await pool.end();
  });
  const event = await a.append('run', identity, 'command-key', fields);
  assert.deepEqual(await b.append('run', identity, 'command-key', fields), event);
  await assert.rejects(() => b.append('run', identity, 'command-key', { ...fields, body: 'Different' }), /Idempotency/);
  assert.equal((await b.list('run', { ...identity, revision: 'r2' })).length, 0);
  assert.deepEqual(await b.list('run', identity), [event]);
});
