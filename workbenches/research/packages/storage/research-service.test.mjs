import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { createResearchService } from './research-service.mjs';
import { sourceHash } from '../workflows/contracts.mjs';

const agents = Object.fromEntries(['planner', 'researcher', 'synthesizer', 'author', 'reader', 'fact'].map(id => [id, { id, revision: 'test', model: 'gpt-5.6-luna', reasoningEffort: 'medium' }]));
const runner = { async run({ definition, input }) {
  const role = definition.id;
  if (role === 'planner' && input.task === 'plan') return { output: { title: 'Plan', document: 'Plan text', problems: [{ id: 'p1', question: 'How?' }] } };
  if (role === 'synthesizer') return { output: { title: 'Synthesis', document: 'Synthesis text', gaps: [], findingResponses: [] } };
  if (role === 'reader' || role === 'fact') return { output: { title: 'Review', document: 'Review text', target: input.target, decision: 'pass', findings: [] } };
  if (role === 'author' && /sample|report/.test(input.task)) return { output: { title: `Author ${input.task}`, document: 'Evidence and explanation.\n\n```mermaid\nflowchart LR\nA-->B\n```' } };
  return { output: { title: `${role} ${input.task}`, document: 'Evidence and explanation.' } };
} };
const options = directory => ({ directory, artifactRoot: join(directory, 'out'), projectRoot: directory, runner, agentsFactory: async () => agents, revisionProvider: async () => 'r1' });
const input = () => { const content = 'Source text'; return { workspaceId: 'w1', topicId: 't1', title: 'Topic', goal: 'Explain topic', readers: ['newcomers'], asOf: '2026-09-22', sources: [{ id: 's1', title: 'Source', content, sha256: sourceHash(content) }] }; };

 test('separate API and worker handles keep exact runs, idempotency, assets and repair lineage', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'research-host-'));
  const api = createResearchService(options(directory));
  const api2 = createResearchService(options(directory));
  const worker = createResearchService(options(directory));
  try {
    const initial = input();
    const [started, repeated] = await Promise.all([
      api.start(initial, { idempotencyKey: 'start-1' }),
      api2.start(initial, { idempotencyKey: 'start-1' }),
    ]);
    const { runId } = started;
    assert.equal(repeated.runId, runId);
    initial.sources[0].content = 'Changed source after submission';
    const frozenRun = api.getRun(runId);
    assert.equal(frozenRun.goal, 'Explain topic');
    assert.equal(frozenRun.asOf, '2026-09-22');
    assert.deepEqual(frozenRun.readers, ['newcomers']);
    assert.equal(frozenRun.model, 'gpt-5.6-luna');
    assert.deepEqual(frozenRun.sources, [{ id: 's1', title: 'Source', sha256: sourceHash('Source text') }]);
    assert.doesNotMatch(JSON.stringify(frozenRun), /Source text|Changed source after submission/);
    assert.deepEqual(api.source(runId, 's1'), { title: 'Source', document: 'Source text' });
    assert.throws(() => api.source(runId, 'unknown'), /not found/);
    await assert.rejects(() => api2.start({ ...input(), title: 'Different' }, { idempotencyKey: 'start-1' }), /different command/);
    assert.equal((await api.snapshot(runId)).runs[0].state, 'queued');
    assert.equal(await worker.workOnce(), true);
    const [view, parallelView] = await Promise.all([api.snapshot(runId), api2.snapshot(runId)]);
    assert.deepEqual(view.artifacts.map(item => item.identity.id), parallelView.artifacts.map(item => item.identity.id));
    assert.equal(view.runs[0].state, 'needs_review');
    const agentCalls = view.calls.filter(call => call.role === 'agent');
    assert.ok(agentCalls.length > 0);
    assert.ok(agentCalls.every(call => call.model === 'gpt-5.6-luna' && call.reasoningEffort === 'medium' && call.methodRevision === 'r1' && /^[a-f0-9]{64}$/.test(call.methodDigest)));
    await assert.rejects(() => api.resume(runId, { idempotencyKey: 'after-review' }), /cannot resume/);
    const report = view.artifacts.find(item => item.type === 'research-report');
    assert.ok(report);
    const reportStage = view.stages.find(item => item.artifactIds.includes(report.identity.id));
    assert.equal(view.ui.primaryByStage[reportStage.id], report.identity.id);
    assert.equal((await api.artifact(runId, report.identity)).ref.id, report.identity.id);
    assert.ok(view.ui.assets[report.identity.id].fileHash);
    assert.equal('legacyAssetId' in view.ui.assets[report.identity.id], false);
    const materializedDb = new DatabaseSync(join(directory, 'research.sqlite'));
    const materialized = materializedDb.prepare('SELECT path,file_hash FROM host_assets WHERE artifact_id=?').get(report.identity.id);
    materializedDb.close();
    assert.equal(sourceHash(readFileSync(materialized.path, 'utf8')), materialized.file_hash);
    assert.match(readFileSync(materialized.path, 'utf8'), /^# /);
    const repair = await api.repair(runId, { identity: report.identity, feedback: [{ id: 'f1', body: 'Clarify the opening', location: 'Opening' }], route: 'expression', idempotencyKey: 'repair-1' });
    assert.equal((await api2.repair(runId, { identity: report.identity, feedback: [{ id: 'f1', body: 'Clarify the opening', location: 'Opening' }], route: 'expression', idempotencyKey: 'repair-1' })).runId, repair.runId);
    assert.equal(await worker.workOnce(), true);
    const repaired = await api.snapshot(repair.runId);
    assert.equal(repaired.runs[0].state, 'needs_review');
    assert.ok(repaired.artifacts.some(item => item.type === 'research-change'));
    assert.ok(repaired.artifacts.some(item => item.scope === 'external' && item.identity.id === report.identity.id));
    const revisedReport = repaired.artifacts.filter(item => item.type === 'research-report' && item.scope !== 'external').at(-1);
    const secondRepair = await api2.repair(repair.runId, { identity: revisedReport.identity, feedback: [{ id: 'f2', body: 'Tighten the ending', location: 'Ending' }], route: 'expression', idempotencyKey: 'repair-2' });
    assert.equal(await worker.workOnce(), true);
    assert.equal((await api.snapshot(secondRepair.runId)).runs[0].state, 'needs_review');
  } finally { await Promise.all([api.close(), api2.close(), worker.close()]); rmSync(directory, { recursive: true, force: true }); }
});

