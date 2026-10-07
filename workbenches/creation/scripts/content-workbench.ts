import { createContentApp } from '../src/spaces/content-app.js';
import { openContentHost } from '../src/spaces/content-host.js';

const host = await openContentHost(true);
const server = createContentApp({ service: host.service, workbench: host.workbench,
  spaceId: host.spaceId });
await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(host.port, '127.0.0.1', resolve); });
console.log(`CONTENT 工作台：http://127.0.0.1:${host.port}/workbench`);
console.log(`执行配置：${host.models.worker.model} / ${host.models.worker.reasoningEffort}；仅显式点击开始才会调用模型。`);
let closing = false;
async function stop() {
  if (closing) return; closing = true;
  try { await host.workbench.stop(); }
  finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await host.pool.end();
  }
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
