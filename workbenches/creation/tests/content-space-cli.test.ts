import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresBlobStore, WorkflowSpaceService, migrateWorkflowSpaces } from '@signal-room/workflow-spaces';

const url = process.env.WORKFLOW_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const creation = fileURLToPath(new URL('..', import.meta.url));
const cli = join(creation, 'scripts/content-space.ts');
const tsx = join(creation, 'node_modules/.bin/tsx');

suite('CONTENT validation CLI summaries', () => {
  let pool: Pool;
  let service: WorkflowSpaceService;
  beforeAll(async () => {
    pool = new Pool({ connectionString: url!, max: 4 });
    await migrateWorkflowSpaces(pool);
    const blobs = new PostgresBlobStore(pool);
    await blobs.migrate();
    service = new WorkflowSpaceService(pool, blobs, { id: 'content-cli-test', kind: 'human' });
  });
  afterAll(async () => { await pool?.end(); });

  it('prints a complete plan summary without embedding the whole Space overview', async () => {
    const space = await service.createSpace({ id: `content-cli-${randomUUID()}`, purpose: 'CLI summary test' });
    const caseId = randomUUID();
    await service.createCase(space.id, { id: caseId, title: 'CLI case', objective: 'Check the summary', constraints: [] });
    const manifest = await service.freezeInputs(space.id, caseId, {});
    for (const id of ['cli-v1', 'cli-v2']) {
      await service.publishWorkflow(space.id, { id, revision: '1', changeReason: id, config: {},
        entrypoints: { content: { workflowId: 'creation.content', codeRevision: '1',
          storageContract: { workflowVersion: id, nodes: { node: { actorKinds: ['program'],
            inputs: {}, outputs: {}, actions: [] } }, stateRules: [] } } } });
    }
    const plan = await service.createValidationPlan(space.id, { id: `cli-plan-${randomUUID()}`,
      kind: 'prospective', question: 'Which version is better?', hypothesis: 'V2 improves clarity',
      baseline: { workflowVersionId: 'cli-v1', entrypoint: 'content' },
      candidate: { workflowVersionId: 'cli-v2', entrypoint: 'content' },
      cases: [{ caseId, inputManifestId: manifest.id, repeats: 1 }],
      standard: { id: 'four-questions', revision: '1', content: 'Answer all four questions' },
      judges: [{ kind: 'human', id: 'content-cli-test' }], expectedVariables: [], exclusionRules: [] });
    await service.freezeValidationPlan(space.id, plan.id);
    const env = { ...process.env, WORKFLOW_DATABASE_URL: url!, WORKFLOW_SPACE_ID: space.id,
      WORKFLOW_SPACE_PRINCIPAL: 'content-cli-test', WORKFLOW_SIWC_MODEL: 'deterministic-test',
      CONTENT_WORKBENCH_CONFIG: join(tmpdir(), `no-content-config-${randomUUID()}.json`) };
    const invoke = (...args: string[]) => spawnSync(tsx, [cli, ...args],
      { cwd: creation, env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });

    const shown = invoke('validation-show', '--plan', plan.id);
    expect(shown.status, shown.stderr).toBe(0);
    const summary = JSON.parse(shown.stdout);
    expect(summary).toEqual(await service.validationSummary(space.id, plan.id));
    expect(summary).not.toHaveProperty('data');
    expect(summary.entries).toHaveLength(2);
    expect(summary.totals.entries).toBe(2);

    const listed = invoke('validation-plans');
    expect(listed.status, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual(await service.validationPlans(space.id));
  }, 30_000);
});
