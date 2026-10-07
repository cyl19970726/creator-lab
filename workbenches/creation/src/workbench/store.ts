import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonicalWorkflowValue, type ArtifactRef } from '@signal-room/workflow';
import type { PieceBrief } from '../stages/brief.js';
import type { Actor, CaseDetail, CaseInput, Command, Comparison, ComparisonInput, ControlRun, CreationCase, Decision, DecisionInput, Experiment, Incident, PreparedRun, Review, ReviewInput, Revision, RevisionInput, RunRequest, RunState, StoredArtifact, ValidatedAcceptance } from './contracts.js';

export class WorkbenchStoreError extends Error {
  constructor(public readonly status: 400 | 403 | 404 | 409, message: string) { super(message); }
}
const now = () => new Date().toISOString();
const document = (value: unknown) => JSON.stringify(canonicalWorkflowValue(value));
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stable(object[key])}`).join(',')}}`;
}
export const workbenchSha256 = (value: unknown): string => createHash('sha256').update(stable(canonicalWorkflowValue(value))).digest('hex');
const requireText = (value: unknown, name: string): void => { if (typeof value !== 'string' || !value.trim()) throw new WorkbenchStoreError(400, `${name} is required`); };
const isActive = (state: RunState) => state === 'queued' || state === 'running';
const deliverableTypes = new Set(['content-draft', 'b3-video']);

