import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { runWorkflow, type AgentRunner } from '@signal-room/workflow';
import { SchemaRegistry } from '@signal-room/workflow-space-contracts';
import { PostgresBlobStore, WorkflowSpaceService, migrateWorkflowSpaces, type AssetVersion } from '@signal-room/workflow-spaces';
import { creationSchemaDefinitions, creationStorageContracts, registerCreationSchemas } from '../src/spaces/contracts.js';
import { createB3FrameSpecFixtureWorkflow, createContentBriefHandoffWorkflow, createCreationSpaceRuntime } from '../src/spaces/runtime.js';
import { createContentWorkflow, CONTENT_REVISION, type ContentDraft, type ContentInput, type ContentResearch, type ContentReview } from '../src/stages/content.js';
import type { PieceBrief } from '../src/stages/brief.js';

const url = process.env.WORKFLOW_DATABASE_URL;
if (!url) throw new Error('Set WORKFLOW_DATABASE_URL to a dedicated PostgreSQL database before running this persistent demo.');

const principal = { id: process.env.WORKFLOW_SPACE_PRINCIPAL || 'local-owner', kind: 'human' as const };
const models = { worker: { model: 'deterministic-fixture', reasoningEffort: 'medium' as const },
  judge: { model: 'deterministic-fixture', reasoningEffort: 'high' as const } };
const input: ContentInput = {
  topicId: 'synthetic-training-board', opportunity: 'Explain a synthetic training progress board',
  readerGoal: 'Understand a three-step process without mistaking a score for a guarantee',
  requiredQuestions: ['What changes after a score?'],
  account: { name: 'Synthetic demo account', positioning: 'Explain technical processes',
    currentAudience: 'Curious general readers', referencePieces: [] },
  form: 'Vertical explainer', materials: [{ id: 'synthetic-source-1', title: 'Synthetic process note',
    text: 'A hypothetical system tries, receives a score, and changes its next attempt. This is fixture text, not an external factual claim.' }],
  standards: 'Synthetic C1-C8 fixture', webResearch: false, maxRevisions: 0,
};
const draft = (version: 1 | 2): ContentDraft => ({
  decision: { workingTitle: version === 1 ? 'The training board' : 'What changes after a score?',
    coreQuestion: input.requiredQuestions[0]!, oneLineAnswer: 'The score informs the next attempt.',
    audience: input.account.currentAudience, audienceChange: 'Can describe the order of the three steps',
    hook: version === 1 ? 'Why did the number move?' : 'A score changes the next try, not the past one.',
    beats: [{ beat: 'Try, score, adjust', says: 'A score informs the next attempt',
      evidence: ['synthetic-source-1'], visualIdea: 'Three labeled boxes' }],
    accountAngle: input.account.positioning, form: input.form, notSaying: ['A score proves quality'],
    biggestRisk: 'Overclaiming from a synthetic score', openQuestions: [], alternativesConsidered: [],
    changesFromPrevious: version === 1 ? 'First synthetic draft' : 'Made the score-to-next-attempt link explicit',
  },
  script: { title: version === 1 ? 'The training board' : 'What changes after a score?', coverText: 'Try → Score → Adjust',
    estimatedSeconds: 30, sourcesUsed: ['synthetic-source-1'],
    changesFromPrevious: version === 1 ? 'First synthetic draft' : 'Clarified the next attempt',
    segments: [{ time: '00:00', voiceover: version === 1
      ? 'The system tries, gets a score, then adjusts.'
      : 'The system tries, receives a score, then changes its next attempt. The score is feedback, not proof of quality.',
      onScreenText: 'Try → Score → Adjust', visual: 'Three boxes with a moving highlight' }],
  },
});
const research: ContentResearch = { questions: [{ question: input.requiredQuestions[0]!,
  answer: 'The next attempt changes after feedback.', materialRefs: ['synthetic-source-1'], gap: '' }],
  notes: [], remainingGaps: [] };
const editorialReview: ContentReview = { verdict: 'pass', route: 'pass',
  criteria: Array.from({ length: 8 }, (_, index) => ({ id: `C${index + 1}`, result: 'ok', reason: 'Synthetic fixture only' })),
  questionCoverage: [{ question: input.requiredQuestions[0]!, answerInDraft: 'The next attempt changes after a score.',
    missing: '', result: 'ok' }], mustChange: [], summary: 'Synthetic editorial fixture; no creative judgment.',
};

