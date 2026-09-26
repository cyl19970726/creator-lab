import { loadConfig } from '../../packages/config.ts';
import { createResearchService } from '../../packages/storage/research-service.mjs';
import { createApp } from './app.ts';
const config = loadConfig();
const service = createResearchService({
  directory: config.stateRoot,
  artifactRoot: config.artifactRoot,
  projectRoot: config.projectRoot,
} as any);
const app = await createApp(config, service);
app.addHook('onClose', async () => {
  await service.close();
});
await app.listen({ port: config.port, host: '127.0.0.1' });
console.log(`Research Workbench: http://127.0.0.1:${config.port}`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void app.close());
