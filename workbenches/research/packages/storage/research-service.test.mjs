import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createResearchService } from './research-service.mjs';
import { sourceHash } from '../workflows/contracts.mjs';

const databaseUrl = process.env.WORKBENCH_TEST_DATABASE_URL;
const model = 'gpt-6-luna';
const roles = Object.fromEntries(['planner', 'researcher', 'synthesizer', 'author', 'reader', 'fact']
  .map(id => [id, { id: `research-${id}`, revision: 'test', model, reasoningEffort: 'medium' }]));
const runner = { async run({ definition, input }) {
  const role = definition.id.replace('research-', '');
  if (role === 'planner' && input.task === 'plan') return { output: { title: 'Plan', document: 'Plan text', problems: [{ id: 'p1', question: 'How?' }] } };
  if (role === 'synthesizer') return { output: { title: 'Synthesis', document: 'Synthesis text', gaps: [], findingResponses: [] } };
  if (role === 'reader' || role === 'fact') return { output: { title: 'Review', document: 'Review text', target: input.target, decision: 'pass', findings: [] } };
  if (role === 'author' && /sample|report/.test(input.task)) return { output: { title: `Author ${input.task}`, document: 'Evidence and explanation.\n\n```mermaid\nflowchart LR\nA-->B\n```' } };
  return { output: { title: `${role} ${input.task}`, document: 'Evidence and explanation.' } };
} };

async function fixture(t) {
  const pool = new Pool({ connectionString: databaseUrl, application_name: 'research-workbench-test' });
  const workspaceId = `research-test-${randomUUID()}`;
  const directory = await mkdtemp(join(tmpdir(), 'research-pg-'));
  const services = [];
  const options = { pool, workspaceId, directory, artifactRoot: join(directory, 'out'), projectRoot: directory,
    runner, agentsFactory: async () => roles, revisionProvider: async () => 'r1' };
  const service = async overrides => { const value = await createResearchService({ ...options, ...overrides }); services.push(value); return value; };
  t.after(async () => {
    await Promise.all(services.map(value => value.close()));
    await pool.query('DELETE FROM research_collaboration_events WHERE workspace_id=$1', [workspaceId]);
    await pool.query('DELETE FROM research_host_assets WHERE workspace_id=$1', [workspaceId]);
    await pool.query('DELETE FROM research_host_commands WHERE workspace_id=$1', [workspaceId]);
    await pool.query('DELETE FROM research_host_runs WHERE workspace_id=$1', [workspaceId]);
    await pool.query('DELETE FROM research_worker_lease WHERE workspace_id=$1', [workspaceId]);
    await pool.query('DELETE FROM aw_step_commits WHERE workspace_id=$1', [workspaceId]);
    await pool.query('DELETE FROM aw_artifact_dependencies WHERE workspace_id=$1', [workspaceId]);
    await pool.query('DELETE FROM aw_events WHERE workspace_id=$1', [workspaceId]);
    await pool.query('DELETE FROM aw_artifacts WHERE workspace_id=$1', [workspaceId]);
    await pool.query('DELETE FROM aw_attempts WHERE workspace_id=$1', [workspaceId]);
    await pool.query('DELETE FROM aw_steps WHERE workspace_id=$1', [workspaceId]);
    await pool.query('DELETE FROM aw_runs WHERE workspace_id=$1', [workspaceId]);
    await pool.end();
    await rm(directory, { recursive: true, force: true });
  });
  return { pool, workspaceId, directory, service };
}

const input = () => { const content = 'Source text'; return { workspaceId: 'w1', topicId: 't1', title: 'Topic', goal: 'Explain topic', readers: ['newcomers'], asOf: '2026-09-22', sources: [{ id: 's1', title: 'Source', content, sha256: sourceHash(content) }] }; };

