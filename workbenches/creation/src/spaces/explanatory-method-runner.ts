import { workflowFingerprint, type AgentRunRequest, type AgentRunner } from '@signal-room/workflow';
import { OpenAIAgentsSdkRunner, type SiwcAuth } from '@signal-room/workflow-agent-sdk';
import { nodeReadTools, type AssetVersion, type ExecutionBudgetReservationReceipt,
  type NodeContext, type WorkflowSpaceService } from '@signal-room/workflow-spaces';
import { z } from 'zod';
import { CONTENT_REVISION, contentDraftAgentOutputSchema, contentFactCheckOutputSchema,
  contentReaderOutputSchema, contentResearchAgentOutputSchema, contentReviewAgentOutputSchema,
  type ContentResearch } from '../stages/content.js';
import { stageAgent } from '../stages/runtime.js';
import type { ContentDeployment } from './content-method.js';
import { assertUniqueSourceHandles, sourceHandleIndex, sourceReferenceIssues,
  type SourceReferenceIssue } from './source-handles.js';

type RequestKind = 'original' | 'tool-continuation' | 'technical-repair';
type Role = 'researcher' | 'author' | 'coldReader' | 'factChecker' | 'editor';
const roleById: Record<string, Role> = {
  'content-researcher': 'researcher', 'content-author': 'author',
  'content-cold-reader': 'coldReader', 'content-fact-checker': 'factChecker', 'content-editor': 'editor',
};
const outputSchemas: Record<Role, z.ZodType> = {
  researcher: contentResearchAgentOutputSchema, author: contentDraftAgentOutputSchema,
  coldReader: contentReaderOutputSchema, factChecker: contentFactCheckOutputSchema,
  editor: contentReviewAgentOutputSchema,
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const withoutMarkdown = (value: unknown) => { const { markdown: _markdown, ...rest } = record(value); return rest; };
const same = (a: unknown, b: unknown) => workflowFingerprint(a) === workflowFingerprint(b);

interface ValidationIssue { path: string; value: unknown; expected: string }
function strippedOutputFields(raw: unknown, parsed: unknown, path = ''): ValidationIssue[] {
  if (Array.isArray(raw) && Array.isArray(parsed))
    return raw.flatMap((item, index) => strippedOutputFields(item, parsed[index], `${path}/${index}`));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
    !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const accepted = parsed as Record<string, unknown>;
  return Object.entries(raw as Record<string, unknown>).flatMap(([key, value]) => {
    const at = `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
    return Object.hasOwn(accepted, key)
      ? strippedOutputFields(value, accepted[key], at)
      : [{ path: at, value, expected: 'additional property is not allowed by output schema' }];
  });
}
class ExactOutputError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super(issues.map(issue => `${issue.path}: ${issue.expected}`).join('; '));
  }
}

function atPath(value: unknown, path: readonly PropertyKey[]): unknown {
  return path.reduce<unknown>((item, segment) => record(item)[String(segment)] ??
    (Array.isArray(item) ? item[Number(segment)] : undefined), value);
}

/** Only the public words delivered to the simulated reader may cross this boundary. */
export function exactColdReaderInput(context: NodeContext): unknown {
  const manuscript = record(context.inputs.manuscript?.payload);
  const script = record(manuscript.script);
  const audience = record(record(context.inputs.audienceProfile?.payload).account);
  const segments = script.segments;
  if (typeof audience.currentAudience !== 'string' || typeof script.title !== 'string' ||
    typeof script.coverText !== 'string' || !Array.isArray(segments))
    throw new Error('Cold reader exact projected inputs are missing');
  return { audienceProfile: audience.currentAudience, title: script.title, coverText: script.coverText,
    segments: segments.map((item, index) => {
      const part = record(item);
      if (Object.keys(part).sort().join(',') !== 'onScreenText,voiceover' ||
        typeof part.voiceover !== 'string' || typeof part.onScreenText !== 'string')
        throw new Error(`Cold reader projection leaked or omitted a field at /script/segments/${index}`);
      return { number: index + 1, voiceover: part.voiceover, onScreenText: part.onScreenText };
    }) };
}

function assertExactContext(role: Role, request: AgentRunRequest<unknown>, context: NodeContext,
  materials?: AssetVersion): void {
  const input = record(request.input);
  if (role === 'coldReader') {
    if (Object.keys(input).sort().join(',') !== 'audienceProfile,coverText,segments,title' ||
      !same(input, exactColdReaderInput(context))) throw new Error('Cold reader input differs from its exact text-only context');
    if (Object.keys(context.inputs).sort().join(',') !== 'audienceProfile,manuscript')
      throw new Error('Cold reader has an undeclared bound input');
    return;
  }
  if (materials) {
    if (!same(input.materials, materials.payload))
      throw new Error(`${role} materials differ from the exact frozen parent`);
  }
  const check = (inputField: string, slot: string, strip = false) => {
    const delivered = context.inputs[slot];
    if (!delivered || !same(input[inputField], strip ? withoutMarkdown(delivered.payload) : delivered.payload))
      throw new Error(`${role}.${inputField} differs from exact bound ${slot}`);
  };
  if (role === 'author') check('research', 'research');
  if (role === 'factChecker') check('draft', 'draft', true);
  if (role === 'editor') {
    check('draft', 'draft', true); check('research', 'research');
    check('coldRead', 'reader'); check('factCheck', 'factCheck');
  }
  if (role === 'researcher' || role === 'author' || role === 'editor') {
    const opportunity = record(context.inputs.opportunity?.payload);
    for (const field of ['opportunity', 'readerGoal', 'requiredQuestions', 'account', 'form', 'standards'])
      if (!same(input[field], opportunity[field])) throw new Error(`${role}.${field} differs from frozen opportunity`);
  }
  if (role === 'researcher' && input.webResearch !== false)
    throw new Error('Explanatory method requires offline research');
}

export interface ExplanatoryMethodBudget {
  current(request: AgentRunRequest<unknown>): Promise<{ deadlineAt: string | null; nodeDeadlineAt: string | null;
    stage: 'trial' | 'case' }>;
  reserve(input: { request: AgentRunRequest<unknown>; turn: number; kind: RequestKind }): Promise<ExecutionBudgetReservationReceipt>;
}
export interface ExplanatoryMethodRunnerOptions {
  service: Pick<WorkflowSpaceService, 'runtimeContexts' | 'readAsset' | 'nodeClient'>;
  spaceId: string;
  auth: Pick<SiwcAuth, 'accessToken'>;
  budget: ExplanatoryMethodBudget;
  fetch?: typeof fetch;
}

/** A guarded adapter: context and allowed tool slots come only from the persisted attempt. */
export function createExplanatoryMethodRunner(options: ExplanatoryMethodRunnerOptions): AgentRunner {
  const contexts = new Map<string, { role: Role; context: NodeContext; materials?: AssetVersion;
    stage: 'trial' | 'case'; providerRequests: number;
    armDeadline: (global: string | null, node: string | null) => void }>();
  const key = (request: AgentRunRequest<unknown>) =>
    `${request.runId}\u0000${request.stepRunId}\u0000${request.attemptId}`;
  const locate = async (request: AgentRunRequest<unknown>) => {
    const role = roleById[request.definition.id];
    if (!role) throw new Error('Unregistered explanatory method role');
    const values = (await options.service.runtimeContexts(options.spaceId,request.runId)).filter(context =>
      context.producer === 'agent' && context.runId === request.runId &&
      context.stepRunId === request.stepRunId && context.attemptId === request.attemptId &&
      context.nodeId === role);
    if (values.length !== 1) throw new Error('One exact persisted explanatory node context is required');
    return { role, context: values[0]! };
  };
  const runner = new OpenAIAgentsSdkRunner({ auth: options.auth, fetch: options.fetch,
    maxTurns: 8, maxToolCalls: 16, timeoutMs: 15 * 60_000, enforceJsonObject: true,
    maxOutputValidationCorrections: 1,
    beforeRequest: async input => {
      const located = contexts.get(key(input.request));
      if (!located) throw new Error('Explanatory runner lost its exact budget context');
      if (located.stage === 'trial' && (located.providerRequests >= 2 ||
        (located.providerRequests === 0 && input.kind !== 'original') ||
        (located.providerRequests === 1 && input.kind !== 'tool-continuation' && input.kind !== 'technical-repair')))
        throw new Error('Trial allows one original and at most one tool continuation or technical repair');
      const receipt = await options.budget.reserve(input);
      if (receipt.reused) throw new Error('An existing budget reservation cannot authorize a second provider POST');
      located.armDeadline(receipt.deadlineAt, receipt.nodeDeadlineAt);
      located.providerRequests += 1;
    },
    tools: async request => {
      const located = contexts.get(key(request));
      if (!located) throw new Error('Explanatory runner lost its exact context');
      if (located.role === 'coldReader') return [];
      const client = await options.service.nodeClient(options.spaceId, located.context.id);
      return nodeReadTools(client, { boundSlots: Object.keys(located.context.inputs) }).map(tool => ({
        name: tool.name, description: tool.description, parameters: tool.parameters,
        execute: async (args: Parameters<typeof tool.execute>[0]) =>
          JSON.parse(JSON.stringify(await tool.execute(args))) as never,
      }));
    },
    validateOutput: (output, request) => {
      const located = contexts.get(key(request));
      if (!located) throw new Error('Explanatory runner lost its exact context');
      const schema = outputSchemas[located.role];
      const parsed = schema.safeParse(output);
      if (!parsed.success) throw new ExactOutputError(parsed.error.issues.map(issue => ({
        path: `/${issue.path.join('/')}`, value: atPath(output, issue.path), expected: issue.message,
      })));
      const stripped = strippedOutputFields(output, parsed.data);
      if (stripped.length) throw new ExactOutputError(stripped);
      if (located.role === 'researcher' && Array.isArray(record(output).notes) && (record(output).notes as unknown[]).length)
        throw new ExactOutputError([{ path: '/notes', value: record(output).notes, expected: 'offline notes must be []' }]);
      if (located.materials && (located.role === 'researcher' || located.role === 'author')) {
        const index = sourceHandleIndex(located.materials);
        const issues = sourceReferenceIssues(located.role, output, index);
        if (issues.length) throw new ExactOutputError(issues.map((issue: SourceReferenceIssue) => ({
          path: issue.path, value: issue.ref, expected: issue.code,
        })));
      }
      return parsed.data;
    },
    outputValidationFeedback: error => {
      if (error instanceof SyntaxError) return '上一次响应不是有效 JSON。只修复 JSON 格式；保留原有事实与引用，不补造答案。';
      if (!(error instanceof ExactOutputError)) return null;
      const issues = error.issues.slice(0, 32).map(issue => ({ path: issue.path,
        value: issue.value === undefined ? null : JSON.parse(JSON.stringify(issue.value)), expected: issue.expected }));
      return { message: '上一次响应未通过结构或准确来源标识校验。只修复列出的路径；不要猜测来源 ID 或编造内容。',
        validationError: { issues } };
    },
  });
  return { async run<Input, Output>(request: AgentRunRequest<Input>) {
    if (request.definition.config?.instructionsFormat !== 'precompiled-schema-v1' ||
      typeof request.definition.config?.prompt !== 'string' ||
      !request.definition.config.prompt.includes('【必须遵循的输出 JSON Schema】'))
      throw new Error('Explanatory method requires exact precompiled schema instructions');
    const { role, context } = await locate(request as AgentRunRequest<unknown>);
    if (context.instructions !== request.definition.config.prompt)
      throw new Error('Explanatory attempt instructions differ from the exact persisted context');
    const delivered = context.inputs.materials;
    const materials = delivered ? await options.service.readAsset(options.spaceId, delivered.assetVersionId) : undefined;
    if (materials && (materials.payloadHash !== delivered!.payloadHash ||
      materials.schema.namespace !== 'creation/content-materials'))
      throw new Error('Explanatory method frozen materials mismatch');
    if (role === 'coldReader' && materials) throw new Error('Cold reader received a materials binding');
    assertExactContext(role, request as AgentRunRequest<unknown>, context, materials);
    const sourceIndex = materials && ['researcher', 'author', 'factChecker'].includes(role)
      ? sourceHandleIndex(materials) : undefined;
    if (sourceIndex) assertUniqueSourceHandles(sourceIndex);
    const sourceMap = sourceIndex?.handles.map(({ ref, label, assetVersionId, payloadHash, pointer }) =>
      ({ id: ref, title: label, assetVersionId, payloadHash, pointer }));
    const actualInput = sourceMap ? { ...record(request.input), sourceMap } : request.input;
    const controller = new AbortController();
    const onAbort = () => controller.abort(request.signal.reason ?? new Error('Explanatory run canceled'));
    request.signal.addEventListener('abort', onAbort, { once: true });
    if (request.signal.aborted) onAbort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let earliest = Number.POSITIVE_INFINITY;
    const armDeadline = (global: string | null, node: string | null) => {
      for (const value of [global, node]) {
        if (value === null) continue;
        const deadline = Date.parse(value);
        if (!Number.isFinite(deadline)) throw new Error('Invalid persisted explanatory budget deadline');
        earliest = Math.min(earliest, deadline);
      }
      if (timer) clearTimeout(timer);
      if (earliest !== Number.POSITIVE_INFINITY) {
        const remaining = earliest - Date.now();
        if (remaining <= 0) controller.abort(new Error('Explanatory execution absolute deadline exceeded'));
        else timer = setTimeout(() => controller.abort(new Error('Explanatory execution absolute deadline exceeded')), remaining);
      }
    };
    let stage: 'trial' | 'case';
    try {
      const current = await options.budget.current(request as AgentRunRequest<unknown>);
      stage = current.stage;
      if (stage !== 'trial' && stage !== 'case') throw new Error('Explanatory budget stage is missing');
      if (stage === 'trial' && role !== 'researcher') throw new Error('Only researcher can run in trial mode');
      armDeadline(current.deadlineAt, current.nodeDeadlineAt);
      if (controller.signal.aborted) throw controller.signal.reason;
    } catch (error) {
      request.signal.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
      throw error;
    }
    const effective = { ...request, input: actualInput, signal: controller.signal, definition: { ...request.definition,
      config: { ...request.definition.config, instructions: request.definition.config.prompt, outputFormat: 'json' } } } as AgentRunRequest<Input>;
    const identity = key(effective as AgentRunRequest<unknown>);
    if (contexts.has(identity)) {
      if (timer) clearTimeout(timer);
      request.signal.removeEventListener('abort', onAbort);
      throw new Error('Explanatory method attempt is already running');
    }
    contexts.set(identity, { role, context, materials, stage, providerRequests: 0, armDeadline });
    try { return await runner.run<Input, Output>(effective); }
    finally { contexts.delete(identity); if (timer) clearTimeout(timer);
      request.signal.removeEventListener('abort', onAbort); }
  } };
}

/** The trial uses the exact same captured researcher declaration as the full workflow. */
export function createExplanatoryResearchAgent(deployment: ContentDeployment) {
  deployment.verify();
  return stageAgent<unknown, ContentResearch>(deployment.roles.researcher, deployment.roleModels.researcher, CONTENT_REVISION);
}
