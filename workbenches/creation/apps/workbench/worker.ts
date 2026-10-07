import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkbenchStore } from '../../src/workbench/store.js';
import { WorkbenchWorker } from '../../src/workbench/execution.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const store = new WorkbenchStore(path.resolve(process.env.WORKBENCH_STATE_ROOT ?? path.join(root, 'data/local/workbench-v1')));
const worker = new WorkbenchWorker(store, { codexHome: process.env.CREATION_WORKBENCH_CODEX_HOME, codexBinary: process.env.CREATION_CODEX_BIN });
let stopping = false;
const stop = () => { if (!stopping) { stopping = true; void worker.stop(); } };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try { await worker.start(); await worker.runLoop(); }
finally { await worker.stop(); store.close(); }
