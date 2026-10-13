import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
export function loadConfig() {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try { process.loadEnvFile(resolve(projectRoot, '.env')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const stateRoot = resolve(projectRoot, process.env.WORKBENCH_STATE_ROOT || '.local/state');
  const contentRoot = resolve(projectRoot, process.env.WORKBENCH_CONTENT_ROOT || '.local/content');
  const artifactRoot = resolve(
    projectRoot,
    process.env.WORKBENCH_ARTIFACT_ROOT || '.local/artifacts',
  );
  const mediaRoot = process.env.WORKBENCH_MEDIA_ROOT
    ? resolve(process.env.WORKBENCH_MEDIA_ROOT)
    : undefined;
  const port = Number(process.env.PORT || 4327);
  const databaseUrl = process.env.WORKFLOW_DATABASE_URL;
  if (!databaseUrl) throw new Error('Set WORKFLOW_DATABASE_URL to the research PostgreSQL database.');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid PORT');
  return { projectRoot, stateRoot, contentRoot, artifactRoot, mediaRoot, databaseUrl, port };
}
export type Config = ReturnType<typeof loadConfig>;
