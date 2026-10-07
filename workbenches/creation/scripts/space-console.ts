import { Pool } from 'pg';
import { PostgresBlobStore, WorkflowSpaceService, createSpaceConsole } from '@signal-room/workflow-spaces';
import { creationAssetReaders } from '../src/spaces/readers.js';

const url = process.env.WORKFLOW_DATABASE_URL;
if (!url) throw new Error('Set WORKFLOW_DATABASE_URL to the existing Workflow Space PostgreSQL database.');
const rawPort = process.env.WORKFLOW_SPACE_CONSOLE_PORT ?? '4318';
const port = Number(rawPort);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WORKFLOW_SPACE_CONSOLE_PORT must be 1..65535');

const pool = new Pool({ connectionString: url });
const blobs = new PostgresBlobStore(pool);
const principal = { id: process.env.WORKFLOW_SPACE_PRINCIPAL || 'local-owner', kind: 'human' as const };
const service = new WorkflowSpaceService(pool, blobs, principal);
const server = createSpaceConsole(service, { title: 'Creation Workflow Spaces', readers: creationAssetReaders });

try {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  console.log(`Read-only Workflow Space console for ${principal.id}: http://127.0.0.1:${port}/`);
  console.log('Loopback only. Press Ctrl+C to close.');
  const shutdown = async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await pool.end();
  };
  process.once('SIGINT', () => { void shutdown().then(() => process.exit(0), error => { console.error(error); process.exit(1); }); });
  process.once('SIGTERM', () => { void shutdown().then(() => process.exit(0), error => { console.error(error); process.exit(1); }); });
} catch (error) {
  await pool.end();
  throw error;
}
