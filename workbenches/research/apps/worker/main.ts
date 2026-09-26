import { loadConfig } from '../../packages/config.ts';
import { createResearchService } from '../../packages/storage/research-service.mjs';

const config = loadConfig();
const service = createResearchService({
  directory: config.stateRoot,
  artifactRoot: config.artifactRoot,
  projectRoot: config.projectRoot,
} as any);

let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void service.close();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

try {
  while (!stopping) {
    const worked = await service.workOnce();
    if (!worked && !stopping) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
} finally {
  await service.close();
}
