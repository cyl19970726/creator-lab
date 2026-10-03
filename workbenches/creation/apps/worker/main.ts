import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CreationStore } from '../../src/infrastructure/store.js';
import { CreationWorker } from './worker.js';

const here = dirname(fileURLToPath(import.meta.url));
const stateRoot = resolve(process.env.CREATION_STATE_ROOT ?? resolve(here, '../../data/local/platform-v1'));
const store = new CreationStore(stateRoot);
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
try { await new CreationWorker({ store }).run(controller.signal); }
finally { store.close(); }
