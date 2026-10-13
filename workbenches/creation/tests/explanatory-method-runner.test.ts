import { describe, expect, it, vi } from 'vitest';
import { workflowFingerprint, type ArtifactDraft } from '@signal-room/workflow';
import type { AssetVersion, NodeContext, SpaceRuntimeResolverApi, WorkflowSpaceService } from '@signal-room/workflow-spaces';
import { CONTENT_ROLES } from '../src/stages/content.js';
import { stageAgent } from '../src/stages/runtime.js';
import { createExplanatoryMethodRunner } from '../src/spaces/explanatory-method-runner.js';
import { resolveCreationPublication } from '../src/spaces/runtime.js';

const future = new Date(Date.now() + 60_000).toISOString();
const budget = () => ({ current: vi.fn(async () => ({ deadlineAt: future, nodeDeadlineAt: future,
  stage: 'case' as 'trial' | 'case' })),
  reserve: vi.fn(async ({ request, turn, kind }: {request:{runId:string;stepRunId:string;attemptId:string};turn:number;kind:string}) =>
    ({ runId: request.runId, stepRunId: request.stepRunId, attemptId: request.attemptId,
      turn, kind: kind as 'original' | 'tool-continuation' | 'technical-repair', stage: 'case' as const,
      callOrdinal: turn, reservedAt: new Date().toISOString(),
      deadlineAt: future, nodeDeadlineAt: future, reused: false })) });
const delivered = (payload: unknown, id = 'asset-1', hash = 'payload-hash') =>
  ({ assetVersionId: id, payloadHash: hash, payload, stateAtBinding: 'candidate',
    schema: { namespace: 'creation/content-draft', revision: '1', hash: 'schema' },
    viewVersion: 'test', deliveredHash: 'delivered' });
const context = (nodeId: string, inputs: Record<string, unknown>) => ({ id: 'context-1', spaceId: 'space', runId: 'run',
  stepRunId: 'step', attemptId: 'attempt', nodeId, producer: 'agent', inputs,
  instructions: definition(nodeId === 'coldReader' ? CONTENT_ROLES.reader : CONTENT_ROLES.researcher).config?.prompt }) as NodeContext;
const response = (text: string, index = 1) => new Response(`data: ${JSON.stringify({ type: 'response.completed',
  response: { id: `response-${index}`, output: [{ type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text }] }] } })}\n\n`,
  { status: 200, headers: { 'content-type': 'text/event-stream' } });
const definition = (role: typeof CONTENT_ROLES.researcher | typeof CONTENT_ROLES.reader) =>
  stageAgent({ ...role, preamble: '', instructionsCompiled: true,
    prompt: `Professional instructions\n\n【必须遵循的输出 JSON Schema】\n${JSON.stringify(role.outputSchema)}\n只返回一个符合该 schema 的 JSON 对象。` },
  { model: 'test-model', reasoningEffort: 'low' }, 'test-v1');
const request = (role: typeof CONTENT_ROLES.researcher | typeof CONTENT_ROLES.reader,
  input: unknown, events: Array<{type:string;data:unknown}>) => ({ runId: 'run', stepRunId: 'step', attemptId: 'attempt',
    definition: definition(role), input, signal: new AbortController().signal,
    emit: async (type: string, data: unknown) => { events.push({ type, data }); } });

