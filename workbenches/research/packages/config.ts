import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
export function loadConfig() {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid PORT');
  return { projectRoot, stateRoot, contentRoot, artifactRoot, mediaRoot, port };
}
export type Config = ReturnType<typeof loadConfig>;
