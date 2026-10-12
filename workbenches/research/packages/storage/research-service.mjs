import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Pool } from 'pg';
import { runWorkflow, workflowFingerprint } from '@signal-room/workflow';
import { migratePostgresWorkflowStore, PostgresWorkflowRunStore } from '@signal-room/workflow-postgres';
import { createWorkflowReadService } from '@signal-room/workflow-read-model';
import { SiwcAuth } from '@signal-room/workflow-agent-sdk';
import { inputCheck, sameIdentity, validIdentity } from '../workflows/contracts.mjs';
import { createResearchWorkflow } from '../workflows/workflow.mjs';
import { createResearchAgents, implementationRevision } from '../workflows/config.mjs';
import { createResearchSiwcRunner } from '../workflows/research-runner.mjs';
import { migrateResearchCollaboration } from '../domain/collaboration.ts';

const WORKSPACE_ID = 'creator-lab-research';
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const clean = value => JSON.parse(JSON.stringify(value));
const safeTitle = value => typeof value === 'string' ? value.replace(/[\x00-\x1f<>]/g, ' ').slice(0, 160) : '';
const identity = a => ({ id: a.id, revision: a.revision, sha256: a.sha256 });

export async function migrateResearchHost(pool) {
  await migratePostgresWorkflowStore(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(4832941, 2)');
    await client.query(`CREATE TABLE IF NOT EXISTS research_host_runs (
      workspace_id text NOT NULL, logical_workspace_id text NOT NULL, run_id text NOT NULL, root_id text NOT NULL,
      topic_id text NOT NULL, input_json text NOT NULL, input_hash text NOT NULL,
      agents_json text NOT NULL, model text NOT NULL, effort text NOT NULL,
      revision text NOT NULL, method_hash text NOT NULL, deadline_at bigint NOT NULL,
      queue_state text NOT NULL, created_at timestamptz NOT NULL,
      lease_owner text, lease_until bigint, cancel_requested boolean NOT NULL DEFAULT false,
      read_only boolean NOT NULL DEFAULT false,
      PRIMARY KEY(workspace_id,run_id)
    )`);
    await client.query('ALTER TABLE research_host_runs ADD COLUMN IF NOT EXISTS read_only boolean NOT NULL DEFAULT false');
    await client.query('ALTER TABLE research_host_runs ADD COLUMN IF NOT EXISTS logical_workspace_id text');
    await client.query(`UPDATE research_host_runs SET logical_workspace_id=COALESCE(input_json::jsonb->>'workspaceId',workspace_id)
      WHERE logical_workspace_id IS NULL`);
    await client.query('ALTER TABLE research_host_runs ALTER COLUMN logical_workspace_id SET NOT NULL');
    await client.query(`CREATE INDEX IF NOT EXISTS research_host_scope
      ON research_host_runs(workspace_id,topic_id,created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS research_host_logical_scope
      ON research_host_runs(workspace_id,logical_workspace_id,topic_id,created_at DESC)`);
    await client.query(`CREATE TABLE IF NOT EXISTS research_host_commands (
      workspace_id text NOT NULL, command_key text NOT NULL, digest text NOT NULL,
      result_json jsonb NOT NULL, PRIMARY KEY(workspace_id,command_key)
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS research_host_assets (
      workspace_id text NOT NULL, artifact_id text NOT NULL, run_id text NOT NULL,
      file_key text NOT NULL, path text NOT NULL, file_hash text NOT NULL,
      revision text NOT NULL, payload_hash text NOT NULL, title text NOT NULL,
      topic_id text NOT NULL, PRIMARY KEY(workspace_id,artifact_id),
      UNIQUE(workspace_id,file_key)
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS research_worker_lease (
      workspace_id text PRIMARY KEY, owner_token text NOT NULL, lease_until bigint NOT NULL
    )`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
  await migrateResearchCollaboration(pool);
}

/** PostgreSQL is the only live state store. A legacy SQLite file is never opened here. */
export async function createResearchService({ databaseUrl = process.env.WORKFLOW_DATABASE_URL, directory, artifactRoot, projectRoot,
  runner, auth = new SiwcAuth(), agentsFactory = createResearchAgents, revisionProvider = implementationRevision,
  workspaceId = WORKSPACE_ID, pool: suppliedPool } = {}) {
  if (!projectRoot || (!databaseUrl && !suppliedPool)) throw new Error('Research project root and WORKFLOW_DATABASE_URL are required');
  projectRoot = resolve(projectRoot);
  directory = resolve(directory || '.local/state');
  artifactRoot = resolve(artifactRoot || join(directory, 'assets'));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const pool = suppliedPool ?? new Pool({ connectionString: databaseUrl, application_name: 'creator-lab-research' });
  try {
    await migrateResearchHost(pool);
  } catch (error) {
    if (!suppliedPool) await pool.end();
    throw error;
  }
  const store = new PostgresWorkflowRunStore(pool, { workspaceId });
  const agentRunner = runner ?? createResearchSiwcRunner({ auth });
  const active = new Map();
  const runFacts = new Map();
  let closed = false, closing;
  const query = (sql, values = [], client = pool) => client.query(sql, values);
  const row = async id => {
    const record = (await query('SELECT * FROM research_host_runs WHERE workspace_id=$1 AND run_id=$2', [workspaceId, id])).rows[0];
    if (record) runFacts.set(id, record);
    return record;
  };
  const root = async id => { const value = await row(id); if (!value) throw new Error('Research run not found'); return value; };
  const assetRow = async id => (await query('SELECT * FROM research_host_assets WHERE workspace_id=$1 AND artifact_id=$2', [workspaceId, id])).rows[0];
  async function transaction(action) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const value = await action(client); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  const readModel = createWorkflowReadService({ store, adapters: {
    title: (_kind, _id, record) => safeTitle(record.phaseDefinition?.title || record.key),
    purpose: phase => safeTitle(phase.phaseDefinition?.purpose),
    error: () => 'Research step failed. Inspect the private run log.',
    callFacts: step => {
      if (step.kind !== 'agent') return {};
      const owner = runFacts.get(step.runId);
      return owner ? { model: owner.model, reasoningEffort: owner.effort, methodRevision: owner.revision, methodDigest: owner.method_hash } : {};
    },
    isDeliverable: artifact => artifact.type === 'research-report',
    externalArtifact: async (requested, rootRecord) => {
      const owner = await row(rootRecord.id);
      if (!owner || !validIdentity(requested)) return undefined;
      const repair = verifyFrozen(owner).repair;
      const allowed = [repair?.candidate?.identity, repair?.prior?.brief?.identity, repair?.prior?.synthesis?.identity, ...(repair?.prior?.evidence || []).map(item => item.identity)].filter(Boolean);
      if (!allowed.some(item => sameIdentity(item, requested))) return undefined;
      const ref = await store.getArtifact(requested.id);
      if (!ref || !sameIdentity(ref, requested)) return undefined;
      const producer = await row(ref.producedBy.workflowRunId);
      if (!producer || producer.logical_workspace_id !== owner.logical_workspace_id || producer.topic_id !== owner.topic_id) return undefined;
      return ref;
    },
    readerUrl: artifact => `/api/runs/${encodeURIComponent(artifact.producedBy.workflowRunId)}/artifacts/${encodeURIComponent(artifact.id)}?revision=${encodeURIComponent(artifact.revision)}&sha256=${artifact.sha256}`,
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
  async function freeze(input, model, effort) {
    if (!inputCheck(input).valid) throw new Error('Invalid research input or source hash');
    if (!model || !effort) throw new Error('Model and reasoning effort must be explicit');
    const copy = clean(input);
    const revision = await revisionProvider(projectRoot);
    const agents = await agentsFactory({ model, reasoningEffort: effort, projectRoot });
    const agentsJson = JSON.stringify(agents, (_key, value) => typeof value === 'function' ? value.toString() : value);
    return { input: copy, revision, agents, agentsJson, methodHash: hash(agentsJson) };
  }
  function verifyFrozen(record) {
    const input = JSON.parse(record.input_json);
    if (record.input_hash && hash(record.input_json) !== record.input_hash) throw new Error('Frozen research input changed');
    if (!inputCheck(input).valid) throw new Error('Frozen research input failed integrity verification');
    return input;
  }
  async function assertRepairBound(input) {
    if (!input.repair) return;
    const refs = [input.repair.candidate, input.repair.prior?.brief, input.repair.prior?.synthesis,
      ...(input.repair.prior?.evidence ?? [])].filter(Boolean);
    for (const item of refs) {
      const ref = await store.getArtifact(item.identity.id);
      const producer = ref && await row(ref.producedBy.workflowRunId);
      if (!ref || !sameIdentity(ref, item.identity) || !producer
        || producer.logical_workspace_id !== input.workspaceId || producer.topic_id !== input.topicId
        || JSON.stringify(await store.getArtifactPayload(ref.id)) !== JSON.stringify(item.payload)) {
        throw new Error('Repair artifact is outside the research workspace or its identity changed');
      }
    }
  }
  async function workOnce() {
    if (closed || active.size) return false;
    const owner = randomUUID();
    let ownsLease = false, claimed, finish;
    try {
      claimed = await transaction(async client => {
        await query(`INSERT INTO research_worker_lease(workspace_id,owner_token,lease_until)
          VALUES($1,'unclaimed',0) ON CONFLICT(workspace_id) DO NOTHING`, [workspaceId], client);
        const lease = (await query('SELECT * FROM research_worker_lease WHERE workspace_id=$1 FOR UPDATE', [workspaceId], client)).rows[0];
        if (Number(lease.lease_until) > Date.now()) return undefined;
        await query('UPDATE research_host_runs SET queue_state=$3,lease_owner=NULL,lease_until=NULL WHERE workspace_id=$1 AND queue_state=$2',
          [workspaceId, 'running', 'interrupted'], client);
        await query('UPDATE research_worker_lease SET owner_token=$2,lease_until=$3 WHERE workspace_id=$1', [workspaceId, owner, Date.now() + 30_000], client);
        ownsLease = true;
        const next = (await query(`SELECT * FROM research_host_runs WHERE workspace_id=$1 AND queue_state='queued' AND cancel_requested=false ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`, [workspaceId], client)).rows[0];
        if (!next) return undefined;
        await query(`UPDATE research_host_runs SET queue_state='running',lease_owner=$3,lease_until=$4 WHERE workspace_id=$1 AND run_id=$2`,
          [workspaceId, next.run_id, owner, Date.now() + 30_000], client);
        return { ...next, queue_state: 'running', lease_owner: owner };
      });
      if (!claimed) return false;
      const runId = claimed.run_id;
      const controller = new AbortController();
      const done = new Promise(resolve => { finish = resolve; });
      const heartbeat = setInterval(async () => {
        try {
          const current = await row(runId);
          if (!current || current.lease_owner !== owner || current.cancel_requested || Number(current.deadline_at) <= Date.now()) {
            controller.abort(new Error('Research canceled or deadline reached')); return;
          }
          const until = Date.now() + 30_000;
          const result = await query('UPDATE research_worker_lease SET lease_until=$3 WHERE workspace_id=$1 AND owner_token=$2', [workspaceId, owner, until]);
          if (result.rowCount !== 1) controller.abort(new Error('Research worker lease lost'));
          else await query('UPDATE research_host_runs SET lease_until=$3 WHERE workspace_id=$1 AND run_id=$2 AND lease_owner=$4', [workspaceId, runId, until, owner]);
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
        const remaining = Number(claimed.deadline_at) - Date.now();
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
        const finalHost = await row(runId);
        const interrupted = closed && !finalHost?.cancel_requested && finalRun?.state === 'canceled';
        await query('UPDATE research_host_runs SET queue_state=$3,lease_owner=NULL,lease_until=NULL WHERE workspace_id=$1 AND run_id=$2 AND lease_owner=$4',
          [workspaceId, runId, interrupted ? 'interrupted' : 'done', owner]);
      }
      return true;
    } finally {
      if (ownsLease) await query('DELETE FROM research_worker_lease WHERE workspace_id=$1 AND owner_token=$2', [workspaceId, owner]);
      if (claimed) { active.delete(claimed.run_id); finish?.(); }
    }
  }
  async function startOne(input, { model = 'gpt-6-luna', reasoningEffort = 'medium', idempotencyKey, budgetMs = 30 * 60_000 } = {}) {
    if (!idempotencyKey || typeof idempotencyKey !== 'string') throw new Error('Idempotency key required');
    if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0) throw new Error('Invalid budget');
    const frozen = await freeze(input, model, reasoningEffort);
    await assertRepairBound(frozen.input);
    const digest = hash(JSON.stringify({ operation: 'start', input: frozen.input, model, reasoningEffort, budgetMs }));
    const workflow = createResearchWorkflow({ agents: frozen.agents, revision: frozen.revision });
    return transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [workspaceId, idempotencyKey]);
      const previous = (await query('SELECT * FROM research_host_commands WHERE workspace_id=$1 AND command_key=$2', [workspaceId, idempotencyKey], client)).rows[0];
      if (previous) { if (previous.digest !== digest) throw new Error('Idempotency key reused with different command'); return previous.result_json; }
      const txStore = store.inTransaction(client);
      const ledger = await txStore.createRun({ workflowId: workflow.id, workflowRevision: workflow.revision,
        inputFingerprint: workflowFingerprint(frozen.input), state: 'queued', metadata: { workspaceId: input.workspaceId, topicId: input.topicId } });
      const runId = ledger.id, inputJson = JSON.stringify(frozen.input);
      await query(`INSERT INTO research_host_runs(workspace_id,logical_workspace_id,run_id,root_id,topic_id,input_json,input_hash,agents_json,model,effort,revision,method_hash,deadline_at,queue_state,created_at)
        VALUES($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'queued',$13)`,
        [workspaceId, input.workspaceId, runId, input.topicId, inputJson, hash(inputJson), frozen.agentsJson, model, reasoningEffort,
          frozen.revision, frozen.methodHash, Date.now() + budgetMs, new Date()], client);
      const result = { runId };
      await query('INSERT INTO research_host_commands VALUES($1,$2,$3,$4::jsonb)', [workspaceId, idempotencyKey, digest, JSON.stringify(result)], client);
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
      const owner = await root(rootId);
      const fileKey = hash(`${rootId}:${ref.id}:${ref.revision}:${ref.sha256}`).slice(0, 24);
      const path = join(artifactRoot, `${fileKey}.md`);
      const body = `# ${safeTitle(payload.title) || 'Research artifact'}\n\n${payload.document}\n`;
      const fileHash = hash(body);
      if (!existsSync(path)) {
        const temporary = join(artifactRoot, `.${fileKey}.${randomUUID()}.tmp`);
        await writeFile(temporary, body, { mode: 0o600, flag: 'wx' });
        try { await link(temporary, path); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        finally { await unlink(temporary).catch(() => {}); }
      }
      if (hash(await readFile(path)) !== fileHash) throw new Error('Materialized research asset was altered');
      await query(`INSERT INTO research_host_assets(workspace_id,artifact_id,run_id,file_key,path,file_hash,revision,payload_hash,title,topic_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(workspace_id,artifact_id) DO NOTHING`,
      [workspaceId, ref.id, rootId, fileKey, path, fileHash, ref.revision, ref.sha256, safeTitle(payload.title), owner.topic_id]);
      const recorded = await assetRow(ref.id);
      if (!recorded || recorded.run_id !== rootId || recorded.file_key !== fileKey || recorded.path !== path || recorded.file_hash !== fileHash
        || recorded.revision !== ref.revision || recorded.payload_hash !== ref.sha256 || recorded.title !== safeTitle(payload.title)
        || recorded.topic_id !== owner.topic_id) throw new Error('Materialized research asset mapping mismatch');
    }
  }
  async function uiFor(dto, fullStages = dto.stages) {
    const assets = {};
    for (const item of dto.artifacts) {
      const entry = await assetRow(item.identity.id);
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
    await root(runId);
    if (!validIdentity(requested)) throw new Error('Exact artifact identity required');
    const dto = await readModel.getSnapshot({ rootRunId: runId });
    if (!dto.artifacts.some(item => sameIdentity(item.identity, requested))) throw new Error('Artifact outside research run');
    const ref = await store.getArtifact(requested.id);
    if (!ref || !sameIdentity(ref, requested)) throw new Error('Artifact identity mismatch');
    return { ref, payload: await store.getArtifactPayload(ref.id) };
  }
  const service = {
    pool, workspaceId, start: startOne, workOnce,
    async resume(runId, { idempotencyKey, budgetMs = 30 * 60_000 } = {}) {
      const item = await root(runId);
      if (item.read_only) throw new Error('Historical research runs are read-only');
      if (!idempotencyKey || typeof idempotencyKey !== 'string') throw new Error('Idempotency key required');
      if (!Number.isSafeInteger(budgetMs) || budgetMs <= 0) throw new Error('Invalid budget');
      if (await revisionProvider(projectRoot) !== item.revision) throw new Error('Implementation revision changed; run cannot resume');
      const agents = await agentsFactory({ model: item.model, reasoningEffort: item.effort, projectRoot });
      if (hash(JSON.stringify(agents, (_key, value) => typeof value === 'function' ? value.toString() : value)) !== item.method_hash) throw new Error('Research agent method changed; run cannot resume');
      return transaction(async client => {
        const digest = hash(`resume:${runId}:${budgetMs}`);
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [workspaceId, idempotencyKey]);
        const previous = (await query('SELECT * FROM research_host_commands WHERE workspace_id=$1 AND command_key=$2', [workspaceId, idempotencyKey], client)).rows[0];
        if (previous) { if (previous.digest !== digest) throw new Error('Idempotency key reused with different command'); return previous.result_json; }
        const current = await root(runId);
        const state = await store.getRun(runId);
        if (!['interrupted', 'done'].includes(current.queue_state) || !['failed', 'canceled', 'running', 'queued'].includes(state?.state)) throw new Error('Run cannot resume');
        await query(`UPDATE research_host_runs SET queue_state='queued',cancel_requested=false,deadline_at=$3,lease_owner=NULL,lease_until=NULL WHERE workspace_id=$1 AND run_id=$2`, [workspaceId, runId, Date.now() + budgetMs], client);
        const result = { runId };
        await query('INSERT INTO research_host_commands VALUES($1,$2,$3,$4::jsonb)', [workspaceId, idempotencyKey, digest, JSON.stringify(result)], client);
        return result;
      });
    },
    async cancel(runId) {
      const initial = await root(runId);
      if (initial.read_only) throw new Error('Historical research runs are read-only');
      await transaction(async client => {
        const current = await root(runId);
        if (current.queue_state === 'queued' || current.queue_state === 'interrupted') {
          await query(`UPDATE research_host_runs SET queue_state='done',cancel_requested=true WHERE workspace_id=$1 AND run_id=$2`, [workspaceId, runId], client);
          await store.inTransaction(client).updateRun(runId, { state: 'canceled' });
        } else if (current.queue_state === 'running') await query('UPDATE research_host_runs SET cancel_requested=true WHERE workspace_id=$1 AND run_id=$2', [workspaceId, runId], client);
      });
      active.get(runId)?.controller.abort(new Error('Research canceled'));
      return { runId };
    },
    async repair(runId, { identity: candidate, feedback, route, idempotencyKey }) {
      const parent = await root(runId); const found = await checkedArtifact(runId, candidate);
      if (parent.read_only) throw new Error('Historical research runs are read-only');
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
        const synthesisRef = synthesisRefs[0], source = await row(synthesisRef.producedBy.workflowRunId);
        if (!source || source.logical_workspace_id !== parent.logical_workspace_id || source.topic_id !== parent.topic_id) throw new Error('Prior synthesis outside topic');
        const verified = async ref => {
          if (!ref || !visible.some(item => sameIdentity(item.identity, ref))) throw new Error('Prior artifact is outside source run');
          const producer = await row(ref.producedBy.workflowRunId);
          if (!producer || producer.logical_workspace_id !== parent.logical_workspace_id || producer.topic_id !== parent.topic_id) throw new Error('Prior artifact outside topic');
          return { identity: identity(ref), payload: await store.getArtifactPayload(ref.id) };
        };
        const prior = { synthesis: await verified(synthesisRef), evidence: [] };
        if (prior.synthesis.payload.gaps?.length) throw new Error('Expression repair requires closed synthesis gaps');
        const steps = await store.listSteps(source.run_id); let foundationPassed = false;
        for (const ref of await store.listArtifacts(source.run_id)) {
          if (ref.type !== 'research-review' || ref?.validation !== 'valid' || ref.review !== 'passed') continue;
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
      await query('UPDATE research_host_runs SET root_id=$3 WHERE workspace_id=$1 AND run_id=$2', [workspaceId, started.runId, started.runId]);
      return started;
    },
    async list({ workspaceId: requestWorkspace, topicId } = {}) {
      if (!requestWorkspace || !topicId) throw new Error('Workspace and topic required');
      const found = await query('SELECT run_id FROM research_host_runs WHERE workspace_id=$1 AND logical_workspace_id=$2 AND topic_id=$3 ORDER BY created_at DESC', [workspaceId, requestWorkspace, topicId]);
      return Promise.all(found.rows.map(async item => ({ ...(await service.getRun(item.run_id)), state: (await store.getRun(item.run_id))?.state })));
    },
    async getRun(runId) {
      const item = await row(runId); if (!item) return undefined; const input = verifyFrozen(item);
      return { id: item.run_id, runId: item.run_id, workspaceId: item.logical_workspace_id, topicId: item.topic_id,
        title: safeTitle(input.title), goal: input.goal, asOf: input.asOf, readers: [...input.readers], model: item.model,
        readOnly: item.read_only,
        sources: input.sources.map(source => ({ id: source.id, title: source.title, sha256: source.sha256 })),
        workflowRevision: item.revision, queueState: item.queue_state, createdAt: item.created_at.toISOString() };
    },
    async source(runId, sourceId) {
      const source = verifyFrozen(await root(runId)).sources.find(item => item.id === sourceId);
      if (!source) throw new Error('Research source not found');
      return { title: source.title, document: source.content };
    },
    async assertWritable(runId) {
      if ((await root(runId)).read_only) throw new Error('Historical research runs are read-only');
    },
    async snapshot(runId) { await root(runId); await materialize(runId); const dto = await readModel.getSnapshot({ rootRunId: runId }); dto.ui = await uiFor(dto); return dto; },
    async changes(runId, cursor) { await root(runId); await materialize(runId); const result = await readModel.getChanges({ rootRunId: runId, cursor }); if (!result.resetRequired) { const full = await readModel.getSnapshot({ rootRunId: runId }); result.changed.ui = { assets: (await uiFor(result.changed, [])).assets, primaryByStage: (await uiFor(full)).primaryByStage }; } return result; },
    async stageDetails(runId, phaseId, { cursor, limit } = {}) { await root(runId); return readModel.getStageDetails({ rootRunId: runId, phaseId, cursor, limit }); },
    artifact: checkedArtifact,
    async waitForIdle() { while (active.size) await new Promise(resolve => setTimeout(resolve, 20)); },
    close() { if (closing) return closing; closed = true; const current = [...active.values()]; for (const item of current) item.controller.abort(new Error('Research host closed')); closing = Promise.all(current.map(item => item.done)).then(() => suppliedPool ? undefined : pool.end()); return closing; },
  };
  return service;
}
