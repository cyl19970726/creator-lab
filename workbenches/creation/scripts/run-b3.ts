import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Pool } from 'pg';
import { runWorkflow } from '@signal-room/workflow';
import { migratePostgresWorkflowStore, PostgresWorkflowRunStore } from '@signal-room/workflow-postgres';
import { b3InputSchema, createB3Workflow, readB3Standards } from '../src/stages/b3.js';
import { creationB3AgentTools } from '../src/stages/b3-agent-tools.js';
import { createStageRunner, type StageModel } from '../src/stages/runtime.js';

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  resume: { type: 'string' }, model: { type: 'string', default: 'gpt-6-luna' },
  effort: { type: 'string', default: 'low' },
} });
const [inputPath] = positionals;
if (!inputPath) throw new Error('Usage: pnpm b3 <input.json> [--resume RUN_ID] [--model gpt-6-luna] [--effort low|medium|high]');
if (!process.env.WORKFLOW_DATABASE_URL) throw new Error('Set WORKFLOW_DATABASE_URL to the PostgreSQL workflow database.');
const effort = values.effort;
if (effort !== 'low' && effort !== 'medium' && effort !== 'high') throw new Error(`Unsupported reasoning effort: ${effort}`);
const model: StageModel = { model: values.model!, reasoningEffort: effort };
const stateRoot = path.resolve(process.env.CREATION_STATE_ROOT ?? '.local/creation');
mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
const raw = JSON.parse(readFileSync(path.resolve(inputPath), 'utf8')) as Record<string, unknown>;
const input = b3InputSchema.parse({ ...raw, stateRoot, standards: raw.standards ?? readB3Standards() });
const database = new Pool({ connectionString: process.env.WORKFLOW_DATABASE_URL });
try {
  await migratePostgresWorkflowStore(database);
  const store = new PostgresWorkflowRunStore(database, { workspaceId: 'creator-lab-creation' });
  const startedAt = Date.now();
  const result = await runWorkflow({
    workflow: createB3Workflow(input, { worker: model, judge: model }), input, store,
    agentRunner: createStageRunner({ tools: creationB3AgentTools }),
    metadata: { workbench: 'creation', stage: 'b3', topicId: input.topicId,
      briefVersion: String(input.brief.version), adapter: 'openai-agents-sdk' },
    ...(values.resume ? { resumeRunId: values.resume } : {}),
  });
  const run = result.run;
  const outputDir = path.join(stateRoot, 'runs', run.id);
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(outputDir, 'input.json'), `${JSON.stringify(input, null, 2)}\n`, { mode: 0o600 });
  const artifacts = await store.listArtifacts(run.id);
  for (const [index, artifact] of artifacts.entries()) {
    const payload = await store.getArtifactPayload(artifact.id) as Record<string, unknown>;
    const base = `${String(index + 1).padStart(2, '0')}-${artifact.type}`;
    writeFileSync(path.join(outputDir, `${base}.json`), `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    if (typeof payload.markdown === 'string') writeFileSync(path.join(outputDir, `${base}.md`), payload.markdown, { mode: 0o600 });
  }
  const steps = await store.listSteps(run.id);
  writeFileSync(path.join(outputDir, 'run.json'), `${JSON.stringify({ runId: run.id,
    state: run.state, output: run.output, error: run.error, elapsedMs: Date.now() - startedAt,
    steps: steps.map(step => ({ key: step.key, kind: step.kind, state: step.state })) }, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ runId: run.id, state: run.state, outputDir, artifacts: artifacts.map(item => item.type) }, null, 2));
} finally {
  await database.end();
}
