import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { runWorkflow, type WorkflowDefinition, type WorkflowTerminal } from '@signal-room/workflow';
import { SQLiteWorkflowRunStore } from '@signal-room/workflow-sqlite';
import { b1InputSchema, createB1Workflow, readB1Standards } from '../src/stages/b1.js';
import { b2InputSchema, createB2Workflow, readB2Standards } from '../src/stages/b2.js';
import { createStageRunner, type StageModel } from '../src/stages/runtime.js';

/**
 * Runs one stage workflow against a real topic and writes every published asset as a readable file.
 *   pnpm stage <b1|b2> <input.json> [--resume <runId>] [--model gpt-6-sol] [--judge-effort high]
 * State lives under .local/stages/<topicId>/ (git-ignored): ledger.sqlite, traces/, <stage>/<runId>/.
 */
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    resume: { type: 'string' },
    model: { type: 'string', default: 'gpt-6-sol' },
    'worker-effort': { type: 'string', default: 'medium' },
    'judge-effort': { type: 'string', default: 'high' },
  },
});
const [stage, inputPath] = positionals;
if ((stage !== 'b1' && stage !== 'b2') || !inputPath) throw new Error('Usage: run-stage.ts <b1|b2> <input.json> [--resume <runId>]');

const effort = (value: string | undefined): StageModel['reasoningEffort'] => {
  if (value !== 'low' && value !== 'medium' && value !== 'high') throw new Error(`Unsupported effort: ${value}`);
  return value;
};

const raw = JSON.parse(readFileSync(path.resolve(inputPath), 'utf8')) as Record<string, unknown>;
const models = {
  worker: { model: values.model!, reasoningEffort: effort(values['worker-effort']) },
  judge: { model: values.model!, reasoningEffort: effort(values['judge-effort']) },
};
const withStandards = (read: () => string) => ({ ...raw, standards: raw.standards ?? read() });
const topicId = String(raw.topicId);
const root = path.resolve('.local/stages', topicId);
mkdirSync(path.join(root, 'traces'), { recursive: true });
const store = new SQLiteWorkflowRunStore(new DatabaseSync(path.join(root, 'ledger.sqlite')));
const started = Date.now();

function execute<Input>(definition: WorkflowDefinition<Input, WorkflowTerminal<never>>, input: Input) {
  return runWorkflow({
    workflow: definition,
    input,
    store,
    agentRunner: createStageRunner({ traceRoot: path.join(root, 'traces') }),
    metadata: { stage, topicId },
    ...(values.resume ? { resumeRunId: values.resume } : {}),
  });
}
const { run } = stage === 'b1'
  ? await execute(createB1Workflow(models), b1InputSchema.parse(withStandards(readB1Standards)))
  : await execute(createB2Workflow(models), b2InputSchema.parse(withStandards(readB2Standards)));

const outDir = path.join(root, stage, run.id);
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'input.json'), `${JSON.stringify(raw, null, 2)}\n`);
const artifacts = await store.listArtifacts(run.id);
for (const [index, ref] of artifacts.entries()) {
  const payload = await store.getArtifactPayload(ref.id) as Record<string, unknown>;
  const base = `${String(index + 1).padStart(2, '0')}-${ref.type}`;
  writeFileSync(path.join(outDir, `${base}.json`), `${JSON.stringify(payload, null, 2)}\n`);
  if (typeof payload?.markdown === 'string') writeFileSync(path.join(outDir, `${base}.md`), payload.markdown);
}
const steps = await store.listSteps(run.id);
writeFileSync(path.join(outDir, 'run.json'), `${JSON.stringify({
  runId: run.id, state: run.state, output: run.output, error: run.error,
  minutes: Math.round((Date.now() - started) / 600) / 100,
  steps: steps.map(step => ({ key: step.key, kind: step.kind, state: step.state })),
}, null, 2)}\n`);
console.log(JSON.stringify({ runId: run.id, state: run.state, outDir, artifacts: artifacts.map(a => a.type) }, null, 2));
