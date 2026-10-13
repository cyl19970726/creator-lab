import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve, basename, dirname } from 'node:path';
import { Pool } from 'pg';
import { migratePostgresWorkflowStore } from '@signal-room/workflow-postgres';
import { fileURLToPath } from 'node:url';

try { process.loadEnvFile(resolve(dirname(fileURLToPath(import.meta.url)), '../.env')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

const args = process.argv.slice(2);
const archiveOnly = args[0] === '--archive-only';
const sqlitePath = archiveOnly ? args[1] : args[0];
const databaseUrl = process.env.WORKFLOW_DATABASE_URL;
if (!sqlitePath || !databaseUrl) {
  throw new Error('Usage: node scripts/import-sqlite-archive.mjs [--archive-only] /absolute/path/to/research.sqlite');
}
const sourcePath = resolve(sqlitePath);
async function fileSha256(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}
// SQLite may leave committed records in the WAL. Include it in the archive identity
// without checkpointing or otherwise modifying the source database.
const mainSha256 = await fileSha256(sourcePath);
const walPath = `${sourcePath}-wal`;
const walSha256 = existsSync(walPath) ? await fileSha256(walPath) : null;
const sourceSha256 = createHash('sha256').update(JSON.stringify({ mainSha256, walSha256 })).digest('hex');
async function currentSourceSha256() {
  const currentMain = await fileSha256(sourcePath);
  const currentWal = existsSync(walPath) ? await fileSha256(walPath) : null;
  return createHash('sha256').update(JSON.stringify({ mainSha256: currentMain, walSha256: currentWal })).digest('hex');
}
const sqlite = new DatabaseSync(sourcePath, { readOnly: true });
sqlite.exec('PRAGMA query_only=ON; BEGIN');
const pool = new Pool({ connectionString: databaseUrl, application_name: 'research-sqlite-archive-import' });

function jsonSafe(value) {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return item.toString();
    if (Buffer.isBuffer(item)) return { $sqliteBlobBase64: item.toString('base64') };
    if (item instanceof Uint8Array) return { $sqliteBlobBase64: Buffer.from(item).toString('base64') };
    return item;
  });
}

