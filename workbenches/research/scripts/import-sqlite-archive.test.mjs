import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';
import { artifactPayloadSha256 } from '@signal-room/workflow';
import { PostgresWorkflowRunStore } from '@signal-room/workflow-postgres';
import { createResearchService } from '../packages/storage/research-service.mjs';

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const importer = fileURLToPath(new URL('./import-sqlite-archive.mjs', import.meta.url));
const digest = path => createHash('sha256').update(JSON.stringify({
  mainSha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
  walSha256: (() => {
    try { return createHash('sha256').update(readFileSync(`${path}-wal`)).digest('hex'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  })(),
})).digest('hex');

test('explicit SQLite archive importer reads the source without changing it and preserves table rows', { skip: !databaseUrl }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'research-sqlite-import-'));
  const path = join(directory, 'legacy.sqlite');
  const source = new DatabaseSync(path);
  source.exec('PRAGMA journal_mode=WAL');
  source.exec('BEGIN IMMEDIATE');
  source.exec('CREATE TABLE history(id INTEGER PRIMARY KEY, note TEXT, binary_data BLOB)');
  source.prepare('INSERT INTO history VALUES(?,?,?)').run(1, 'keep this run', Buffer.from([0, 1, 255]));
  const runId = 'legacy-run-1', stepId = 'legacy-step-1', attemptId = 'legacy-attempt-1', artifactId = 'legacy-artifact-1';
  const payload = { title: 'Historical report', document: '# Preserved report' };
  const sha256 = await artifactPayloadSha256(payload);
  const input = { workspaceId: 'token-economics', topicId: 'historic-topic', title: 'Historic study', goal: 'Preserve this historic study',
    readers: ['researcher'], asOf: '2026-09-01', sources: [{ id: 'source-1', title: 'Source', content: 'source text',
      sha256: createHash('sha256').update('source text').digest('hex') }] };
  source.exec(`CREATE TABLE workflow_runs(id TEXT, document TEXT);
    CREATE TABLE workflow_steps(id TEXT, run_id TEXT, document TEXT);
    CREATE TABLE workflow_attempts(id TEXT, step_run_id TEXT, document TEXT);
    CREATE TABLE workflow_events(id TEXT, run_id TEXT, seq INTEGER, document TEXT);
    CREATE TABLE workflow_artifacts(id TEXT, run_id TEXT, document TEXT, payload TEXT);
    CREATE TABLE host_runs(run_id TEXT, root_id TEXT, workspace_id TEXT, topic_id TEXT, input_json TEXT, input_hash TEXT,
      agents_json TEXT, model TEXT, effort TEXT, revision TEXT, method_hash TEXT, deadline_at INTEGER, queue_state TEXT,
      created_at TEXT, lease_owner TEXT, lease_until INTEGER, cancel_requested INTEGER);`);
  const put = (table, values) => source.prepare(`INSERT INTO ${table} VALUES(${values.map(() => '?').join(',')})`).run(...values);
  const runDoc = { id: runId, workflowId: 'historic-research', workflowRevision: 'old-revision', inputFingerprint: 'old-input', state: 'succeeded', metadata: {} };
  const stepDoc = { id: stepId, runId, workflowId: 'historic-research', workflowRevision: 'old-revision', key: 'report', kind: 'workflow',
    inputFingerprint: 'old-input', configFingerprint: 'old-config', state: 'succeeded', validation: 'valid' };
  const attemptDoc = { id: attemptId, runId, stepRunId: stepId, state: 'succeeded' };
  const eventDoc = { id: 'legacy-event-1', runId, seq: 1, type: 'workflow.started', timestamp: '2026-09-01T00:00:00.000Z' };
  const artifactDoc = { id: artifactId, type: 'research-report', schemaVersion: '1', revision: 'old-artifact-revision', sha256,
    uri: 'workflow-artifact://legacy-run-1', producedBy: { workflowRunId: runId, stepRunId: stepId, attemptId },
    dependsOn: [], validation: 'valid', review: 'pending' };
  put('workflow_runs', [runId, JSON.stringify(runDoc)]);
  put('workflow_steps', [stepId, runId, JSON.stringify(stepDoc)]);
  put('workflow_attempts', [attemptId, stepId, JSON.stringify(attemptDoc)]);
  put('workflow_events', [eventDoc.id, runId, eventDoc.seq, JSON.stringify(eventDoc)]);
  put('workflow_artifacts', [artifactId, runId, JSON.stringify(artifactDoc), JSON.stringify(payload)]);
  const inputJson = JSON.stringify(input);
  put('host_runs', [runId, runId, 'token-economics', input.topicId, inputJson,
    createHash('sha256').update(inputJson).digest('hex'), '{}', 'gpt-5.6-luna', 'medium', 'old-revision', 'old-method',
    Date.now(), 'done', '2026-09-01T00:00:00.000Z', null, null, 0]);
  // Leave committed rows in the WAL while the read-only importer runs.
  source.exec('COMMIT');
  const walPath = `${path}-wal`;
  assert.equal(readFileSync(walPath).length > 0, true);
  const sourceHash = await digest(path);
  const pool = new Pool({ connectionString: databaseUrl, application_name: 'research-archive-import-test' });
  const importedSha = sourceHash;
  t.after(async () => {
    await pool.query('DELETE FROM research_host_assets WHERE workspace_id=$1 AND artifact_id=$2', ['creator-lab-research', artifactId]).catch(() => {});
    await pool.query('DELETE FROM aw_artifact_dependencies WHERE workspace_id=$1 AND (artifact_id=$2 OR dependency_id=$2)', ['creator-lab-research', artifactId]).catch(() => {});
    await pool.query('DELETE FROM aw_artifacts WHERE workspace_id=$1 AND id=$2', ['creator-lab-research', artifactId]).catch(() => {});
    await pool.query('DELETE FROM aw_events WHERE workspace_id=$1 AND run_id=$2', ['creator-lab-research', runId]).catch(() => {});
    await pool.query('DELETE FROM aw_attempts WHERE workspace_id=$1 AND run_id=$2', ['creator-lab-research', runId]).catch(() => {});
    await pool.query('DELETE FROM aw_steps WHERE workspace_id=$1 AND run_id=$2', ['creator-lab-research', runId]).catch(() => {});
    await pool.query('DELETE FROM aw_runs WHERE workspace_id=$1 AND id=$2', ['creator-lab-research', runId]).catch(() => {});
    await pool.query('DELETE FROM research_host_runs WHERE workspace_id=$1 AND run_id=$2', ['creator-lab-research', runId]).catch(() => {});
    await pool.query('DELETE FROM research_legacy_imports WHERE source_sha256=$1', [importedSha]).catch(() => {});
    await pool.end();
    source.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const result = spawnSync(process.execPath, [importer, path], { encoding: 'utf8', env: { ...process.env, WORKFLOW_DATABASE_URL: databaseUrl } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(await digest(path), sourceHash);
  const archived = await pool.query('SELECT row_json FROM research_legacy_rows WHERE source_sha256=$1 AND table_name=$2 ORDER BY row_number', [sourceHash, 'history']);
  assert.equal(archived.rows.length, 1);
  assert.equal(archived.rows[0].row_json.note, 'keep this run');
  assert.deepEqual(archived.rows[0].row_json.binary_data, { $sqliteBlobBase64: 'AAH/' });
  const store = new PostgresWorkflowRunStore(pool, { workspaceId: 'creator-lab-research' });
  assert.equal((await store.getRun(runId)).state, 'succeeded');
  assert.equal((await store.listSteps(runId)).length, 1);
  assert.equal((await store.listEvents(runId)).length, 1);
  assert.deepEqual(await store.getArtifactPayload(artifactId), payload);
  const host = await pool.query('SELECT read_only, model FROM research_host_runs WHERE workspace_id=$1 AND run_id=$2', ['creator-lab-research', runId]);
  assert.deepEqual(host.rows[0], { read_only: true, model: 'gpt-5.6-luna' });
  const projected = await pool.query('SELECT run_count,step_count,attempt_count,event_count,artifact_count FROM research_legacy_projections WHERE source_sha256=$1', [sourceHash]);
  assert.deepEqual(projected.rows[0], { run_count: 1, step_count: 1, attempt_count: 1, event_count: 1, artifact_count: 1 });
  const service = await createResearchService({ databaseUrl, workspaceId: 'creator-lab-research',
    projectRoot: fileURLToPath(new URL('..', import.meta.url)), directory: join(directory, 'state'), artifactRoot: join(directory, 'artifacts') });
  t.after(() => service.close());
  const history = await service.getRun(runId);
  assert.equal(history.readOnly, true);
  assert.equal(history.model, 'gpt-5.6-luna');
  await assert.rejects(service.assertWritable(runId), /Historical research runs are read-only/);
  const snapshot = await service.snapshot(runId);
  assert.equal(snapshot.artifacts[0].identity.id, artifactId);
  const report = await service.artifact(runId, snapshot.artifacts[0].identity);
  assert.deepEqual(report.payload, payload);
});
