import { z } from 'zod';

export const idSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const text = (max = 12000) => z.string().trim().min(1).max(max);
export const materialSchema = z.object({ id: idSchema, title: text(200), text: text(40000), url: z.string().url().max(2000).optional() }).strict();
export const workspaceInputSchema = z.object({ commandId: idSchema, name: text(100), positioning: text(3000) }).strict();
export const createWorkSchema = z.object({
  commandId: idSchema, workspaceId: idSchema, title: text(200), question: text(3000), audience: text(1000),
  purpose: z.enum(['explanation', 'opinion', 'narrative']), medium: z.literal('article'),
  accountPositioning: text(3000), constraints: z.string().max(3000), materials: z.array(materialSchema).max(20),
}).strict().refine(x => new Set(x.materials.map(m => m.id)).size === x.materials.length, 'Material IDs must be unique');
export const executionConfigSchema = z.object({ model: text(100), reasoningEffort: z.enum(['low','medium','high']), maxRevisions: z.number().int().min(0).max(2) }).strict();
export const startSchema = executionConfigSchema.extend({ commandId: idSchema }).strict();
export const revisionSchema = startSchema.extend({ artifactId: idSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/), feedback: text(6000) }).strict();
export const decisionSchema = z.object({ commandId: idSchema, artifactId: idSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/), action: z.enum(['select','accept','return']), reason: text(3000) }).strict();
export const commandSchema = z.object({ commandId: idSchema }).strict();

export const definitionSchema = z.object({
  question: text(3000), promise: text(3000), audienceChange: text(3000), accountFit: text(3000),
  materialRoles: z.array(z.object({ sourceId: idSchema, use: text(3000) }).strict()).max(20),
  scope: text(5000), unknowns: z.array(text(2000)).max(20),
}).strict();
export const draftSchema = z.object({ title: text(200), body: text(40000), sourceIds: z.array(idSchema).max(20) }).strict();
export const reviewSchema = z.object({
  verdict: z.enum(['pass','revise','blocked']), summary: text(4000),
  findings: z.array(z.object({ severity: z.enum(['critical','major','minor']), message: text(3000) }).strict()).max(30),
}).strict().refine(r => r.verdict !== 'pass' || r.findings.every(f => f.severity === 'minor'), 'Passing review cannot contain major or critical findings');

export type Material = z.infer<typeof materialSchema>;
export type ContentDefinition = z.infer<typeof definitionSchema>;
export type Draft = z.infer<typeof draftSchema>;
export type Review = z.infer<typeof reviewSchema>;
export type ExecutionConfig = z.infer<typeof executionConfigSchema>;
export type CreateWork = z.infer<typeof createWorkSchema>;
export type WorkspaceInput = z.infer<typeof workspaceInputSchema>;
export type StartInput = z.infer<typeof startSchema>;
export type RevisionInput = z.infer<typeof revisionSchema>;
export type DecisionInput = z.infer<typeof decisionSchema>;
export type WorkflowInput = Omit<CreateWork, 'commandId' | 'workspaceId' | 'title'> & ExecutionConfig & {
  workId: string;
  revision?: { draft: Draft; definition: ContentDefinition; feedback: string; parentAssetId: string; parentHash: string; parentRevision: string };
};
export interface Workspace { id: string; name: string; positioning: string; createdAt: string }
export interface Work extends Omit<CreateWork,'commandId'> { id: string; createdAt: string; selectedArtifactId: string | null }
export type JobState = 'queued'|'running'|'succeeded'|'needs_review'|'blocked'|'failed'|'canceled';
export interface Job { id: string; workId: string; state: JobState; runId: string | null; createdAt: string; updatedAt: string; model: string; reasoningEffort: string; maxRevisions: number; cancelRequested: boolean; error: string | null; parentArtifactId: string | null; feedback: string | null }
export interface ArtifactIdentity { id: string; revision: string; sha256: string }
export interface Artifact { id: string; workId: string; jobId: string; kind: 'definition'|'draft'|'review'; sha256: string; content: string; payload: unknown; vendorRef: ArtifactIdentity; createdAt: string; dependencies: string[] }
export interface Decision { id: string; workId: string; artifactId: string; sha256: string; action: 'select'|'accept'|'return'; reason: string; createdAt: string; actor: 'user' }
export interface WorkDetail { work: Work; jobs: Job[]; artifacts: Artifact[]; decisions: Decision[] }
export interface ExecutionStep { id: string; key: string; kind: string; state: string; attempts: number }
export interface ExecutionView { runId: string | null; state: string; workflowId?: string; workflowRevision?: string; steps: ExecutionStep[]; error?: string }
