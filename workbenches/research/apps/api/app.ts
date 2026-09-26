import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { ZodError } from 'zod';
import {
  IdentitySchema,
  StartSchema,
  FeedbackSchema,
  DecisionSchema,
  RepairSchema,
  ResumeSchema,
} from '../../packages/contracts/index.ts';
import type { Config } from '../../packages/config.ts';
import { contentRepository } from '../../packages/storage/content.ts';
import { collaborationRepository } from '../../packages/domain/collaboration.ts';
import { renderReader, readerCsp } from './reader.ts';
// The migrated engine stays JS while public boundaries are validated TypeScript.
export async function createApp(config: Config, service: any) {
  const app = Fastify({ bodyLimit: 65536, logger: { level: 'error' } });
  const content = contentRepository(config.contentRoot);
  const collaboration = collaborationRepository(resolve(config.stateRoot, 'collaboration.sqlite'));
  app.addHook('onClose', async () => {
    collaboration.close();
  });
  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host || '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host))
      return reply.code(403).send({ error: '只允许本机访问' });
    if (req.url === '/reader.js' || req.url.startsWith('/assets/')) {
      reply.header('Access-Control-Allow-Origin', '*');
      return;
    }
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`)
      return reply.code(403).send({ error: '请求来源不匹配' });
    if (req.headers['sec-fetch-site'] === 'cross-site')
      return reply.code(403).send({ error: '不接受跨站请求' });
  });
  app.setErrorHandler((e, req, reply) => {
    const error = e as Error & { statusCode?: number };
    if (e instanceof ZodError)
      return reply.code(400).send({
        error: '输入格式不正确',
        details: e.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    const known =
      /^(Research run not found|Research source not found|Run not found|Unknown topic|Source outside topic|Unknown frozen source|Source changed;|Duplicate sources|Duplicate feedback|Feedback outside selected version|Idempotency key reused|Run cannot resume|Implementation revision changed;|Research agent method changed;|Artifact outside research run|Artifact identity mismatch|Exact artifact identity required|Expression repair requires|Prior artifact is outside|Invalid research|Frozen research|Repair candidate must|Research model is pinned|Research reasoning is pinned)/.test(
        error.message,
      );
    if (known) {
      const status = /not found|Unknown|outside/i.test(error.message) ? 404 : 409;
      return reply.code(status).send({ error: error.message });
    }
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500)
      return reply.code(error.statusCode).send({ error: '请求格式不正确或内容超过上限' });
    req.log.error({ err: error }, 'Unhandled API failure');
    return reply.code(500).send({ error: '服务暂时无法完成此操作，请查看本机运行日志' });
  });
  app.get('/api/health', async () => ({
    ok: true,
    execution: 'separate-worker',
    model: 'gpt-5.6-luna',
  }));
  app.get('/api/topics', async () => ({ topics: content.topics() }));
  app.get<{ Params: { topicId: string; sourceId: string } }>(
    '/api/topics/:topicId/sources/:sourceId',
    async (req, reply) => {
      const { sources } = content.freeze(req.params.topicId, [req.params.sourceId]);
      return reply
        .header('Content-Security-Policy', readerCsp)
        .header('Cache-Control', 'no-store')
        .type('text/html')
        .send(renderReader({ title: sources[0].title, document: sources[0].content }));
    },
  );
  app.get<{ Params: { id: string } }>('/api/topics/:id/runs', async (req) => ({
    runs: await service.list({ workspaceId: 'token-economics', topicId: req.params.id }),
  }));
  app.post('/api/runs', async (req, reply) => {
    const b = StartSchema.parse(req.body),
      { topic, sources } = content.freeze(b.topicId, b.sourceIds);
    const result = await service.start(
      {
        workspaceId: 'token-economics',
        topicId: topic.id,
        title: b.title,
        goal: b.goal,
        readers: topic.readers,
        asOf: b.asOf,
        sources,
      },
      { model: b.model, reasoningEffort: b.reasoningEffort, idempotencyKey: b.idempotencyKey },
    );
    return reply.code(202).send(result);
  });
  const ensure = (id: string) => {
    if (!service.getRun(id)) throw new Error('Run not found');
  };
  app.get<{ Params: { id: string; sourceId: string } }>(
    '/api/runs/:id/inputs/:sourceId',
    async (req, reply) => {
      const payload = service.source(req.params.id, req.params.sourceId);
      return reply
        .header('Content-Security-Policy', readerCsp)
        .header('Cache-Control', 'no-store')
        .type('text/html')
        .send(renderReader(payload));
    },
  );
  app.get<{ Params: { id: string } }>('/api/runs/:id/snapshot', async (req) => {
    ensure(req.params.id);
    return service.snapshot(req.params.id);
  });
  app.get<{ Params: { id: string }; Querystring: { cursor: string } }>(
    '/api/runs/:id/changes',
    async (req) => {
      ensure(req.params.id);
      return service.changes(req.params.id, req.query.cursor);
    },
  );
  app.get<{ Params: { id: string; phaseId: string }; Querystring: { cursor?: string } }>(
    '/api/runs/:id/stages/:phaseId',
    async (req) => {
      ensure(req.params.id);
      return service.stageDetails(req.params.id, req.params.phaseId, {
        cursor: req.query.cursor,
        limit: 30,
      });
    },
  );
  app.get<{
    Params: { id: string; assetId: string };
    Querystring: { revision: string; sha256: string };
  }>('/api/runs/:id/artifacts/:assetId', async (req, reply) => {
    const identity = IdentitySchema.parse({ id: req.params.assetId, ...req.query });
    const { payload } = await service.artifact(req.params.id, identity);
    return reply
      .header('Content-Security-Policy', readerCsp)
      .header('Cache-Control', 'no-store')
      .type('text/html')
      .send(renderReader(payload));
  });
  app.get<{
    Params: { id: string };
    Querystring: { artifactId: string; revision: string; sha256: string };
  }>('/api/runs/:id/collaboration', async (req) => {
    const identity = IdentitySchema.parse({
      id: req.query.artifactId,
      revision: req.query.revision,
      sha256: req.query.sha256,
    });
    await service.artifact(req.params.id, identity);
    return { events: collaboration.list(req.params.id, identity) };
  });
  app.post<{ Params: { id: string } }>('/api/runs/:id/feedback', async (req) => {
    const { identity, idempotencyKey, ...fields } = FeedbackSchema.parse(req.body);
    await service.artifact(req.params.id, identity);
    return collaboration.append(req.params.id, identity, idempotencyKey, {
      type: 'feedback',
      ...fields,
    });
  });
  app.post<{ Params: { id: string } }>('/api/runs/:id/decision', async (req) => {
    const { identity, idempotencyKey, ...fields } = DecisionSchema.parse(req.body);
    await service.artifact(req.params.id, identity);
    return collaboration.append(req.params.id, identity, idempotencyKey, {
      type: 'decision',
      ...fields,
    });
  });
  app.post<{ Params: { id: string } }>('/api/runs/:id/repair', async (req, reply) => {
    const b = RepairSchema.parse(req.body);
    await service.artifact(req.params.id, b.identity);
    if (new Set(b.feedbackIds).size !== b.feedbackIds.length) throw new Error('Duplicate feedback');
    const events = collaboration.list(req.params.id, b.identity);
    const feedback = b.feedbackIds.map((id) => {
      const event = events.find((e) => e.id === id && e.type === 'feedback');
      if (!event) throw new Error('Feedback outside selected version');
      return { id: event.id, body: event.body, location: event.location };
    });
    return reply.code(202).send(
      await service.repair(req.params.id, {
        identity: b.identity,
        feedback,
        route: b.route,
        idempotencyKey: b.idempotencyKey,
      }),
    );
  });
  app.post<{ Params: { id: string } }>('/api/runs/:id/resume', async (req, reply) =>
    reply.code(202).send(await service.resume(req.params.id, ResumeSchema.parse(req.body))),
  );
  app.post<{ Params: { id: string } }>('/api/runs/:id/cancel', async (req, reply) =>
    reply.code(202).send(await service.cancel(req.params.id)),
  );
  const webRoot = resolve(config.projectRoot, 'dist/web');
  if (existsSync(webRoot)) {
    await app.register(staticFiles, { root: webRoot, index: 'index.html' });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/')
        ? reply.code(404).send({ error: '入口不存在' })
        : reply.sendFile('index.html'),
    );
  }
  return app;
}
