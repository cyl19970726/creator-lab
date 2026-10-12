import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { archiveHistoricalSqliteState, restoreHistoricalSqliteArchive } from '../scripts/history-sqlite-archive.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'creation-sqlite-history-test-')); roots.push(root);
  const state = path.join(root, 'historical-state'), archive = path.join(root, 'archive'), restored = path.join(root, 'restored');
  mkdirSync(state);
  const db = new DatabaseSync(path.join(state, 'workbench.sqlite'));
  try {
    db.exec('CREATE TABLE wb_cases(id TEXT PRIMARY KEY, title TEXT NOT NULL); INSERT INTO wb_cases VALUES (\'case-1\', \'Article\');');
    db.exec('PRAGMA user_version = 1');
  } finally { db.close(); }
  mkdirSync(path.join(state, 'runs', 'one'), { recursive: true });
  writeFileSync(path.join(state, 'runs', 'one', 'input.json'), 'private evidence', { mode: 0o600 });
  writeFileSync(path.join(state, 'auth.json'), 'credential must not copy', { mode: 0o600 });
  return { root, state, archive, restored };
}

test('historical SQLite archive roundtrip preserves inert records and private evidence without opening for writes', async () => {
  const f = fixture();
  const manifest = await archiveHistoricalSqliteState(f.state, f.archive);
  expect(manifest.schema).toBe('workbench-state-v1');
  expect(manifest.files.some(file => file.path === 'workbench.sqlite')).toBe(true);
  expect(manifest.files.some(file => file.path === 'auth.json')).toBe(false);
  await restoreHistoricalSqliteArchive(f.archive, f.restored);
  expect(readFileSync(path.join(f.restored, 'runs', 'one', 'input.json'), 'utf8')).toBe('private evidence');
  const db = new DatabaseSync(path.join(f.restored, 'workbench.sqlite'), { readOnly: true });
  try { expect(db.prepare('SELECT title FROM wb_cases WHERE id = ?').get('case-1')).toEqual({ title: 'Article' }); }
  finally { db.close(); }
});

test('archive verifies hashes before restoring and never overwrites a nonempty target', async () => {
  const f = fixture(); await archiveHistoricalSqliteState(f.state, f.archive);
  writeFileSync(path.join(f.archive, 'runs', 'one', 'input.json'), 'tampered');
  await expect(restoreHistoricalSqliteArchive(f.archive, f.restored)).rejects.toThrow(/hash mismatch/);
  mkdirSync(f.restored); writeFileSync(path.join(f.restored, 'keep.txt'), 'keep');
  await expect(restoreHistoricalSqliteArchive(f.archive, f.restored)).rejects.toThrow();
  expect(readFileSync(path.join(f.restored, 'keep.txt'), 'utf8')).toBe('keep');
});

test('archive rejects nested destinations and symlinks; restore rejects destinations inside the archive', async () => {
  const f = fixture();
  await expect(archiveHistoricalSqliteState(f.state, path.join(f.state, 'nested'))).rejects.toThrow(/separate/);
  symlinkSync(path.join(f.root, 'outside'), path.join(f.state, 'runs', 'one', 'escape'));
  await expect(archiveHistoricalSqliteState(f.state, f.archive)).rejects.toThrow(/Symlink/);
  rmSync(path.join(f.state, 'runs', 'one', 'escape'));
  await archiveHistoricalSqliteState(f.state, f.archive);
  await expect(restoreHistoricalSqliteArchive(f.archive, path.join(f.archive, 'nested'))).rejects.toThrow(/separate/);
});
