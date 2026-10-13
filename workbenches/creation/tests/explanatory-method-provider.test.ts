import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { BusinessUnderstandingRevision, MethodCapabilityRevision, MethodDesignRevision } from '@signal-room/workflow-spaces';
import { CONTENT_ROLES } from '../src/stages/content.js';
import { assertExplanatoryProviderSourceSnapshot, buildExplanatoryMethodCandidate,
  captureExplanatoryMethod } from '../src/spaces/explanatory-method-provider.js';

const sha = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');
const content = (value: string) => ({ content: value, sha256: sha(value) });
const stages = { researcher: CONTENT_ROLES.researcher, author: CONTENT_ROLES.author,
  coldReader: CONTENT_ROLES.reader, factChecker: CONTENT_ROLES.checker, editor: CONTENT_ROLES.editor };

function fixture() {
  const understanding = { id: 'understanding-1', payloadHash: 'understanding-hash' } as BusinessUnderstandingRevision;
  const capability = {
    id: 'capability-1', assetId: 'method-capability:test.explanatory', revision: 1,
    payloadHash: 'capability-hash', previousRevisionId: null, recordedBy: 'agent-1',
    workflowId: 'test.explanatory', entrypoint: 'content',
    understanding: { revisionId: understanding.id, payloadHash: understanding.payloadHash },
    provider: { id: 'creation.explanatory-method', contractRevision: '1' },
    nodes: Object.fromEntries(Object.entries(stages).map(([key, stage]) => [key, {
      instructions: content(`Full professional ${key} instructions.`),
      outputSchema: content(JSON.stringify(stage.outputSchema)),
      model: 'gpt-6-luna', reasoningEffort: 'high',
    }])),
    validation: content(JSON.stringify({ revision: 3, budget: { maxNodeCalls: 15, maxProviderRequests: 15,
      clockStartsAt: 'first provider request reservation; 60-minute wall budget continues during diagnosis and waiting',
      maxCaseBusinessRounds: 2, maxTechnicalRepairsPerNode: 1,
      maxWallMinutes: 60, maxNodeMinutes: 15, webResearch: false },
      trial: { node: 'researcher', maxModelCalls: 2,
        secondCallOnly: 'one tool continuation OR one technical repair within the same 2-request hard cap; at most one technical repair; no request added when the cap is consumed',
        parity: 'Use the same frozen researcher instructions, output schema, first-round context projection, and read_bound_asset tool contract as a full Case; no special no-tool shortcut.' } })),
    predecessorVersionId: null, changeReason: 'Professional method revision',
    authorship: { kind: 'agent', name: 'designer', sessionId: 'session-1' },
  } as MethodCapabilityRevision;
  const design = { id: 'design-1', payloadHash: 'design-hash', workflowId: capability.workflowId,
    entrypoint: 'content', understanding: capability.understanding,
    capability: { revisionId: capability.id, payloadHash: capability.payloadHash } } as MethodDesignRevision;
  return { capability, design, understanding };
}

