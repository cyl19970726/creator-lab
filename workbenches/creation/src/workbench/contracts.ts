import type { ArtifactRef } from '@signal-room/workflow';
import type { PieceBrief } from '../stages/brief.js';

export type WorkflowId = 'creation.content' | 'creation.b3';
export interface Actor { kind: 'user' | 'agent'; id: string }
export interface Command { commandId: string }
export interface CaseInput {
  title: string; opportunity: string; readerGoal: string; requiredQuestions: string[];
  account: { name: string; positioning: string; currentAudience: string; referencePieces: { title: string; result: string; lesson: string }[] };
  form: string; materials: { id: string; title: string; text: string }[];
  webResearch: boolean; maxSeconds?: number;
}
export interface CreationCase { id: string; input: CaseInput; inputHash: string; createdAt: string }
export interface RevisionInput { workflowId: WorkflowId; code: unknown; config: unknown; standards: unknown; deployment?: unknown }
export interface Revision extends RevisionInput { id: string; sha256: string; createdAt: string }
export interface RunRequest extends Command {
  workflowId: WorkflowId; model: string; workerEffort: 'low' | 'medium' | 'high'; judgeEffort: 'low' | 'medium' | 'high'; maxRevisions: number;
  hypothesis: string; baselineRunId?: string; feedback?: string;
  production?: { scope: 'sample' | 'full'; sampleSegments?: number; voice?: 'placeholder' | 'minimax' };
}
export interface PreparedRun { input: unknown; revision: RevisionInput; deployment?: unknown }
export type RunState = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'canceled' | 'blocked' | 'needs_review';
export interface ControlRun {
  id: string; caseId: string; workflowId: WorkflowId; revisionId: string; experimentId: string;
  nativeRunId: string | null; state: RunState; input: unknown; inputHash: string;
  config: Omit<RunRequest, 'commandId'>; createdAt: string; startedAt: string | null;
  finishedAt: string | null; error: string | null; terminal: unknown | null; cancelRequested: boolean;
  preparedEvidence: unknown | null; preparedHash: string | null;
}
export interface Experiment { id: string; caseId: string; runId: string; baselineRunId: string | null; hypothesis: string; createdAt: string }
export interface StoredArtifact { id: string; caseId: string; runId: string; nativeRef: ArtifactRef; sha256: string; payload: unknown; createdAt: string }
export interface ReviewInput extends Command {
  artifactId: string; sha256: string; baselineArtifactId?: string; baselineSha256?: string;
  standardVersion: string; good: string; bad: string; improvement: string; unsatisfied: string;
  verdict: 'pass' | 'fail' | 'uncertain'; visibleMaterials?: string[];
  evaluator?: { model: string; promptRevision: string; visibleMaterials: string[] };
}
export interface Review extends Omit<ReviewInput, 'commandId'> { id: string; caseId: string; actor: Actor; createdAt: string }
export interface ComparisonInput extends Command {
  baselineArtifactId: string; baselineSha256: string; candidateArtifactId: string; candidateSha256: string;
  baselineReviewId: string; candidateReviewId: string; conditions: Record<string, unknown>;
  differences: string; conclusion: string;
}
export interface Comparison extends Omit<ComparisonInput, 'commandId'> { id: string; caseId: string; workflowId: WorkflowId; actor: Actor; createdAt: string }
export type DecisionInput = (Command & { kind: 'artifact'; action: 'adopt' | 'reject' | 'observe'; artifactId: string; sha256: string; reviewId: string; reason: string }) |
  (Command & { kind: 'workflow'; action: 'adopt' | 'rollback' | 'observe'; revisionId: string; comparisonId: string; reason: string });
export interface Decision { id: string; caseId: string; actor: Actor; createdAt: string; input: DecisionInput }
/** Acceptance is constructed by the authenticated API after its gate checks. It is mandatory for adoption. */
export type ValidatedAcceptance =
  | { kind: 'artifact'; actorId: string; artifactId: string; sha256: string; reviewId: string; brief?: PieceBrief }
  | { kind: 'workflow'; actorId: string; revisionId: string; comparisonId: string };
export interface Incident { id: string; runId: string; error: string; createdAt: string }
export interface CaseDetail { case: CreationCase; runs: ControlRun[]; artifacts: StoredArtifact[]; reviews: Review[]; comparisons: Comparison[]; decisions: Decision[]; experiments: Experiment[]; incidents: Incident[]; briefs: PieceBrief[] }