interface CommandRow { scope: string; hash: string; response: string }
export class WorkbenchStore {
  readonly database: DatabaseSync;
  readonly stateRoot: string;
  constructor(stateRoot: string) {
    this.stateRoot = stateRoot;
    mkdirSync(stateRoot, { recursive: true });
    this.database = new DatabaseSync(join(stateRoot, 'workbench.sqlite'));
    this.database.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS wb_cases (id TEXT PRIMARY KEY, document TEXT NOT NULL CHECK(json_valid(document)));
      CREATE TABLE IF NOT EXISTS wb_revisions (id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, sha256 TEXT NOT NULL, document TEXT NOT NULL CHECK(json_valid(document)), UNIQUE(workflow_id,sha256));
      CREATE TABLE IF NOT EXISTS wb_runs (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES wb_cases(id), revision_id TEXT NOT NULL REFERENCES wb_revisions(id), native_run_id TEXT UNIQUE, state TEXT NOT NULL, document TEXT NOT NULL CHECK(json_valid(document)));
      CREATE INDEX IF NOT EXISTS wb_runs_case ON wb_runs(case_id);
      CREATE UNIQUE INDEX IF NOT EXISTS wb_one_active_run ON wb_runs(case_id) WHERE state IN ('queued','running');
      CREATE UNIQUE INDEX IF NOT EXISTS wb_one_running_globally ON wb_runs((1)) WHERE state='running';
      CREATE TABLE IF NOT EXISTS wb_experiments (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES wb_cases(id), run_id TEXT NOT NULL UNIQUE REFERENCES wb_runs(id), baseline_run_id TEXT REFERENCES wb_runs(id), document TEXT NOT NULL CHECK(json_valid(document)));
      CREATE TABLE IF NOT EXISTS wb_artifacts (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES wb_cases(id), run_id TEXT NOT NULL REFERENCES wb_runs(id), native_id TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, document TEXT NOT NULL CHECK(json_valid(document)));
      CREATE INDEX IF NOT EXISTS wb_artifacts_case ON wb_artifacts(case_id);
      CREATE TABLE IF NOT EXISTS wb_reviews (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES wb_cases(id), artifact_id TEXT NOT NULL REFERENCES wb_artifacts(id), document TEXT NOT NULL CHECK(json_valid(document)));
      CREATE TABLE IF NOT EXISTS wb_comparisons (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES wb_cases(id), baseline_artifact_id TEXT NOT NULL REFERENCES wb_artifacts(id), candidate_artifact_id TEXT NOT NULL REFERENCES wb_artifacts(id), document TEXT NOT NULL CHECK(json_valid(document)));
      CREATE TABLE IF NOT EXISTS wb_decisions (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES wb_cases(id), document TEXT NOT NULL CHECK(json_valid(document)));
      CREATE TABLE IF NOT EXISTS wb_incidents (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES wb_runs(id), document TEXT NOT NULL CHECK(json_valid(document)));
      CREATE TABLE IF NOT EXISTS wb_briefs (id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES wb_cases(id), artifact_id TEXT NOT NULL UNIQUE REFERENCES wb_artifacts(id), document TEXT NOT NULL CHECK(json_valid(document)));
      CREATE TABLE IF NOT EXISTS wb_commands (id TEXT PRIMARY KEY, scope TEXT NOT NULL, hash TEXT NOT NULL, response TEXT NOT NULL CHECK(json_valid(response)));
    `);
  }
  close(): void { this.database.close(); }
  /** Worker startup only: API process restarts must not interrupt a live worker. */
  interruptOrphanedRuns(): ControlRun[] {
    return this.transaction(() => this.rows<ControlRun>("SELECT document FROM wb_runs WHERE state='running'").map(run =>
      this.updateRun({ ...run, state: 'interrupted', finishedAt: now(), error: 'Worker process stopped before completion' })));
  }
  private rows<T>(sql: string, ...args: string[]): T[] { return this.database.prepare(sql).all(...args).map(row => parse<T>(row.document)); }
  private one<T>(sql: string, ...args: string[]): T | undefined { return this.rows<T>(sql, ...args)[0]; }
  private transaction<T>(action: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.database.exec('COMMIT'); return result; }
    catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
  private command<T>(commandId: string, scope: string, actor: Actor, body: unknown, action: () => T): T {
    requireText(commandId, 'commandId'); this.checkActor(actor);
    const hash = workbenchSha256({ actor, body });
    return this.transaction(() => {
      const prior = this.database.prepare('SELECT scope,hash,response FROM wb_commands WHERE id=?').get(commandId) as unknown as CommandRow | undefined;
      if (prior) {
        if (prior.scope !== scope || prior.hash !== hash) throw new WorkbenchStoreError(409, 'Command ID was already used with another actor, scope or body');
        return parse<T>(prior.response);
      }
      const result = action();
      this.database.prepare('INSERT INTO wb_commands(id,scope,hash,response) VALUES (?,?,?,?)').run(commandId, scope, hash, document(result));
      return result;
    });
  }
  private checkActor(actor: Actor): void {
    if (!actor || !['user','agent'].includes(actor.kind)) throw new WorkbenchStoreError(400, 'Actor kind is required');
    requireText(actor.id, 'actor.id');
  }
  getCase(id: string): CreationCase {
    const value = this.one<CreationCase>('SELECT document FROM wb_cases WHERE id=?', id);
    if (!value) throw new WorkbenchStoreError(404, 'Case not found');
    return value;
  }
  listCases(): CreationCase[] { return this.rows('SELECT document FROM wb_cases ORDER BY rowid DESC'); }
  createCase(input: CaseInput & Command, actor: Actor): CreationCase {
    return this.command(input.commandId, 'case:create', actor, input, () => {
      requireText(input.title, 'title'); requireText(input.opportunity, 'opportunity'); requireText(input.readerGoal, 'readerGoal');
      if (!input.requiredQuestions?.length || !input.materials?.length) throw new WorkbenchStoreError(400, 'Questions and materials are required');
      const { commandId: _commandId, ...fields } = input;
      const record: CreationCase = { id: randomUUID(), input: canonicalWorkflowValue(fields), inputHash: workbenchSha256(fields), createdAt: now() };
      this.database.prepare('INSERT INTO wb_cases(id,document) VALUES (?,?)').run(record.id, document(record));
      return record;
    });
  }
  detail(caseId: string): CaseDetail {
    const theCase = this.getCase(caseId);
    const artifacts = this.rows<StoredArtifact>('SELECT document FROM wb_artifacts WHERE case_id=? ORDER BY rowid', caseId).map(artifact => this.getArtifact(artifact.id));
    return { case: theCase, runs: this.listRuns(caseId), artifacts,
      reviews: this.rows('SELECT document FROM wb_reviews WHERE case_id=? ORDER BY rowid', caseId),
      comparisons: this.rows('SELECT document FROM wb_comparisons WHERE case_id=? ORDER BY rowid', caseId),
      decisions: this.rows('SELECT document FROM wb_decisions WHERE case_id=? ORDER BY rowid', caseId),
      experiments: this.rows('SELECT document FROM wb_experiments WHERE case_id=? ORDER BY rowid', caseId),
      incidents: this.rows('SELECT document FROM wb_incidents WHERE run_id IN (SELECT id FROM wb_runs WHERE case_id=?) ORDER BY rowid', caseId),
      briefs: this.rows('SELECT document FROM wb_briefs WHERE case_id=? ORDER BY rowid', caseId) };
  }
  getRun(id: string): ControlRun {
    const run = this.one<ControlRun>('SELECT document FROM wb_runs WHERE id=?', id);
    if (!run) throw new WorkbenchStoreError(404, 'Run not found');
    return run;
  }
  listRuns(caseId?: string): ControlRun[] {
    if (caseId) this.getCase(caseId);
    return caseId ? this.rows('SELECT document FROM wb_runs WHERE case_id=? ORDER BY rowid DESC', caseId) : this.rows('SELECT document FROM wb_runs ORDER BY rowid DESC');
  }
  listArtifacts(runId: string): StoredArtifact[] {
    this.getRun(runId);
    return this.rows<StoredArtifact>('SELECT document FROM wb_artifacts WHERE run_id=? ORDER BY rowid', runId).map(artifact => this.getArtifact(artifact.id));
  }
  getRevision(id: string): Revision {
    const revision = this.one<Revision>('SELECT document FROM wb_revisions WHERE id=?', id);
    if (!revision) throw new WorkbenchStoreError(404, 'Revision not found');
    return revision;
  }
  listRevisions(): Revision[] { return this.rows('SELECT document FROM wb_revisions ORDER BY rowid DESC'); }
  registerRevision(input: RevisionInput): Revision {
    if (input.workflowId !== 'creation.content' && input.workflowId !== 'creation.b3') throw new WorkbenchStoreError(400, 'Unknown workflow');
    const frozen = canonicalWorkflowValue(input);
    const sha256 = workbenchSha256(frozen);
    const existing = this.one<Revision>('SELECT document FROM wb_revisions WHERE workflow_id=? AND sha256=?', input.workflowId, sha256);
    if (existing) return existing;
    const revision: Revision = { ...frozen, id: randomUUID(), sha256, createdAt: now() };
    this.database.prepare('INSERT OR IGNORE INTO wb_revisions(id,workflow_id,sha256,document) VALUES (?,?,?,?)').run(revision.id, revision.workflowId, sha256, document(revision));
    return this.one<Revision>('SELECT document FROM wb_revisions WHERE workflow_id=? AND sha256=?', input.workflowId, sha256)!;
  }
  createRun(caseId: string, request: RunRequest, actor: Actor, prepare: (runId: string) => PreparedRun): ControlRun {
    return this.command(request.commandId, `run:create:${caseId}`, actor, request, () => {
      this.getCase(caseId);
      if (actor.kind !== 'user') throw new WorkbenchStoreError(403, 'Agent execution requires explicit delegated authority');
      if (request.workflowId === 'creation.b3' && !this.getAcceptedBrief(caseId)) throw new WorkbenchStoreError(409, 'Production requires an accepted content brief');
      if (this.database.prepare("SELECT 1 FROM wb_runs WHERE case_id=? AND state IN ('queued','running')").get(caseId)) throw new WorkbenchStoreError(409, 'Case already has an active run');
      if (request.baselineRunId) {
        const baseline = this.getRun(request.baselineRunId);
        if (baseline.caseId !== caseId || baseline.workflowId !== request.workflowId) throw new WorkbenchStoreError(409, 'Baseline run belongs to another scope');
      }
      const runId = randomUUID();
      const prepared = prepare(runId);
      if (!prepared || !prepared.revision || prepared.revision.workflowId !== request.workflowId) throw new WorkbenchStoreError(409, 'Prepared revision does not match requested workflow');
      const revision = this.registerRevision(prepared.revision);
      const input = canonicalWorkflowValue(prepared.input);
      const preparedEvidence = prepared.deployment === undefined ? null : canonicalWorkflowValue(prepared.deployment);
      const { commandId: _commandId, ...configuration } = request;
      const run: ControlRun = { id: runId, caseId, workflowId: request.workflowId, revisionId: revision.id, experimentId: randomUUID(), nativeRunId: null,
        state: 'queued', input, inputHash: workbenchSha256(input), config: canonicalWorkflowValue(configuration), createdAt: now(), startedAt: null,
        finishedAt: null, error: null, terminal: null, cancelRequested: false,
        preparedEvidence, preparedHash: preparedEvidence === null ? null : workbenchSha256(preparedEvidence) };
      const experiment: Experiment = { id: run.experimentId, caseId, runId, baselineRunId: request.baselineRunId ?? null, hypothesis: request.hypothesis, createdAt: run.createdAt };
      this.database.prepare('INSERT INTO wb_runs(id,case_id,revision_id,native_run_id,state,document) VALUES (?,?,?,?,?,?)').run(run.id, caseId, run.revisionId, null, run.state, document(run));
      this.database.prepare('INSERT INTO wb_experiments(id,case_id,run_id,baseline_run_id,document) VALUES (?,?,?,?,?)').run(experiment.id,caseId,runId,experiment.baselineRunId,document(experiment));
      return run;
    });
  }
  private updateRun(run: ControlRun): ControlRun {
    this.database.prepare('UPDATE wb_runs SET native_run_id=?,state=?,document=? WHERE id=?').run(run.nativeRunId,run.state,document(run),run.id);
    return run;
  }
  claimNext(): ControlRun | undefined {
    return this.transaction(() => {
      if (this.database.prepare("SELECT 1 FROM wb_runs WHERE state='running'").get()) return undefined;
      const run = this.one<ControlRun>("SELECT document FROM wb_runs WHERE state='queued' ORDER BY rowid LIMIT 1");
      return run ? this.updateRun({ ...run, state: 'running', startedAt: now(), finishedAt: null, error: null }) : undefined;
    });
  }
  bindRun(controlId: string, nativeId: string): ControlRun {
    requireText(nativeId, 'nativeId');
    const run = this.getRun(controlId);
    if (run.state !== 'running' || (run.nativeRunId && run.nativeRunId !== nativeId)) throw new WorkbenchStoreError(409, 'Run is not active or is bound to another native run');
    // Native create may call this while its own SQLite operation is in progress. Do not open a nested transaction.
    const native = this.database.prepare('SELECT id FROM workflow_runs WHERE id=?').get(nativeId);
    if (!native) throw new WorkbenchStoreError(409, 'Native workflow run not found');
    return this.updateRun({ ...run, nativeRunId: nativeId });
  }
  finishRun(id: string, state: RunState, terminal: unknown = null, error: string | null = null): ControlRun {
    const run = this.getRun(id);
    if (run.state !== 'running') throw new WorkbenchStoreError(409, 'Run is not running');
    if (isActive(state)) throw new WorkbenchStoreError(400, 'Terminal state required');
    return this.updateRun({ ...run, state, terminal: canonicalWorkflowValue(terminal), error, finishedAt: now() });
  }
  saveArtifact(runId: string, nativeRef: ArtifactRef, payload: unknown): StoredArtifact {
    const run = this.getRun(runId);
    if (!run.nativeRunId || nativeRef.producedBy.workflowRunId !== run.nativeRunId) throw new WorkbenchStoreError(409, 'Artifact native run does not match control run');
    const canonicalPayload = canonicalWorkflowValue(payload);
    if (nativeRef.sha256 !== workbenchSha256(canonicalPayload)) throw new WorkbenchStoreError(409, 'Artifact payload SHA-256 mismatch');
    const nativeRow = this.database.prepare('SELECT document,payload FROM workflow_artifacts WHERE id=? AND run_id=?').get(nativeRef.id, run.nativeRunId);
    if (!nativeRow || workbenchSha256(parse(nativeRow.payload)) !== nativeRef.sha256 || workbenchSha256(parse(nativeRow.document)) !== workbenchSha256(nativeRef)) throw new WorkbenchStoreError(409, 'Native artifact does not match exact reference and payload');
    const existing = this.one<StoredArtifact>('SELECT document FROM wb_artifacts WHERE native_id=?', nativeRef.id);
    if (existing) {
      if (existing.runId !== runId || existing.sha256 !== nativeRef.sha256) throw new WorkbenchStoreError(409, 'Native artifact is already bound differently');
      return this.getArtifact(existing.id);
    }
    const artifact: StoredArtifact = { id: nativeRef.id, caseId: run.caseId, runId, nativeRef: canonicalWorkflowValue(nativeRef), sha256: nativeRef.sha256, payload: canonicalPayload, createdAt: now() };
    this.database.prepare('INSERT OR IGNORE INTO wb_artifacts(id,case_id,run_id,native_id,sha256,document) VALUES (?,?,?,?,?,?)').run(artifact.id,artifact.caseId,runId,nativeRef.id,artifact.sha256,document(artifact));
    const persisted = this.getArtifact(artifact.id);
    if (persisted.runId !== runId || persisted.sha256 !== artifact.sha256) throw new WorkbenchStoreError(409, 'Native artifact is already bound differently');
    return persisted;
  }
  getArtifact(id: string): StoredArtifact {
    const artifact = this.one<StoredArtifact>('SELECT document FROM wb_artifacts WHERE id=?', id);
    if (!artifact) throw new WorkbenchStoreError(404, 'Artifact not found');
    if (workbenchSha256(artifact.payload) !== artifact.sha256 || artifact.nativeRef.sha256 !== artifact.sha256) throw new WorkbenchStoreError(409, 'Stored artifact integrity check failed');
    return artifact;
  }
  private exactArtifact(caseId: string, id: string, sha256: string): StoredArtifact {
    const artifact = this.getArtifact(id);
    if (artifact.caseId !== caseId || artifact.sha256 !== sha256) throw new WorkbenchStoreError(409, 'Artifact case or SHA-256 does not match');
    return artifact;
  }
  cancelRun(id: string, command: Command, actor: Actor): ControlRun {
    return this.command(command.commandId, `run:cancel:${id}`, actor, command, () => {
      if (actor.kind !== 'user') throw new WorkbenchStoreError(403, 'Agent cannot cancel execution');
      const run = this.getRun(id);
      if (!isActive(run.state)) throw new WorkbenchStoreError(409, 'Run is not active');
      return this.updateRun(run.state === 'queued' ? { ...run, state: 'canceled', finishedAt: now() } : { ...run, cancelRequested: true });
    });
  }
  resumeRun(id: string, command: Command, actor: Actor): ControlRun {
    return this.command(command.commandId, `run:resume:${id}`, actor, command, () => {
      if (actor.kind !== 'user') throw new WorkbenchStoreError(403, 'Agent cannot resume execution');
      const run = this.getRun(id);
      if (run.state !== 'failed' && run.state !== 'interrupted') throw new WorkbenchStoreError(409, 'Only failed or interrupted runs can resume');
      if (!run.nativeRunId) throw new WorkbenchStoreError(409, 'No native run checkpoint exists; create a new candidate');
      if (this.database.prepare("SELECT 1 FROM wb_runs WHERE case_id=? AND state IN ('queued','running')").get(run.caseId)) throw new WorkbenchStoreError(409, 'Case already has an active run');
      return this.updateRun({ ...run, state: 'queued', startedAt: null, finishedAt: null, error: null, terminal: null, cancelRequested: false });
    });
  }
  saveReview(caseId: string, input: ReviewInput, actor: Actor): Review {
    return this.command(input.commandId, `review:create:${caseId}`, actor, input, () => {
      this.getCase(caseId); const artifact = this.exactArtifact(caseId,input.artifactId,input.sha256);
      if (!deliverableTypes.has(artifact.nativeRef.type)) throw new WorkbenchStoreError(409, 'Business review requires a deliverable artifact');
      for (const key of ['good','bad','improvement','unsatisfied','standardVersion'] as const) requireText(input[key],key);
      if (Boolean(input.baselineArtifactId) !== Boolean(input.baselineSha256)) throw new WorkbenchStoreError(400, 'Baseline ID and SHA-256 must be paired');
      if (input.baselineArtifactId && input.baselineSha256) {
        const baseline = this.exactArtifact(caseId,input.baselineArtifactId,input.baselineSha256);
        if (baseline.id === artifact.id || baseline.nativeRef.type !== artifact.nativeRef.type || this.getRun(baseline.runId).workflowId !== this.getRun(artifact.runId).workflowId) {
          throw new WorkbenchStoreError(409, 'Review baseline must be a different deliverable from the same workflow and type');
        }
      }
      if (actor.kind === 'agent') {
        if (!input.evaluator) throw new WorkbenchStoreError(400, 'Agent evaluator metadata is required');
        requireText(input.evaluator.model,'evaluator.model'); requireText(input.evaluator.promptRevision,'evaluator.promptRevision');
        if (!Array.isArray(input.evaluator.visibleMaterials)) throw new WorkbenchStoreError(400, 'Agent visible materials are required');
      } else if (input.evaluator) {
        throw new WorkbenchStoreError(400, 'Human reviews cannot carry Agent evaluator identity');
      }
      const { commandId: _commandId, ...fields } = input;
      const review: Review = { ...canonicalWorkflowValue(fields), id: randomUUID(), caseId, actor, createdAt: now() };
      this.database.prepare('INSERT INTO wb_reviews(id,case_id,artifact_id,document) VALUES (?,?,?,?)').run(review.id,caseId,review.artifactId,document(review));
      return review;
    });
  }
  private getReview(id: string): Review {
    const review = this.one<Review>('SELECT document FROM wb_reviews WHERE id=?', id);
    if (!review) throw new WorkbenchStoreError(404, 'Review not found');
    return review;
  }
  saveComparison(caseId: string, input: ComparisonInput, actor: Actor): Comparison {
    return this.command(input.commandId, `comparison:create:${caseId}`, actor, input, () => {
      if (actor.kind !== 'user') throw new WorkbenchStoreError(403, 'Only a user may compare for business decisions');
      this.getCase(caseId);
      const baseline = this.exactArtifact(caseId,input.baselineArtifactId,input.baselineSha256);
      const candidate = this.exactArtifact(caseId,input.candidateArtifactId,input.candidateSha256);
      if (baseline.id === candidate.id) throw new WorkbenchStoreError(400, 'Comparison requires two assets');
      if (!deliverableTypes.has(baseline.nativeRef.type) || baseline.nativeRef.type !== candidate.nativeRef.type) throw new WorkbenchStoreError(409, 'Comparison requires the same deliverable type');
      const baselineRun = this.getRun(baseline.runId); const candidateRun = this.getRun(candidate.runId);
      if (baselineRun.workflowId !== candidateRun.workflowId) throw new WorkbenchStoreError(409, 'Comparison workflow mismatch');
      const baselineReview = this.getReview(input.baselineReviewId); const candidateReview = this.getReview(input.candidateReviewId);
      if (baselineReview.caseId !== caseId || baselineReview.artifactId !== baseline.id || baselineReview.sha256 !== baseline.sha256 || candidateReview.caseId !== caseId || candidateReview.artifactId !== candidate.id || candidateReview.sha256 !== candidate.sha256) throw new WorkbenchStoreError(409, 'Comparison review does not bind exact artifacts');
      if ((candidateReview.baselineArtifactId || candidateReview.baselineSha256) &&
          (candidateReview.baselineArtifactId !== baseline.id || candidateReview.baselineSha256 !== baseline.sha256)) {
        throw new WorkbenchStoreError(409, 'Candidate review baseline does not match the comparison baseline');
      }
      for (const review of [baselineReview,candidateReview]) for (const key of ['good','bad','improvement','unsatisfied','standardVersion'] as const) requireText(review[key],`review.${key}`);
      requireText(input.differences,'differences'); requireText(input.conclusion,'conclusion');
      const sameStandard = baselineReview.standardVersion === candidateReview.standardVersion;
      const { commandId: _commandId, ...fields } = input;
      const comparison: Comparison = { ...canonicalWorkflowValue(fields), id: randomUUID(), caseId, workflowId: baselineRun.workflowId, actor, createdAt: now(),
        conditions: { ...canonicalWorkflowValue(input.conditions), observed: {
          sameInput: baselineRun.inputHash === candidateRun.inputHash, baselineInputHash: baselineRun.inputHash, candidateInputHash: candidateRun.inputHash,
          baselineRevisionId: baselineRun.revisionId, candidateRevisionId: candidateRun.revisionId,
          baselineConfig: baselineRun.config, candidateConfig: candidateRun.config,
          baselineStandardVersion: baselineReview.standardVersion, candidateStandardVersion: candidateReview.standardVersion,
          sameStandard, comparabilityLimitation: sameStandard ? null : 'Reviews use different standard versions; this comparison cannot establish a like-for-like quality improvement.',
        } } };
      this.database.prepare('INSERT INTO wb_comparisons(id,case_id,baseline_artifact_id,candidate_artifact_id,document) VALUES (?,?,?,?,?)').run(comparison.id,caseId,baseline.id,candidate.id,document(comparison));
      return comparison;
    });
  }
  decide(caseId: string, input: DecisionInput, actor: Actor, acceptance?: ValidatedAcceptance | (() => ValidatedAcceptance)): Decision {
    return this.command(input.commandId, `decision:create:${caseId}`, actor, input, () => {
      this.getCase(caseId);
      if (actor.kind !== 'user') throw new WorkbenchStoreError(403, 'Agent review does not grant adoption authority');
      requireText(input.reason,'reason');
      // Resolve gate evidence after the command replay check and under the write lock.
      const needsGate = input.kind === 'artifact' ? input.action === 'adopt' : input.action === 'adopt' || input.action === 'rollback';
      const verified = needsGate ? (typeof acceptance === 'function' ? acceptance() : acceptance) : undefined;
      if (input.kind === 'artifact') {
        this.exactArtifact(caseId,input.artifactId,input.sha256);
        const review = this.getReview(input.reviewId);
        if (review.caseId !== caseId || review.artifactId !== input.artifactId || review.sha256 !== input.sha256) throw new WorkbenchStoreError(409, 'Decision review does not bind exact artifact');
        if (input.action === 'adopt') {
          if (!verified || verified.kind !== 'artifact' || verified.actorId !== actor.id || verified.artifactId !== input.artifactId || verified.sha256 !== input.sha256 || verified.reviewId !== input.reviewId) throw new WorkbenchStoreError(403, 'Validated artifact gate acceptance is required');
          if (review.verdict !== 'pass' || review.actor.kind !== 'user') throw new WorkbenchStoreError(409, 'Human passing review of exact artifact is required');
          const artifact = this.getArtifact(input.artifactId);
          if (artifact.nativeRef.type === 'content-draft' && (!verified.brief || verified.brief.topicId !== caseId)) {
            throw new WorkbenchStoreError(409, 'Content adoption requires a brief for the same case');
          }
        }
      } else {
        this.getRevision(input.revisionId);
        const comparison = this.one<Comparison>('SELECT document FROM wb_comparisons WHERE id=?', input.comparisonId);
        if (!comparison || comparison.caseId !== caseId) throw new WorkbenchStoreError(409, 'Workflow comparison does not match case');
        const targetArtifact = this.getArtifact(input.action === 'rollback' ? comparison.baselineArtifactId : comparison.candidateArtifactId);
        const targetRevision = this.getRun(targetArtifact.runId).revisionId;
        const baselineRevision = this.getRun(this.getArtifact(comparison.baselineArtifactId).runId).revisionId;
        const candidateRevision = this.getRun(this.getArtifact(comparison.candidateArtifactId).runId).revisionId;
        if (input.action === 'observe' ? input.revisionId !== baselineRevision && input.revisionId !== candidateRevision : targetRevision !== input.revisionId) {
          throw new WorkbenchStoreError(409, 'Workflow decision revision is not the selected comparison side');
        }
        if (input.action === 'adopt' || input.action === 'rollback') {
          const baselineReview = this.getReview(comparison.baselineReviewId), candidateReview = this.getReview(comparison.candidateReviewId);
          if (baselineReview.standardVersion !== candidateReview.standardVersion) throw new WorkbenchStoreError(409, 'Workflow adoption requires reviews under one standard version');
          if (!verified || verified.kind !== 'workflow' || verified.actorId !== actor.id || verified.revisionId !== input.revisionId || verified.comparisonId !== input.comparisonId) throw new WorkbenchStoreError(403, 'Validated workflow gate acceptance is required');
        }
      }
      const decision: Decision = { id: randomUUID(), caseId, actor, createdAt: now(), input: canonicalWorkflowValue(input) };
      this.database.prepare('INSERT INTO wb_decisions(id,case_id,document) VALUES (?,?,?)').run(decision.id,caseId,document(decision));
      if (input.kind === 'artifact' && input.action === 'adopt' && verified?.kind === 'artifact' && verified.brief) {
        const brief = canonicalWorkflowValue(verified.brief);
        if (!this.database.prepare('SELECT 1 FROM wb_briefs WHERE artifact_id=?').get(input.artifactId)) {
          this.database.prepare('INSERT INTO wb_briefs(id,case_id,artifact_id,document) VALUES (?,?,?,?)').run(randomUUID(),caseId,input.artifactId,document(brief));
        }
      }
      return decision;
    });
  }
  getBrief(caseId: string): PieceBrief | undefined {
    this.getCase(caseId);
    return this.one('SELECT document FROM wb_briefs WHERE case_id=? ORDER BY rowid DESC LIMIT 1', caseId);
  }
  getAcceptedBrief(caseId: string): PieceBrief | undefined {
    this.getCase(caseId);
    const decisions = this.rows<Decision>('SELECT document FROM wb_decisions WHERE case_id=? ORDER BY rowid',caseId);
    let selectedId: string | undefined;
    for (const decision of decisions) {
      const input = decision.input;
      if (input.kind !== 'artifact') continue;
      const artifact = this.getArtifact(input.artifactId);
      if (artifact.nativeRef.type !== 'content-draft') continue;
      if (input.action === 'adopt') selectedId = input.artifactId;
      else if (input.action === 'reject' && selectedId === input.artifactId) selectedId = undefined;
    }
    return selectedId ? this.one<PieceBrief>('SELECT document FROM wb_briefs WHERE case_id=? AND artifact_id=?',caseId,selectedId) : undefined;
  }
  saveIncident(runId: string, error: string): Incident {
    this.getRun(runId); requireText(error,'error');
    const incident: Incident = { id: randomUUID(), runId, error, createdAt: now() };
    this.database.prepare('INSERT INTO wb_incidents(id,run_id,document) VALUES (?,?,?)').run(incident.id,runId,document(incident));
    return incident;
  }
  listIncidents(runId: string): Incident[] { this.getRun(runId); return this.rows('SELECT document FROM wb_incidents WHERE run_id=? ORDER BY rowid',runId); }
}