describe('explanatory method candidate', () => {
  it('captures all five exact role instructions and preserves the full workflow scope', () => {
    const { capability, design, understanding } = fixture();
    const { candidate, deployment } = captureExplanatoryMethod(capability, design, understanding);
    expect(deployment.candidate().version).toEqual(candidate.version);
    expect(candidate.workflowId).toBe(capability.workflowId);
    expect(candidate.version.entrypoints.content?.workflowId).toBe(capability.workflowId);
    expect(candidate.version.changeReason).toBe(capability.changeReason);
    expect(candidate.version.designBasis).toEqual({ designRevisionId: design.id, designPayloadHash: design.payloadHash,
      understandingRevisionId: understanding.id, understandingPayloadHash: understanding.payloadHash });
    expect(candidate.availability.state).toBe('unavailable');
    expect(candidate.version.entrypoints.content?.storageContract.nodes.coldReader?.inputs.manuscript?.projection)
      .toMatchObject({ version: 'text-viewer-view-v1', fields: [
        '/script/title', '/script/coverText', '/script/segments/*/voiceover', '/script/segments/*/onScreenText',
      ] });
    expect(candidate.version.entrypoints.content?.nodeDefinitions?.coldReader?.tools).toEqual([]);
    const nodes = candidate.version.entrypoints.content?.nodeDefinitions;
    const researcher = nodes?.researcher;
    const researcherSlots = Object.keys(candidate.version.entrypoints.content?.storageContract.nodes.researcher?.inputs ?? {}).sort();
    expect(researcher?.toolDefinitions).toMatchObject([{ name: 'read_bound_asset',
      description: `Read a bound input for this exact attempt. Available slots: ${researcherSlots.join(', ')}.`,
      parameters: { type: 'object', properties: { slot: { type: 'string', enum: researcherSlots,
        description: 'Exact input slot bound to this attempt.' } }, required: ['slot'], additionalProperties: false } }]);
    expect(researcher?.toolDefinitions?.[0]?.outputSchema).toMatchObject({ oneOf: [
      { required: ['assetVersionId', 'stateAtBinding', 'payloadHash', 'schema', 'viewVersion', 'deliveredHash', 'payload'] },
      { properties: { ok: { const: false }, error: { properties: { code: { const: 'UNBOUND_INPUT_SLOT' } } } } },
    ] });
    expect(researcher?.configuration?.toolContract).toMatchObject({
      response: { success: { kind: 'DeliveredInput', source: 'NodeClient.read' },
        denial: { ok: false, error: { code: 'UNBOUND_INPUT_SLOT' } },
        executionError: { kind: 'throws', source: 'NodeClient.read', normalized: false } },
      permissions: { allowedSlots: researcherSlots, deliveredView: 'binding-defined',
        readFullMethodExposed: false, write: false, webResearch: false },
    });
    expect(researcher?.configuration?.toolPolicy).toMatchObject({ executionModes: { trial: 'available for bound researcher' } });
    expect(nodes?.coldReader?.configuration?.executor).toMatchObject({ tools: [] });
    expect(nodes?.factChecker?.configuration?.contextPolicy).toContain('research');
    for (const key of Object.keys(capability.nodes)) {
      const declared = candidate.version.entrypoints.content?.nodeDefinitions?.[key];
      expect(declared?.instructions).toContain(capability.nodes[key]!.instructions.content);
      expect(declared?.instructions).toContain('【必须遵循的输出 JSON Schema】');
      expect(declared?.instructions?.split('【必须遵循的输出 JSON Schema】')).toHaveLength(2);
      expect(declared?.instructions).not.toContain('【角色说明】');
      expect(declared?.model).toBe(capability.nodes[key]!.model);
      expect((declared?.configuration?.stageDeclaration as Record<string, unknown>)?.instructionsFormat)
        .toBe('precompiled-schema-v1');
    }
    expect(candidate.version.config.policy).toMatchObject({ budget: { legacyMaxRevisions: 1 } });
    const process = candidate.version.entrypoints.content?.process;
    expect(process?.revision).toBe('explanatory-process-1');
    expect(process?.edges.filter(edge => edge.kind === 'rework').map(edge => edge.maxTraversals))
      .toEqual([1, 1, 1]);
    expect((nodes?.route?.configuration?.programRouting as Record<string, unknown>)?.maxTotalReworkTraversals).toBe(1);
    expect(nodes?.creatorDraftGate?.configuration?.handoff).toMatchObject({
      automaticContinuation: false, implementedCommands: [],
      runtimeBehavior: 'needs_review records a creator-facing handoff and stops this run',
    });
  });

  it('is deterministic for identical bytes and changes identity with instruction bytes', () => {
    const same = fixture();
    const first = buildExplanatoryMethodCandidate(same.capability, same.design, same.understanding);
    expect(buildExplanatoryMethodCandidate(same.capability, same.design, same.understanding)).toEqual(first);
    const changed = fixture();
    changed.capability.nodes.author!.instructions = content('Different professional author instructions.');
    const second = buildExplanatoryMethodCandidate(changed.capability, changed.design, changed.understanding);
    expect(second.candidateId).not.toBe(first.candidateId);
  });

  it('retains predecessor and rejects incompatible output contracts', () => {
    const { capability, design, understanding } = fixture();
    capability.predecessorVersionId = 'prior-version';
    const candidate = buildExplanatoryMethodCandidate(capability, design, understanding);
    expect(candidate.version.predecessorId).toBe('prior-version');
    capability.nodes.coldReader!.outputSchema = content(JSON.stringify({ type: 'object', properties: {} }));
    expect(() => buildExplanatoryMethodCandidate(capability, design, understanding))
      .toThrow('coldReader output schema is incompatible');
  });

  it('rejects the historical v2 trial because it hid the researcher read tool', () => {
    const { capability, design, understanding } = fixture();
    const prior = JSON.parse(capability.validation.content) as Record<string, unknown>;
    prior.revision = 2;
    capability.validation = content(JSON.stringify(prior));
    expect(() => buildExplanatoryMethodCandidate(capability, design, understanding))
      .toThrow('v3 provider-request parity is required');
  });

  it('publishes the same captured storage and process definition', async () => {
    const { capability, design, understanding } = fixture();
    const { candidate, deployment } = captureExplanatoryMethod(capability, design, understanding);
    const frozen = await deployment.frozenDefinition();
    expect(frozen.workflowId).toBe(capability.workflowId);
    expect(frozen.storageContract.workflowVersion).toBe(candidate.candidateId);
    expect(frozen.process?.hash).toBeTruthy();
    expect(frozen.process?.revision).toBe('explanatory-process-1');
    expect(frozen.process?.edges).toEqual(candidate.version.entrypoints.content?.process?.edges);
  });

  it('refuses mixed loaded and changed implementation source identities', () => {
    expect(() => assertExplanatoryProviderSourceSnapshot({ provider: 'loaded', runner: 'loaded' },
      { provider: 'loaded', runner: 'changed' }))
      .toThrow('restart with matching code');
    expect(() => assertExplanatoryProviderSourceSnapshot({ provider: 'loaded', runner: 'loaded' },
      { runner: 'loaded', provider: 'loaded' })).not.toThrow();
  });
});
