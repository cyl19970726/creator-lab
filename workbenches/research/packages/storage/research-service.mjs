import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, linkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runWorkflow, workflowFingerprint } from '@signal-room/workflow';
import { SQLiteWorkflowRunStore } from '@signal-room/workflow-sqlite';
import { CodexSdkRunner } from '@signal-room/workflow-codex';
import { createWorkflowReadService } from '@signal-room/workflow-read-model';
import { inputCheck, sameIdentity, validIdentity } from '../workflows/contracts.mjs';
import { createResearchWorkflow } from '../workflows/workflow.mjs';
import { createResearchAgents, implementationRevision } from '../workflows/config.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const clean = value => JSON.parse(JSON.stringify(value));
const safeTitle = value => typeof value === 'string' ? value.replace(/[\x00-\x1f<>]/g, ' ').slice(0, 160) : '';
const identity = a => ({ id: a.id, revision: a.revision, sha256: a.sha256 });
const transactionQueues = new Map();

/** @param {{directory: string, artifactRoot?: string, projectRoot: string, runner?: any, agentsFactory?: any, revisionProvider?: any}} options */
export function createResearchService({ directory, artifactRoot, projectRoot, runner, agentsFactory = createResearchAgents, revisionProvider = implementationRevision } = {}) {
  if (!directory || !projectRoot) throw new Error('Research directory and project root are required');
  directory = resolve(directory); projectRoot = resolve(projectRoot); artifactRoot = resolve(artifactRoot || join(directory, 'assets'));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, 'research.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
  db.exec(`CREATE TABLE IF NOT EXISTS host_runs(run_id TEXT PRIMARY KEY, root_id TEXT NOT NULL, workspace_id TEXT NOT NULL, topic_id TEXT NOT NULL, input_json TEXT NOT NULL, input_hash TEXT NOT NULL, agents_json TEXT NOT NULL, model TEXT NOT NULL, effort TEXT NOT NULL, revision TEXT NOT NULL, method_hash TEXT NOT NULL, deadline_at INTEGER, queue_state TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS host_scope ON host_runs(workspace_id,topic_id,created_at);
    CREATE TABLE IF NOT EXISTS host_commands(key TEXT PRIMARY KEY, digest TEXT NOT NULL, result_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS host_assets(artifact_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, file_key TEXT NOT NULL UNIQUE, path TEXT NOT NULL, file_hash TEXT NOT NULL, revision TEXT NOT NULL, payload_hash TEXT NOT NULL, title TEXT NOT NULL, workspace_id TEXT NOT NULL, topic_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS host_worker_lease(id INTEGER PRIMARY KEY CHECK(id=1), owner_pid INTEGER NOT NULL, owner_birth TEXT, owner_token TEXT NOT NULL, lease_until INTEGER NOT NULL);`);
  db.exec('BEGIN IMMEDIATE');
  try {
    const assetColumns = new Set(db.prepare('PRAGMA table_info(host_assets)').all().map(item => item.name));
    if (assetColumns.has('legacy_id') && !assetColumns.has('file_key')) db.exec('ALTER TABLE host_assets RENAME COLUMN legacy_id TO file_key');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const columns = new Set(db.prepare('PRAGMA table_info(host_runs)').all().map(item => item.name));
  if (!columns.has('input_hash')) db.exec("ALTER TABLE host_runs ADD COLUMN input_hash TEXT NOT NULL DEFAULT ''");
  if (!columns.has('agents_json')) db.exec("ALTER TABLE host_runs ADD COLUMN agents_json TEXT NOT NULL DEFAULT ''");
  for (const [name, definition] of [['lease_owner', 'TEXT'], ['lease_until', 'INTEGER'], ['cancel_requested', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE host_runs ADD COLUMN ${name} ${definition}`);
  }
  const store = new SQLiteWorkflowRunStore(db);
  const agentRunner = runner ?? new CodexSdkRunner(undefined, join(directory, 'private-traces'));
  const active = new Map();
  let closed = false, closing;
  const row = id => db.prepare('SELECT * FROM host_runs WHERE run_id=?').get(id);
  const root = id => { const value = row(id); if (!value) throw new Error('Research run not found'); return value; };
  const assetRow = id => db.prepare('SELECT * FROM host_assets WHERE artifact_id=?').get(id);
  function transaction(action) {
    const previous = transactionQueues.get(directory) || Promise.resolve();
    const next = previous.then(async () => {
      db.exec('BEGIN IMMEDIATE');
      try { const result = await action(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    });
    transactionQueues.set(directory, next.catch(() => {}));
    return next;
  }
  function alive(pid) { if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } }
  function processBirth(pid) { try { return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined; } catch { return undefined; } }
  function leaseIsLive(lease) {
    if (!alive(lease.owner_pid)) return false;
    const birth = processBirth(lease.owner_pid);
    return !birth || !lease.owner_birth || birth === lease.owner_birth;
  }
  const readModel = createWorkflowReadService({ store, adapters: {
    title: (_kind, _id, record) => safeTitle(record.phaseDefinition?.title || record.key),
    purpose: phase => safeTitle(phase.phaseDefinition?.purpose),
    error: () => 'Research step failed. Inspect the private run log.',
    callFacts: step => {
      if (step.kind !== 'agent') return {};
      const owner = row(step.runId);
      return owner ? { model: owner.model, reasoningEffort: owner.effort, methodRevision: owner.revision, methodDigest: owner.method_hash } : {};
    },
    isDeliverable: artifact => artifact.type === 'research-report',
    externalArtifact: async (requested, rootRecord) => {
      const owner = row(rootRecord.id);
      if (!owner || !validIdentity(requested)) return undefined;
      const repair = verifyFrozen(owner).repair;
      const allowed = [repair?.candidate?.identity, repair?.prior?.brief?.identity, repair?.prior?.synthesis?.identity, ...(repair?.prior?.evidence || []).map(item => item.identity)].filter(Boolean);
      if (!allowed.some(item => sameIdentity(item, requested))) return undefined;
      const ref = await store.getArtifact(requested.id);
      if (!ref || !sameIdentity(ref, requested)) return undefined;
      const producer = row(ref.producedBy.workflowRunId);
      if (!producer || producer.workspace_id !== owner.workspace_id || producer.topic_id !== owner.topic_id) return undefined;
      return ref;
    },
    readerUrl: artifact => `/api/runs/${encodeURIComponent(findRoot(artifact.producedBy.workflowRunId))}/artifacts/${encodeURIComponent(artifact.id)}?revision=${encodeURIComponent(artifact.revision)}&sha256=${artifact.sha256}`,
    relations: async artifact => {
      const payload = await store.getArtifactPayload(artifact.id);
      if (!payload || typeof payload !== 'object') return [];
      const relations = [];
      if (validIdentity(payload.target) && artifact.type === 'research-review') relations.push({ kind: 'reviews', from: identity(artifact), to: payload.target });
      if (validIdentity(payload.previous)) relations.push({ kind: 'revises', from: identity(artifact), to: payload.previous });
      if (validIdentity(payload.candidate) && artifact.type === 'research-release') relations.push({ kind: 'selected', from: identity(artifact), to: payload.candidate });
      return relations;
    },
  }});
  function findRoot(runId) { return row(runId)?.root_id || runId; }
  async function freeze(input, model, effort) {
    if (!inputCheck(input).valid) throw new Error('Invalid research input or source hash');
    if (!model || !effort) throw new Error('Model and reasoning effort must be explicit');
    const copy = clean(input);
    const revision = await revisionProvider(projectRoot);
    const agents = await agentsFactory({ model, reasoningEffort: effort, projectRoot });
    const agentsJson = JSON.stringify(agents, (_key, value) => typeof value === 'function' ? value.toString() : value);
    const methodHash = hash(agentsJson);
    return { input: copy, revision, agents, agentsJson, methodHash };
  }
  function verifyFrozen(record) {
    const input = JSON.parse(record.input_json);
    if (record.input_hash && hash(record.input_json) !== record.input_hash) throw new Error('Frozen research input changed');
    if (!inputCheck(input).valid) throw new Error('Frozen research input failed integrity verification');
    return input;
  }
  async function workOnce() {
    if (closed || active.size) return false;
    const owner = `${process.pid}:${randomUUID()}`;
    const birth = processBirth(process.pid);
    let ownsLease = false;
    let claimed;
    let finish;
    try {
      claimed = await transaction(() => {
        const lease = db.prepare('SELECT * FROM host_worker_lease WHERE id=1').get();
        if (lease && leaseIsLive(lease)) return undefined;
        db.prepare('INSERT INTO host_worker_lease(id,owner_pid,owner_birth,owner_token,lease_until) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET owner_pid=excluded.owner_pid,owner_birth=excluded.owner_birth,owner_token=excluded.owner_token,lease_until=excluded.lease_until').run(process.pid, birth ?? null, owner, Date.now() + 30_000);
        ownsLease = true;
        db.prepare("UPDATE host_runs SET queue_state='interrupted',lease_owner=NULL,lease_until=NULL WHERE queue_state='running'").run();
        const next = db.prepare("SELECT * FROM host_runs WHERE queue_state='queued' AND cancel_requested=0 ORDER BY created_at LIMIT 1").get();
        if (!next) return undefined;
        db.prepare("UPDATE host_runs SET queue_state='running',lease_owner=?,lease_until=? WHERE run_id=? AND queue_state='queued'").run(owner, Date.now() + 30_000, next.run_id);
        return next;
      });
      if (!claimed) return false;
      const runId = claimed.run_id;
      const controller = new AbortController();
      const done = new Promise(resolve => { finish = resolve; });
      const heartbeat = setInterval(() => {
        try {
          const current = row(runId);
          if (!current || current.lease_owner !== owner || current.cancel_requested || current.deadline_at <= Date.now()) controller.abort(new Error('Research canceled or deadline reached'));
          else {
            const until = Date.now() + 30_000;
            const renewed = db.prepare('UPDATE host_worker_lease SET lease_until=? WHERE id=1 AND owner_token=?').run(until, owner);
            if (renewed.changes !== 1) controller.abort(new Error('Research worker lease lost'));
            else db.prepare('UPDATE host_runs SET lease_until=? WHERE run_id=? AND lease_owner=?').run(until, runId, owner);
          }
        } catch { controller.abort(new Error('Research lease unavailable')); }
      }, 1000);
      active.set(runId, { controller, done });
      try {
        const input = verifyFrozen(claimed);
        const revision = await revisionProvider(projectRoot);
        if (revision !== claimed.revision) throw new Error('Implementation revision changed; run cannot resume');
        const agents = await agentsFactory({ model: claimed.model, reasoningEffort: claimed.effort, projectRoot });
        const agentsJson = JSON.stringify(agents, (_key, value) => typeof value === 'function' ? value.toString() : value);
        if (agentsJson !== claimed.agents_json || hash(agentsJson) !== claimed.method_hash) throw new Error('Research agent method changed; run cannot resume');
        const workflow = createResearchWorkflow({ agents, revision: claimed.revision });
        const remaining = claimed.deadline_at - Date.now();
        if (remaining <= 0) controller.abort(new Error('Research deadline reached'));
        const deadline = remaining > 0 ? setTimeout(() => controller.abort(new Error('Research deadline reached')), Math.min(remaining, 2_147_483_647)) : undefined;
        try { await runWorkflow({ workflow, input, store, agentRunner, resumeRunId: runId, signal: controller.signal }); }
        finally { if (deadline) clearTimeout(deadline); }
        await materialize(runId);
      } catch {
        const actual = await store.getRun(runId);
        if (actual?.state === 'queued' || actual?.state === 'running') await store.updateRun(runId, { state: controller.signal.aborted ? 'canceled' : 'failed', error: 'Research execution failed' });
      } finally {
        clearInterval(heartbeat);
        const finalRun = await store.getRun(runId);
        const interrupted = closed && !row(runId)?.cancel_requested && finalRun?.state === 'canceled';
        db.prepare('UPDATE host_runs SET queue_state=?,lease_owner=NULL,lease_until=NULL WHERE run_id=? AND lease_owner=?').run(interrupted ? 'interrupted' : 'done', runId, owner);
      }
      return true;
    } finally {
      try { if (ownsLease) db.prepare('DELETE FROM host_worker_lease WHERE id=1 AND owner_token=?').run(owner); }
      finally { if (claimed) { active.delete(claimed.run_id); finish?.(); } }
    }
  }
  async function startOne(input, { model = 'gpt-5.6-luna', reasoningEffort = 'medium', idempotencyKey, budgetMs = 30 * 60_000 } = {}) {
    if (!idempotencyKey || typeof idempotencyKey !== 'string') throw new Error('Idempotency key required');
    if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0) throw new Error('Invalid budget');
    const frozen = await freeze(input, model, reasoningEffort);
    const digest = hash(JSON.stringify({ operation: 'start', input: frozen.input, model, reasoningEffort, budgetMs }));
    const workflow = createResearchWorkflow({ agents: frozen.agents, revision: frozen.revision });
    return transaction(async () => {
      const previous = db.prepare('SELECT * FROM host_commands WHERE key=?').get(idempotencyKey);
      if (previous) {
        if (previous.digest !== digest) throw new Error('Idempotency key reused with different command');
        return JSON.parse(previous.result_json);
      }
      const ledger = await store.createRun({ workflowId: workflow.id, workflowRevision: workflow.revision, inputFingerprint: workflowFingerprint(frozen.input), state: 'queued', metadata: { workspaceId: input.workspaceId, topicId: input.topicId } });
      const runId = ledger.id;
      const inputJson = JSON.stringify(frozen.input);
      db.prepare(`INSERT INTO host_runs(run_id,root_id,workspace_id,topic_id,input_json,input_hash,agents_json,model,effort,revision,method_hash,deadline_at,queue_state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(runId, runId, input.workspaceId, input.topicId, inputJson, hash(inputJson), frozen.agentsJson, model, reasoningEffort, frozen.revision, frozen.methodHash, Date.now() + budgetMs, 'queued', new Date().toISOString());
      const result = { runId };
      db.prepare('INSERT INTO host_commands VALUES(?,?,?)').run(idempotencyKey, digest, JSON.stringify(result));
      return result;
    });
  }
  async function materialize(rootId) {
    const snapshot = await readModel.getSnapshot({ rootRunId: rootId });
    for (const safe of snapshot.artifacts) {
      if (safe.scope === 'external') continue;
      const ref = await store.getArtifact(safe.identity.id);
      if (!ref || !sameIdentity(ref, safe.identity)) continue;
      const payload = await store.getArtifactPayload(ref.id);
      if (typeof payload?.document !== 'string') continue;
      const owner = root(rootId);
      const fileKey = hash(`${rootId}:${ref.id}:${ref.revision}:${ref.sha256}`).slice(0, 24);
      const path = join(artifactRoot, `${fileKey}.md`);
      const body = `# ${safeTitle(payload.title) || 'Research artifact'}\n\n${payload.document}\n`;
      const fileHash = hash(body);
      if (!existsSync(path)) {
        const temporary = join(artifactRoot, `.${fileKey}.${randomUUID()}.tmp`);
        writeFileSync(temporary, body, { mode: 0o600, flag: 'wx' });
        try { linkSync(temporary, path); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        finally { unlinkSync(temporary); }
      }
      if (hash(readFileSync(path)) !== fileHash) throw new Error('Materialized research asset was altered');
      db.prepare('INSERT OR IGNORE INTO host_assets(artifact_id,run_id,file_key,path,file_hash,revision,payload_hash,title,workspace_id,topic_id) VALUES(?,?,?,?,?,?,?,?,?,?)').run(ref.id, rootId, fileKey, path, fileHash, ref.revision, ref.sha256, safeTitle(payload.title), owner.workspace_id, owner.topic_id);
      const recorded = assetRow(ref.id);
      if (!recorded || recorded.run_id !== rootId || recorded.file_key !== fileKey || recorded.path !== path || recorded.file_hash !== fileHash
        || recorded.revision !== ref.revision || recorded.payload_hash !== ref.sha256 || recorded.title !== safeTitle(payload.title)
        || recorded.workspace_id !== owner.workspace_id || recorded.topic_id !== owner.topic_id) {
        throw new Error('Materialized research asset mapping mismatch');
      }
    }
  }
  async function uiFor(dto, fullStages = dto.stages) {
    const assets = {};
    for (const item of dto.artifacts) {
      const entry = assetRow(item.identity.id);
      assets[item.identity.id] = { title: safeTitle((await store.getArtifactPayload(item.identity.id))?.title), ...(entry ? { fileHash: entry.file_hash } : {}) };
    }
    const primaryByStage = {};
    for (const stage of fullStages) {
      const phase = (await store.listSteps(stage.runId)).find(step => step.id === stage.id);
      const primary = phase?.artifactBindings?.filter(binding => binding.primary && stage.artifactIds.includes(binding.artifact?.id || binding.artifactId || binding.id)) ?? [];
      const candidates = primary.map(binding => binding.artifact?.id || binding.artifactId || binding.id).filter(id => dto.artifacts.some(artifact => artifact.identity.id === id));
      if (candidates.length === 1) primaryByStage[stage.id] = candidates[0];
    }
    return { assets, primaryByStage };
  }
  async function checkedArtifact(runId, requested) {
    root(runId);
    if (!validIdentity(requested)) throw new Error('Exact artifact identity required');
    const dto = await readModel.getSnapshot({ rootRunId: runId });
    if (!dto.artifacts.some(item => sameIdentity(item.identity, requested))) throw new Error('Artifact outside research run');
    const ref = await store.getArtifact(requested.id);
    if (!ref || !sameIdentity(ref, requested)) throw new Error('Artifact identity mismatch');
    return { ref, payload: await store.getArtifactPayload(ref.id) };
  }
  const service = {
    start: startOne,
    workOnce,
    async resume(runId, { idempotencyKey, budgetMs = 30 * 60_000 } = {}) {
      const item = root(runId);
      if (!idempotencyKey || typeof idempotencyKey !== 'string') throw new Error('Idempotency key required');
      if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0) throw new Error('Invalid budget');
      if (await revisionProvider(projectRoot) !== item.revision) throw new Error('Implementation revision changed; run cannot resume');
      const agents = await agentsFactory({ model: item.model, reasoningEffort: item.effort, projectRoot });
      if (hash(JSON.stringify(agents, (_key, value) => typeof value === 'function' ? value.toString() : value)) !== item.method_hash) throw new Error('Research agent method changed; run cannot resume');
      return transaction(async () => {
        const digest = hash(`resume:${runId}:${budgetMs}`);
        const previous = db.prepare('SELECT * FROM host_commands WHERE key=?').get(idempotencyKey);
        if (previous) { if (previous.digest !== digest) throw new Error('Idempotency key reused with different command'); return JSON.parse(previous.result_json); }
        const current = root(runId);
        const state = await store.getRun(runId);
        if (!['interrupted', 'done'].includes(current.queue_state) || !['failed', 'canceled', 'running', 'queued'].includes(state?.state)) throw new Error('Run cannot resume');
        db.prepare("UPDATE host_runs SET queue_state='queued',cancel_requested=0,deadline_at=?,lease_owner=NULL,lease_until=NULL WHERE run_id=?").run(Date.now() + budgetMs, runId);
        const result = { runId };
        db.prepare('INSERT INTO host_commands VALUES(?,?,?)').run(idempotencyKey, digest, JSON.stringify(result));
        return result;
      });
    },
    async cancel(runId) { root(runId); await transaction(async () => { const current = root(runId); if (current.queue_state === 'queued' || current.queue_state === 'interrupted') { db.prepare("UPDATE host_runs SET queue_state='done',cancel_requested=1 WHERE run_id=?").run(runId); await store.updateRun(runId, { state: 'canceled' }); } else if (current.queue_state === 'running') db.prepare('UPDATE host_runs SET cancel_requested=1 WHERE run_id=?').run(runId); }); active.get(runId)?.controller.abort(new Error('Research canceled')); return { runId }; },
    async repair(runId, { identity: candidate, feedback, route, idempotencyKey }) {
      const parent = root(runId); const found = await checkedArtifact(runId, candidate);
      if (found.ref.type !== 'research-report') throw new Error('Repair candidate must be a report');
      const input = verifyFrozen(parent);
      input.repair = { candidate: { identity: candidate, payload: found.payload }, feedback, route };
      if (route === 'expression') {
        const visible = (await readModel.getSnapshot({ rootRunId: runId })).artifacts;
        const synthesisRefs = [];
        for (const dep of found.ref.dependsOn) {
          const ref = await store.getArtifact(dep.artifactId);
          if (ref?.type === 'research-synthesis' && ref.revision === dep.revision && ref.sha256 === dep.sha256) synthesisRefs.push(ref);
        }
        if (synthesisRefs.length !== 1) throw new Error('Expression repair requires one exact candidate synthesis');
        const synthesisRef = synthesisRefs[0];
        const source = row(synthesisRef.producedBy.workflowRunId);
        if (!source || source.workspace_id !== parent.workspace_id || source.topic_id !== parent.topic_id) throw new Error('Prior synthesis outside topic');
        const verified = async ref => {
          if (!ref || !visible.some(item => sameIdentity(item.identity, ref))) throw new Error('Prior artifact is outside source run');
          const producer = row(ref.producedBy.workflowRunId);
          if (!producer || producer.workspace_id !== parent.workspace_id || producer.topic_id !== parent.topic_id) throw new Error('Prior artifact outside topic');
          return { identity: identity(ref), payload: await store.getArtifactPayload(ref.id) };
        };
        const prior = { synthesis: await verified(synthesisRef), evidence: [] };
        if (prior.synthesis.payload.gaps?.length) throw new Error('Expression repair requires closed synthesis gaps');
        const steps = await store.listSteps(source.run_id);
        let foundationPassed = false;
        for (const ref of await store.listArtifacts(source.run_id)) {
          if (ref.type !== 'research-review') continue;
          if (ref?.validation !== 'valid' || ref.review !== 'passed') continue;
          const step = steps.find(entry => entry.id === ref.producedBy.stepRunId);
          if (!step?.phasePath?.some(part => part.startsWith('a2-foundation-review-'))) continue;
          const payload = await store.getArtifactPayload(ref.id);
          if (payload?.decision === 'pass' && sameIdentity(payload.target, synthesisRef)) foundationPassed = true;
        }
        if (!foundationPassed) throw new Error('Expression repair requires exact passed foundation review');
        for (const dep of synthesisRef.dependsOn) {
          const ref = await store.getArtifact(dep.artifactId);
          if (!ref || ref.revision !== dep.revision || ref.sha256 !== dep.sha256) throw new Error('Prior synthesis dependency mismatch');
          if (ref.type === 'research-brief') prior.brief = await verified(ref);
          if (ref.type === 'research-evidence') prior.evidence.push(await verified(ref));
        }
        if (!prior.evidence.length) throw new Error('Expression repair requires prior evidence');
        input.repair.prior = prior;
      }
      if (!inputCheck(input).valid) throw new Error('Invalid research repair');
      const started = await startOne(input, { model: parent.model, reasoningEffort: parent.effort, idempotencyKey });
      db.prepare('UPDATE host_runs SET root_id=? WHERE run_id=?').run(started.runId, started.runId);
      return started;
    },
    list: async ({ workspaceId, topicId } = {}) => {
      if (!workspaceId || !topicId) throw new Error('Workspace and topic required');
      return Promise.all(db.prepare('SELECT run_id FROM host_runs WHERE workspace_id=? AND topic_id=? ORDER BY created_at DESC').all(workspaceId, topicId).map(async item => ({ ...service.getRun(item.run_id), state: (await store.getRun(item.run_id))?.state })));
    },
    getRun: runId => { const item = row(runId); if (!item) return undefined; const input = verifyFrozen(item); return {
      id: item.run_id, runId: item.run_id, workspaceId: item.workspace_id, topicId: item.topic_id,
      title: safeTitle(input.title), goal: input.goal, asOf: input.asOf, readers: [...input.readers],
      model: item.model, sources: input.sources.map(source => ({ id: source.id, title: source.title, sha256: source.sha256 })),
      workflowRevision: item.revision, queueState: item.queue_state, createdAt: item.created_at,
    }; },
    source: (runId, sourceId) => {
      const source = verifyFrozen(root(runId)).sources.find(item => item.id === sourceId);
      if (!source) throw new Error('Research source not found');
      return { title: source.title, document: source.content };
    },
    snapshot: async runId => { root(runId); await materialize(runId); const dto = await readModel.getSnapshot({ rootRunId: runId }); dto.ui = await uiFor(dto); return dto; },
    changes: async (runId, cursor) => { root(runId); await materialize(runId); const result = await readModel.getChanges({ rootRunId: runId, cursor }); if (!result.resetRequired) { const full = await readModel.getSnapshot({ rootRunId: runId }); result.changed.ui = { assets: (await uiFor(result.changed, [])).assets, primaryByStage: (await uiFor(full)).primaryByStage }; } return result; },
    stageDetails: (runId, phaseId, { cursor, limit } = {}) => { root(runId); return readModel.getStageDetails({ rootRunId: runId, phaseId, cursor, limit }); },
    artifact: (runId, requested) => checkedArtifact(runId, requested),
    async waitForIdle() { while (active.size) await new Promise(resolve => setTimeout(resolve, 20)); },
    close() { if (closing) return closing; closed = true; const current = [...active.values()]; for (const item of current) item.controller.abort(new Error('Research host closed')); closing = Promise.all(current.map(item => item.done)).then(() => { db.close(); }); return closing; },
  };
  return service;
}
