import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import { buildApp } from './app.js';
import { CreationStore } from '../../src/infrastructure/store.js';

const here = dirname(fileURLToPath(import.meta.url));
const stateRoot = resolve(process.env.CREATION_STATE_ROOT ?? resolve(here, '../../data/local/platform-v1'));
const store = new CreationStore(stateRoot);
const app = buildApp({ store });
const webDist = resolve(here, '../web/dist');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, prefix: '/' });
  app.get('/', async (_request, reply) => reply.sendFile('index.html'));
} else console.info('Web bundle unavailable; run the web dev server or build the workbench. API is available.');
const shutdown = async () => { await app.close(); store.close(); };
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
await app.listen({ host: '127.0.0.1', port: Number(process.env.CREATION_PORT ?? 4337) });
