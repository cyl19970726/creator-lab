import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collaborationRepository } from './collaboration.ts';
test('collaboration preserves exact scope across reopen and rejects idempotency conflicts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'collab-')),
    path = join(dir, 'db.sqlite'),
    identity = { id: 'a', revision: 'r1', sha256: 'a'.repeat(64) };
  const a = collaborationRepository(path);
  const fields = { type: 'feedback' as const, body: 'Explain', location: 'figure' };
  const event = a.append('run', identity, 'key', fields);
  assert.deepEqual(a.append('run', identity, 'key', fields), event);
  assert.throws(
    () => a.append('run', identity, 'key', { ...fields, body: 'Different' }),
    /Idempotency/,
  );
  assert.equal(a.list('run', { ...identity, revision: 'r2' }).length, 0);
  a.close();
  const b = collaborationRepository(path);
  assert.equal(b.list('run', identity)[0].id, event.id);
  b.close();
  rmSync(dir, { recursive: true, force: true });
});
