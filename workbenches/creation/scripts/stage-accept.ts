import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { SQLiteWorkflowRunStore } from '@signal-room/workflow-sqlite';
import type { ArtifactRef } from '@signal-room/workflow';
import type { AudienceQuestion, Challenge, ContentDecision, ResearchNotes } from '../src/stages/b1.js';
import type { EditorVerdict, FactCheck, Script } from '../src/stages/b2.js';
import { briefAfterB1, briefAfterB2, briefAfterContent, briefSchema, type GateAcceptance, type PieceBrief } from '../src/stages/brief.js';
import { contentAcceptanceFailures, contentInputSchema, type ContentDraft, type ContentResearch, type ContentReview, type ContentFactCheck } from '../src/stages/content.js';

/**
 * The creator's gate. Records the verdict on one run; on "accept" it writes the next version of the piece brief
 * from that run's own assets, so the next stage never depends on a hand-assembled input.
 *   pnpm stage:accept <topicId> <runId> --verdict accept|revise|invalid --reviewer "名字"
 *        [--note "对这一版的意见"]... [--next "留给下一阶段的话"]... [--purpose "生产"] [--keep-current]
 * Writes .local/stages/<topic>/decisions.json and, on accept of content (or historical B1/B2), an immutable brief/v<n>.json.
 * Only an adopted acceptance updates brief/latest.json.
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
if (!['content', 'b1', 'b2', 'b3'].includes(stage)) throw new Error(`Unsupported stage: ${stage}`);
const acceptedAt = new Date().toISOString();

// Prepare the decision in memory. A content/B1/B2 acceptance is recorded only after its brief can be built.
const decisionsFile = path.join(root, 'decisions.json');
const decisions = existsSync(decisionsFile)
  ? JSON.parse(readFileSync(decisionsFile, 'utf8')) as { title?: string; current: Record<string, string>; runs: Record<string, { purpose: string; review?: unknown }> }
  : { current: {}, runs: {} };
decisions.runs[runId] = {
  purpose: values.purpose ?? decisions.runs[runId]?.purpose ?? '生产',
  review: { reviewer: values.reviewer, verdict, notes: [...values.note!, ...values.next!.map(n => `给下一阶段：${n}`)], at: acceptedAt.slice(0, 10) },
};
if (verdict === 'accept' && !values['keep-current']) decisions.current[stage] = runId;
if (verdict !== 'accept' || stage === 'b3') {
  writeFileSync(decisionsFile, `${JSON.stringify(decisions, null, 2)}\n`);
  console.log(`recorded ${verdict} for ${stage} ${runId}`);
  process.exit(0);
}

// ---- next brief version, built only from this run's assets and frozen input
const artifacts = await store.listArtifacts(runId);
const lastRef = (type: string): ArtifactRef | undefined => artifacts.filter(a => a.type === type).at(-1);
const last = async <T>(type: string): Promise<T | undefined> => {
  const ref = lastRef(type);
  return ref ? await store.getArtifactPayload(ref.id) as T : undefined;
};
const all = async <T>(type: string): Promise<T[]> =>
  Promise.all(artifacts.filter(a => a.type === type).map(async a => await store.getArtifactPayload(a.id) as T));
const inputFile = path.join(root, stage, runId, 'input.json');
if (!existsSync(inputFile)) throw new Error(`The run's frozen input is missing: ${inputFile}`);
const input = JSON.parse(readFileSync(inputFile, 'utf8')) as Record<string, unknown>;
const gate: GateAcceptance = { runId, revision: run.workflowRevision, acceptedAt, reviewer: values.reviewer, notesForNext: values.next! };
const briefDir = path.join(root, 'brief');
const latestFile = path.join(briefDir, 'latest.json');
const previous = existsSync(latestFile) ? briefSchema.parse(JSON.parse(readFileSync(latestFile, 'utf8'))) : undefined;
// Evaluation briefs do not advance latest, so allocate from every version ever written.
const nextVersion = Math.max(previous?.version ?? 0, ...(
  existsSync(briefDir) ? readdirSync(briefDir).map(name => /^v(\d+)\.json$/.exec(name)?.[1]).filter((n): n is string => !!n).map(Number) : []
)) + 1;

let brief: PieceBrief;
if (stage === 'content') {
  const details = (run.output as { details?: { stage?: string; reason?: string; draft?: ArtifactRef; review?: ArtifactRef; research?: ArtifactRef; guardFailures?: string[] } } | undefined)?.details;
  if (run.state !== 'needs_review' || details?.stage !== 'CONTENT' || details.reason !== 'awaiting-human-review' || !Array.isArray(details.guardFailures) || details.guardFailures.length) {
    throw new Error(`Content run is not ready for acceptance: ${run.state} / ${details?.reason ?? 'no final reason'}`);
  }
  const draftRef = lastRef('content-draft');
  const researchRef = lastRef('content-research');
  const factRef = lastRef('content-fact-check');
  const reviewRef = lastRef('content-review');
  const sameRef = (a: ArtifactRef | undefined, b: ArtifactRef | undefined) => !!a && !!b && a.id === b.id && a.sha256 === b.sha256 && a.revision === b.revision && a.producedBy.workflowRunId === runId;
  const dependsOn = (review: ArtifactRef, source: ArtifactRef) => review.dependsOn.some(d => d.artifactId === source.id && d.sha256 === source.sha256 && d.revision === source.revision);
  if (!sameRef(details.draft, draftRef) || !sameRef(details.research, researchRef) || !sameRef(details.review, reviewRef) || !factRef || !reviewRef || !draftRef || !researchRef ||
      !dependsOn(reviewRef, draftRef) || !dependsOn(reviewRef, researchRef) || !dependsOn(reviewRef, factRef)) {
    throw new Error('Content terminal references do not match one final reviewed draft, research set, and fact check');
  }
  const draft = await last<ContentDraft>('content-draft');
  const review = await last<ContentReview>('content-review');
  const factCheck = await last<ContentFactCheck>('content-fact-check');
  const researchSet = await last<ContentResearch>('content-research');
  if (!draft?.decision || !draft.script || review?.verdict !== 'pass' || review.route !== 'pass' || review.guardFailures?.length || !factCheck || !researchSet) {
    throw new Error('Content run needs a final draft and passing content review before acceptance');
  }
  const parsed = contentInputSchema.parse(input);
  const failures = contentAcceptanceFailures(parsed, review, factCheck, draft, researchSet);
  if (failures.length) throw new Error(`Content acceptance guards failed: ${failures.join('; ')}`);
  // Each research artifact carries the cumulative, corrected note set for that round.
  const research = researchSet.notes;
  brief = briefAfterContent({ input: parsed, draft, research, review, previousVersion: nextVersion - 1, gate });
} else if (stage === 'b1') {
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
    previousVersion: nextVersion - 1, gate,
  });
} else {
  const base = briefSchema.parse(input.brief);
  const script = await last<Script>('b2-script');
  if (!script) throw new Error('B2 run has no script to hand over');
  brief = briefAfterB2({ ...base, version: nextVersion - 1 }, {
    script, editor: await last<EditorVerdict>('b2-editor'), factCheck: await last<FactCheck>('b2-fact-check'), gate,
  });
}
const versionFile = path.join(briefDir, `v${brief.version}.json`);
mkdirSync(briefDir, { recursive: true });
const serialized = `${JSON.stringify(brief, null, 2)}\n`;
writeFileSync(versionFile, serialized, { flag: 'wx' });
if (!values['keep-current']) writeFileSync(latestFile, serialized);
writeFileSync(decisionsFile, `${JSON.stringify(decisions, null, 2)}\n`);
console.log(`recorded ${verdict} for ${stage} ${runId}`);
console.log(`brief v${brief.version} → ${versionFile}`);
console.log(`  notes for B2: ${brief.notesForB2.length}   notes for B3: ${brief.notesForB3.length}   materials: ${brief.materials.length}`);
