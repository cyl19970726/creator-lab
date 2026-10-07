import { createHash } from 'node:crypto';
import { type AgentRunRequest, type AgentRunner } from '@signal-room/workflow';
import { SiwcResponsesRunner, type SiwcAuth } from '@signal-room/workflow-agent-sdk';
import { nodeReadTools, type WorkflowSpaceService } from '@signal-room/workflow-spaces';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export interface ContentSiwcOptions {
  service: WorkflowSpaceService;
  spaceId: string;
  auth: Pick<SiwcAuth, 'accessToken'>;
  maxTurns?: number;
  maxToolCalls?: number;
  fetch?: typeof fetch;
}

export function contentSiwcExecutorManifest(options: Pick<ContentSiwcOptions, 'maxTurns'|'maxToolCalls'> = {}) {
  return { adapter: 'SIWC Responses', tools: ['read_bound_asset'],
    maxTurns: options.maxTurns ?? 8, maxToolCalls: options.maxToolCalls ?? 16,
    instructionMapping: 'stage prompt followed by output JSON Schema and JSON-only instruction',
    outputFormat: 'json', webResearchSupported: false };
}

/** Adapt existing CONTENT roles to SIWC without changing their creative instructions. */
export function createContentSiwcRunner(options: ContentSiwcOptions): AgentRunner {
  const manifest = contentSiwcExecutorManifest(options);
  const { maxTurns, maxToolCalls } = manifest;
  const runner = new SiwcResponsesRunner({
    auth: options.auth,
    maxTurns,
    maxToolCalls,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    tools: async request => {
      const contexts = await options.service.runtimeContexts(options.spaceId, request.runId);
      const matching = contexts.filter(context => context.producer === 'agent' &&
        context.stepRunId === request.stepRunId && context.attemptId === request.attemptId);
      if (matching.length !== 1) throw new Error('Exact persisted CONTENT node context is required for bound asset reads');
      const context = matching[0]!;
      const client = await options.service.nodeClient(options.spaceId, context.id);
      return nodeReadTools(client, { boundSlots: Object.keys(context.inputs) }).map(tool => ({
        name: tool.name, description: tool.description, parameters: tool.parameters,
        execute: async (args: Parameters<typeof tool.execute>[0]) =>
          JSON.parse(JSON.stringify(await tool.execute(args))) as never,
      }));
    },
  });
  return {
    async run<Input, Output>(request: AgentRunRequest<Input>) {
      if (!request.definition.id.startsWith('content-')) throw new Error('CONTENT SIWC runner cannot execute another workflow');
      if (request.definition.id === 'content-researcher' &&
        (request.input as { webResearch?: unknown })?.webResearch === true) {
        throw new Error('联网研究尚未接入此工作台；请先提供材料后运行 CONTENT。');
      }
      const prompt = request.definition.config?.prompt;
      const schema = request.definition.config?.outputSchema;
      if (typeof prompt !== 'string' || !prompt.trim() || !schema) throw new Error('CONTENT role has no prompt or JSON schema');
      const instructions = `${prompt}\n\n【必须遵循的输出 JSON Schema】\n${JSON.stringify(schema)}\n只返回一个符合该 schema 的 JSON 对象。`;
      const config = { ...request.definition.config, instructions, outputFormat: 'json' };
      await request.emit('content.siwc.mapping', {
        role: request.definition.id, instructions, instructionsSha256: digest(instructions),
        outputSchema: schema, outputSchemaSha256: digest(schema),
        outputFormat: manifest.outputFormat, maxTurns, maxToolCalls, tools: manifest.tools,
      });
      return runner.run<Input, Output>({ ...request, definition: { ...request.definition, config } });
    },
  };
}
