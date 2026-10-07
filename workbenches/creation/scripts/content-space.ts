import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { inspectSpace } from '@signal-room/workflow-spaces/operator';
import { openContentHost } from '../src/spaces/content-host.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  help: { type: 'boolean' }, case: { type: 'string' }, input: { type: 'string' }, key: { type: 'string' },
  run: { type: 'string' }, asset: { type: 'string' }, context: { type: 'string' }, session: { type: 'string' },
  after: { type: 'string' }, limit: { type: 'string' }, file: { type: 'string' },
  type: { type: 'string' },
  'baseline-run': { type: 'string' }, 'baseline-review': { type: 'string' },
  'baseline-asset': { type: 'string' }, hypothesis: { type: 'string' },
  'expected-version': { type: 'string' }, predecessor: { type: 'string' }, reason: { type: 'string' },
  version: { type: 'string' },
  plan: { type: 'string' }, entry: { type: 'string' }, attempt: { type: 'string' },
  manifest: { type: 'string' },
} });
const command = positionals[0] ?? 'status';
const required = (key: keyof typeof values): string => {
  const value = values[key]; if (typeof value !== 'string' || !value.trim()) throw new Error(`--${key} is required`);
  return value;
};
const fromFile = async (key: 'input'|'file') => JSON.parse(await readFile(required(key), 'utf8'));
const emit = (value: unknown) => console.log(JSON.stringify(value, null, 2));
if (values.help) {
  console.log(`CONTENT Space operator CLI (JSON output)
  init
  status
  method-preview                           read-only candidate definition and graph
  method-publish --expected-version ID --reason TEXT [--predecessor ID]
  case --file case.json                    {id,title,objective,constraints}
  detail --case ID
  freeze-input --case ID --input input.json --key KEY
  run --version ID --case ID --input input.json --key KEY [--hypothesis TEXT]
  run --version ID --case ID --manifest ID --key KEY
  validation-create --file plan.json
  validation-freeze --plan ID
  validation-plans                          plans only
  validation-show --plan ID                 scoped plan, coverage, reviews and comparison
  validation-run --plan ID --entry ID [--attempt NUMBER]   queue only
  validation-dispatch                                 explicitly execute queued work
  validation-review --plan ID --file review.json
  validation-link-run --plan ID --file link.json
  validation-link-review --plan ID --file link.json
  validation-compare --plan ID --file comparison.json
  validation-issue --plan ID --file issue.json
  validation-exclude --plan ID --file exclusion.json
  validation-iteration --plan ID --file iteration.json
  validation-adopt --plan ID --file adoption.json
  tasks                                    persistent execution queue, no model calls
  cancel --run ID                          request cancellation for only this run
  dispatch                                 explicitly execute eligible queued work, wait until idle
  inspect --run ID
  process --run ID                        frozen method or explicitly retrospective process query
  neighborhood --asset VERSION_ID [--run ID] [--after CURSOR] [--limit 100]
  events --run ID [--after SEQ] [--limit 100] [--type EVENT_TYPE]
  asset --asset VERSION_ID
  context --context ID
  session --session ID [--after SEQ] [--limit 100]
  review --case ID --file review.json      exact run/draft/answers/standard/id/idempotencyKey; human-authored review
  revise --version ID --case ID --baseline-run ID --baseline-asset ID --baseline-review ID --file notes.json --hypothesis TEXT --key KEY
  experiment --version ID --case ID --baseline-run ID --baseline-review ID --hypothesis TEXT --key KEY
  compare                                  recorded comparisons from the current space

Only run/revise/experiment/dispatch/validation-dispatch can call models. Preview does not write; publication does not run or adopt.
revise uses exact prior draft + explicit creator feedback. experiment reruns frozen original inputs using the selected deployed method.
Interrupted work is never automatically replayed. Missing historical executors are not replaced with current code.
Validation summaries return exact IDs. Use inspect/process, asset/context/session, events or neighborhood to retrieve evidence on demand.
Inspection is privileged operator access, not a tool for workflow execution nodes.`);
  await new Promise<void>(resolve => process.stdout.write('', () => resolve()));
  process.exit(0);
}
const host = await openContentHost(command === 'init');
const { service, workbench, spaceId } = host;
const validation = workbench.validation(spaceId);
let interrupted = false;
process.on('SIGINT', () => { interrupted = true; void workbench.stop(); });
process.on('SIGTERM', () => { interrupted = true; void workbench.stop(); });
try {
  switch (command) {
    case 'init': emit({ spaceId, initialized: true, model: host.models.worker.model }); break;
    case 'status': emit(await inspectSpace(service, spaceId, { kind: 'summary' })); break;
    case 'method-preview': emit(await workbench.preview(spaceId)); break;
    case 'method-publish': emit(await workbench.publishMethod(spaceId, {
      expectedVersionId: required('expected-version'), changeReason: required('reason'),
      ...(values.predecessor ? { predecessorId: values.predecessor } : {}),
    })); break;
    case 'case': emit(await workbench.createCase(spaceId, await fromFile('file'))); break;
    case 'detail': emit(await workbench.detail(spaceId, required('case'))); break;
    case 'freeze-input': emit(await workbench.freezeInput({ spaceId, caseId: required('case'),
      input: await fromFile('input'), idempotencyKey: required('key') })); break;
    case 'validation-create': emit(await validation.create(await fromFile('file'))); break;
    case 'validation-freeze': emit(await validation.freeze(required('plan'))); break;
    case 'validation-plans': emit(await service.validationPlans(spaceId)); break;
    case 'validation-show': emit(await service.validationSummary(spaceId, required('plan'))); break;
    case 'validation-run': emit(await validation.start(required('plan'), required('entry'),
      values.attempt === undefined ? undefined : Number(values.attempt))); break;
    case 'validation-dispatch':
      await validation.dispatch();
      await workbench.waitIdle(spaceId);
      emit(await workbench.tasks(spaceId));
      break;
    case 'validation-review': emit(await validation.review(required('plan'), await fromFile('file'))); break;
    case 'validation-link-run': emit(await validation.linkRun(required('plan'), await fromFile('file'))); break;
    case 'validation-link-review': emit(await validation.linkReview(required('plan'), await fromFile('file'))); break;
    case 'validation-compare': emit(await validation.compare(required('plan'), await fromFile('file'))); break;
    case 'validation-issue': emit(await validation.issue(required('plan'), await fromFile('file'))); break;
    case 'validation-exclude': emit(await validation.exclude(required('plan'), await fromFile('file'))); break;
    case 'validation-iteration': emit(await validation.iteration(required('plan'), await fromFile('file'))); break;
    case 'validation-adopt': emit(await validation.adopt(required('plan'), await fromFile('file'))); break;
    case 'tasks': emit(await workbench.tasks(spaceId)); break;
    case 'cancel': emit(await workbench.cancel(spaceId, required('run'))); break;
    case 'dispatch':
      await workbench.dispatch(spaceId);
      await workbench.waitIdle(spaceId);
      emit(await workbench.tasks(spaceId));
      break;
    case 'inspect': emit(await inspectSpace(service, spaceId, { kind: 'run', runId: required('run') })); break;
    case 'process': emit(await inspectSpace(service, spaceId, { kind: 'process', runId: required('run') })); break;
    case 'neighborhood': emit(await inspectSpace(service, spaceId, {kind:'neighborhood',assetVersionId:required('asset'),
      ...(values.run?{runId:values.run}:{}),...(values.after?{cursor:Number(values.after)}:{}),...(values.limit?{limit:Number(values.limit)}:{})}));break;
    case 'events': emit(await inspectSpace(service, spaceId, { kind: 'events', runId: required('run'),
      ...(values.after ? { after: Number(values.after) } : {}), ...(values.limit ? { limit: Number(values.limit) } : {}),
      ...(values.type ? { type: values.type } : {}) })); break;
    case 'asset': emit(await inspectSpace(service, spaceId, { kind: 'asset', assetVersionId: required('asset') })); break;
    case 'context': emit(await inspectSpace(service, spaceId, { kind: 'context', contextId: required('context') })); break;
    case 'session': emit(await inspectSpace(service, spaceId, { kind: 'session', sessionId: required('session'),
      ...(values.after ? { after: Number(values.after) } : {}), ...(values.limit ? { limit: Number(values.limit) } : {}) })); break;
    case 'review': emit(await workbench.review({ ...await fromFile('file'), spaceId, caseId: required('case') })); break;
    case 'compare': emit((await service.overview(spaceId)).comparisons); break;
    case 'run':
    case 'revise':
    case 'experiment': {
      const handle = command === 'run'
        ? values.manifest
          ? await workbench.startFromManifest({ spaceId, caseId: required('case'), inputManifestId: required('manifest'),
            idempotencyKey: required('key'), workflowVersionId: required('version') })
          : await workbench.start({ spaceId, caseId: required('case'), input: await fromFile('input'), idempotencyKey: required('key'),
            workflowVersionId: required('version'), ...(values.hypothesis ? { hypothesis: values.hypothesis } : {}) })
        : command === 'revise'
          ? await workbench.rerun({ spaceId, caseId: required('case'), baselineRunId: required('baseline-run'),
            workflowVersionId: required('version'),
            baselineDraftVersionId: required('baseline-asset'), baselineReviewId: required('baseline-review'),
            feedbackNotes: await fromFile('file'), hypothesis: required('hypothesis'), idempotencyKey: required('key') })
          : await workbench.experiment({ spaceId, caseId: required('case'), baselineRunId: required('baseline-run'),
            workflowVersionId: required('version'),
            baselineReviewId: required('baseline-review'), hypothesis: required('hypothesis'), idempotencyKey: required('key') });
      console.error(JSON.stringify({ event: 'content.run.created', runId: handle.runId,
        workflowVersionId: handle.workflowVersionId, inputManifestId: handle.inputManifestId }));
      const result = await handle.completion;
      emit(await workbench.runStatus(spaceId, handle.runId));
      if (result.run.state === 'failed' || interrupted) process.exitCode = 1;
      break;
    }
    default: throw new Error(`Unknown command: ${command}. Use --help.`);
  }
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'CONTENT operation failed' }));
  process.exitCode = 1;
} finally {
  // Settle this host's claimed jobs before closing their durable store.
  await workbench.stop();
  await host.pool.end();
}
