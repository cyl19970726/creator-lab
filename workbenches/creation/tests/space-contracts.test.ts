import { describe, expect, test } from 'vitest';
import { SchemaRegistry, publishStorageContract } from '@signal-room/workflow-space-contracts';
import { creationStorageContracts, registerCreationSchemas } from '../src/spaces/contracts.js';

const draft = {
  decision: {
    workingTitle: '训练过程', coreQuestion: '如何训练？', oneLineAnswer: '尝试后评分再调整', audience: '普通读者',
    audienceChange: '看懂训练', hook: '评分如何改变模型？', beats: [{ beat: '反馈', says: '尝试后评分', evidence: ['m1'], visualIdea: '反馈循环' }],
    accountAngle: '解释机制', form: '竖屏', notSaying: [], biggestRisk: '过度简化', openQuestions: [],
    alternativesConsidered: [], changesFromPrevious: '首版',
  },
  script: {
    title: '训练过程', coverText: '看懂训练', estimatedSeconds: 30,
    segments: [{ time: '00:00', voiceover: '模型尝试后由评分器反馈，再调整。', onScreenText: '尝试→评分→调整', visual: '反馈循环' }],
    sourcesUsed: ['m1'], changesFromPrevious: '首版',
  },
};

describe('creation space schemas and storage contracts', () => {
  test('registers separately hashed agent-output and stored-asset schemas', () => {
    const registry = new SchemaRegistry();
    const refs = registerCreationSchemas(registry);

    expect(refs.draftAgent.namespace).toBe('creation/content-draft-agent-output');
    expect(refs.draft.namespace).toBe('creation/content-draft');
    expect(refs.draft.hash).not.toBe(refs.draftAgent.hash);
    registry.validatePayload(refs.material, { id: 'm1', title: '官方材料', text: '一手说明' });
    registry.validatePayload(refs.materials, [{ id: 'm1', title: '官方材料', text: '一手说明' }]);
    registry.validatePayload(refs.draftAgent, draft);
    registry.validatePayload(refs.draft, { ...draft, markdown: '# 完整稿' });
    expect(() => registry.validatePayload(refs.draftAgent, { ...draft, markdown: '# 不属于 Agent 输出' })).toThrow();
    expect(() => registry.validatePayload(refs.draft, draft)).toThrow();
  });

  test('registers strict briefs, stored review metadata and complete frame-spec payloads', () => {
    const registry = new SchemaRegistry();
    const refs = registerCreationSchemas(registry);
    const brief = {
      schemaVersion: 'brief-v1', topicId: 'topic', version: 1,
      sources: [{ stage: 'content', runId: 'run-1', revision: 'content-v2', acceptedAt: '2026-10-04T00:00:00Z', reviewer: 'creator' }],
      creator: { opportunity: '理解训练', account: { name: '账号', positioning: '解释技术', currentAudience: '普通观众', referencePieces: [] }, form: '竖屏' },
      audienceQuestion: { readerGoal: '看懂训练', requiredQuestions: ['训练怎么进行？'], questionInAudienceWords: '怎么训练？' },
      decision: draft.decision, materials: [{ id: 'm1', title: '材料', text: '一手材料' }], notesForB2: [],
      script: draft.script, notesForB3: [],
    };
    registry.validatePayload(refs.brief, brief);
    expect(() => registry.validatePayload(refs.brief, { ...brief, decision: { coreQuestion: '宽泛对象不应被接受' } })).toThrow();
    registry.validatePayload(refs.reviewAgent, { verdict: 'pass', route: 'pass', criteria: [{ id: 'C1', result: 'ok', reason: '清楚' }], questionCoverage: [], mustChange: [], summary: '可制作' });
    registry.validatePayload(refs.review, { verdict: 'pass', route: 'pass', criteria: [{ id: 'C1', result: 'ok', reason: '清楚' }], questionCoverage: [], mustChange: [], summary: '可制作', guardFailures: [] });
    expect(() => registry.validatePayload(refs.review, { verdict: 'pass', route: 'pass', criteria: [], questionCoverage: [], mustChange: [], summary: '可制作', guardFailures: [], extra: true })).toThrow();
    registry.validatePayload(refs.frameDesignAgent, { files: ['frames-spec/01.py'], buildCheckPassed: true, notes: '完成' });
    registry.validatePayload(refs.frameSpecs, { report: { files: ['frames-spec/01.py'], buildCheckPassed: true, notes: '完成' }, build: { ok: true, output: 'GREEN' }, specs: [{ file: '01.py', content: 'SPEC = dict(...)' }] });
    expect(() => registry.validatePayload(refs.frameSpecs, { report: { files: [], buildCheckPassed: true, notes: '完成' }, build: { ok: true, output: 'GREEN' }, specs: [{ file: '01.py' }] })).toThrow();
    registry.validatePayload(refs.voiceManifest, { voice: 'placeholder', lines: [{ index: 1, seconds: 2.4 }] });
  });

  test('publishes distinct content and B3 contracts with a human acceptance transition and restricted cold read', () => {
    const registry = new SchemaRegistry();
    const refs = registerCreationSchemas(registry);
    const [contentDraft, b3Draft] = creationStorageContracts(refs, 'creation-test-v1');
    const content = publishStorageContract(registry, contentDraft);
    const b3 = publishStorageContract(registry, b3Draft);

    expect(content.workflowVersion).toBe('creation-test-v1');
    expect(b3.workflowVersion).toBe('creation-test-v1');
    expect(content.nodes.creatorDraftGate.actorKinds).toEqual(['human']);
    expect(content.nodes.creatorDraftGate.actions).toContain('accept');
    expect(content.nodes.briefBuilder.actorKinds).toEqual(['program']);
    expect(content.nodes.briefBuilder.outputs.brief.initialState).toBe('candidate');
    expect(content.nodes.creatorAcceptance.actorKinds).toEqual(['human']);
    expect(content.nodes.creatorAcceptance.actions).toContain('accept');
    expect(content.stateRules).toContainEqual({ schema: refs.draft, from: 'candidate', to: 'accepted', action: 'accept', actorKinds: ['human'], nodeId: 'creatorDraftGate' });
    expect(content.stateRules).toContainEqual({ schema: refs.brief, from: 'candidate', to: 'accepted', action: 'accept', actorKinds: ['human'], nodeId: 'creatorAcceptance' });
    expect(content.nodes.coldReader.inputs.manuscript.projection).toEqual({
      version: 'viewer-view-v1', fields: ['/script/title', '/script/coverText', '/script/segments'], schema: refs.viewerDraft,
    });
    expect(content.nodes.coldReader.inputs.audienceProfile.projection).toEqual({
      version: 'audience-profile-v1', fields: ['/account/currentAudience'], schema: refs.readerProfile,
    });
    expect(content.nodes.coldReader.actions).not.toContain('readBoundInput');
    expect(b3.nodes.designer.inputs.brief.states).toEqual(['accepted']);
    expect(b3.nodes.voice.actorKinds).toEqual(['program']);
    expect(b3.nodes.voice.outputs.voiceManifest.requiredInputs).toEqual(['brief']);
    expect(b3.nodes.designer.outputs.frameSpecs.agentOutputSchema).toEqual(refs.frameDesignAgent);
    expect(b3.nodes.designer.outputs.frameSpecs.requiredInputs).toEqual(['brief', 'voiceManifest']);
    expect(b3.nodes.assembler.outputs.assembly.requiredInputs).toEqual(['frameSpecs']);
    expect(b3.nodes.inspector.outputs.inspection.requiredInputs).toEqual(['brief', 'assembly']);
    expect(b3.schemas.map(item => item.namespace)).toContain(refs.brief.namespace);
  });
});
