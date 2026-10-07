import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { Pool } from 'pg';
import { SiwcAuth } from '@signal-room/workflow-agent-sdk';
import { migrateWorkflowSpaces, PostgresBlobStore, WorkflowSpaceService } from '@signal-room/workflow-spaces';
import { createContentWorkbench } from './content-workbench.js';
import { contentSiwcExecutorManifest, createContentSiwcRunner } from './content-runner.js';
import { registerContentPresentation } from './presentation-registration.js';
import { creationAssetReaders } from './readers.js';
import { createContentProcessResolver } from './process.js';
import type { StageModel } from '../stages/runtime.js';

export interface ContentLocalConfig {
  databaseUrl?: string; principal?: string; model?: string;
  reasoningEffort?: 'low'|'medium'|'high'; port?: number; spaceId?: string;
  concurrency?: number;
  /** Explicit same-code deployments; older source revisions require their retained factory module. */
  authorPrompt?: string;
  retainedProfiles?: Array<{ worker: StageModel; judge: StageModel; authorPrompt?: string }>;
}

/** Local trusted operator host. Connection configuration never becomes a node input. */
export async function openContentHost(initialize = false) {
  const root = fileURLToPath(new URL('../../../../', import.meta.url));
  const configPath = resolve(process.env.CONTENT_WORKBENCH_CONFIG ?? `${root}/.local/content-space/runtime.json`);
  let config: ContentLocalConfig = {};
  try { config = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const databaseUrl = process.env.WORKFLOW_DATABASE_URL ?? config.databaseUrl;
  if (!databaseUrl) throw new Error('Set WORKFLOW_DATABASE_URL or a private CONTENT_WORKBENCH_CONFIG file.');
  const model = process.env.WORKFLOW_SIWC_MODEL ?? config.model;
  if (!model) throw new Error('Set WORKFLOW_SIWC_MODEL explicitly.');
  const principal = { id: process.env.WORKFLOW_SPACE_PRINCIPAL ?? config.principal ?? 'local-owner', kind: 'human' as const };
  const spaceId = process.env.WORKFLOW_SPACE_ID ?? config.spaceId ?? 'creator-content';
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const blobs = new PostgresBlobStore(pool);
    if (initialize) { await migrateWorkflowSpaces(pool); await blobs.migrate(); }
    let service:WorkflowSpaceService;
    service = new WorkflowSpaceService(pool, blobs, principal, {readerIds:Object.keys(creationAssetReaders),resultRoleIds:['final-draft','research','cold-read','fact-check','editorial-review'],
      processResolvers:{'creation.content':input=>createContentProcessResolver(service)(input)}});
    const existing = (await service.listSpaces()).find(space => space.id === spaceId);
    if (!existing) {
      if (!initialize) throw new Error('CONTENT space is not initialized. Run content:space init first.');
      await service.createSpace({ id: spaceId, purpose: '内容创作：研究、写稿、审阅和逐轮改进' });
    }
    if(initialize)await registerContentPresentation(service,spaceId);
    const reasoningEffort = config.reasoningEffort ?? 'low';
    const models = { worker: { model, reasoningEffort }, judge: { model, reasoningEffort } };
    const auth = new SiwcAuth();
    const runner = createContentSiwcRunner({ service, spaceId, auth });
    const executorManifest = contentSiwcExecutorManifest();
    const workbench = createContentWorkbench({ service, runner, principalId: principal.id, models,
      executorManifest, concurrency: config.concurrency ?? 2,
      ...(config.authorPrompt !== undefined ? { authorPrompt: config.authorPrompt } : {}),
      retainedProfiles: (config.retainedProfiles ?? []).map(({ authorPrompt, ...models }) => ({ models, runner, executorManifest,
        ...(authorPrompt !== undefined ? { authorPrompt } : {}) })) });
    const port = Number(process.env.CONTENT_WORKBENCH_PORT ?? config.port ?? 4393);
    if (initialize) {
      await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
      await writeFile(configPath, JSON.stringify({ ...config, databaseUrl, principal: principal.id,
        model, reasoningEffort, spaceId, port }, null, 2)+'\n', { mode: 0o600 });
    }
    return { pool, service, workbench, spaceId, models, principal, auth, port };
  } catch (error) { await pool.end(); throw error; }
}
