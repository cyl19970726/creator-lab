import { creatorWorkerConcurrency } from "../../core/config.js";
import { creatorResearchEventSchema, creatorResearchRunSchema,
  type CreatorAcquisitionAdapter, type CreatorResearchEvent, type CreatorResearchRun } from "../../../../contracts/index.js";
import type { AppendEventInput, CreatorResearchRepository, ResearchJobLane } from "../../../../research/index.js";
import { researchJobSchema, type ResearchJob, type ResearchJobStatus } from "../../../../research/index.js";
import { AnalysisPgContext, type AnalysisLeaseGuard } from "./analysis-pg-context.js";

type RunRow = { run_json: CreatorResearchRun };
type JobRow = { id: string; run_id: string; node_key: string; status: string; idempotency_key: string;
  attempts: number; max_attempts: number; available_at: string; lease_owner: string | null;
  lease_expires_at: string | null; heartbeat_at: string | null; payload_json: unknown;
  last_error: string | null; created_at: string; updated_at: string };
type EventRow = { sequence: string | number; run_id: string; job_id: string | null; type: string;
  created_at: string; message: string; payload_json: unknown };

const postControlRevisions = new Set(["v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9", "v10", "v11"]);
const creatorControlRevisions = new Set(["v2", "v3", "v4", "v5", "v6", "v7", "v8"]);
const activeStates = new Set(["leased", "running"]);

