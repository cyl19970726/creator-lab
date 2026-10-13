import { defineAgent, type AgentRunner, type ArtifactRef, type WorkflowTerminal } from '@signal-room/workflow';
import { OpenAIAgentsSdkRunner, SiwcAuth, type SiwcRunnerOptions } from '@signal-room/workflow-agent-sdk';
import type { z } from 'zod';

/** The workflow owns persistence; the official Agents SDK owns every model/tool turn. */
export function createStageRunner(options: Pick<SiwcRunnerOptions, 'tools' | 'fetch' | 'images'> & {
  auth?: Pick<SiwcAuth, 'accessToken'>; timeoutMs?: number;
} = {}): AgentRunner {
  return new OpenAIAgentsSdkRunner({ auth: options.auth ?? new SiwcAuth(), maxTurns: 8, maxToolCalls: 24,
    timeoutMs: options.timeoutMs ?? 15 * 60_000, enforceJsonObject: true,
    ...(options.tools ? { tools: options.tools } : {}), ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.images ? { images: options.images } : {}) });
}

/** Workflow input is the complete role context; no operator or repository instructions are injected. */
export const CONTENT_ROLE_PREAMBLE = '';

export interface StageModel {
  model: string;
  reasoningEffort: 'low' | 'medium' | 'high';
}

/** One role inside a stage. `prompt` states the job; `guards` names the failure this role exists to catch. */
export interface RoleSpec {
  id: string;
  title: string;
  guards: string;
  prompt: string;
  outputSchema: unknown;
  webSearch?: boolean;
  /** Omitted uses the historic CONTENT preamble; an empty value is an explicit clean prompt. */
  preamble?: string;
  /** The prompt already includes the JSON schema instruction for an exact provider capture. */
  instructionsCompiled?: boolean;
}

export function stageAgent<Input, Output>(role: RoleSpec, model: StageModel, revision: string) {
  return defineAgent<Input, Output>({
    id: role.id,
    revision,
    model: model.model,
    reasoningEffort: model.reasoningEffort,
    promptRevision: revision,
    skillsRevision: 'none',
    permissionsRevision: `agents-sdk-${role.webSearch ? 'web' : 'bounded'}-v1`,
    config: {
      prompt: (role.preamble ?? CONTENT_ROLE_PREAMBLE) + role.prompt,
      outputSchema: role.outputSchema,
      ...(role.instructionsCompiled ? { instructionsFormat: 'precompiled-schema-v1' } : {}),
      timeoutMs: 900_000,
    },
  });
}

/** JSON Schema for strict structured role output: every property required, no extras. */
export function objectSchema(properties: Record<string, unknown>): Record<string, unknown> {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}
export const str = { type: 'string' };
export const strList = { type: 'array', items: str };
export const oneOf = (...values: string[]) => ({ type: 'string', enum: values });
export const listOf = (item: unknown) => ({ type: 'array', items: item });

export function dependency(ref: ArtifactRef) {
  return { artifactId: ref.id, revision: ref.revision, sha256: ref.sha256 };
}

export function check<T>(schema: z.ZodType<T>, value: unknown) {
  const parsed = schema.safeParse(value);
  return parsed.success
    ? { valid: true }
    : { valid: false, details: parsed.error.issues.map(issue => ({ path: issue.path, message: issue.message })) };
}

export function isTerminal(value: unknown): value is WorkflowTerminal<never> {
  return !!value && typeof value === 'object' && 'ok' in value && (value as { ok?: unknown }).ok === false;
}