let round: 1 | 2 = 1;
const fakeRunner: AgentRunner = { async run(request) {
  const byRole: Record<string, unknown> = {
    'content-researcher': research,
    'content-author': draft(round),
    'content-cold-reader': { retell: 'A try receives a score and informs the next try.',
      oneLineAnswerAsUnderstood: 'The next attempt changes.', unansweredQuestions: [], lostAt: [], boredAt: [],
      keepWatchingAt3s: { yes: true, why: 'The sequence is visible' },
      keepWatchingAt30s: { yes: true, why: 'The example is short' }, mostMemorable: 'Try → Score → Adjust' },
    'content-fact-checker': { issues: [], summary: 'Synthetic statements match the frozen synthetic note.' },
    'content-editor': editorialReview,
  };
  const output = byRole[request.definition.id];
  if (!output) throw new Error(`Unexpected deterministic role: ${request.definition.id}`);
  await request.emit('fixture.output', { role: request.definition.id, round, synthetic: true });
  return { output: output as never, validation: 'pending' };
} };

function exact(assets: Array<AssetVersion & { state: string }>, runId: string, namespace: string): AssetVersion & { state: string } {
  const found = assets.filter(asset => asset.source.kind === 'node' && asset.source.runId === runId && asset.schema.namespace === namespace);
  if (found.length !== 1) throw new Error(`Expected one ${namespace} from run ${runId}; found ${found.length}`);
  return found[0]!;
}
function agentPayload<T>(asset: AssetVersion): T {
  const { markdown: _markdown, ...payload } = asset.payload as Record<string, unknown>;
  return payload as T;
}

