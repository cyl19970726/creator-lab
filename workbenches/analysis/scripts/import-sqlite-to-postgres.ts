#!/usr/bin/env node
/** Explicit, repeatable import of one frozen analysis runtime. Never opens the source for writing. */
import "dotenv/config";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { migratePostgresWorkflowStore } from "@signal-room/workflow-postgres";
import { artifactPayloadSha256 } from "@signal-room/workflow";
import { AnalysisPgContext } from "../packages/adapters/src/platform/database/analysis-pg-context.js";
import { PostgresCreatorArtifactStore } from "../packages/adapters/src/platform/artifacts/postgres-creator-artifact-store.js";

type SqliteRow = Record<string, unknown>;
const textFile = /\.(?:json|jsonl|md|txt|srt|vtt|csv|tsv|html|xml|ya?ml)$/i;
function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index+1];
}
function rows(db: DatabaseSync, table: string): SqliteRow[] {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return exists ? db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as SqliteRow[] : [];
}
function value(row: SqliteRow, key: string): string { return String(row[key] ?? ""); }
function parsed(row: SqliteRow, key: string): unknown { return JSON.parse(value(row,key)) as unknown; }
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}
async function importRow(context: AnalysisPgContext, table: string, keys: string[], fields: Record<string,unknown>): Promise<void> {
  const columns = Object.keys(fields);
  const values = columns.map((column) => fields[column]);
  const placeholders = columns.map((_,index) => `$${index+1}`);
  await context.query(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${placeholders.join(",")}) ON CONFLICT DO NOTHING`,values);
  const where = keys.map((key,index) => `${key}=$${index+1}`).join(" AND ");
  const found = await context.query<SqliteRow>(`SELECT ${columns.join(",")} FROM ${table} WHERE ${where}`,keys.map((key) => fields[key]));
  if (!found.rows[0]) throw new Error(`Import row not readable: ${table}`);
  for (const column of columns) {
    const actual = found.rows[0][column];
    const expected = fields[column];
    const equal = canonical(actual) === canonical(expected)
      || (typeof actual === "string" && typeof expected === "number" && Number(actual) === expected);
    if (!equal) {
      throw new Error(`Import conflict in ${table}.${column}; target contains different data`);
    }
  }
}
async function hashFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
async function inventory(root: string, runIds: string[]): Promise<{ text: Array<{ reference:string; file:string }>;
  media: Array<{ reference:string; file:string; relative:string }>; missingRuns:string[] }> {
  const text: Array<{ reference:string; file:string }> = [], media: Array<{ reference:string; file:string; relative:string }> = [];
  const missingRuns: string[] = [];
  for (const runId of runIds) {
    const directory = path.join(root,"runs",runId);
    try { await fs.access(directory); } catch { missingRuns.push(runId); continue; }
    const visit = async (at: string): Promise<void> => {
      for (const entry of await fs.readdir(at,{withFileTypes:true})) {
        const file = path.join(at,entry.name);
        if (entry.isSymbolicLink()) throw new Error(`Source run contains a symlink: ${file}`);
        if (entry.isDirectory()) { await visit(file); continue; }
        if (!entry.isFile()) continue;
        const relative = path.relative(directory,file).split(path.sep).join("/");
        const reference = `/artifacts/${runId}/${relative}`;
        if (textFile.test(entry.name)) text.push({reference,file});
        else media.push({reference,file,relative});
      }
    };
    await visit(directory);
  }
  return { text,media,missingRuns };
}

const source = arg("--source");
const workspaceId = arg("--workspace");
const execute = process.argv.includes("--execute");
const mediaRoot = arg("--media-root");
if (!source || !workspaceId || !/^[a-zA-Z0-9._:-]{1,128}$/.test(workspaceId)) {
  throw new Error("Usage: --source FROZEN_RUNTIME --workspace TRUSTED_ID [--media-root DIRECTORY --execute]");
}
const sourceRoot = path.resolve(source);
const db = new DatabaseSync(path.join(sourceRoot,"self-media.sqlite"),{readOnly:true});
try {
  const names = ["creator_research_runs","research_jobs","research_events","creator_research_batches",
    "creator_research_batch_items","research_workflow_executions","workflow_runs","workflow_steps",
    "workflow_attempts","workflow_events","workflow_artifacts","workflow_step_commits"];
  const sourceRows = Object.fromEntries(names.map((name) => [name,rows(db,name)])) as Record<string,SqliteRow[]>;
  const sourceId = await hashFile(path.join(sourceRoot,"self-media.sqlite"));
  const runIds = sourceRows.creator_research_runs!.map((row) => value(row,"id"));
  const files = await inventory(sourceRoot,runIds);
  const counts = Object.fromEntries(names.map((name) => [name,sourceRows[name]!.length]));
  const activeJobs = sourceRows.research_jobs!.filter((row) => ["leased","running"].includes(value(row,"status"))).length;
  console.log(JSON.stringify({mode:execute?"import":"dry-run",counts,runCount:runIds.length,
    textFiles:files.text.length,mediaFiles:files.media.length,missingRunDirectories:files.missingRuns.length,
    activeJobs},null,2));
  if (!execute) process.exitCode = 0;
  else {
    if (!mediaRoot) throw new Error("--media-root is required for an executable import");
    if (files.missingRuns.length) throw new Error("Source has missing run directories; inspect dry-run before import");
    // Legacy job states remain exact for reading, but imported IDs are excluded from PG claims.
    const url = process.env.ANALYSIS_DATABASE_URL ?? process.env.WORKFLOW_DATABASE_URL;
    if (!url) throw new Error("Set ANALYSIS_DATABASE_URL or WORKFLOW_DATABASE_URL privately before import");
    const pool = new Pool({connectionString:url});
    try {
      const context = new AnalysisPgContext(pool);
      const artifacts = new PostgresCreatorArtifactStore(context);
      await migratePostgresWorkflowStore(pool);
      await context.migrate();
      await artifacts.migrate();
      await context.transaction(async () => {
        await context.query(`INSERT INTO analysis_import_receipts
          (source_id,workspace_id,imported_at,source_hint,manifest)
          VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT(source_id) DO NOTHING`,
          [sourceId,workspaceId,new Date().toISOString(),path.basename(sourceRoot),JSON.stringify({counts,
            textFiles:files.text.length,mediaFiles:files.media.length,missingRunDirectories:files.missingRuns.length})]);
        const receipt = await context.query<{ workspace_id:string; manifest:unknown }>(
          "SELECT workspace_id,manifest FROM analysis_import_receipts WHERE source_id=$1",[sourceId]);
        if (receipt.rows[0]?.workspace_id !== workspaceId || canonical(receipt.rows[0]?.manifest) !== canonical({counts,
          textFiles:files.text.length,mediaFiles:files.media.length,missingRunDirectories:files.missingRuns.length})) {
          throw new Error("Existing import receipt differs from this source snapshot");
        }
        for (const row of sourceRows.creator_research_runs!) await importRow(context,"analysis_creator_runs",["id"],{
          id:row.id,profile_url:row.profile_url,status:row.status,current_stage:row.current_stage,
          creator_id:row.creator_id,created_at:row.created_at,updated_at:row.updated_at,
          run_json:parsed(row,"run_json") });
        for (const row of sourceRows.research_jobs!) {
          await importRow(context,"analysis_research_jobs",["id"],{
            ...row,payload_json:parsed(row,"payload_json") });
          await importRow(context,"analysis_imported_jobs",["job_id"],{
            job_id:row.id,source_id:sourceId });
        }
        for (const row of sourceRows.research_events!) await importRow(context,"analysis_research_events",["sequence"],{
          ...row,payload_json:parsed(row,"payload_json") });
        for (const row of sourceRows.creator_research_batches!) await importRow(context,"analysis_creator_batches",["id"],row);
        for (const row of sourceRows.creator_research_batch_items!) await importRow(context,"analysis_creator_batch_items",["batch_id","position"],row);
        for (const row of sourceRows.workflow_runs!) {
          const document = parsed(row,"document") as Record<string,unknown>;
          await importRow(context,"aw_runs",["workspace_id","id"],{
            workspace_id:workspaceId,id:row.id,parent_run_id:document.parentRunId ?? null,document });
        }
        for (const row of sourceRows.workflow_steps!) await importRow(context,"aw_steps",["workspace_id","id"],{
          workspace_id:workspaceId,run_id:row.run_id,id:row.id,document:parsed(row,"document") });
        for (const row of sourceRows.workflow_attempts!) {
          const document = parsed(row,"document") as Record<string,unknown>;
          await importRow(context,"aw_attempts",["workspace_id","id"],{
            workspace_id:workspaceId,run_id:document.runId,step_run_id:row.step_run_id,id:row.id,document });
        }
        for (const row of sourceRows.workflow_events!) await importRow(context,"aw_events",["workspace_id","run_id","seq"],{
          workspace_id:workspaceId,run_id:row.run_id,seq:row.seq,id:row.id,
          step_run_id:(parsed(row,"document") as Record<string,unknown>).stepRunId ?? null,
          attempt_id:(parsed(row,"document") as Record<string,unknown>).attemptId ?? null,
          document:parsed(row,"document") });
        for (const row of sourceRows.workflow_artifacts!) {
          const document = parsed(row,"document") as Record<string,unknown>;
          const payload = parsed(row,"payload");
          if (await artifactPayloadSha256(payload) !== document.sha256) throw new Error(`Workflow artifact hash mismatch: ${row.id}`);
          const producer = document.producedBy as Record<string,unknown>;
          await importRow(context,"aw_artifacts",["workspace_id","id"],{
            workspace_id:workspaceId,run_id:row.run_id,step_run_id:producer.stepRunId,
            attempt_id:producer.attemptId,id:row.id,document,payload });
        }
        for (const row of sourceRows.workflow_step_commits!) {
          const source = row as Record<string,unknown>;
          const required = ["run_id","step_run_id","attempt_id","idempotency_key","request_hash","receipt"];
          if (required.some((key) => !(key in source))) throw new Error("Unsupported legacy workflow_step_commits schema");
          await importRow(context,"aw_step_commits",["workspace_id","run_id","idempotency_key"],{
            workspace_id:workspaceId,run_id:source.run_id,step_run_id:source.step_run_id,
            attempt_id:source.attempt_id,idempotency_key:source.idempotency_key,
            request_hash:source.request_hash,
            receipt:typeof source.receipt === "string" ? JSON.parse(source.receipt) as unknown : source.receipt });
        }
        for (const row of sourceRows.workflow_artifacts!) {
          const document = parsed(row,"document") as { dependsOn?: Array<{ artifactId:string }> };
          for (const dependency of document.dependsOn ?? []) await importRow(context,"aw_artifact_dependencies",
            ["workspace_id","artifact_id","dependency_id"],{
              workspace_id:workspaceId,artifact_id:row.id,dependency_id:dependency.artifactId });
        }
        for (const row of sourceRows.research_workflow_executions!) {
          const document = parsed(row,"document") as Record<string,unknown>;
          await importRow(context,"analysis_workflow_executions",["id"],{
            id:row.id,creator_run_id:row.creator_run_id,
            parent_workflow_run_id:document.parentWorkflowRunId ?? null,
            parent_step_run_id:document.parentStepRunId ?? null,document });
        }
        await context.query(`UPDATE aw_runs SET next_event_seq=COALESCE((SELECT max(seq)+1 FROM aw_events
          WHERE aw_events.workspace_id=aw_runs.workspace_id AND aw_events.run_id=aw_runs.id),1)
          WHERE workspace_id=$1`,[workspaceId]);
        await context.query(`SELECT setval(pg_get_serial_sequence('analysis_research_events','sequence'),
          COALESCE((SELECT max(sequence) FROM analysis_research_events),1),true)`);
      });
      for (const file of files.text) await artifacts.ingest(file.reference,file.file);
      const destinationRoot = path.resolve(mediaRoot);
      for (const item of files.media) {
        const destination = path.resolve(destinationRoot,item.reference.slice("/artifacts/".length));
        if (!destination.startsWith(`${destinationRoot}${path.sep}`)) throw new Error("Media path escapes managed root");
        await fs.mkdir(path.dirname(destination),{recursive:true});
        const sourceHash = await hashFile(item.file);
        try {
          if (await hashFile(destination) !== sourceHash) throw new Error(`Managed media conflict: ${item.reference}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          await fs.copyFile(item.file,destination);
          if (await hashFile(destination) !== sourceHash) throw new Error(`Managed media copy failed: ${item.reference}`);
        }
        const stat = await fs.stat(destination);
        const sourceStat = await fs.stat(item.file);
        await importRow(context,"analysis_media_refs",["reference"],{
          reference:item.reference,run_id:item.reference.split("/")[2],managed_path:destination,
          sha256:sourceHash,bytes:stat.size,created_at:sourceStat.mtime.toISOString() });
      }
      await context.transaction(async () => {
        const savedText = await context.query<{ count:string }>(
          "SELECT count(*)::text AS count FROM analysis_artifact_refs WHERE run_id=ANY($1::text[])",[runIds]);
        const savedMedia = await context.query<{ count:string }>(
          "SELECT count(*)::text AS count FROM analysis_media_refs WHERE run_id=ANY($1::text[])",[runIds]);
        if (Number(savedText.rows[0]?.count) < files.text.length || Number(savedMedia.rows[0]?.count) < files.media.length) {
          throw new Error("Imported file inventory is incomplete; receipt remains importing");
        }
        await context.query(`UPDATE analysis_import_receipts SET state='completed',completed_at=$2
          WHERE source_id=$1 AND state='importing'`,[sourceId,new Date().toISOString()]);
      });
      console.log(JSON.stringify({mode:"imported",counts,textFiles:files.text.length,mediaFiles:files.media.length}));
    } finally { await pool.end(); }
  }
} finally { db.close(); }
