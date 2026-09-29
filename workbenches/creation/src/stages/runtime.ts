import { existsSync } from 'node:fs';
import path from 'node:path';
import { Codex } from '@openai/codex-sdk';
import { defineAgent, type AgentRunner, type ArtifactRef, type WorkflowTerminal } from '@signal-room/workflow';
import { CodexSdkRunner } from '@signal-room/workflow-codex';
import type { z } from 'zod';

/**
 * The Codex CLI bundled with the SDK (0.154) rejects GPT-6 models for ChatGPT-account logins.
 * The CLI shipped inside the ChatGPT app is newer and accepts them, so stage runs point the SDK at it.
 * Override with CREATION_CODEX_BIN when the app lives elsewhere.
 */
export const DEFAULT_CODEX_BIN = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';

export function resolveCodexBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.CREATION_CODEX_BIN?.trim();
  if (configured) {
    if (!existsSync(configured)) throw new Error(`CREATION_CODEX_BIN does not exist: ${configured}`);
    return configured;
  }
  return existsSync(DEFAULT_CODEX_BIN) ? DEFAULT_CODEX_BIN : undefined;
}

export function createStageRunner(options: { traceRoot: string; codexBinary?: string }): AgentRunner {
  if (!path.isAbsolute(options.traceRoot)) throw new Error('Stage traceRoot must be an absolute private directory');
  const codexPathOverride = options.codexBinary ?? resolveCodexBinary();
  return new CodexSdkRunner({ create: codexOptions => new Codex({
    ...codexOptions,
    ...(codexPathOverride ? { codexPathOverride } : {}),
    // Run traces live inside the repo, so Codex would otherwise inject every AGENTS.md on the way up
    // (≈5k chars of repo engineering rules) into content roles. Found in B1 traces, 2026-09-30.
    config: { ...(codexOptions?.config ?? {}), project_doc_max_bytes: 0 },
  }) }, options.traceRoot);
}

/**
 * The user's global ~/.codex/AGENTS.md (≈12k chars of engineering working agreements) is still injected
 * and cannot be switched off per call. Content roles are told explicitly that it does not apply to them,
 * because its reporting rules ("distinguish facts from assumptions", "state limitations") leaked into
 * scripts as disclaimers.
 */
export const CONTENT_ROLE_PREAMBLE = '【角色说明】你是内容创作流程中的一个角色，不是编程助手。上方 AGENTS.md 里的工程协作约定（模型路由、子 agent、提交与测试、技能治理、汇报时区分事实与推断等）只适用于软件开发，与本任务无关：不要照它的方式给内容加限定语、免责声明或流程说明。事实是否有依据由本流程里专门的角色负责。以下是你的任务。\n\n';

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
}

/** Roles that make files (B3) get a writable sandbox plus the project directory they work in. */
export interface AgentAccess { sandbox: 'read-only' | 'workspace-write'; additionalDirectories?: string[] }

export function stageAgent<Input, Output>(role: RoleSpec, model: StageModel, revision: string, access: AgentAccess = { sandbox: 'read-only' }) {
  return defineAgent<Input, Output>({
    id: role.id,
    revision,
    model: model.model,
    reasoningEffort: model.reasoningEffort,
    promptRevision: revision,
    skillsRevision: 'none',
    permissionsRevision: `${access.sandbox}${role.webSearch ? '-web' : ''}-v1`,
    config: {
      prompt: CONTENT_ROLE_PREAMBLE + role.prompt,
      outputSchema: role.outputSchema,
      threadOptions: {
        sandboxMode: access.sandbox,
        approvalPolicy: 'never',
        ...(access.additionalDirectories?.length ? { additionalDirectories: access.additionalDirectories } : {}),
        ...(role.webSearch ? { webSearchMode: 'live' as const } : { webSearchMode: 'disabled' as const }),
      },
      timeoutMs: 900_000,
    },
  });
}

/** JSON Schema for Codex structured output: every property required, no extras. */
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
