import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runWorkflow, type AgentRunner, type ArtifactRef, type WorkflowDefinition } from '@signal-room/workflow';
import type { Job, WorkflowInput } from '../../src/contracts/index.js';
import { definitionSchema, draftSchema, reviewSchema } from '../../src/contracts/index.js';
import { frozenWorkflowInput } from '../../src/application/job-input.js';
import { publicExecutionError } from '../../src/application/public-error.js';
import { CreationStore } from '../../src/infrastructure/store.js';
import { RecoveryRunStore } from '../../src/infrastructure/recovery-run-store.js';
import { createArticleRunner, createArticleWorkflow, type ArticleWorkflowOutput } from '../../src/workflows/article.js';
import { acquireWorkerLock } from '../../src/infrastructure/process-lock.js';

type NativeEnvelope = { kind: 'definition' | 'draft' | 'review'; content: string; payload: unknown };
function envelope(value: unknown, ref: ArtifactRef): NativeEnvelope {
  if (!value || typeof value !== 'object') throw new Error(`Invalid native artifact ${ref.id}`);
  const item = value as Record<string, unknown>;
  if (item.kind !== ref.type || !['definition', 'draft', 'review'].includes(ref.type) || typeof item.content !== 'string')
    throw new Error(`Native artifact ${ref.id} has an invalid envelope`);
  const schema = ref.type === 'definition' ? definitionSchema : ref.type === 'draft' ? draftSchema : reviewSchema;
  return { kind: ref.type as NativeEnvelope['kind'], content: item.content, payload: schema.parse(item.payload) };
}

export interface WorkerOptions {
  store: CreationStore;
  agentRunner?: AgentRunner;
  workflowFactory?: (input: WorkflowInput) => WorkflowDefinition<WorkflowInput, ArticleWorkflowOutput>;
  pollMs?: number;
}

export class CreationWorker {
  private readonly store: CreationStore;
  private readonly runner: AgentRunner;
  private readonly workflowFactory: WorkerOptions['workflowFactory'];
  private readonly pollMs: number;
  constructor(options: WorkerOptions) {
    this.store = options.store;
    const traceRoot = join(options.store.stateRoot, 'traces');
    mkdirSync(traceRoot, { recursive: true });
    this.runner = options.agentRunner ?? createArticleRunner({ traceRoot });
    this.workflowFactory = options.workflowFactory ?? createArticleWorkflow;
    this.pollMs = options.pollMs ?? 250;
  }
  private nativeStore(job: Job): RecoveryRunStore {
    const register = (ref: ArtifactRef, payload: unknown) => {
      const item = envelope(payload, ref);
      this.store.registerArtifact({ workId: job.workId, jobId: job.id, kind: item.kind, content: item.content,
        payload: item.payload, vendorRef: { id: ref.id, revision: ref.revision, sha256: ref.sha256 },
        dependencies: ref.dependsOn.map(d => d.artifactId) });
    };
    return new RecoveryRunStore(this.store.database, runId => this.store.bindRun(job.id, runId), register);
  }
  private async reconcile(job: Job, native: RecoveryRunStore): Promise<void> {
    if (!job.runId) return;
    for (const ref of await native.listArtifacts(job.runId)) {
      const payload = await native.getArtifactPayload(ref.id);
      const item = envelope(payload, ref);
      this.store.registerArtifact({ workId: job.workId, jobId: job.id, kind: item.kind, content: item.content,
        payload: item.payload, vendorRef: { id: ref.id, revision: ref.revision, sha256: ref.sha256 },
        dependencies: ref.dependsOn.map(d => d.artifactId) });
    }
  }
  async processNext(): Promise<Job | undefined> {
    const claimed = this.store.claimNext();
    if (!claimed) return undefined;
    const native = this.nativeStore(claimed);
    const controller = new AbortController();
    const cancelTimer = setInterval(() => {
      if (this.store.getJobAny(claimed.id)?.cancelRequested) controller.abort(new Error('User canceled job'));
    }, this.pollMs);
    try {
      if (claimed.cancelRequested) controller.abort(new Error('User canceled job'));
      // Reconcile before replay: native publication may have committed before business registration.
      await this.reconcile(claimed, native);
      const input = frozenWorkflowInput(this.store, claimed.id);
      const current = claimed.runId ? await native.getRun(claimed.runId) : undefined;
      if (claimed.runId && !current) throw new Error('Bound native run is missing');
      if (current && ['succeeded', 'needs_review', 'blocked', 'canceled'].includes(current.state)) {
        await this.reconcile(claimed, native);
        return this.store.finish(claimed.id, current.state as Job['state'], current.error ? publicExecutionError(current.error) : null);
      }
      if (controller.signal.aborted && !claimed.runId) return this.store.finish(claimed.id, 'canceled');
      const result = await runWorkflow({ workflow: this.workflowFactory!(input), input, store: native,
        agentRunner: this.runner, signal: controller.signal, resumeRunId: claimed.runId ?? undefined,
        metadata: { workId: claimed.workId, jobId: claimed.id } });
      const bound = this.store.getJobAny(claimed.id)!;
      await this.reconcile(bound, native);
      return this.store.finish(claimed.id, result.run.state as Job['state'], result.run.error ? publicExecutionError(result.run.error) : null);
    } catch (error) {
      const bound = this.store.getJobAny(claimed.id)!;
      try { await this.reconcile(bound, native); } catch (reconcileError) {
        return this.store.finish(claimed.id, 'failed', publicExecutionError(reconcileError));
      }
      const nativeError = bound.runId ? (await native.getRun(bound.runId))?.error : undefined;
      return this.store.finish(claimed.id, controller.signal.aborted ? 'canceled' : 'failed',
        controller.signal.aborted ? null : publicExecutionError(nativeError ?? error));
    } finally { clearInterval(cancelTimer); }
  }
  async run(signal: AbortSignal): Promise<void> {
    const lock = await acquireWorkerLock(this.store.stateRoot);
    try {
      while (!signal.aborted) {
        const processed = await this.processNext();
        if (!processed) await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, this.pollMs);
          signal.addEventListener('abort', done, { once: true });
          if (signal.aborted) done();
        });
      }
    } finally { await lock.release(); }
  }
}