describe('guarded explanatory method runner', () => {
  it('passes only text and no tools to the cold reader', async () => {
    const manuscript = { script: { title: 'Title', coverText: 'Cover',
      segments: [{ voiceover: 'spoken', onScreenText: 'shown' }] } };
    const ctx = context('coldReader', { manuscript: delivered(manuscript),
      audienceProfile: delivered({ account: { currentAudience: 'curious reader' } }) });
    const service = { runtimeContexts: async () => [ctx], nodeClient: vi.fn() } as unknown as WorkflowSpaceService;
    const bodies: Record<string, unknown>[] = [];
    const output = { retell: 'I learned it', oneLineAnswerAsUnderstood: 'Answer', unansweredQuestions: [],
      lostAt: [], boredAt: [], keepWatchingAt3s: { yes: true, why: 'clear' },
      keepWatchingAt30s: { yes: true, why: 'clear' }, mostMemorable: 'Answer' };
    const runner = createExplanatoryMethodRunner({ service, spaceId: 'space', auth: { accessToken: async () => 'secret' },
      budget: budget(), fetch: (async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return response(JSON.stringify(output));
      }) as typeof fetch });
    const events: Array<{type:string;data:unknown}> = [];
    const input = { audienceProfile: 'curious reader', title: 'Title', coverText: 'Cover',
      segments: [{ number: 1, voiceover: 'spoken', onScreenText: 'shown' }] };
    expect((await runner.run(request(CONTENT_ROLES.reader, input, events))).output).toEqual(output);
    expect(bodies[0]?.instructions).toBe(request(CONTENT_ROLES.reader, input, []).definition.config?.prompt);
    expect(JSON.stringify(bodies[0]?.input)).not.toContain('visual');
    expect(JSON.stringify(bodies[0]?.input)).not.toContain('sourceMap');
    expect(JSON.stringify(bodies[0]?.input)).not.toContain('additional_tools');
    expect(service.nodeClient).not.toHaveBeenCalled();
  });

  it('preserves invalid JSON and uses one reserved technical repair', async () => {
    const materials = [{ id: 'S1', title: 'Source', text: 'facts' }];
    const opportunity = { opportunity: 'Question', readerGoal: 'Understand', requiredQuestions: ['Why?'],
      account: { currentAudience: 'reader', referencePieces: [{ title: 'Before', result: 'Observed', lesson: 'Explain' }] },
      form: 'article', standards: 'clear' };
    const ctx = context('researcher', { materials: delivered(materials, 'materials-v1', 'hash-m1'),
      opportunity: delivered(opportunity) });
    const service = { runtimeContexts: async () => [ctx],
      readAsset: async () => ({ id: 'materials-v1', payloadHash: 'hash-m1', payload: materials,
        schema: { namespace: 'creation/content-materials', revision: '1', hash: 'schema' } } as AssetVersion),
      nodeClient: async () => ({ read: async () => ({}) }) } as unknown as WorkflowSpaceService;
    const messages = ['{invalid', JSON.stringify({ questions: [{ question: 'Why?', answer: 'Because', materialRefs: ['S1'], gap: '' }],
      notes: [], remainingGaps: [] })];
    const bodies: Record<string, unknown>[] = [];
    const gate = budget();
    gate.current.mockResolvedValue({ deadlineAt: future, nodeDeadlineAt: future, stage: 'trial' });
    const runner = createExplanatoryMethodRunner({ service, spaceId: 'space', auth: { accessToken: async () => 'secret' },
      budget: gate, fetch: (async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return response(messages[bodies.length - 1]!, bodies.length);
      }) as typeof fetch });
    const events: Array<{type:string;data:unknown}> = [];
    const input = { ...opportunity, account: { referencePieces: [{ lesson: 'Explain', result: 'Observed', title: 'Before' }],
      currentAudience: 'reader' }, webResearch: false, materials };
    const result = await runner.run(request(CONTENT_ROLES.researcher, input, events));
    expect(result.output).toMatchObject({ notes: [] });
    expect(bodies).toHaveLength(2);
    expect(gate.reserve.mock.calls.map(([value]) => value.kind)).toEqual(['original', 'technical-repair']);
    expect(events.filter(event => event.type === 'siwc.response')).toHaveLength(2);
    expect(JSON.stringify(bodies[0]?.input)).toContain('sourceMap');
  });

  it('gives the trial researcher the same frozen input and read tool as a Case', async () => {
    const materials = [{ id: 'S1', title: 'Source', text: 'full frozen text' }];
    const opportunity = { opportunity: 'Question', readerGoal: 'Understand', requiredQuestions: ['Why?'],
      account: { currentAudience: 'reader' }, form: 'article', standards: 'clear' };
    const ctx = context('researcher', { materials: delivered(materials, 'materials-v1', 'hash-m1'),
      opportunity: delivered(opportunity) });
    const service = { runtimeContexts: async () => [ctx],
      readAsset: async () => ({ id: 'materials-v1', payloadHash: 'hash-m1', payload: materials,
        schema: { namespace: 'creation/content-materials', revision: '1', hash: 'schema' } } as AssetVersion),
      nodeClient: vi.fn(async () => ({ read: async () => delivered(materials, 'materials-v1', 'hash-m1') })) } as unknown as WorkflowSpaceService;
    const gate = budget();
    gate.current.mockResolvedValue({ deadlineAt: future, nodeDeadlineAt: future, stage: 'trial' });
    const bodies: Record<string, unknown>[] = [];
    const output = { questions: [{ question: 'Why?', answer: 'Because', materialRefs: ['S1'], gap: '' }],
      notes: [], remainingGaps: [] };
    const runner = createExplanatoryMethodRunner({ service, spaceId: 'space', auth: { accessToken: async () => 'secret' },
      budget: gate, fetch: (async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return response(JSON.stringify(output));
      }) as typeof fetch });
    expect((await runner.run(request(CONTENT_ROLES.researcher,
      { ...opportunity, webResearch: false, materials }, []))).output).toEqual(output);
    expect(JSON.stringify(bodies[0]?.input)).toContain('full frozen text');
    expect(JSON.stringify(bodies[0]?.input)).toContain('sourceMap');
    expect(JSON.stringify(bodies[0])).toContain('read_bound_asset');
    expect(JSON.stringify(bodies[0])).toContain('materials');
    expect(service.nodeClient).toHaveBeenCalledTimes(1);
  });

  it('stops a trial before a third provider POST after two tool continuations', async () => {
    const materials = [{ id: 'S1', title: 'Source', text: 'facts' }];
    const opportunity = { opportunity: 'Question', readerGoal: 'Understand', requiredQuestions: ['Why?'],
      account: { currentAudience: 'reader' }, form: 'article', standards: 'clear' };
    const ctx = context('researcher', { materials: delivered(materials, 'materials-v1', 'hash-m1'),
      opportunity: delivered(opportunity) });
    const service = { runtimeContexts: async () => [ctx],
      readAsset: async () => ({ id: 'materials-v1', payloadHash: 'hash-m1', payload: materials,
        schema: { namespace: 'creation/content-materials', revision: '1', hash: 'schema' } } as AssetVersion),
      nodeClient: async () => ({ read: async () => delivered(materials, 'materials-v1', 'hash-m1') }) } as unknown as WorkflowSpaceService;
    const gate = budget();
    gate.current.mockResolvedValue({ deadlineAt: future, nodeDeadlineAt: future, stage: 'trial' });
    const fetcher = vi.fn(async () => new Response(`data: ${JSON.stringify({ type: 'response.completed',
      response: { id: 'tool-response', output: [{ type: 'function_call', name: 'read_bound_asset',
        call_id: 'call-1', arguments: '{"slot":"materials"}' }] } })}\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const runner = createExplanatoryMethodRunner({ service, spaceId: 'space', auth: { accessToken: async () => 'secret' },
      budget: gate, fetch: fetcher as typeof fetch });
    await expect(runner.run(request(CONTENT_ROLES.researcher,
      { ...opportunity, webResearch: false, materials }, [])))
      .rejects.toThrow('at most one tool continuation or technical repair');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(gate.reserve.mock.calls.map(([value]) => value.kind)).toEqual(['original', 'tool-continuation']);
  });

  it('rejects an unknown S99 citation after one correction and records its exact path', async () => {
    const materials = [{ id: 'S1', title: 'Source', text: 'facts' }];
    const opportunity = { opportunity: 'Question', readerGoal: 'Understand', requiredQuestions: ['Why?'],
      account: { currentAudience: 'reader' }, form: 'article', standards: 'clear' };
    const ctx = context('researcher', { materials: delivered(materials, 'materials-v1', 'hash-m1'),
      opportunity: delivered(opportunity) });
    const service = { runtimeContexts: async () => [ctx],
      readAsset: async () => ({ id: 'materials-v1', payloadHash: 'hash-m1', payload: materials,
        schema: { namespace: 'creation/content-materials', revision: '1', hash: 'schema' } } as AssetVersion),
      nodeClient: async () => ({ read: async () => ({}) }) } as unknown as WorkflowSpaceService;
    const bad = JSON.stringify({ questions: [{ question: 'Why?', answer: 'Because', materialRefs: ['S99'], gap: '' }],
      notes: [], remainingGaps: [] });
    const events: Array<{type:string;data:unknown}> = [];
    const gate = budget();
    const fetcher = vi.fn(async () => response(bad));
    const runner = createExplanatoryMethodRunner({ service, spaceId: 'space', auth: { accessToken: async () => 'secret' },
      budget: gate, fetch: fetcher as typeof fetch });
    await expect(runner.run(request(CONTENT_ROLES.researcher,
      { ...opportunity, webResearch: false, materials }, events))).rejects.toThrow('/questions/0/materialRefs/0');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(events.filter(event => event.type === 'siwc.response')).toHaveLength(2);
    expect(events.find(event => event.type === 'siwc.validation_error')?.data).toMatchObject({
      issues: [{ path: '/questions/0/materialRefs/0', value: 'S99', expected: 'SOURCE_ID_MISSING' }] });
  });

  it('repairs an S99 citation in exactly two POSTs and publishes only the repaired direct output', async () => {
    const materials = [{ id: 'S1', title: 'Source', text: 'facts' }];
    const opportunity = { opportunity: 'Question', readerGoal: 'Understand', requiredQuestions: ['Why?'],
      account: { currentAudience: 'reader' }, form: 'article', standards: 'clear' };
    const ctx = context('researcher', { materials: delivered(materials, 'materials-v1', 'hash-m1'),
      opportunity: delivered(opportunity, 'opportunity-v1') });
    const readAsset = vi.fn(async () => ({ id: 'materials-v1', payloadHash: 'hash-m1', payload: materials,
      schema: { namespace: 'creation/content-materials', revision: '1', hash: 'schema' } } as AssetVersion));
    const service = { runtimeContexts: async () => [ctx], readAsset,
      nodeClient: async () => ({ read: async () => ({}) }) } as unknown as WorkflowSpaceService;
    const valid = { questions: [{ question: 'Why?', answer: 'Because', materialRefs: ['S1'], gap: '' }],
      notes: [], remainingGaps: [] };
    const bad = { ...valid, questions: [{ ...valid.questions[0], materialRefs: ['S99'] }] };
    const events: Array<{type:string;data:unknown}> = [];
    const gate = budget();
    const fetcher = vi.fn(async () => response(JSON.stringify(fetcher.mock.calls.length === 1 ? bad : valid),
      fetcher.mock.calls.length));
    const runner = createExplanatoryMethodRunner({ service, spaceId: 'space', auth: { accessToken: async () => 'secret' },
      budget: gate, fetch: fetcher as typeof fetch });
    const input = { ...opportunity, webResearch: false, materials };
    const agent = request(CONTENT_ROLES.researcher, input, events);
    const result = await runner.run(agent);
    expect(result.output).toEqual(valid);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(gate.reserve.mock.calls.map(([value]) => value.kind)).toEqual(['original', 'technical-repair']);
    const originals = events.filter(event => event.type === 'siwc.response');
    expect(originals).toHaveLength(2);
    expect(JSON.stringify(originals[0]?.data)).toContain('S99');
    expect(JSON.stringify(originals[1]?.data)).toContain('S1');
    expect(events.find(event => event.type === 'siwc.validation_error')?.data).toMatchObject({
      issues: [{ path: '/questions/0/materialRefs/0', value: 'S99', expected: 'SOURCE_ID_MISSING' }] });
    const config = { config: { instructionsFormat: 'precompiled-schema-v1' } };
    const source = { ...ctx, id: 'research-context', actualInput: input, effectiveConfig: config };
    const publication = { type: 'content-research', payload: result.output, dependsOn: [],
      producedBy: { workflowRunId: 'run', stepRunId: 'publish-step' } } as unknown as ArtifactDraft;
    const api = { binding: { entrypoint: 'content' },
      inputManifest: async () => ({ assets: { opportunity: 'opportunity-v1', materials: 'materials-v1' } }),
      artifacts: async () => [], contexts: async () => [source], frozenProcess: async () => undefined,
      steps: async () => [
        { id: 'publish-step', kind: 'program', phasePath: ['content-research-0'] },
        { id: 'step', kind: 'agent', phasePath: ['content-research-0'], state: 'succeeded',
          validation: 'valid', inputFingerprint: workflowFingerprint(input),
          configFingerprint: workflowFingerprint(config), output: result.output },
      ] } as unknown as SpaceRuntimeResolverApi;
    const published = await resolveCreationPublication(publication, api,
      async () => [{ id: 'attempt', state: 'succeeded' }] as never);
    expect(published.generatedByContextId).toBe('research-context');
    expect(JSON.stringify(publication.payload)).not.toContain('S99');
  });

  it('stops on a denied bound read without another POST or any other Space/source read', async () => {
    const materials = [{ id: 'S1', title: 'Source', text: 'facts' }];
    const opportunity = { opportunity: 'Question', readerGoal: 'Understand', requiredQuestions: ['Why?'],
      account: { currentAudience: 'reader' }, form: 'article', standards: 'clear' };
    const ctx = context('researcher', { materials: delivered(materials, 'materials-v1', 'hash-m1'),
      opportunity: delivered(opportunity) });
    const readAsset = vi.fn(async () => ({ id: 'materials-v1', payloadHash: 'hash-m1', payload: materials,
      schema: { namespace: 'creation/content-materials', revision: '1', hash: 'schema' } } as AssetVersion));
    const deniedRead = vi.fn(async () => { throw new Error('Unbound input denied'); });
    const nodeClient = vi.fn(async () => ({ read: deniedRead }));
    const service = { runtimeContexts: async () => [ctx], readAsset, nodeClient } as unknown as WorkflowSpaceService;
    const events: Array<{type:string;data:unknown}> = [];
    const gate = budget();
    const fetcher = vi.fn(async () => new Response(`data: ${JSON.stringify({ type: 'response.completed',
      response: { id: 'tool-denied', output: [{ type: 'function_call', name: 'read_bound_asset',
        call_id: 'read-1', arguments: '{"slot":"materials"}' }] } })}\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const runner = createExplanatoryMethodRunner({ service, spaceId: 'space', auth: { accessToken: async () => 'secret' },
      budget: gate, fetch: fetcher as typeof fetch });
    await expect(runner.run(request(CONTENT_ROLES.researcher,
      { ...opportunity, webResearch: false, materials }, events))).rejects.toThrow('Unbound input denied');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(gate.reserve).toHaveBeenCalledTimes(1);
    expect(nodeClient).toHaveBeenCalledExactlyOnceWith('space', 'context-1');
    expect(deniedRead).toHaveBeenCalledExactlyOnceWith('materials');
    expect(readAsset).toHaveBeenCalledExactlyOnceWith('space', 'materials-v1');
    expect(events.some(event => event.type === 'siwc.tool_failed')).toBe(true);
    expect(events.filter(event => event.type === 'siwc.response')).toHaveLength(1);
  });

  it('rejects an extra nested field instead of silently stripping it', async () => {
    const materials = [{ id: 'S1', title: 'Source', text: 'facts' }];
    const opportunity = { opportunity: 'Question', readerGoal: 'Understand', requiredQuestions: ['Why?'],
      account: { currentAudience: 'reader' }, form: 'article', standards: 'clear' };
    const ctx = context('researcher', { materials: delivered(materials, 'materials-v1', 'hash-m1'),
      opportunity: delivered(opportunity) });
    const service = { runtimeContexts: async () => [ctx],
      readAsset: async () => ({ id: 'materials-v1', payloadHash: 'hash-m1', payload: materials,
        schema: { namespace: 'creation/content-materials', revision: '1', hash: 'schema' } } as AssetVersion),
      nodeClient: async () => ({ read: async () => ({}) }) } as unknown as WorkflowSpaceService;
    const good = { questions: [{ question: 'Why?', answer: 'Because', materialRefs: ['S1'], gap: '' }],
      notes: [], remainingGaps: [] };
    const bad = { ...good, questions: [{ ...good.questions[0], invented: 'quietly removed' }] };
    const events: Array<{type:string;data:unknown}> = [];
    const gate = budget();
    const fetcher = vi.fn(async () => response(JSON.stringify(fetcher.mock.calls.length === 1 ? bad : good),
      fetcher.mock.calls.length));
    const runner = createExplanatoryMethodRunner({ service, spaceId: 'space', auth: { accessToken: async () => 'secret' },
      budget: gate, fetch: fetcher as typeof fetch });
    const result = await runner.run(request(CONTENT_ROLES.researcher,
      { ...opportunity, webResearch: false, materials }, events));
    expect(result.output).toEqual(good);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(gate.reserve.mock.calls.map(([value]) => value.kind)).toEqual(['original', 'technical-repair']);
    expect(events.find(event => event.type === 'siwc.validation_error')?.data).toMatchObject({
      issues: [{ path: '/questions/0/invented', value: 'quietly removed',
        expected: 'additional property is not allowed by output schema' }] });
  });

  it('stops before auth when the persisted absolute deadline expired', async () => {
    const manuscript = { script: { title: 'Title', coverText: 'Cover', segments: [] } };
    const ctx = context('coldReader', { manuscript: delivered(manuscript),
      audienceProfile: delivered({ account: { currentAudience: 'reader' } }) });
    const auth = vi.fn(async () => 'secret');
    const fetcher = vi.fn(async () => response('{}'));
    const gate = budget();
    gate.current.mockResolvedValue({ deadlineAt: new Date(Date.now() - 1000).toISOString(), nodeDeadlineAt: future, stage: 'case' });
    const runner = createExplanatoryMethodRunner({ service: { runtimeContexts: async () => [ctx] } as unknown as WorkflowSpaceService,
      spaceId: 'space', auth: { accessToken: auth }, budget: gate, fetch: fetcher as typeof fetch });
    await expect(runner.run(request(CONTENT_ROLES.reader,
      { audienceProfile: 'reader', title: 'Title', coverText: 'Cover', segments: [] }, [])))
      .rejects.toThrow('absolute deadline exceeded');
    expect(auth).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects instructions that differ from the persisted node context before auth', async () => {
    const manuscript = { script: { title: 'Title', coverText: 'Cover', segments: [] } };
    const ctx = { ...context('coldReader', { manuscript: delivered(manuscript),
      audienceProfile: delivered({ account: { currentAudience: 'reader' } }) }),
      instructions: 'Different instructions' };
    const auth = vi.fn(async () => 'secret');
    const runner = createExplanatoryMethodRunner({ service: { runtimeContexts: async () => [ctx] } as unknown as WorkflowSpaceService,
      spaceId: 'space', auth: { accessToken: auth }, budget: budget(), fetch: vi.fn() as typeof fetch });
    await expect(runner.run(request(CONTENT_ROLES.reader,
      { audienceProfile: 'reader', title: 'Title', coverText: 'Cover', segments: [] }, [])))
      .rejects.toThrow('instructions differ from the exact persisted context');
    expect(auth).not.toHaveBeenCalled();
  });

  it('does not POST again for a reused reservation', async () => {
    const manuscript = { script: { title: 'Title', coverText: 'Cover', segments: [] } };
    const ctx = context('coldReader', { manuscript: delivered(manuscript),
      audienceProfile: delivered({ account: { currentAudience: 'reader' } }) });
    const gate = budget();
    gate.reserve.mockResolvedValue({ runId: 'run', stepRunId: 'step', attemptId: 'attempt', turn: 1,
      kind: 'original', stage: 'case', callOrdinal: 1, reservedAt: new Date().toISOString(),
      deadlineAt: future, nodeDeadlineAt: future, reused: true });
    const fetcher = vi.fn(async () => response('{}'));
    const runner = createExplanatoryMethodRunner({ service: { runtimeContexts: async () => [ctx] } as unknown as WorkflowSpaceService,
      spaceId: 'space', auth: { accessToken: async () => 'secret' }, budget: gate, fetch: fetcher as typeof fetch });
    await expect(runner.run(request(CONTENT_ROLES.reader,
      { audienceProfile: 'reader', title: 'Title', coverText: 'Cover', segments: [] }, [])))
      .rejects.toThrow('second provider POST');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
