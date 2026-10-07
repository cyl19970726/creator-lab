import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ArtifactRef } from '@signal-room/workflow';
import { briefAfterContent, type PieceBrief } from '../stages/brief.js';
import { contentAcceptanceFailures, contentInputSchema, type ContentDraft, type ContentFactCheck, type ContentResearch, type ContentReview } from '../stages/content.js';
import type { StoredArtifact } from './contracts.js';
import type { WorkbenchStore } from './store.js';

const sha = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
const exactRef = (a: ArtifactRef | undefined, b: ArtifactRef | undefined) => Boolean(a && b && a.id === b.id && a.sha256 === b.sha256 && a.revision === b.revision && a.producedBy.workflowRunId === b.producedBy.workflowRunId);
const hasDependency = (ref: ArtifactRef, dependency: ArtifactRef) => ref.dependsOn.some(d => d.artifactId === dependency.id && d.revision === dependency.revision && d.sha256 === dependency.sha256);
function asObject(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function terminalDetails(store: WorkbenchStore, artifact: StoredArtifact) {
  const run = store.getRun(artifact.runId);
  const terminal = asObject(run.terminal);
  const details = asObject(terminal.details);
  if (run.state !== 'needs_review' || terminal.state !== 'needs_review' || terminal.ok !== false || details.reason !== 'awaiting-human-review') {
    throw new Error('Run has no final, converged creator gate');
  }
  if (!run.nativeRunId || artifact.nativeRef.producedBy.workflowRunId !== run.nativeRunId) throw new Error('Artifact is not from the bound native run');
  return { run, details };
}
export interface MediaFile { name: string; path: string; sha256: string; bytes: number; mimeType: string }
function checkedMedia(store: WorkbenchStore, runId: string, mediaPath: string, allowed: string[]): MediaFile {
  const root = realpathSync(path.join(store.stateRoot, 'runs', runId));
  if (!path.isAbsolute(mediaPath) || !existsSync(mediaPath)) throw new Error('Final media file is missing');
  const actual = realpathSync(mediaPath);
  if (!actual.startsWith(`${root}${path.sep}`)) throw new Error('Media path escapes the private run directory');
  const stat = statSync(actual);
  if (!stat.isFile() || stat.size <= 0) throw new Error('Final media file is empty or not a file');
  const extension = path.extname(actual).toLowerCase();
  if (!allowed.includes(extension)) throw new Error('Unsupported media type');
  const digest = sha(readFileSync(actual));
  if (extension === '.mp4') {
    const receiptPath = path.join(path.dirname(actual), 'video.json');
    if (!existsSync(receiptPath)) throw new Error('Video digest receipt is missing');
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as { file?: string; sha256?: string; bytes?: number };
    if (receipt.file !== path.basename(actual) || receipt.sha256 !== digest || receipt.bytes !== stat.size) throw new Error('Video bytes do not match the saved digest receipt');
  } else {
    const name = path.basename(actual);
    const recorded = /-([a-f0-9]{64})\.(?:png|jpe?g)$/.exec(name)?.[1];
    if (!recorded || recorded !== digest) throw new Error('Snapshot bytes do not match the saved filename digest');
  }
  return { name: path.basename(actual), path: actual, sha256: digest, bytes: stat.size,
    mimeType: extension === '.mp4' ? 'video/mp4' : extension === '.png' ? 'image/png' : 'image/jpeg' };
}
function finalB3(store: WorkbenchStore, artifact: StoredArtifact) {
  const { run, details } = terminalDetails(store, artifact);
  if (details.stage !== 'B3' || artifact.nativeRef.type !== 'b3-video' || !['sample', 'full'].includes(String(details.scope))) throw new Error('Only a final inspected video can be accepted');
  const payload = asObject(artifact.payload);
  if (typeof payload.output !== 'string' || details.video !== payload.output) throw new Error('Final video does not match the gate');
  const video = checkedMedia(store, run.id, payload.output, ['.mp4']);
  const peers = store.listArtifacts(run.id);
  const inspections = peers.filter(a => a.nativeRef.type === 'b3-inspection' && hasDependency(artifact.nativeRef, a.nativeRef));
  if (inspections.length !== 1) throw new Error('Final video does not depend on one exact inspection');
  const inspection = asObject(inspections[0]!.payload);
  const opened = inspection.imagesOpened;
  const sheets = details.contactSheets;
  if (inspection.verdict !== 'pass' || !Array.isArray(opened) || !Array.isArray(sheets) || !sheets.length ||
    opened.length !== sheets.length || new Set(opened).size !== sheets.length || !sheets.every((sheet, i) => typeof sheet === 'string' && opened[i] === sheet)) {
    throw new Error('Final inspector did not pass and open the exact final contact sheets');
  }
  const images = sheets.map(sheet => checkedMedia(store, run.id, sheet as string, ['.png', '.jpg', '.jpeg']));
  return { video, images };
}
export function mediaFilesForArtifact(store: WorkbenchStore, artifact: StoredArtifact): MediaFile[] {
  const stored = store.getArtifact(artifact.id);
  if (!exactRef(stored.nativeRef, artifact.nativeRef) || stored.sha256 !== artifact.sha256) throw new Error('Artifact reference is stale');
  const run = store.getRun(stored.runId);
  if (!run.nativeRunId || stored.nativeRef.producedBy.workflowRunId !== run.nativeRunId) throw new Error('Artifact is not bound to this run');
  const payload = asObject(stored.payload);
  if (stored.nativeRef.type === 'b3-assembly') {
    if (!Array.isArray(payload.sheets)) return [];
    return payload.sheets.map(file => checkedMedia(store, run.id, file as string, ['.png', '.jpg', '.jpeg']));
  }
  if (stored.nativeRef.type === 'b3-video') {
    if (typeof payload.output !== 'string') return [];
    const files = [checkedMedia(store, run.id, payload.output, ['.mp4'])];
    const details = asObject(asObject(run.terminal).details);
    if (details.video === payload.output && Array.isArray(details.contactSheets)) {
      files.push(...details.contactSheets.map(file => checkedMedia(store, run.id, file as string, ['.png', '.jpg', '.jpeg'])));
    }
    return files;
  }
  return [];
}
export function validateArtifactAcceptance(store: WorkbenchStore, artifact: StoredArtifact, actorId: string, notesForNext: string[] = []): { brief?: PieceBrief } {
  if (!actorId.trim()) throw new Error('Reviewer identity is required');
  if (!Array.isArray(notesForNext) || notesForNext.some(note => typeof note !== 'string' || !note.trim())) throw new Error('Creator handoff notes must be nonempty strings');
  const stored = store.getArtifact(artifact.id);
  if (!exactRef(stored.nativeRef, artifact.nativeRef) || stored.sha256 !== artifact.sha256) throw new Error('Artifact reference is stale');
  const { run, details } = terminalDetails(store, stored);
  if (run.workflowId === 'creation.b3') { finalB3(store, stored); return {}; }
  if (run.workflowId !== 'creation.content' || details.stage !== 'CONTENT' || stored.nativeRef.type !== 'content-draft' ||
    !Array.isArray(details.guardFailures) || details.guardFailures.length) throw new Error('Content artifact is not the final accepted draft');
  const peers = store.listArtifacts(run.id);
  const byRef = (ref: unknown, type: string) => peers.find(a => a.nativeRef.type === type && exactRef(a.nativeRef, ref as ArtifactRef));
  const draft = byRef(details.draft, 'content-draft');
  const review = byRef(details.review, 'content-review');
  const research = byRef(details.research, 'content-research');
  if (!draft || draft.id !== stored.id || !review || !research) throw new Error('Content gate references do not bind the final artifacts');
  const facts = peers.filter(a => a.nativeRef.type === 'content-fact-check' && hasDependency(review.nativeRef, a.nativeRef));
  if (facts.length !== 1 || !hasDependency(review.nativeRef, draft.nativeRef) || !hasDependency(review.nativeRef, research.nativeRef)) {
    throw new Error('Final editor review lacks exact draft, research or fact-check dependencies');
  }
  const draftValue = draft.payload as ContentDraft;
  const reviewValue = review.payload as ContentReview;
  const researchValue = research.payload as ContentResearch;
  const factsValue = facts[0]!.payload as ContentFactCheck;
  if (!draftValue?.decision || !draftValue?.script || reviewValue?.verdict !== 'pass' || reviewValue.route !== 'pass' ||
    reviewValue.guardFailures?.length || !Array.isArray(researchValue?.notes) || !Array.isArray(factsValue?.issues)) throw new Error('Final content artifacts are incomplete');
  const input = contentInputSchema.parse(run.input);
  const failures = contentAcceptanceFailures(input, reviewValue, factsValue, draftValue, researchValue);
  if (failures.length) throw new Error(`Content acceptance failed: ${failures.join('; ')}`);
  const previousVersion = store.getAcceptedBrief(run.caseId)?.version ?? 0;
  return { brief: briefAfterContent({ input, draft: draftValue, research: researchValue.notes, review: reviewValue, previousVersion,
    gate: { runId: run.nativeRunId!, revision: store.getRevision(run.revisionId).sha256, acceptedAt: new Date().toISOString(), reviewer: actorId, notesForNext } }) };
}
