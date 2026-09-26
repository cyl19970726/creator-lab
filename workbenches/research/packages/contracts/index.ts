import { z } from 'zod';
export const IdentitySchema = z
  .object({
    id: z.string().min(1),
    revision: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type Identity = z.infer<typeof IdentitySchema>;
export const StartSchema = z
  .object({
    topicId: z.string().min(1),
    title: z.string().min(1).max(200),
    goal: z.string().min(10).max(12000),
    asOf: z.iso.date(),
    sourceIds: z.array(z.string()).min(1).max(30),
    idempotencyKey: z.string().min(8),
    model: z.literal('gpt-5.6-luna').default('gpt-5.6-luna'),
    reasoningEffort: z.literal('medium').default('medium'),
  })
  .strict();
export type StartRequest = z.infer<typeof StartSchema>;
export const FeedbackSchema = z
  .object({
    identity: IdentitySchema,
    body: z.string().min(1).max(12000),
    location: z.string().max(1000).default('全文'),
    idempotencyKey: z.string().min(8),
  })
  .strict();
export const DecisionSchema = z
  .object({
    identity: IdentitySchema,
    verdict: z.enum(['accept', 'return']),
    scope: z.enum(['whole', 'partial']),
    scopeLabel: z.string().min(1).max(1000),
    idempotencyKey: z.string().min(8),
  })
  .strict();
export const RepairSchema = z
  .object({
    identity: IdentitySchema,
    feedbackIds: z.array(z.string()).min(1).max(50),
    route: z.enum(['expression', 'evidence']),
    idempotencyKey: z.string().min(8),
  })
  .strict();
export const ResumeSchema = z.object({ idempotencyKey: z.string().min(8) }).strict();
export interface Source {
  id: string;
  title: string;
  sha256: string;
  size: number;
  provenance: string;
}
export interface Topic {
  id: string;
  title: string;
  goal: string;
  readers: string[];
  sources: Source[];
}
export interface Run {
  goal: string;
  asOf: string;
  readers: string[];
  model: 'gpt-5.6-luna';
  sources: Array<{ id: string; title: string; sha256: string }>;

  id: string;
  runId: string;
  topicId: string;
  workspaceId: string;
  title: string;
  state?: string;
  queueState: string;
  createdAt: string;
  workflowRevision: string;
}
export interface CollaborationEvent {
  id: string;
  runId: string;
  identity: Identity;
  type: 'feedback' | 'decision';
  actor: 'user';
  createdAt: string;
  body?: string;
  location?: string;
  verdict?: 'accept' | 'return';
  scope?: 'whole' | 'partial';
  scopeLabel?: string;
}
export interface ArtifactUI {
  title: string;
  fileHash?: string;
}
// Workflow DTOs remain owned by the upstream read-model; these are product-only extensions.
import type { WorkflowSnapshot } from '@signal-room/workflow-read-model';
export type ResearchSnapshot = WorkflowSnapshot & {
  ui: { assets: Record<string, ArtifactUI>; primaryByStage: Record<string, string> };
};