try {
  // This is an explicit first-run archive importer, so make the shared ledger and
  // minimal host projection schema available before the API has run once.
  await migratePostgresWorkflowStore(pool);
  await pool.query(`CREATE TABLE IF NOT EXISTS research_host_runs (
    workspace_id text NOT NULL, run_id text NOT NULL, root_id text NOT NULL,
    topic_id text NOT NULL, input_json text NOT NULL, input_hash text NOT NULL,
    agents_json text NOT NULL, model text NOT NULL, effort text NOT NULL,
    revision text NOT NULL, method_hash text NOT NULL, deadline_at bigint NOT NULL,
    queue_state text NOT NULL, created_at timestamptz NOT NULL,
    lease_owner text, lease_until bigint, cancel_requested boolean NOT NULL DEFAULT false,
    read_only boolean NOT NULL DEFAULT false, PRIMARY KEY(workspace_id,run_id)
  )`);
  await pool.query('ALTER TABLE research_host_runs ADD COLUMN IF NOT EXISTS read_only boolean NOT NULL DEFAULT false');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(4832941, 3)');
    await client.query(`CREATE TABLE IF NOT EXISTS research_legacy_imports (
      source_sha256 text PRIMARY KEY, source_name text NOT NULL, source_path text NOT NULL,
      imported_at timestamptz NOT NULL DEFAULT now(), table_counts jsonb NOT NULL
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS research_legacy_rows (
      source_sha256 text NOT NULL REFERENCES research_legacy_imports(source_sha256) ON DELETE CASCADE,
      table_name text NOT NULL, row_number bigint NOT NULL, row_json jsonb NOT NULL,
      PRIMARY KEY(source_sha256,table_name,row_number)
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS research_legacy_projections (
      source_sha256 text PRIMARY KEY REFERENCES research_legacy_imports(source_sha256) ON DELETE CASCADE,
      workspace_id text NOT NULL, run_count integer NOT NULL, step_count integer NOT NULL,
      attempt_count integer NOT NULL, event_count integer NOT NULL, artifact_count integer NOT NULL,
      projected_at timestamptz NOT NULL DEFAULT now()
    )`);
    const prior = await client.query('SELECT table_counts FROM research_legacy_imports WHERE source_sha256=$1', [sourceSha256]);
    if (prior.rows[0]) {
      console.log(JSON.stringify({ sourceSha256, imported: false, tableCounts: prior.rows[0].table_counts }));
      await client.query('COMMIT');
    } else {
      const names = sqlite.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map(item => item.name);
      const counts = {};
      await client.query('INSERT INTO research_legacy_imports(source_sha256,source_name,source_path,table_counts) VALUES($1,$2,$3,$4::jsonb)',
        [sourceSha256, basename(sourcePath), sourcePath, '{}']);
      for (const name of names) {
        if (typeof name !== 'string' || name.includes('\0')) continue;
        const quoted = `"${name.replaceAll('"', '""')}"`;
        let rowCount = 0;
        for (const row of sqlite.prepare(`SELECT * FROM ${quoted}`).iterate()) {
          rowCount++;
          await client.query(`INSERT INTO research_legacy_rows(source_sha256,table_name,row_number,row_json)
            VALUES($1,$2,$3,$4::jsonb)`, [sourceSha256, name, rowCount, jsonSafe(row)]);
        }
        counts[name] = rowCount;
      }
      await client.query('UPDATE research_legacy_imports SET table_counts=$2::jsonb WHERE source_sha256=$1', [sourceSha256, JSON.stringify(counts)]);
      const projectable = new Set(names);
      if (!archiveOnly && projectable.has('workflow_runs') && projectable.has('workflow_steps')
        && projectable.has('workflow_attempts') && projectable.has('workflow_events')
        && projectable.has('workflow_artifacts') && projectable.has('host_runs')) {
        const workspaceId = process.env.RESEARCH_HISTORY_WORKSPACE_ID || 'creator-lab-research';
        const records = table => [...sqlite.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).iterate()];
        const oldRuns = records('workflow_runs');
        for (const item of oldRuns) {
          const doc = JSON.parse(item.document);
          await client.query(`INSERT INTO aw_runs(workspace_id,id,parent_run_id,next_event_seq,document)
            VALUES($1,$2,$3,1,$4::jsonb) ON CONFLICT(workspace_id,id) DO NOTHING`,
          [workspaceId, doc.id, doc.parentRunId ?? null, JSON.stringify(doc)]);
        }
        const oldSteps = records('workflow_steps');
        for (const item of oldSteps) {
          const doc = JSON.parse(item.document);
          await client.query(`INSERT INTO aw_steps(workspace_id,run_id,id,document)
            VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(workspace_id,id) DO NOTHING`,
          [workspaceId, doc.runId, doc.id, JSON.stringify(doc)]);
        }
        const oldAttempts = records('workflow_attempts');
        for (const item of oldAttempts) {
          const doc = JSON.parse(item.document);
          await client.query(`INSERT INTO aw_attempts(workspace_id,run_id,step_run_id,id,document)
            VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(workspace_id,id) DO NOTHING`,
          [workspaceId, doc.runId, doc.stepRunId, doc.id, JSON.stringify(doc)]);
        }
        const oldEvents = records('workflow_events');
        for (const item of oldEvents) {
          const doc = JSON.parse(item.document);
          await client.query(`INSERT INTO aw_events(workspace_id,run_id,seq,id,step_run_id,attempt_id,document)
            VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(workspace_id,run_id,seq) DO NOTHING`,
          [workspaceId, doc.runId, doc.seq, doc.id, doc.stepRunId ?? null, doc.attemptId ?? null, JSON.stringify(doc)]);
        }
        const oldArtifacts = records('workflow_artifacts');
        for (const item of oldArtifacts) {
          const doc = JSON.parse(item.document);
          const payload = JSON.parse(item.payload);
          await client.query(`INSERT INTO aw_artifacts(workspace_id,run_id,step_run_id,attempt_id,id,document,payload)
            VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) ON CONFLICT(workspace_id,id) DO NOTHING`,
          [workspaceId, doc.producedBy.workflowRunId, doc.producedBy.stepRunId, doc.producedBy.attemptId,
            doc.id, JSON.stringify(doc), JSON.stringify(payload)]);
        }
        for (const item of oldArtifacts) {
          const doc = JSON.parse(item.document);
          for (const dependency of doc.dependsOn ?? []) {
            await client.query(`INSERT INTO aw_artifact_dependencies(workspace_id,artifact_id,dependency_id)
              VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [workspaceId, doc.id, dependency.artifactId]);
          }
        }
        await client.query(`UPDATE aw_runs r SET next_event_seq=GREATEST(r.next_event_seq, e.last_seq+1)
          FROM (SELECT workspace_id,run_id,max(seq) AS last_seq FROM aw_events WHERE workspace_id=$1 GROUP BY workspace_id,run_id) e
          WHERE r.workspace_id=e.workspace_id AND r.id=e.run_id`, [workspaceId]);
        for (const item of records('host_runs')) {
          await client.query(`INSERT INTO research_host_runs(workspace_id,run_id,root_id,topic_id,input_json,input_hash,
            agents_json,model,effort,revision,method_hash,deadline_at,queue_state,created_at,cancel_requested,read_only)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'done',$13,false,true)
            ON CONFLICT(workspace_id,run_id) DO NOTHING`,
          [workspaceId, item.run_id, item.root_id, item.topic_id, item.input_json, item.input_hash, item.agents_json,
            item.model, item.effort, item.revision, item.method_hash, item.deadline_at, item.created_at]);
        }
        await client.query(`INSERT INTO research_legacy_projections(source_sha256,workspace_id,run_count,step_count,
          attempt_count,event_count,artifact_count) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(source_sha256) DO NOTHING`,
        [sourceSha256, workspaceId, oldRuns.length, oldSteps.length, oldAttempts.length, oldEvents.length, oldArtifacts.length]);
      }
      if (await currentSourceSha256() !== sourceSha256) throw new Error('SQLite source or WAL changed during import; transaction rolled back');
      await client.query('COMMIT');
      const projection = (await client.query('SELECT * FROM research_legacy_projections WHERE source_sha256=$1', [sourceSha256])).rows[0] ?? null;
      console.log(JSON.stringify({ sourceSha256, imported: true, archiveOnly, tableCounts: counts, projection }));
    }
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
} finally {
  sqlite.exec('ROLLBACK');
  sqlite.close();
  await pool.end();
}