test('PostgreSQL keeps exact run, idempotency, history, assets and repair lineage across service handles', { skip: !databaseUrl }, async t => {
  const fx = await fixture(t); const api = await fx.service(), api2 = await fx.service(), worker = await fx.service();
  const initial = input();
  const [started, repeated] = await Promise.all([
    api.start(initial, { idempotencyKey: 'start-1' }), api2.start(initial, { idempotencyKey: 'start-1' }),
  ]);
  assert.equal(repeated.runId, started.runId);
  initial.sources[0].content = 'Changed source after submission';
  assert.equal((await api2.getRun(started.runId)).model, model);
  assert.deepEqual(await api.source(started.runId, 's1'), { title: 'Source', document: 'Source text' });
  assert.equal((await api.snapshot(started.runId)).runs[0].state, 'queued');
  assert.equal(await worker.workOnce(), true);
  const [snapshot, reopened] = await Promise.all([api.snapshot(started.runId), api2.snapshot(started.runId)]);
  assert.deepEqual(snapshot.artifacts.map(item => item.identity.id), reopened.artifacts.map(item => item.identity.id));
  assert.equal(snapshot.runs[0].state, 'needs_review');
  assert.ok(snapshot.calls.filter(call => call.role === 'agent').every(call => call.model === model && call.reasoningEffort === 'medium' && /^[a-f0-9]{64}$/.test(call.methodDigest)), JSON.stringify(snapshot.calls.filter(call => call.role === 'agent').slice(0, 2)));
  const report = snapshot.artifacts.find(item => item.type === 'research-report');
  assert.ok(report);
  assert.ok(snapshot.ui.assets[report.identity.id].fileHash);
  const storedAsset = (await fx.pool.query('SELECT path,file_hash FROM research_host_assets WHERE workspace_id=$1 AND artifact_id=$2', [fx.workspaceId, report.identity.id])).rows[0];
  assert.equal(sourceHash(await readFile(storedAsset.path, 'utf8')), storedAsset.file_hash);
  const repaired = await api.repair(started.runId, { identity: report.identity,
    feedback: [{ id: 'f1', body: 'Clarify the opening', location: 'Opening' }], route: 'expression', idempotencyKey: 'repair-1' });
  assert.equal((await api2.repair(started.runId, { identity: report.identity,
    feedback: [{ id: 'f1', body: 'Clarify the opening', location: 'Opening' }], route: 'expression', idempotencyKey: 'repair-1' })).runId, repaired.runId);
  assert.equal(await worker.workOnce(), true);
  const repairSnapshot = await api.snapshot(repaired.runId);
  assert.equal(repairSnapshot.runs[0].state, 'needs_review');
  assert.ok(repairSnapshot.artifacts.some(item => item.type === 'research-change'));
  assert.ok(repairSnapshot.artifacts.some(item => item.scope === 'external' && item.identity.id === report.identity.id));
});

test('PostgreSQL worker lease serializes claims and persisted cancellation reaches active SDK runner', { skip: !databaseUrl }, async t => {
  const fx = await fixture(t); const api = await fx.service(), first = await fx.service(), second = await fx.service();
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const blocking = await fx.service({ runner: { async run({ signal }) { entered(); await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true })); } } });
  const queued = await api.start(input(), { idempotencyKey: 'cancel-running' });
  const execution = blocking.workOnce();
  await started;
  assert.equal(await first.workOnce(), false);
  assert.equal(await second.workOnce(), false);
  await api.cancel(queued.runId);
  assert.equal(await execution, true);
  assert.equal((await api.snapshot(queued.runId)).runs[0].state, 'canceled');
});

test('PostgreSQL queued cancellation survives a new service handle', { skip: !databaseUrl }, async t => {
  const fx = await fixture(t); const api = await fx.service();
  const { runId } = await api.start(input(), { idempotencyKey: 'queued-cancel' });
  await api.cancel(runId);
  const reopened = await fx.service();
  assert.equal((await reopened.snapshot(runId)).runs[0].state, 'canceled');
  assert.equal(await reopened.workOnce(), false);
});
