import Fastify, { type FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { commandSchema, createWorkSchema, decisionSchema, idSchema, revisionSchema, startSchema, workspaceInputSchema } from '../../src/contracts/index.js';
import { CreationStore, StoreError } from '../../src/infrastructure/store.js';
import { publicExecutionError } from '../../src/application/public-error.js';
import { SQLiteWorkflowRunStore } from '@signal-room/workflow-sqlite';

const scoped = z.object({ workspaceId: idSchema }).strict();
const workParams = z.object({ workId: idSchema }).strict();
const jobParams = z.object({ jobId: idSchema }).strict();
const workspaceParams = z.object({ workspaceId: idSchema }).strict();
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const loopbackPeers = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function buildApp(options: { store: CreationStore }): FastifyInstance {
  const app = Fastify({ bodyLimit: 1_000_000, logger: false });
  const store = options.store;
  const ledger = new SQLiteWorkflowRunStore(store.database);
  const safeJobError = async (job: { error: string | null; runId: string | null }) => {
    if (!job.error) return null;
    if (publicExecutionError(job.error) === job.error) return job.error;
    const run = job.runId ? await ledger.getRun(job.runId) : undefined;
    return publicExecutionError(run?.error ?? job.error);
  };
  app.addHook('onRequest', async (request, reply) => {
    let host: URL;
    try { host = new URL(`http://${request.headers.host ?? ''}`); }
    catch { reply.code(403).send({ error: 'Invalid host' }); return; }
    if (!localHosts.has(host.hostname) || !loopbackPeers.has(request.socket.remoteAddress ?? '')) {
      reply.code(403).send({ error: 'Local connection required' }); return;
    }
    if (request.headers['sec-fetch-site'] === 'cross-site') { reply.code(403).send({ error: 'Cross-site request denied' }); return; }
    const origin = request.headers.origin;
    if (origin) {
      let url: URL;
      try { url = new URL(origin); } catch { reply.code(403).send({ error: 'Invalid origin' }); return; }
      const sameOrigin = url.protocol === 'http:' && url.host === host.host;
      const viteOrigin = url.protocol === 'http:' && localHosts.has(url.hostname) && url.port === '4338';
      if (!sameOrigin && !viteOrigin) {
        reply.code(403).send({ error: 'Origin is not allowed' }); return;
      }
      reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        .header('Access-Control-Allow-Headers', 'content-type').code(204).send();
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof StoreError) { reply.code(error.status).send({ error: error.message }); return; }
    if (error instanceof ZodError) { reply.code(400).send({ error: error.issues.map(i => i.message).join('; ') }); return; }
    if (error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500) {
      reply.code(error.statusCode).send({ error: 'Invalid request' }); return;
    }
    reply.code(500).send({ error: 'Internal server error' });
  });
  app.get('/api/workspaces', async () => store.listWorkspaces());
  app.post('/api/workspaces', async request => store.createWorkspace(workspaceInputSchema.parse(request.body)));
  app.get('/api/workspaces/:workspaceId/works', async request => {
    const { workspaceId } = workspaceParams.parse(request.params);
    return store.listWorks(workspaceId);
  });
  app.post('/api/workspaces/:workspaceId/works', async request => {
    const { workspaceId } = workspaceParams.parse(request.params);
    const input = createWorkSchema.parse(request.body);
    if (input.workspaceId !== workspaceId) throw new StoreError(409, 'Workspace scope mismatch');
    return store.createWork(input);
  });
  app.get('/api/works/:workId', async request => {
    const { workId } = workParams.parse(request.params);
    const { workspaceId } = scoped.parse(request.query);
    const detail = store.detail(workId, workspaceId);
    return { ...detail, jobs: await Promise.all(detail.jobs.map(async job => ({ ...job, error: await safeJobError(job) }))) };
  });
  app.post('/api/works/:workId/start', async request => {
    const { workId } = workParams.parse(request.params);
    const { workspaceId } = scoped.parse(request.query);
    return store.start(workId, workspaceId, startSchema.parse(request.body));
  });
  app.post('/api/works/:workId/revise', async request => {
    const { workId } = workParams.parse(request.params);
    const { workspaceId } = scoped.parse(request.query);
    return store.revise(workId, workspaceId, revisionSchema.parse(request.body));
  });
  app.post('/api/works/:workId/decisions', async request => {
    const { workId } = workParams.parse(request.params);
    const { workspaceId } = scoped.parse(request.query);
    return store.decide(workId, workspaceId, decisionSchema.parse(request.body));
  });
  app.post('/api/jobs/:jobId/cancel', async request => {
    const { jobId } = jobParams.parse(request.params);
    const { workspaceId } = scoped.parse(request.query);
    return store.cancel(jobId, workspaceId, commandSchema.parse(request.body).commandId);
  });
  app.post('/api/jobs/:jobId/resume', async request => {
    const { jobId } = jobParams.parse(request.params);
    const { workspaceId } = scoped.parse(request.query);
    return store.resume(jobId, workspaceId, commandSchema.parse(request.body).commandId);
  });
  app.get('/api/jobs/:jobId/execution', async request => {
    const { jobId } = jobParams.parse(request.params);
    const { workspaceId } = scoped.parse(request.query);
    const job = store.getJob(jobId, workspaceId);
    const publicError = await safeJobError(job);
    if (!job.runId) return { runId: null, state: job.state, steps: [], ...(publicError ? { error: publicError } : {}) };
    const run = await ledger.getRun(job.runId);
    if (!run) throw new StoreError(409, 'Native execution record is missing');
    const steps = await ledger.listSteps(run.id);
    const counts = await Promise.all(steps.map(async step => (await ledger.listAttempts(step.id)).length));
    return { runId: run.id, state: run.state, workflowId: run.workflowId, workflowRevision: run.workflowRevision,
      steps: steps.map((s, i) => ({ id: s.id, key: s.key, kind: s.kind, state: s.state, attempts: counts[i]! })),
      ...(publicError ? { error: publicError } : {}) };
  });
  return app;
}
