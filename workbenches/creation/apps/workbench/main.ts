import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { WorkbenchStore } from '../../src/workbench/store.js';
import { buildWorkbenchApp } from './app.js';
import { acquireWorkerLock } from '../../src/infrastructure/process-lock.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const port = Number(process.env.WORKBENCH_PORT ?? 4341);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid WORKBENCH_PORT');
const stateRoot = path.resolve(process.env.WORKBENCH_STATE_ROOT ?? path.join(root, 'data/local/workbench-v1'));
const apiLock = await acquireWorkerLock(path.join(stateRoot, '.api-process'));
const store = new WorkbenchStore(stateRoot);
const app = buildWorkbenchApp({ store, auth: {
  token: process.env.WORKBENCH_ACCESS_TOKEN ?? '',
  actorId: process.env.WORKBENCH_ACTOR_ID ?? 'creator',
  publicOrigin: process.env.WORKBENCH_PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`,
  ...(process.env.WORKBENCH_DEV_ORIGIN ? { devOrigin: process.env.WORKBENCH_DEV_ORIGIN } : {}),
} });
const dist = path.join(root, 'apps/workbench/web/dist');
if (existsSync(dist)) {
  await app.register(fastifyStatic, { root: dist, prefix: '/' });
  app.setNotFoundHandler((request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({ error: '接口不存在' }) : reply.sendFile('index.html'));
}
let closing = false;
const shutdown = async () => { if (closing) return; closing = true; await app.close(); store.close(); await apiLock.release(); };
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
await app.listen({ host: process.env.WORKBENCH_HOST ?? '127.0.0.1', port });
console.log(`业务工作台正在监听 ${process.env.WORKBENCH_HOST ?? '127.0.0.1'}:${port}。打开页面不会启动模型。`);