test('renames the new-app asset key column without changing rows or files', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'research-schema-'));
  const path = join(directory, 'kept.md');
  writeFileSync(path, '# Kept\n');
  const db = new DatabaseSync(join(directory, 'research.sqlite'));
  db.exec('CREATE TABLE host_assets(artifact_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, legacy_id TEXT NOT NULL UNIQUE, path TEXT NOT NULL, file_hash TEXT NOT NULL, revision TEXT NOT NULL, payload_hash TEXT NOT NULL, title TEXT NOT NULL, workspace_id TEXT NOT NULL, topic_id TEXT NOT NULL)');
  db.prepare('INSERT INTO host_assets VALUES(?,?,?,?,?,?,?,?,?,?)').run('artifact', 'run', 'stable-key', path, sourceHash('# Kept\n'), 'rev', 'payload', 'Kept', 'w', 't');
  db.close();
  const service = createResearchService(options(directory));
  await service.close();
  const migrated = new DatabaseSync(join(directory, 'research.sqlite'));
  try {
    const columns = migrated.prepare('PRAGMA table_info(host_assets)').all().map(item => item.name);
    assert.ok(columns.includes('file_key'));
    assert.equal(columns.includes('legacy_id'), false);
    assert.deepEqual({ ...migrated.prepare('SELECT artifact_id,run_id,file_key,path,file_hash FROM host_assets').get() }, {
      artifact_id: 'artifact', run_id: 'run', file_key: 'stable-key', path, file_hash: sourceHash('# Kept\n'),
    });
    assert.equal(readFileSync(path, 'utf8'), '# Kept\n');
  } finally { migrated.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('dead owner becomes interrupted; explicit resume renews budget; queued cancel persists', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'research-restart-'));
  const api = createResearchService(options(directory));
  const worker = createResearchService(options(directory));
  try {
    const { runId } = await api.start(input(), { idempotencyKey: 'start' });
    const db = new DatabaseSync(join(directory, 'research.sqlite'));
    db.prepare("UPDATE host_runs SET queue_state='running',lease_owner='99999999:dead',lease_until=1 WHERE run_id=?").run(runId);
    db.close();
    assert.equal(await worker.workOnce(), false);
    assert.equal(api.getRun(runId).queueState, 'interrupted');
    await api.resume(runId, { idempotencyKey: 'resume', budgetMs: 120000 });
    assert.equal(await worker.workOnce(), true);
    assert.equal((await api.snapshot(runId)).runs[0].state, 'needs_review');
    const next = await api.start(input(), { idempotencyKey: 'next' });
    await api.cancel(next.runId);
    assert.equal((await api.snapshot(next.runId)).runs[0].state, 'canceled');
    assert.equal(await worker.workOnce(), false);
  } finally { await Promise.all([api.close(), worker.close()]); rmSync(directory, { recursive: true, force: true }); }
});

