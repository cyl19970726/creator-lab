import type { CreatorAcquisitionAdapter, CreatorResearchEvent, CreatorResearchRun } from "../../../contracts/index.js";
import type { ResearchJob, ResearchJobStatus } from "../../index.js";
import type { Awaitable } from "./awaitable.js";

export type AppendEventInput = Omit<CreatorResearchEvent, "sequence">;
export type ResearchJobLane = "any" | "redfox" | "ego-browser" | "portfolio" | "video" | "synthesis";
export type ResearchLeaseGuard = { jobId: string; expectedLeaseOwner: string; expectedAttempts: number };

export interface CreatorResearchRepository {
  save(run: CreatorResearchRun, guard?: ResearchLeaseGuard): Awaitable<void>;
  get(id: string): Awaitable<CreatorResearchRun | null>;
  list(limit?: number): Awaitable<CreatorResearchRun[]>;
  findLatestByProfileUrl(profileUrl: string): Awaitable<CreatorResearchRun | null>;
  findLatestByProfileUrlAndAdapter(profileUrl: string, adapter: CreatorAcquisitionAdapter): Awaitable<CreatorResearchRun | null>;
  enqueue(job: ResearchJob): Awaitable<ResearchJob>;
  cancelWorkflowJobs?(runId: string, workflowRunId: string, updatedAt: string): Awaitable<number>;
  requeueRun(runId: string, availableAt: string): Awaitable<ResearchJob | null>;
  claimNext(workerId: string, now: string, leaseExpiresAt: string, lane?: ResearchJobLane,
    runId?: string): Awaitable<ResearchJob | null>;
  activeVideoPostExternalIds(runId: string, at: string): Awaitable<string[]>;
  updateJobStatus(input: {
    jobId: string;
    status: ResearchJobStatus;
    updatedAt: string;
    lastError?: string | null;
    expectedLeaseOwner?: string;
    expectedAttempts?: number;
  }): Awaitable<boolean | void>;
  heartbeat(jobId: string, workerId: string, at: string, leaseExpiresAt: string): Awaitable<boolean>;
  appendEvent(event: AppendEventInput, guard?: ResearchLeaseGuard): Awaitable<CreatorResearchEvent>;
  listEvents(runId: string, afterSequence?: number): Awaitable<CreatorResearchEvent[]>;
  close(): Awaitable<void>;
  /** Scope job writes to a current lease without holding a transaction across external work. */
  runWithJobLease?<T>(jobId: string, workerId: string, attempts: number, operation: () => Promise<T>): Promise<T>;
  /** Short creator-row critical section for concurrent post projection and batch registration. */
  withRunTransaction?<T>(runId: string, operation: () => Promise<T>): Promise<T>;
}
