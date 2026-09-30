import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { SQLiteWorkflowRunStore } from '@signal-room/workflow-sqlite';
import type { AudienceQuestion, Challenge, ContentDecision, ResearchNotes } from '../src/stages/b1.js';
import type { EditorVerdict, FactCheck, Script } from '../src/stages/b2.js';
import { briefAfterB1, briefAfterB2, briefSchema, type GateAcceptance, type PieceBrief } from '../src/stages/brief.js';

/**
 * The creator's gate. Records the verdict on one run; on "accept" it writes the next version of the piece brief
 * from that run's own assets, so the next stage never depends on a hand-assembled input.
 *   pnpm stage:accept <topicId> <runId> --verdict accept|revise|invalid --reviewer "名字"
 *        [--note "对这一版的意见"]... [--next "留给下一阶段的话"]... [--purpose "生产"] [--keep-current]
 * Writes .local/stages/<topic>/decisions.json and, on accept of B1/B2, brief/v<n>.json + brief/latest.json.
 */
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    verdict: { type: 'string' }, reviewer: { type: 'string' }, purpose: { type: 'string' },
    /** Evaluation runs: record the verdict and write the brief, but do not replace the piece's adopted version. */
    'keep-current': { type: 'boolean', default: false },
    note: { type: 'string', multiple: true, default: [] }, next: { type: 'string', multiple: true, default: [] },
  },
});
const [topicId, runId] = positionals;
const verdict = values.verdict;
if (!topicId || !runId || !verdict || !['accept', 'revise', 'invalid'].includes(verdict) || !values.reviewer) {
  throw new Error('Usage: stage-accept.ts <topicId> <runId> --verdict accept|revise|invalid --reviewer <name> [--note ...] [--next ...]');
}
const root = path.resolve('.local/stages', topicId);
const store = new SQLiteWorkflowRunStore(new DatabaseSync(path.join(root, 'ledger.sqlite'), { readOnly: true }));
const run = await store.getRun(runId);
if (!run) throw new Error(`No run ${runId} in ${topicId}`);
const stage = String(run.metadata?.stage);
const acceptedAt = new Date().toISOString();

// ---- decision record
const decisionsFile = path.join(root, 'decisions.json');
const decisions = existsSync(decisionsFile)
  ? JSON.parse(readFileSync(decisionsFile, 'utf8')) as { title?: string; current: Record<string, string>; runs: Record<string, { purpose: string; review?: unknown }> }
  : { current: {}, runs: {} };
decisions.runs[runId] = {
  purpose: values.purpose ?? decisions.runs[runId]?.purpose ?? '生产',
  review: { reviewer: values.reviewer, verdict, notes: [...values.note!, ...values.next!.map(n => `给下一阶段：${n}`)], at: acceptedAt.slice(0, 10) },
};
if (verdict === 'accept' && !values['keep-current']) decisions.current[stage] = runId;
writeFileSync(decisionsFile, `${JSON.stringify(decisions, null, 2)}\n`);
console.log(`recorded ${verdict} for ${stage} ${runId}`);
if (verdict !== 'accept' || stage === 'b3') process.exit(0);

// ---- next brief version, built only from this run's assets and frozen input
const artifacts = await store.listArtifacts(runId);
const last = async <T>(type: string): Promise<T | undefined> => {
  const ref = artifacts.filter(a => a.type === type).at(-1);
  return ref ? await store.getArtifactPayload(ref.id) as T : undefined;
};
const all = async <T>(type: string): Promise<T[]> =>
  Promise.all(artifacts.filter(a => a.type === type).map(async a => await store.getArtifactPayload(a.id) as T));
const inputFile = path.join(root, stage, runId, 'input.json');
if (!existsSync(inputFile)) throw new Error(`The run's frozen input is missing: ${inputFile}`);
const input = JSON.parse(readFileSync(inputFile, 'utf8')) as Record<string, unknown>;
const gate: GateAcceptance = { runId, revision: run.workflowRevision, acceptedAt, reviewer: values.reviewer, notesForNext: values.next! };
const briefDir = path.join(root, 'brief');
mkdirSync(briefDir, { recursive: true });
const latestFile = path.join(briefDir, 'latest.json');
const previous = existsSync(latestFile) ? briefSchema.parse(JSON.parse(readFileSync(latestFile, 'utf8'))) : undefined;

let brief: PieceBrief;
if (stage === 'b1') {
  const prior = input.prior as { audienceQuestion?: AudienceQuestion; researchNotes?: unknown } | undefined;
  const audienceQuestion = await last<AudienceQuestion>('b1-audience-question') ?? prior?.audienceQuestion;
  const decision = await last<ContentDecision>('b1-content-decision');
  if (!audienceQuestion || !decision) throw new Error('B1 run has no audience question or content decision to hand over');
  // Research from this run, plus research carried in from an earlier round (prior.researchNotes may be nested).
  const carried: ResearchNotes['notes'] = [];
  const collect = (value: unknown) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray((value as ResearchNotes).notes)) carried.push(...(value as ResearchNotes).notes);
    else Object.values(value).forEach(collect);
  };
  collect(prior?.researchNotes);
  const research = [...carried, ...(await all<ResearchNotes>('b1-research-notes')).flatMap(r => r.notes)];
  brief = briefAfterB1({
    input: input as never, audienceQuestion, decision, research, challenge: await last<Challenge>('b1-challenge'),
    previousVersion: previous?.version, gate,
  });
} else {
  const base = briefSchema.parse(input.brief);
  const script = await last<Script>('b2-script');
  if (!script) throw new Error('B2 run has no script to hand over');
  brief = briefAfterB2({ ...base, version: Math.max(base.version, previous?.version ?? 0) }, {
    script, editor: await last<EditorVerdict>('b2-editor'), factCheck: await last<FactCheck>('b2-fact-check'), gate,
  });
}
const versionFile = path.join(briefDir, `v${brief.version}.json`);
writeFileSync(versionFile, `${JSON.stringify(brief, null, 2)}\n`);
writeFileSync(latestFile, `${JSON.stringify(brief, null, 2)}\n`);
console.log(`brief v${brief.version} → ${versionFile}`);
console.log(`  notes for B2: ${brief.notesForB2.length}   notes for B3: ${brief.notesForB3.length}   materials: ${brief.materials.length}`);