test('only one worker claims a running job and API cancellation reaches it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'research-cancel-'));
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const blockingRunner = { async run({ signal }) {
    began();
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }));
  } };
  const api = createResearchService(options(directory));
  const first = createResearchService({ ...options(directory), runner: blockingRunner });
  const second = createResearchService(options(directory));
  try {
    const { runId } = await api.start(input(), { idempotencyKey: 'start' });
    const execution = first.workOnce();
    await started;
    assert.equal(await second.workOnce(), false);
    await api.cancel(runId);
    assert.equal(await execution, true);
    assert.equal((await api.snapshot(runId)).runs[0].state, 'canceled');
  } finally { await Promise.all([api.close(), first.close(), second.close()]); rmSync(directory, { recursive: true, force: true }); }
});

test('expression repair rejects a synthesis dependency from another topic', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'research-lineage-'));
  const api = createResearchService(options(directory));
  const worker = createResearchService(options(directory));
  try {
    const a = await api.start(input(), { idempotencyKey: 'topic-a' });
    const b = await api.start({ ...input(), topicId: 't2' }, { idempotencyKey: 'topic-b' });
    await worker.workOnce();
    await worker.workOnce();
    const report = (await api.snapshot(a.runId)).artifacts.find(item => item.type === 'research-report');
    const otherSynthesis = (await api.snapshot(b.runId)).artifacts.find(item => item.type === 'research-synthesis');
    const db = new DatabaseSync(join(directory, 'research.sqlite'));
    const document = JSON.parse(db.prepare('SELECT document FROM workflow_artifacts WHERE id=?').get(report.identity.id).document);
    const ownSynthesis = document.dependsOn.find(dep => {
      const ref = db.prepare('SELECT document FROM workflow_artifacts WHERE id=?').get(dep.artifactId);
      return ref && JSON.parse(ref.document).type === 'research-synthesis';
    });
    Object.assign(ownSynthesis, { artifactId: otherSynthesis.identity.id, revision: otherSynthesis.identity.revision, sha256: otherSynthesis.identity.sha256 });
    db.prepare('UPDATE workflow_artifacts SET document=? WHERE id=?').run(JSON.stringify(document), report.identity.id);
    db.close();
    await assert.rejects(() => api.repair(a.runId, { identity: report.identity, feedback: [{ id: 'f', body: 'Fix', location: 'Opening' }], route: 'expression', idempotencyKey: 'bad-lineage' }), /outside topic/);
  } finally { await Promise.all([api.close(), worker.close()]); rmSync(directory, { recursive: true, force: true }); }
});

test('two processes cannot both replace a stale worker lease', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'research-election-'));
  const api = createResearchService(options(directory));
  const children = [];
  try {
    await api.start(input(), { idempotencyKey: 'start' });
    const db = new DatabaseSync(join(directory, 'research.sqlite'));
    db.prepare('INSERT INTO host_worker_lease(id,owner_pid,owner_birth,owner_token,lease_until) VALUES(1,99999999,?,?,1)').run('old', 'stale');
    db.close();
    const script = `
      const { createResearchService } = await import(process.env.TEST_MODULE);
      const roles = Object.fromEntries(['planner','researcher','synthesizer','author','reader','fact'].map(id => [id,{id,revision:'test',model:'gpt-5.6-luna',reasoningEffort:'medium'}]));
      const service = createResearchService({ directory:process.env.TEST_DIR, projectRoot:process.env.TEST_DIR, artifactRoot:process.env.TEST_DIR+'/out', agentsFactory:async()=>roles, revisionProvider:async()=> 'r1', runner:{async run(){await new Promise(r=>setTimeout(r,1200));throw new Error('stop');}} });
      console.log('READY');
      process.stdin.once('data', async () => { process.stdin.destroy(); try { console.log('RESULT '+await service.workOnce()); } finally { await service.close(); } });
    `;
    for (let i = 0; i < 2; i++) children.push(spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TEST_DIR: directory, TEST_MODULE: new URL('./research-service.mjs', import.meta.url).href }, stdio: ['pipe', 'pipe', 'pipe'] }));
    const outputs = children.map(child => { let output = ''; child.stdout.on('data', chunk => { output += chunk; }); return () => output; });
    await Promise.all(children.map(child => new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); })));
    for (const child of children) child.stdin.write('go\n');
    const exits = await Promise.all(children.map(child => new Promise((resolve, reject) => { child.once('exit', code => code === 0 ? resolve(code) : reject(new Error(`worker exited ${code}`))); child.once('error', reject); })));
    assert.equal(exits.length, 2);
    assert.deepEqual(outputs.map(read => /RESULT (true|false)/.exec(read())?.[1]).sort(), ['false', 'true']);
  } finally { for (const child of children) child.kill(); await api.close(); rmSync(directory, { recursive: true, force: true }); }
});
