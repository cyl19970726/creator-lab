import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Artifact, ArtifactIdentity, CreateWork, Decision, DecisionInput, ExecutionConfig, Job, RevisionInput, Work, WorkDetail, Workspace, WorkspaceInput } from '../contracts/index.js';

export class StoreError extends Error {
  constructor(public readonly status: 400 | 404 | 409, message: string) { super(message); }
}

const now = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value);
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

function syncDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function materializeArtifact(path: string, bytes: string): void {
  const directory = dirname(path);
  const temporary = `${path}.tmp-${randomUUID()}`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    const buffer = Buffer.from(bytes);
    let offset = 0;
    while (offset < buffer.length) {
      const written = writeSync(fd, buffer, offset, buffer.length - offset);
      if (written === 0) throw new Error('Artifact write made no progress');
      offset += written;
    }
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(temporary);
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temporary, path);
    syncDirectory(directory);
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

interface CommandRow { scope: string; hash: string; response: string }
interface JobRow extends Job { workspaceId: string; snapshot: string }

export class CreationStore {
  readonly database: DatabaseSync;
  readonly stateRoot: string;
  constructor(stateRoot: string) {
    this.stateRoot = stateRoot;
    mkdirSync(stateRoot, { recursive: true });
    mkdirSync(join(stateRoot, 'artifacts'), { recursive: true });
    this.database = new DatabaseSync(join(stateRoot, 'creation-v1.sqlite'));
    this.database.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS works (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), document TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS works_scope ON works(workspace_id);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id), workspace_id TEXT NOT NULL, state TEXT NOT NULL, snapshot TEXT NOT NULL, document TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_work ON jobs(work_id);
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_active ON jobs(work_id) WHERE state IN ('queued','running');
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id), job_id TEXT NOT NULL REFERENCES jobs(id), native_id TEXT NOT NULL UNIQUE, document TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS artifacts_work ON artifacts(work_id);
      CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id), document TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, scope TEXT NOT NULL, hash TEXT NOT NULL, response TEXT NOT NULL);
    `);
  }
  close(): void { this.database.close(); }
  private rows<T>(sql: string, ...args: (string | number)[]): T[] {
    return this.database.prepare(sql).all(...args).map(row => parse<T>(row.document));
  }
  private one<T>(sql: string, ...args: (string | number)[]): T | undefined { return this.rows<T>(sql, ...args)[0]; }
  private command<T>(commandId: string, scope: string, body: unknown, action: () => T): T {
    const hash = digest(json(body));
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.database.prepare('SELECT scope, hash, response FROM commands WHERE id = ?').get(commandId) as unknown as CommandRow | undefined;
      if (prior) {
        if (prior.scope !== scope || prior.hash !== hash) throw new StoreError(409, 'Command ID was already used with a different scope or payload');
        this.database.exec('COMMIT');
        return parse<T>(prior.response);
      }
      const result = action();
      this.database.prepare('INSERT INTO commands(id, scope, hash, response) VALUES (?,?,?,?)').run(commandId, scope, hash, json(result));
      this.database.exec('COMMIT');
      return result;
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  listWorkspaces(): Workspace[] { return this.rows('SELECT document FROM workspaces ORDER BY rowid DESC'); }
  createWorkspace(input: WorkspaceInput): Workspace {
    return this.command(input.commandId, 'workspace:create', input, () => {
      const workspace: Workspace = { id: randomUUID(), name: input.name, positioning: input.positioning, createdAt: now() };
      this.database.prepare('INSERT INTO workspaces(id, document) VALUES (?,?)').run(workspace.id, json(workspace));
      return workspace;
    });
  }
  getWorkspace(id: string): Workspace {
    const found = this.one<Workspace>('SELECT document FROM workspaces WHERE id = ?', id);
    if (!found) throw new StoreError(404, 'Workspace not found');
    return found;
  }
  listWorks(workspaceId: string): Work[] {
    this.getWorkspace(workspaceId);
    return this.rows('SELECT document FROM works WHERE workspace_id = ? ORDER BY rowid DESC', workspaceId);
  }
  createWork(input: CreateWork): Work {
    return this.command(input.commandId, `work:create:${input.workspaceId}`, input, () => {
      this.getWorkspace(input.workspaceId);
      const { commandId: _commandId, ...fields } = input;
      const work: Work = { ...fields, id: randomUUID(), createdAt: now(), selectedArtifactId: null };
      this.database.prepare('INSERT INTO works(id, workspace_id, document) VALUES (?,?,?)').run(work.id, input.workspaceId, json(work));
      return work;
    });
  }
  getWork(workId: string, workspaceId: string): Work {
    const work = this.one<Work>('SELECT document FROM works WHERE id = ? AND workspace_id = ?', workId, workspaceId);
    if (!work) throw new StoreError(404, 'Work not found');
    return work;
  }
  detail(workId: string, workspaceId: string): WorkDetail {
    const work = this.getWork(workId, workspaceId);
    const jobs = this.rows<Job>('SELECT document FROM jobs WHERE work_id = ? ORDER BY rowid DESC', workId);
    const artifacts = this.rows<Artifact>('SELECT document FROM artifacts WHERE work_id = ? ORDER BY rowid', workId).map(a => this.verifyArtifact(a));
    const decisions = this.rows<Decision>('SELECT document FROM decisions WHERE work_id = ? ORDER BY rowid', workId);
    return { work, jobs, artifacts, decisions };
  }
  private active(workId: string): boolean {
    return !!this.database.prepare("SELECT 1 FROM jobs WHERE work_id = ? AND state IN ('queued','running')").get(workId);
  }
  private insertJob(work: Work, config: ExecutionConfig, parentArtifactId: string | null, feedback: string | null): Job {
    if (this.active(work.id)) throw new StoreError(409, 'Work already has an active job');
    const createdAt = now();
    const job: Job = { id: randomUUID(), workId: work.id, state: 'queued', runId: null, createdAt, updatedAt: createdAt,
      model: config.model, reasoningEffort: config.reasoningEffort, maxRevisions: config.maxRevisions,
      cancelRequested: false, error: null, parentArtifactId, feedback };
    const frozenConfig: ExecutionConfig = { model: config.model, reasoningEffort: config.reasoningEffort, maxRevisions: config.maxRevisions };
    const snapshot = json({ work, config: frozenConfig, parentArtifactId, feedback });
    this.database.prepare('INSERT INTO jobs(id, work_id, workspace_id, state, snapshot, document) VALUES (?,?,?,?,?,?)')
      .run(job.id, work.id, work.workspaceId, job.state, snapshot, json(job));
    return job;
  }
  start(workId: string, workspaceId: string, input: ExecutionConfig & { commandId: string }): Job {
    return this.command(input.commandId, `work:start:${workspaceId}:${workId}`, input, () => this.insertJob(this.getWork(workId, workspaceId), input, null, null));
  }
  revise(workId: string, workspaceId: string, input: RevisionInput): Job {
    return this.command(input.commandId, `work:revise:${workspaceId}:${workId}`, input, () => {
      const work = this.getWork(workId, workspaceId);
      const artifact = this.getArtifact(input.artifactId, workId);
      if (artifact.kind !== 'draft' || artifact.sha256 !== input.sha256) throw new StoreError(409, 'Revision parent is stale or is not a draft');
      return this.insertJob(work, input, artifact.id, input.feedback);
    });
  }
  decide(workId: string, workspaceId: string, input: DecisionInput): Decision {
    return this.command(input.commandId, `work:decision:${workspaceId}:${workId}`, input, () => {
      const work = this.getWork(workId, workspaceId);
      const artifact = this.getArtifact(input.artifactId, workId);
      if (artifact.kind !== 'draft' || artifact.sha256 !== input.sha256) throw new StoreError(409, 'Decision targets a stale or non-draft artifact');
      if (input.action === 'accept') {
        const job = this.getJob(artifact.jobId, workspaceId);
        if (job.state !== 'succeeded') throw new StoreError(409, 'Acceptance requires a completed workflow and passing review');
        const review = this.rows<Artifact>('SELECT document FROM artifacts WHERE job_id = ? ORDER BY rowid DESC', job.id)
          .find(a => a.kind === 'review' && a.dependencies.includes(artifact.id));
        if (!review || (this.verifyArtifact(review).payload as { verdict?: string }).verdict !== 'pass') throw new StoreError(409, 'Acceptance requires a passing review of this exact draft');
      }
      const decision: Decision = { id: randomUUID(), workId, artifactId: artifact.id, sha256: artifact.sha256,
        action: input.action, reason: input.reason, createdAt: now(), actor: 'user' };
      this.database.prepare('INSERT INTO decisions(id, work_id, document) VALUES (?,?,?)').run(decision.id, workId, json(decision));
      if (input.action === 'select' || input.action === 'accept') {
        const updated = { ...work, selectedArtifactId: artifact.id };
        this.database.prepare('UPDATE works SET document = ? WHERE id = ?').run(json(updated), workId);
      }
      return decision;
    });
  }
  getJob(jobId: string, workspaceId: string): Job {
    const job = this.one<Job>('SELECT document FROM jobs WHERE id = ? AND workspace_id = ?', jobId, workspaceId);
    if (!job) throw new StoreError(404, 'Job not found');
    return job;
  }
  getJobAny(jobId: string): Job | undefined { return this.one('SELECT document FROM jobs WHERE id = ?', jobId); }
  getSnapshot(jobId: string): { work: Work; config: ExecutionConfig; parentArtifactId: string | null; feedback: string | null } {
    const row = this.database.prepare('SELECT snapshot FROM jobs WHERE id = ?').get(jobId);
    if (!row) throw new StoreError(404, 'Job not found');
    return parse(String(row.snapshot));
  }
  private saveJob(job: Job): void {
    this.database.prepare('UPDATE jobs SET state = ?, document = ? WHERE id = ?').run(job.state, json(job), job.id);
  }
  claimNext(): Job | undefined {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const job = this.one<Job>("SELECT document FROM jobs WHERE state IN ('running','queued') ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END, rowid LIMIT 1");
      if (job && job.state === 'queued') this.saveJob({ ...job, state: 'running', updatedAt: now() });
      this.database.exec('COMMIT');
      return job ? this.getJobAny(job.id) : undefined;
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  bindRun(jobId: string, runId: string): void {
    const job = this.getJobAny(jobId);
    if (!job || job.state !== 'running') throw new StoreError(409, 'Job is not running');
    if (job.runId && job.runId !== runId) throw new StoreError(409, 'Job is bound to another run');
    this.saveJob({ ...job, runId, updatedAt: now() });
  }
  finish(jobId: string, state: Job['state'], error: string | null = null): Job {
    const job = this.getJobAny(jobId);
    if (!job) throw new StoreError(404, 'Job not found');
    if (job.state !== 'running') return job;
    const updated = { ...job, state, error, updatedAt: now() };
    this.saveJob(updated);
    return updated;
  }
  cancel(jobId: string, workspaceId: string, commandId: string): Job {
    return this.command(commandId, `job:cancel:${workspaceId}:${jobId}`, { commandId }, () => {
      const job = this.getJob(jobId, workspaceId);
      if (!['queued','running'].includes(job.state)) throw new StoreError(409, 'Only active jobs can be canceled');
      const updated: Job = { ...job, cancelRequested: true, state: job.state === 'queued' ? 'canceled' : 'running', updatedAt: now() };
      this.saveJob(updated);
      return updated;
    });
  }
  resume(jobId: string, workspaceId: string, commandId: string): Job {
    return this.command(commandId, `job:resume:${workspaceId}:${jobId}`, { commandId }, () => {
      const job = this.getJob(jobId, workspaceId);
      if (job.state !== 'failed') throw new StoreError(409, 'Only failed jobs can be resumed');
      if (this.active(job.workId)) throw new StoreError(409, 'Work already has an active job');
      const updated: Job = { ...job, state: 'queued', cancelRequested: false, error: null, updatedAt: now() };
      this.saveJob(updated);
      return updated;
    });
  }
  getArtifact(id: string, workId: string): Artifact {
    const artifact = this.one<Artifact>('SELECT document FROM artifacts WHERE id = ? AND work_id = ?', id, workId);
    if (!artifact) throw new StoreError(404, 'Artifact not found');
    return this.verifyArtifact(artifact);
  }
  private filePath(id: string): string { return join(this.stateRoot, 'artifacts', `${id}.json`); }
  private verifyArtifact(artifact: Artifact): Artifact {
    const path = this.filePath(artifact.id);
    let bytes: string;
    try { bytes = readFileSync(path, 'utf8'); } catch { throw new StoreError(409, 'Artifact file is missing'); }
    if (digest(bytes) !== artifact.sha256) throw new StoreError(409, 'Artifact file hash mismatch');
    const envelope = parse<{ content: string; payload: unknown }>(bytes);
    return { ...artifact, content: envelope.content, payload: envelope.payload };
  }
  registerArtifact(input: { workId: string; jobId: string; kind: Artifact['kind']; content: string; payload: unknown; vendorRef: ArtifactIdentity; dependencies: string[] }): Artifact {
    const prior = this.one<Artifact>('SELECT document FROM artifacts WHERE native_id = ?', input.vendorRef.id);
    if (prior) return this.verifyArtifact(prior);
    const id = input.vendorRef.id;
    const bytes = json({ content: input.content, payload: input.payload });
    const sha256 = digest(bytes);
    const path = this.filePath(id);
    if (existsSync(path)) {
      if (digest(readFileSync(path, 'utf8')) !== sha256) {
        // No business row exists. A prior process may have died while writing the old
        // final file; retain it for inspection, then rematerialize from native payload.
        renameSync(path, `${path}.quarantined-${randomUUID()}`);
        syncDirectory(join(this.stateRoot, 'artifacts'));
      }
    }
    if (!existsSync(path)) materializeArtifact(path, bytes);
    const artifact: Artifact = { id, workId: input.workId, jobId: input.jobId, kind: input.kind,
      sha256, content: input.content, payload: input.payload, vendorRef: input.vendorRef, createdAt: now(), dependencies: input.dependencies };
    this.database.prepare('INSERT OR IGNORE INTO artifacts(id, work_id, job_id, native_id, document) VALUES (?,?,?,?,?)')
      .run(id, input.workId, input.jobId, input.vendorRef.id, json(artifact));
    return this.verifyArtifact(this.one<Artifact>('SELECT document FROM artifacts WHERE id = ?', id)!);
  }
}
