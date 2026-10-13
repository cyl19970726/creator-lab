import { describe, expect, it } from 'vitest';
import { workflowFingerprint, type ArtifactDraft } from '@signal-room/workflow';
import type { SpaceRuntimeResolverApi } from '@signal-room/workflow-spaces';
import { resolveCreationPublication } from '../src/spaces/runtime.js';

function fixture(professional: boolean, publishedAnswer = 'model answer') {
  const raw = { questions: [{ question: 'Why?', answer: 'model answer', materialRefs: ['S1'], gap: '' }],
    notes: [], remainingGaps: [] };
  const published = { ...raw, questions: [{ ...raw.questions[0]!, answer: publishedAnswer }] };
  const artifact = { type: 'content-research', payload: published, dependsOn: [],
    producedBy: { workflowRunId: 'run', stepRunId: 'publish-step' } } as unknown as ArtifactDraft;
  const config = professional ? { config: { instructionsFormat: 'precompiled-schema-v1' } } : { config: {} };
  const context = { id: 'research-context', producer: 'agent', nodeId: 'researcher',
    stepRunId: 'agent-step', attemptId: 'attempt', actualInput: {}, effectiveConfig: config,
    inputs: { opportunity: { assetVersionId: 'opportunity' }, materials: { assetVersionId: 'materials' } } };
  const api = { binding: { entrypoint: 'content' },
    inputManifest: async () => ({ assets: { opportunity: 'opportunity', materials: 'materials' } }),
    artifacts: async () => [], contexts: async () => [context], frozenProcess: async () => undefined,
    steps: async () => [
      { id: 'publish-step', kind: 'program', phasePath: ['content-research-0'] },
      { id: 'agent-step', kind: 'agent', phasePath: ['content-research-0'], state: 'succeeded',
        validation: 'valid', inputFingerprint: workflowFingerprint({}), configFingerprint: workflowFingerprint(config),
        output: raw },
    ] } as unknown as SpaceRuntimeResolverApi;
  const attempts = async () => [{ id: 'attempt', state: 'succeeded' }] as never;
  return { artifact, api, attempts };
}

describe('explanatory research publication parity', () => {
  it('binds the direct model output to the exact successful agent context', async () => {
    const { artifact, api, attempts } = fixture(true);
    expect((await resolveCreationPublication(artifact, api, attempts)).generatedByContextId).toBe('research-context');
  });

  it('rejects a transformed research result for the explanatory method', async () => {
    const { artifact, api, attempts } = fixture(true, 'rewritten answer');
    await expect(resolveCreationPublication(artifact, api, attempts)).rejects.toThrow('Missing agent source context');
  });

  it('preserves legacy research merge publication behavior', async () => {
    const { artifact, api, attempts } = fixture(false, 'merged answer');
    expect((await resolveCreationPublication(artifact, api, attempts)).generatedByContextId).toBe('research-context');
  });
});