function payload(job: JobRow): Record<string, unknown> {
  const value = typeof job.payload_json === "string" ? JSON.parse(job.payload_json) : job.payload_json;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function workflowId(job: JobRow): string | undefined {
  const value = payload(job).workflowId;
  return typeof value === "string" ? value : undefined;
}
function workflowRevision(job: JobRow): string | undefined {
  const value = payload(job).workflowRevision;
  return typeof value === "string" ? value : undefined;
}
function legacyPost(job: JobRow): boolean {
  return job.node_key === "workflow.advance" && workflowId(job) === "post.analyze"
    && (workflowRevision(job) ?? "v1") === "v1";
}
function postWorker(job: JobRow): boolean {
  return job.node_key === "workflow.advance" && ["post.source-check", "post.build", "post.review",
    "post.repair", "post.repair-evaluation"].includes(workflowId(job) ?? "");
}
function videoWork(job: JobRow): boolean {
  return job.node_key === "video.reconstruct" || postWorker(job) || legacyPost(job);
}
function postVideoWork(job: JobRow): boolean { return postWorker(job) || legacyPost(job); }
function workflowControl(job: JobRow): boolean {
  if (job.node_key !== "workflow.advance") return false;
  const id = workflowId(job), revision = workflowRevision(job);
  return id === "creator.analyze" || (id === "post.analyze" && postControlRevisions.has(revision ?? ""))
    || (id === "creator.synthesize" && creatorControlRevisions.has(revision ?? ""));
}
function laneMatches(lane: ResearchJobLane, job: JobRow, run: CreatorResearchRun): boolean {
  if (lane === "any") return true;
  if (lane === "redfox" || lane === "ego-browser") return ["creator.acquire", "creator.enrich"].includes(job.node_key)
    && run.collectionPolicy?.adapter === lane;
  if (lane === "portfolio") return job.node_key === "creator.portfolio";
  if (lane === "video") return videoWork(job);
  return job.node_key === "creator.synthesize" || (job.node_key === "workflow.advance"
    && (["creator.analyze", "creator.synthesize", "creator.build", "creator.review", "creator.repair"].includes(workflowId(job) ?? "")
      || (workflowId(job) === "post.analyze" && postControlRevisions.has(workflowRevision(job) ?? ""))));
}
function active(job: JobRow, now: string): boolean {
  return activeStates.has(job.status) && (job.lease_expires_at ?? "9999-12-31T23:59:59.999Z") > now;
}
function parseJob(row: JobRow): ResearchJob {
  return researchJobSchema.parse({ id: row.id, runId: row.run_id, nodeKey: row.node_key, status: row.status,
    idempotencyKey: row.idempotency_key, attempts: row.attempts, maxAttempts: row.max_attempts,
    availableAt: row.available_at, leaseOwner: row.lease_owner, leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at, payload: payload(row), lastError: row.last_error,
    createdAt: row.created_at, updatedAt: row.updated_at });
}
function parseEvent(row: EventRow): CreatorResearchEvent {
  const sequence = Number(row.sequence);
  if (!Number.isSafeInteger(sequence)) throw new Error("Research event sequence exceeds safe integer range");
  return creatorResearchEventSchema.parse({ sequence, runId: row.run_id, jobId: row.job_id, type: row.type,
    createdAt: row.created_at, message: row.message, payload: row.payload_json });
}

/** PostgreSQL implementation of the existing research queue and run projections. */
export class PostgresCreatorResearchRepository implements CreatorResearchRepository {
  constructor(private readonly context: AnalysisPgContext) {}

  runWithJobLease<T>(jobId: string, workerId: string, attempts: number,
    operation: () => Promise<T>): Promise<T> {
    return this.context.runWithJobLease(jobId, workerId, attempts, operation);
  }

  withRunTransaction<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    return this.context.transaction(async () => {
      // Match every job-owned write's lock order: lease row, then creator row.
      await this.context.assertLease(undefined, runId);
      const result = await this.context.query<{ id:string }>(
        "SELECT id FROM analysis_creator_runs WHERE id=$1 FOR UPDATE",[runId]);
      if (!result.rows[0]) throw new Error(`Creator run not found: ${runId}`);
      return operation();
    });
  }

  async save(run: CreatorResearchRun, guard?: AnalysisLeaseGuard): Promise<void> {
    const value = creatorResearchRunSchema.parse(run);
    await this.context.transaction(async () => {
      await this.context.assertLease(guard, value.id);
      await this.context.query(`INSERT INTO analysis_creator_runs
      (id,profile_url,status,current_stage,creator_id,created_at,updated_at,run_json)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
      ON CONFLICT(id) DO UPDATE SET profile_url=excluded.profile_url,status=excluded.status,
      current_stage=excluded.current_stage,creator_id=excluded.creator_id,
      updated_at=excluded.updated_at,run_json=excluded.run_json`,
      [value.id,value.profileUrl,value.status,value.currentStage,value.creatorId,value.createdAt,
        value.updatedAt,JSON.stringify(value)]);
    });
  }

  async get(id: string): Promise<CreatorResearchRun | null> {
    const result = await this.context.query<RunRow>("SELECT run_json FROM analysis_creator_runs WHERE id=$1", [id]);
    return result.rows[0] ? creatorResearchRunSchema.parse(result.rows[0].run_json) : null;
  }

  async list(limit = 50): Promise<CreatorResearchRun[]> {
    const bounded = Number.isFinite(limit) ? Math.min(100,Math.max(1,Math.trunc(limit))) : 50;
    const result = await this.context.query<RunRow>(
      "SELECT run_json FROM analysis_creator_runs ORDER BY updated_at DESC,id DESC LIMIT $1", [bounded]);
    return result.rows.map((row) => creatorResearchRunSchema.parse(row.run_json));
  }

  async findLatestByProfileUrl(profileUrl: string): Promise<CreatorResearchRun | null> {
    const result = await this.context.query<RunRow>(
      "SELECT run_json FROM analysis_creator_runs WHERE profile_url=$1 ORDER BY updated_at DESC,id DESC LIMIT 1", [profileUrl]);
    return result.rows[0] ? creatorResearchRunSchema.parse(result.rows[0].run_json) : null;
  }

  async findLatestByProfileUrlAndAdapter(profileUrl: string, adapter: CreatorAcquisitionAdapter): Promise<CreatorResearchRun | null> {
    const result = await this.context.query<RunRow>(`SELECT run_json FROM analysis_creator_runs
      WHERE profile_url=$1 AND run_json #>> '{collectionPolicy,adapter}'=$2 ORDER BY updated_at DESC,id DESC LIMIT 1`,
      [profileUrl,adapter]);
    return result.rows[0] ? creatorResearchRunSchema.parse(result.rows[0].run_json) : null;
  }

  async enqueue(job: ResearchJob): Promise<ResearchJob> {
    const value = researchJobSchema.parse(job);
    return this.context.transaction(async () => {
      await this.context.assertLease(undefined, value.runId);
      await this.context.query(`INSERT INTO analysis_research_jobs
      (id,run_id,node_key,status,idempotency_key,attempts,max_attempts,available_at,lease_owner,
       lease_expires_at,heartbeat_at,payload_json,last_error,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15)
      ON CONFLICT(idempotency_key) DO NOTHING`,
      [value.id,value.runId,value.nodeKey,value.status,value.idempotencyKey,value.attempts,value.maxAttempts,
        value.availableAt,value.leaseOwner,value.leaseExpiresAt,value.heartbeatAt,
        JSON.stringify(value.payload),value.lastError,value.createdAt,value.updatedAt]);
      const result = await this.context.query<JobRow>("SELECT * FROM analysis_research_jobs WHERE idempotency_key=$1", [value.idempotencyKey]);
      if (!result.rows[0]) throw new Error("任务写入失败");
      return parseJob(result.rows[0]);
    });
  }

  async cancelWorkflowJobs(runId: string, workflowRunId: string, updatedAt: string): Promise<number> {
    const result = await this.context.query(`UPDATE analysis_research_jobs
      SET status='canceled',lease_owner=NULL,lease_expires_at=NULL,heartbeat_at=NULL,
        last_error='workflow_canceled',updated_at=$3
      WHERE run_id=$1 AND node_key='workflow.advance' AND payload_json->>'workflowRunId'=$2
        AND status IN ('queued','backoff','needs_user')
        AND NOT EXISTS (SELECT 1 FROM analysis_imported_jobs imported WHERE imported.job_id=analysis_research_jobs.id)`,
      [runId,workflowRunId,updatedAt]);
    return result.rowCount ?? 0;
  }

  async requeueRun(runId: string, availableAt: string): Promise<ResearchJob | null> {
    return this.context.transaction(async () => {
      const result = await this.context.query<JobRow>(`SELECT * FROM analysis_research_jobs
        WHERE run_id=$1 AND status IN ('needs_user','backoff','failed')
          AND NOT EXISTS (SELECT 1 FROM analysis_imported_jobs imported WHERE imported.job_id=analysis_research_jobs.id)
        ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`, [runId]);
      const row = result.rows[0];
      if (!row) return null;
      const updated = await this.context.query<JobRow>(`UPDATE analysis_research_jobs SET status='queued',available_at=$2,
        lease_owner=NULL,lease_expires_at=NULL,heartbeat_at=NULL,last_error=NULL,updated_at=$2
        WHERE id=$1 RETURNING *`, [row.id,availableAt]);
      return parseJob(updated.rows[0]!);
    });
  }

  async claimNext(workerId: string, now: string, leaseExpiresAt: string, lane: ResearchJobLane = "any",
    runId?: string): Promise<ResearchJob | null> {
    return this.context.transaction(async () => {
      // Capacity and same-run checks must see a serialized claim set across workers.
      await this.context.query("SELECT pg_advisory_xact_lock(4832941,42)");
      const all = await this.context.query<JobRow>(`SELECT job.* FROM analysis_research_jobs job
        WHERE NOT EXISTS (SELECT 1 FROM analysis_imported_jobs imported WHERE imported.job_id=job.id)
        ORDER BY job.created_at,job.id FOR UPDATE OF job`);
      const relatedRunIds = [...new Set(all.rows.map((row) => row.run_id))];
      const runs = new Map<string,CreatorResearchRun>();
      if (relatedRunIds.length) {
        const result = await this.context.query<{ id:string; run_json:CreatorResearchRun }>(
          "SELECT id,run_json FROM analysis_creator_runs WHERE id=ANY($1::text[])", [relatedRunIds]);
        for (const row of result.rows) runs.set(row.id,creatorResearchRunSchema.parse(row.run_json));
      }
      for (const job of all.rows.filter((row) => (!runId || row.run_id === runId)
        && activeStates.has(row.status) && row.lease_expires_at && row.lease_expires_at <= now)) {
        if (job.attempts >= job.max_attempts) await this.exhaustRetryBudget(job, runs.get(job.run_id), now);
        else await this.context.query(`UPDATE analysis_research_jobs SET status='backoff',available_at=$2,
          lease_owner=NULL,lease_expires_at=NULL,heartbeat_at=NULL,last_error='lease_expired',updated_at=$2 WHERE id=$1`,
        [job.id,now]);
        job.status = job.attempts >= job.max_attempts ? "failed" : "backoff";
        job.available_at = now; job.lease_owner = null; job.lease_expires_at = null;
        job.last_error = job.status === "failed" ? "retry_limit_exhausted" : "lease_expired";
      }
      const activeJobs = all.rows.filter((row) => active(row,now));
      const limits = creatorWorkerConcurrency();
      const laneAtCapacity = lane !== "any" && activeJobs.filter((job) => {
        const run = runs.get(job.run_id);
        return run && laneMatches(lane,job,run) && !workflowControl(job);
      }).length >= limits[lane as Exclude<ResearchJobLane,"any">];
      const postVideoActive = activeJobs.filter(postVideoWork).length;
      const candidates = all.rows.filter((job) => {
        const run = runs.get(job.run_id);
        if (!run || (runId && job.run_id !== runId) || !laneMatches(lane,job,run)) return false;
        const ready = (["queued","backoff"].includes(job.status) && job.available_at <= now)
          || (activeStates.has(job.status) && job.lease_expires_at !== null && job.lease_expires_at <= now);
        if (!ready) return false;
        if (!["queued","preflight","collecting","backoff","reviewable"].includes(run.status)
          && !(job.node_key === "workflow.advance" && run.status === "ready")) return false;
        if (laneAtCapacity && !workflowControl(job)) return false;
        if (postVideoWork(job) && postVideoActive >= 2) return false;
        return !activeJobs.some((other) => other.run_id === job.run_id && other.id !== job.id
          && !(workflowControl(job) || workflowControl(other) || (videoWork(job) && videoWork(other))));
      });
      const rank = (job: JobRow): number => workflowControl(job) ? 0
        : job.node_key === "workflow.advance" && ["post.review","post.repair","post.repair-evaluation"].includes(workflowId(job) ?? "") ? 1
          : workflowId(job) === "post.build" ? 2 : 1;
      candidates.sort((a,b) => {
        const activeRank = Number(!activeStates.has(a.status)) - Number(!activeStates.has(b.status));
        if (activeRank) return activeRank;
        const backoffRank = Number(!(a.status === "backoff" && a.last_error === "lease_expired"))
          - Number(!(b.status === "backoff" && b.last_error === "lease_expired"));
        if (backoffRank) return backoffRank;
        return rank(a)-rank(b) || a.available_at.localeCompare(b.available_at) || a.created_at.localeCompare(b.created_at)
          || a.id.localeCompare(b.id);
      });
      const selected = candidates[0];
      if (!selected) return null;
      const result = await this.context.query<JobRow>(`UPDATE analysis_research_jobs
        SET status='leased',attempts=attempts+1,lease_owner=$2,lease_expires_at=$3,heartbeat_at=$4,updated_at=$4
        WHERE id=$1 AND status<>'canceled' RETURNING *`, [selected.id,workerId,leaseExpiresAt,now]);
      if (!result.rows[0]) throw new Error("任务租约竞争失败");
      return parseJob(result.rows[0]);
    });
  }

  async activeVideoPostExternalIds(runId: string, at: string): Promise<string[]> {
    const result = await this.context.query<{ payload_json: Record<string,unknown> }>(`SELECT payload_json
      FROM analysis_research_jobs WHERE run_id=$1 AND node_key='video.reconstruct'
      AND status IN ('leased','running') AND lease_expires_at>$2
      AND NOT EXISTS (SELECT 1 FROM analysis_imported_jobs imported WHERE imported.job_id=analysis_research_jobs.id)`, [runId,at]);
    return [...new Set(result.rows.flatMap((row) => typeof row.payload_json?.postExternalId === "string"
      ? [row.payload_json.postExternalId] : []))];
  }

  async updateJobStatus(input: { jobId: string; status: ResearchJobStatus; updatedAt: string;
    lastError?: string | null; expectedLeaseOwner?: string; expectedAttempts?: number }): Promise<boolean> {
    const terminal = ["succeeded","failed","needs_user","canceled"].includes(input.status);
    return this.context.transaction(async () => {
      const guard = this.context.leaseGuard ?? (input.expectedLeaseOwner !== undefined && input.expectedAttempts !== undefined
        ? { jobId:input.jobId, expectedLeaseOwner:input.expectedLeaseOwner, expectedAttempts:input.expectedAttempts } : undefined);
      if (guard && guard.jobId !== input.jobId) throw new Error("STALE_RESEARCH_LEASE");
      if (guard) await this.context.assertLease(guard);
      const result = await this.context.query(`UPDATE analysis_research_jobs SET status=$2,updated_at=$3,last_error=$4,
      lease_owner=CASE WHEN $5 THEN NULL ELSE lease_owner END,
      lease_expires_at=CASE WHEN $5 THEN NULL ELSE lease_expires_at END
      WHERE id=$1 AND status NOT IN ('canceled','succeeded')
        AND NOT EXISTS (SELECT 1 FROM analysis_imported_jobs imported WHERE imported.job_id=analysis_research_jobs.id)
        AND ($6::text IS NULL OR (lease_owner=$6 AND attempts=$7))`,
      [input.jobId,input.status,input.updatedAt,input.lastError ?? null,terminal,
        guard?.expectedLeaseOwner ?? null,guard?.expectedAttempts ?? null]);
      if (guard && result.rowCount !== 1) throw new Error("STALE_RESEARCH_LEASE");
      return result.rowCount === 1;
    });
  }

  async heartbeat(jobId: string, workerId: string, at: string, leaseExpiresAt: string): Promise<boolean> {
    return this.context.transaction(async () => {
      const guard = this.context.leaseGuard;
      if (guard && (guard.jobId !== jobId || guard.expectedLeaseOwner !== workerId)) return false;
      if (guard) {
        try { await this.context.assertLease(); }
        catch (error) { if (error instanceof Error && error.message === "STALE_RESEARCH_LEASE") return false; throw error; }
      }
      const result = await this.context.query(`UPDATE analysis_research_jobs SET heartbeat_at=$3,
      lease_expires_at=$4,updated_at=$3 WHERE id=$1 AND lease_owner=$2 AND status IN ('leased','running')
        AND lease_expires_at::timestamptz > now()
        AND ($5::integer IS NULL OR attempts=$5)`,
      [jobId,workerId,at,leaseExpiresAt,guard?.expectedAttempts ?? null]);
      return result.rowCount === 1;
    });
  }

  async appendEvent(event: AppendEventInput, guard?: AnalysisLeaseGuard): Promise<CreatorResearchEvent> {
    const value = creatorResearchEventSchema.omit({ sequence: true }).parse(event);
    return this.context.transaction(async () => {
      await this.context.assertLease(guard, value.runId);
      const result = await this.context.query<EventRow>(`INSERT INTO analysis_research_events
      (run_id,job_id,type,created_at,message,payload_json) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
    [value.runId,value.jobId,value.type,value.createdAt,value.message,JSON.stringify(value.payload)]);
      return parseEvent(result.rows[0]!);
    });
  }

  async listEvents(runId: string, afterSequence = 0): Promise<CreatorResearchEvent[]> {
    const result = await this.context.query<EventRow>(`SELECT * FROM analysis_research_events
      WHERE run_id=$1 AND sequence>$2 ORDER BY sequence ASC LIMIT 500`, [runId,afterSequence]);
    return result.rows.map(parseEvent);
  }

  close(): void { /* The composition root owns the shared pool. */ }

  private async exhaustRetryBudget(job: JobRow, existing: CreatorResearchRun | undefined, timestamp: string): Promise<void> {
    if (!existing) throw new Error(`Creator run is missing for expired job ${job.id}`);
    const run = creatorResearchRunSchema.parse(existing);
    const failedStage = job.node_key === "creator.portfolio" ? "tiering"
      : ["creator.enrich","video.reconstruct"].includes(job.node_key) ? "deep_capture"
        : job.node_key === "creator.synthesize" ? "synthesis" : "preflight";
    const message = `任务租约连续过期，已达到自动重试上限 ${job.max_attempts} 次。请检查 Worker 或 Runner 后在 Dashboard 点击继续。`;
    const stage = run.stages.find((candidate) => candidate.id === failedStage);
    if (stage) { stage.status = "failed"; stage.message = message; }
    run.status = "failed"; run.updatedAt = timestamp;
    run.worker = { state:"failed",attempt:job.attempts,jobId:job.id,workerId:null,lastHeartbeatAt:timestamp };
    run.blockers = [{ code:"retry_limit_exhausted",message,userActionRequired:false }];
    run.nextAction = "自动重试已停止；检查失败原因后可在 Dashboard 点击继续。";
    await this.save(run);
    await this.context.query(`UPDATE analysis_research_jobs SET status='failed',lease_owner=NULL,
      lease_expires_at=NULL,heartbeat_at=NULL,last_error='retry_limit_exhausted',updated_at=$2 WHERE id=$1`,
      [job.id,timestamp]);
    await this.appendEvent({ runId:run.id,jobId:job.id,type:"run.failed",createdAt:timestamp,message,
      payload:{code:"retry_limit_exhausted",attempts:job.attempts,maxAttempts:job.max_attempts,nodeKey:job.node_key} });
  }
}