const pool = new Pool({ connectionString: url });
try {
  await migrateWorkflowSpaces(pool);
  const blobs = new PostgresBlobStore(pool); await blobs.migrate();
  const service = new WorkflowSpaceService(pool, blobs, principal);
  const space = await service.createSpace({ purpose: 'Synthetic creation lifecycle demonstration' });
  const registry = new SchemaRegistry();
  const refs = registerCreationSchemas(registry);
  await service.registerSchemas(space.id, creationSchemaDefinitions());
  const entrypoints = (versionId: string) => {
    const [content, b3] = creationStorageContracts(refs, versionId);
    if (!content || !b3) throw new Error('Creation contracts missing');
    return {
      content: { workflowId: 'creation.content', codeRevision: CONTENT_REVISION, storageContract: content },
      'content-handoff': { workflowId: 'creation.content-handoff', codeRevision: 'content-handoff-v1', storageContract: content },
      'b3-fixture': { workflowId: 'creation.b3-fixture', codeRevision: 'b3-fixture-v1', storageContract: b3 },
    };
  };
  const v1Id = `creation-demo-v1-${randomUUID()}`;
  const v1 = await service.publishWorkflow(space.id, { id: v1Id, revision: '1',
    changeReason: 'Initial synthetic creation fixture', config: { runner: 'deterministic-fixture' },
    entrypoints: entrypoints(v1Id) });
  const caseRecord = await service.createCase(space.id, { id: randomUUID(), title: 'Synthetic training board',
    objective: input.readerGoal, constraints: ['Fixture output only', 'No external factual claim'] });
  const { materials: _materials, ...opportunityPayload } = input;
  const opportunity = await service.importAsset(space.id, { schema: refs.opportunity, payload: opportunityPayload,
    description: 'Synthetic content opportunity', idempotencyKey: 'opportunity-v1' });
  const materials = await service.importAsset(space.id, { schema: refs.materials, payload: input.materials,
    description: 'Synthetic process note', idempotencyKey: 'materials-v1' });
  const contentManifest = await service.freezeInputs(space.id, caseRecord.id,
    { opportunity: opportunity.id, materials: materials.id });
  const contentRuntime = await createCreationSpaceRuntime(service, space.id,
    { workflowVersionId: v1.id, entrypoint: 'content', inputManifestId: contentManifest.id }, fakeRunner, refs);
  const first = await runWorkflow({ workflow: createContentWorkflow(models), input, ...contentRuntime });
  if (first.run.state !== 'needs_review') throw new Error(`Expected synthetic CONTENT review gate, got ${first.run.state}`);
  const firstAssets = (await service.overview(space.id)).assets;
  const firstDraft = exact(firstAssets, first.run.id, 'creation/content-draft');
  const firstResearch = exact(firstAssets, first.run.id, 'creation/content-research');
  const firstEditorial = exact(firstAssets, first.run.id, 'creation/content-review');
  await service.transition(space.id, { workflowVersionId: v1.id, entrypoint: 'content', nodeId: 'creatorDraftGate',
    assetVersionId: firstDraft.id, to: 'accepted', action: 'accept',
    reason: 'Synthetic human choice to exercise the handoff; not creative approval', idempotencyKey: 'synthetic-draft-gate' });
  if ((await service.readAsset(space.id, firstDraft.id)).state !== 'accepted') throw new Error('Exact draft did not reach the synthetic handoff state');

  const handoffManifest = await service.freezeInputs(space.id, caseRecord.id, {
    opportunity: opportunity.id, materials: materials.id, draft: firstDraft.id,
    research: firstResearch.id, review: firstEditorial.id,
  });
  const handoffRuntime = await createCreationSpaceRuntime(service, space.id,
    { workflowVersionId: v1.id, entrypoint: 'content-handoff', inputManifestId: handoffManifest.id }, fakeRunner, refs);
  const handoff = await runWorkflow({ workflow: createContentBriefHandoffWorkflow(), input: {
    input, draft: agentPayload<ContentDraft>(firstDraft), research: firstResearch.payload as ContentResearch,
    review: firstEditorial.payload as ContentReview,
    source: { runId: first.run.id, revision: CONTENT_REVISION, acceptedAt: new Date().toISOString(),
      reviewer: `${principal.id} (synthetic choice)`, notesForNext: [] },
  }, ...handoffRuntime });
  if (handoff.run.state !== 'succeeded') throw new Error(`Brief handoff failed: ${handoff.run.state}`);
  const brief = exact((await service.overview(space.id)).assets, handoff.run.id, 'creation/content-piece-brief');
  await service.transition(space.id, { workflowVersionId: v1.id, entrypoint: 'content-handoff', nodeId: 'creatorAcceptance',
    assetVersionId: brief.id, to: 'accepted', action: 'accept',
    reason: 'Synthetic human choice to exercise B3 input binding; not creative approval', idempotencyKey: 'synthetic-brief-gate' });
  const acceptedBrief = await service.readAsset(space.id, brief.id);
  if (acceptedBrief.state !== 'accepted') throw new Error('Exact brief did not reach the synthetic B3 input state');

  const b3Manifest = await service.freezeInputs(space.id, caseRecord.id, { brief: brief.id });
  const b3Runtime = await createCreationSpaceRuntime(service, space.id,
    { workflowVersionId: v1.id, entrypoint: 'b3-fixture', inputManifestId: b3Manifest.id }, fakeRunner, refs);
  const b3 = await runWorkflow({ workflow: createB3FrameSpecFixtureWorkflow(),
    input: { brief: acceptedBrief.payload as PieceBrief }, ...b3Runtime });
  if (b3.run.state !== 'succeeded') throw new Error(`B3 fixture failed: ${b3.run.state}`);
  const frame = exact((await service.overview(space.id)).assets, b3.run.id, 'creation/b3-frame-specs');
  const framePayload = frame.payload as { specs: Array<{ file: string; content: string }> };
  const frameBytes = Buffer.from(framePayload.specs.map(spec => spec.content).join('\n'));
  const blob = await service.uploadBlob(space.id, frameBytes, 'text/x-python');
  const frameWithAttachment = await service.transformAsset(space.id, { assetId: frame.assetId, expectedHead: frame.id,
    schema: frame.schema, payload: frame.payload, dependencies: [frame.id], blobIds: [blob.id],
    operation: 'attach-synthetic-frame-source', description: 'Managed byte attachment for deterministic B3 fixture',
    idempotencyKey: 'attach-frame-bytes' });
  if (!Buffer.from(await service.readBlob(space.id, blob.id)).equals(frameBytes) || frameWithAttachment.attachments.length !== 1) {
    throw new Error('Managed frame source bytes did not round-trip');
  }

  const feedback = { reviewer: `${principal.id} (synthetic choice)`,
    notes: ['Clarify that a score changes the next attempt and does not prove quality.'] };
  const feedbackAsset = await service.importAsset(space.id, { schema: refs.humanFeedback, payload: feedback,
    description: 'Synthetic human feedback on first exact draft', idempotencyKey: 'feedback-v1' });
  const v2Input: ContentInput = { ...input, prior: { draft: agentPayload<ContentDraft>(firstDraft), humanReview: feedback } };
  const { materials: _v2Materials, ...v2OpportunityPayload } = v2Input;
  const v2Opportunity = await service.importAsset(space.id, { schema: refs.opportunity, payload: v2OpportunityPayload,
    description: 'Synthetic revised opportunity with frozen feedback', idempotencyKey: 'opportunity-v2' });
  const v2Id = `creation-demo-v2-${randomUUID()}`;
  const v2 = await service.publishWorkflow(space.id, { id: v2Id, predecessorId: v1.id, revision: '2',
    changeReason: 'Respond to exact synthetic feedback: clarify the score-to-next-attempt link',
    config: { runner: 'deterministic-fixture', feedbackSource: feedbackAsset.id }, entrypoints: entrypoints(v2Id) });
  const v2Manifest = await service.freezeInputs(space.id, caseRecord.id, { opportunity: v2Opportunity.id,
    materials: materials.id, priorDraft: firstDraft.id, feedback: feedbackAsset.id });
  round = 2;
  const v2Runtime = await createCreationSpaceRuntime(service, space.id,
    { workflowVersionId: v2.id, entrypoint: 'content', inputManifestId: v2Manifest.id }, fakeRunner, refs);
  const second = await runWorkflow({ workflow: createContentWorkflow(models), input: v2Input, ...v2Runtime });
  if (second.run.state !== 'needs_review') throw new Error(`Expected second CONTENT review gate, got ${second.run.state}`);
  const secondDraft = exact((await service.overview(space.id)).assets, second.run.id, 'creation/content-draft');
  const b3Contexts = await service.runtimeContexts(space.id, b3.run.id);
  if (!b3Contexts.length || b3Contexts.some(context => context.inputs.brief?.assetVersionId !== brief.id)) {
    throw new Error('B3 context lost its frozen accepted v1 brief after the CONTENT v2 run');
  }
  const originalVoiceover = (acceptedBrief.payload as { script?: { segments?: Array<{ voiceover?: string }> } })
    .script?.segments?.[0]?.voiceover;
  if (!originalVoiceover || !framePayload.specs.some(spec => spec.content.includes(originalVoiceover))) {
    throw new Error('B3 fixture source does not contain text from the frozen original brief script');
  }

  const standard = { id: 'synthetic-clarity', revision: '1',
    content: 'Four questions about source fidelity and clarity in this synthetic demonstration.' };
  const firstReview = await service.recordReview(space.id, { id: randomUUID(), runId: first.run.id,
    assetVersionIds: [firstDraft.id], standard, judge: { kind: 'human', id: principal.id },
    evidence: [firstDraft.id, materials.id], answers: { good: 'The three steps are named.',
      bad: 'The role of the score is vague.', improvement: 'First run; no baseline is recorded.',
      unresolved: 'A synthetic fixture cannot establish creative quality.' } });
  const secondReview = await service.recordReview(space.id, { id: randomUUID(), runId: second.run.id,
    assetVersionIds: [secondDraft.id], standard, judge: { kind: 'human', id: principal.id },
    evidence: [secondDraft.id, feedbackAsset.id], baselineReviewId: firstReview.id,
    answers: { good: 'The next-attempt link is explicit.', bad: 'This remains a short fixture.',
      improvement: 'Compared with v1, v2 says the score changes the next attempt and is not proof of quality.',
      unresolved: 'Real reader response and creative quality remain unassessed.' } });
  const comparison = await service.compare(space.id, { id: randomUUID(), baselineReviewId: firstReview.id,
    candidateReviewId: secondReview.id, conclusion: 'The synthetic revision addresses the stated feedback.' });
  const iteration = await service.recordIteration(space.id, { id: randomUUID(), reviewIds: [firstReview.id, secondReview.id],
    hypothesis: 'Explicitly tie the score to the next attempt.', workflowVersionId: v2.id,
    caseIds: [caseRecord.id], runIds: [second.run.id] });
  const knowledge = await service.saveKnowledge(space.id, { id: randomUUID(), entryId: 'score-to-next-attempt',
    content: 'In this synthetic case, distinguish feedback about the next attempt from proof of overall quality.',
    classification: 'inference', scope: { caseId: caseRecord.id, roles: ['researcher', 'author'] },
    sourceAssetIds: [feedbackAsset.id, secondDraft.id], sourceMessageIds: [], status: 'active' });

  console.log(JSON.stringify({ spaceId: space.id, caseId: caseRecord.id, workflowVersionIds: [v1.id, v2.id],
    contentRunIds: [first.run.id, second.run.id], handoffRunId: handoff.run.id, b3RunId: b3.run.id,
    draftVersionIds: [firstDraft.id, secondDraft.id], acceptedBriefVersionId: brief.id,
    frameVersionId: frame.id, attachedFrameVersionId: frameWithAttachment.id, blobId: blob.id,
    reviewIds: [firstReview.id, secondReview.id], comparisonId: comparison.id,
    iterationId: iteration.id, knowledgeId: knowledge.id,
    execution: 'deterministic fake Agent outputs and program B3 fixture',
    syntheticHumanTransitions: true, creativeQualityAccepted: false }, null, 2));
} finally { await pool.end(); }
