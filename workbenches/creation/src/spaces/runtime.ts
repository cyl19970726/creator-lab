import { workflow, workflowFingerprint, type AgentRunRequest, type AgentRunner, type ArtifactDraft,
  type ArtifactRef, type AttemptRecord, type StepRecord, type StepResultCommit, type WorkflowDefinition } from '@signal-room/workflow';
import { createSpaceRuntime, type SpaceRuntimeService, type SpaceRuntimeResolverApi } from '@signal-room/workflow-spaces';
import type { AssetVersion, InputManifest } from '@signal-room/workflow-spaces';
import type { CreationSchemaRefs } from './contracts.js';
import { briefAfterContent, type PieceBrief } from '../stages/brief.js';
import type { ContentInput, ContentDraft, ContentResearch, ContentReview } from '../stages/content.js';
import { dependency } from '../stages/runtime.js';
import { contentOccurrence,contentCitationDeclarations } from './process.js';
import type { NodeOccurrenceAnnotation,NodeRelationWrite,ProcessDecisionBinding } from '@signal-room/workflow-spaces';

const roleNodes: Record<string, { nodeId: string; outputSlot: string }> = {
  'content-researcher': { nodeId: 'researcher', outputSlot: 'research' },
  'content-author': { nodeId: 'author', outputSlot: 'draft' },
  'content-cold-reader': { nodeId: 'coldReader', outputSlot: 'reader' },
  'content-fact-checker': { nodeId: 'factChecker', outputSlot: 'factCheck' },
  'content-editor': { nodeId: 'editor', outputSlot: 'review' },
  'b3-designer': { nodeId: 'designer', outputSlot: 'frameSpecs' },
  'b3-inspector': { nodeId: 'inspector', outputSlot: 'inspection' },
};
const artifactSlots: Record<string, { nodeId: string; outputSlot: string; slot: string }> = {
  'content-research': { nodeId: 'researcher', outputSlot: 'research', slot: 'research' },
  'content-draft': { nodeId: 'author', outputSlot: 'draft', slot: 'draft' },
  'content-reader': { nodeId: 'coldReader', outputSlot: 'reader', slot: 'reader' },
  'content-fact-check': { nodeId: 'factChecker', outputSlot: 'factCheck', slot: 'factCheck' },
  'content-review': { nodeId: 'editor', outputSlot: 'review', slot: 'review' },
  'content-piece-brief': { nodeId: 'briefBuilder', outputSlot: 'brief', slot: 'brief' },
  'b3-voice-manifest': { nodeId: 'voice', outputSlot: 'voiceManifest', slot: 'voiceManifest' },
  'b3-frame-specs': { nodeId: 'designer', outputSlot: 'frameSpecs', slot: 'frameSpecs' },
  'b3-assembly': { nodeId: 'assembler', outputSlot: 'assembly', slot: 'assembly' },
  'b3-inspection': { nodeId: 'inspector', outputSlot: 'inspection', slot: 'inspection' },
};

function same(a: unknown, b: unknown): boolean {
  return workflowFingerprint(a) === workflowFingerprint(b);
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function withoutMarkdown(value: unknown): unknown {
  const source = object(value);
  const { markdown: _markdown, ...rest } = source;
  return rest;
}
function must<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

type ArtifactPair = { artifact: ArtifactRef; version: AssetVersion };
function phaseOf(pair: ArtifactPair, steps: Map<string, StepRecord>): string | undefined {
  return steps.get(pair.artifact.producedBy.stepRunId)?.phasePath?.[0];
}
function exactCoreDependency(pair: ArtifactPair, type: string, pairs: ArtifactPair[]): ArtifactPair {
  const found = pair.artifact.dependsOn.map(dependency => pairs.find(candidate =>
    candidate.artifact.id === dependency.artifactId && candidate.artifact.revision === dependency.revision &&
    candidate.artifact.sha256 === dependency.sha256 && candidate.artifact.type === type)).filter((item): item is ArtifactPair => !!item);
  if (found.length !== 1) throw new Error(`Expected one exact ${type} dependency of ${pair.artifact.type}; found ${found.length}`);
  return found[0]!;
}

function feedbackInput(input: unknown): Record<string, unknown> | undefined {
  const value = object(input);
  return Object.keys(object(value.humanReview)).length ? object(value.humanReview) : undefined;
}

function voiceFixturePayload(brief: PieceBrief) {
  const segments = ((brief.script as { segments?: Array<{ voiceover?: string }> } | undefined)?.segments ?? []);
  return { voice: 'placeholder', lines: segments.map((_, index) => ({ index: index + 1, seconds: 2.4 })) };
}
function frameFixturePayload(brief: PieceBrief) {
  const segment = ((brief.script as { segments?: Array<{ onScreenText?: string; voiceover?: string; visual?: string; title?: string }> } | undefined)?.segments ?? [])[0];
  const account = brief.creator.account.name.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 24) || 'accepted-brief';
  const headline = JSON.stringify(segment?.onScreenText ?? brief.decision.coreQuestion);
  const voiceover = JSON.stringify(segment?.voiceover ?? brief.decision.oneLineAnswer);
  const visual = JSON.stringify(segment?.visual ?? brief.decision.hook);
  const title = JSON.stringify((brief.script as { title?: string } | undefined)?.title ?? account);
  const design = { files: ['frames-spec/01-accepted-brief.py'], buildCheckPassed: false, notes: 'Deterministic storage fixture only; no designer model, frame builder, or renderer was run.' };
  const content = `SPEC = dict(kind="shell", name="01-accepted-brief", cid="01-accepted-brief", p="f01", dur=3.0, body=${headline}, voiceover=${voiceover}, visual=${visual}, title=${title}, css=".accepted-brief{display:grid}", tl=[])\n`;
  return { report: design, build: { ok: false, output: 'Not run: storage fixture only; frame build and render were not run.' }, specs: [{ file: 'frames-spec/01-accepted-brief.py', content }] };
}

async function validateFrozenProgramOutput(artifact: ArtifactDraft, api: SpaceRuntimeResolverApi, manifest: InputManifest): Promise<void> {
  if (artifact.type === 'content-piece-brief') {
    const ids = ['opportunity', 'materials', 'draft', 'research', 'review'] as const;
    const versions = Object.fromEntries(await Promise.all(ids.map(async key => [key, await api.readAsset(must(manifest.assets[key], `Handoff needs frozen ${key}`))] as const)));
    if (versions.draft.state !== 'accepted') throw new Error('Brief builder requires the frozen accepted draft');
    const source = (object(artifact.payload).sources as Array<Record<string, unknown>> | undefined)?.[0];
    if (versions.draft.source.kind !== 'node' || source?.runId !== versions.draft.source.runId) {
      throw new Error('Brief source must identify the exact frozen accepted draft run');
    }
    const acceptedDraft = withoutMarkdown(versions.draft.payload) as ContentDraft;
    const expected = briefAfterContent({
      input: { ...versions.opportunity.payload as ContentInput, materials: versions.materials.payload as ContentInput['materials'] },
      draft: acceptedDraft,
      research: (versions.research.payload as ContentResearch).notes,
      review: versions.review.payload as ContentReview,
      gate: { runId: versions.draft.source.runId, revision: String(source.revision), acceptedAt: String(source.acceptedAt),
        reviewer: String(source.reviewer), notesForNext: [] },
    });
    if (!same(artifact.payload, expected)) throw new Error('Program brief payload does not match its exact frozen accepted inputs');
  }
  if (api.binding.entrypoint === 'b3-fixture' && (artifact.type === 'b3-voice-manifest' || artifact.type === 'b3-frame-specs')) {
    const briefAsset = await api.readAsset(must(manifest.assets.brief, 'B3 fixture requires a frozen brief'));
    if (briefAsset.state !== 'accepted') throw new Error('B3 fixture requires the frozen accepted brief');
    const brief = briefAsset.payload as PieceBrief;
    const expected = artifact.type === 'b3-voice-manifest' ? voiceFixturePayload(brief) : frameFixturePayload(brief);
    if (!same(artifact.payload, expected)) throw new Error(`Program ${artifact.type} does not match the frozen accepted brief`);
  }
}

/** Bind each existing stage role to immutable manifest imports and exact same-run outputs. */
export async function resolveCreationAgent(request: AgentRunRequest<unknown>, api: SpaceRuntimeResolverApi,
  _refs: CreationSchemaRefs): Promise<{ nodeId: string; inputs: Record<string, string>; instructions: string;process?:NodeOccurrenceAnnotation }> {
  const role = must(roleNodes[request.definition.id], `Unregistered creation role: ${request.definition.id}`);
  const manifest = await api.inputManifest();
  const inputs: Record<string, string> = {};
  const bindManifest = async (slot: string, assetName: string) => {
    inputs[slot] = must(manifest.assets[assetName], `Manifest is missing ${assetName}`);
  };
  const artifacts = await api.artifacts(request.runId);
  const steps = new Map((await api.steps(request.runId)).map(step => [step.id, step]));
  const activeStep = must(steps.get(request.stepRunId), 'Current Agent step is missing');
  const phase = activeStep.phasePath?.[0];
  const roundMatch = /^content-(?:research|draft|check|editor)-(\d+)$/.exec(phase ?? '');
  const contentRound = roundMatch ? Number(roundMatch[1]) : undefined;
  if (request.definition.id.startsWith('content-') && contentRound === undefined) throw new Error('CONTENT Agent has no exact round phase');
  const matches = (type: string, expected: unknown, strip = false): ArtifactPair[] => artifacts.filter(({ artifact, version }) =>
    artifact.type === type && same(strip ? withoutMarkdown(version.payload) : version.payload, expected));
  const inPhase = (type: string, expected: unknown, targetPhase: string, strip = false): ArtifactPair => {
    const found = matches(type, expected, strip).filter(pair => phaseOf(pair, steps) === targetPhase);
    if (found.length !== 1) throw new Error(`Expected one exact ${type} in ${targetPhase}; found ${found.length}`);
    return found[0]!;
  };
  const currentResearch = (expected: unknown): ArtifactPair => {
    const found = matches('content-research', expected).filter(pair => {
      const match = /^content-research-(\d+)$/.exec(phaseOf(pair, steps) ?? '');
      return match && Number(match[1]) <= contentRound!;
    }).sort((a, b) => Number(phaseOf(b, steps)!.split('-').at(-1)) - Number(phaseOf(a, steps)!.split('-').at(-1)));
    const latestPhase = found.length ? phaseOf(found[0]!, steps) : undefined;
    const latest = found.filter(pair => phaseOf(pair, steps) === latestPhase);
    if (latest.length !== 1) throw new Error(`Expected one exact current research; found ${latest.length}`);
    return latest[0]!;
  };
  const priorDraft = async (expected: unknown): Promise<{ artifact?: ArtifactRef; version: AssetVersion }> => {
    if (contentRound! > 0) return inPhase('content-draft', expected, `content-draft-${contentRound! - 1}`, true);
    const version = await api.readAsset(must(manifest.assets.priorDraft, 'Previous draft is not a same-run output or frozen input'));
    if (!same(withoutMarkdown(version.payload), expected)) throw new Error('Frozen previous draft does not match the role input');
    return { version };
  };
  const input = object(request.input);
  const feedback = feedbackInput(input);

  switch (request.definition.id) {
    case 'content-researcher': {
      await bindManifest('opportunity', 'opportunity'); await bindManifest('materials', 'materials');
      let previousDraft: { artifact: ArtifactRef; version: AssetVersion } | undefined;
      if (input.previousDraft) {
        const prior = await priorDraft(input.previousDraft);
        if (prior.artifact) previousDraft = { artifact: prior.artifact, version: prior.version };
        inputs.priorDraft = prior.version.id;
      }
      if (input.previousReview) inputs.priorReview = inPhase('content-review', input.previousReview, `content-editor-${contentRound! - 1}`).version.id;
      if (feedback) {
        const versionId = must(manifest.assets.feedback, 'Manifest is missing creator feedback');
        if (!same((await api.readAsset(versionId)).payload, feedback)) throw new Error('Frozen creator feedback does not match the role input');
        inputs.creatorFeedback = versionId;
      }
      if (previousDraft) {
        inputs.priorResearch = exactCoreDependency(previousDraft, 'content-research', artifacts).version.id;
      }
      break;
    }
    case 'content-author': {
      await bindManifest('opportunity', 'opportunity'); await bindManifest('materials', 'materials');
      inputs.research = currentResearch(input.research).version.id;
      let previousDraft: { artifact: ArtifactRef; version: AssetVersion } | undefined;
      if (input.previousDraft) {
        const prior = await priorDraft(input.previousDraft);
        if (prior.artifact) previousDraft = { artifact: prior.artifact, version: prior.version };
        inputs.priorDraft = prior.version.id;
      }
      if (input.review) inputs.priorReview = inPhase('content-review', input.review, `content-editor-${contentRound! - 1}`).version.id;
      if (feedback) {
        const versionId = must(manifest.assets.feedback, 'Manifest is missing creator feedback');
        if (!same((await api.readAsset(versionId)).payload, feedback)) throw new Error('Frozen creator feedback does not match the role input');
        inputs.creatorFeedback = versionId;
      }
      break;
    }
    case 'content-cold-reader': {
      const draft = artifacts.filter(({ artifact }) => artifact.type === 'content-draft').filter(pair => phaseOf(pair, steps) === `content-draft-${contentRound}`).filter(({ version }) => {
        const script = object(object(version.payload).script);
        return script.title === input.title && script.coverText === input.coverText && same(script.segments, input.segments);
      });
      if (draft.length !== 1) throw new Error(`Expected one exact cold-reader draft; found ${draft.length}`);
      inputs.manuscript = draft[0]!.version.id;
      await bindManifest('audienceProfile', 'opportunity');
      break;
    }
    case 'content-fact-checker': {
      const draft = inPhase('content-draft', input.draft, `content-draft-${contentRound}`, true);
      inputs.draft = draft.version.id;
      inputs.research = exactCoreDependency(draft, 'content-research', artifacts).version.id;
      await bindManifest('materials', 'materials');
      break;
    }
    case 'content-editor': {
      const draft = inPhase('content-draft', input.draft, `content-draft-${contentRound}`, true);
      inputs.draft = draft.version.id;
      const research = exactCoreDependency(draft, 'content-research', artifacts);
      if (!same(research.version.payload, input.research)) throw new Error('Editor research is not the exact draft dependency');
      inputs.research = research.version.id;
      inputs.reader = inPhase('content-reader', input.coldRead, `content-check-${contentRound}`).version.id;
      inputs.factCheck = inPhase('content-fact-check', input.factCheck, `content-check-${contentRound}`).version.id;
      await bindManifest('opportunity', 'opportunity');
      break;
    }
    case 'b3-designer':
    case 'b3-inspector': {
      await bindManifest('brief', 'brief');
      const related = artifacts.filter(({ artifact }) => artifact.type === 'b3-voice-manifest');
      if (request.definition.id === 'b3-designer') inputs.voiceManifest = must(related.at(-1)?.version.id, 'B3 designer needs an exact voice manifest');
      else inputs.assembly = must(artifacts.find(({ artifact }) => artifact.type === 'b3-assembly')?.version.id, 'B3 inspector needs assembly');
      break;
    }
  }
  return { nodeId: role.nodeId, inputs, instructions: request.definition.config?.prompt as string ?? `Run ${request.definition.id}`,
    ...(await api.frozenProcess(request.runId)&&contentOccurrence(activeStep,role.nodeId)?{process:contentOccurrence(activeStep,role.nodeId)}:{}) };
}

function dependencyAssetIds(targetNode: string, artifact: ArtifactDraft,
  pairs: Array<{ artifact: ArtifactRef; version: AssetVersion }>): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const dependency of artifact.dependsOn) {
    const exact = pairs.find(pair => pair.artifact.id === dependency.artifactId && pair.artifact.revision === dependency.revision && pair.artifact.sha256 === dependency.sha256);
    if (!exact) throw new Error(`Missing exact core dependency ${dependency.artifactId} for ${artifact.type}`);
    const mapping = artifactSlots[exact.artifact.type];
    if (!mapping) continue;
    let slot = mapping.slot;
    if (exact.artifact.type === 'content-draft') {
      slot = targetNode === 'coldReader' ? 'manuscript' : ['researcher', 'author'].includes(targetNode) ? 'priorDraft' : 'draft';
    } else if (exact.artifact.type === 'content-review' && ['researcher', 'author'].includes(targetNode)) {
      slot = 'priorReview';
    } else if (exact.artifact.type === 'content-research' && targetNode === 'researcher') {
      slot = 'priorResearch';
    }
    inputs[slot] = exact.version.id;
  }
  return inputs;
}

/** Preserve core publish dependencies and generated-agent provenance when committing business assets. */
export async function resolveCreationPublication(artifact: ArtifactDraft, api: SpaceRuntimeResolverApi,
  attemptsForStep: (stepId: string) => Promise<AttemptRecord[]>): Promise<{
  nodeId: string; inputs: Record<string, string>; outputSlot: string; dependencySlots?: string[]; generatedByContextId?: string;process?:NodeOccurrenceAnnotation;relations?:NodeRelationWrite[];
}> {
  const mapping = must(artifactSlots[artifact.type], `Unregistered creation publication: ${artifact.type}`);
  const pairs = await api.artifacts(artifact.producedBy.workflowRunId);
  const inputs = dependencyAssetIds(mapping.nodeId, artifact, pairs);
  const manifest = await api.inputManifest();
  const fallback = (slot: string, versionId: string | undefined) => { if (!inputs[slot] && versionId) inputs[slot] = versionId; };
  await validateFrozenProgramOutput(artifact, api, manifest);
  if (['researcher', 'author'].includes(mapping.nodeId)) {
    for (const name of ['opportunity', 'materials']) fallback(name, manifest.assets[name]);
    fallback('creatorFeedback', manifest.assets.feedback);
    fallback('priorDraft', manifest.assets.priorDraft);
  }
  if (mapping.nodeId === 'briefBuilder') {
    for (const name of ['draft', 'review', 'research']) fallback(name, manifest.assets[name]);
  }
  if (mapping.nodeId === 'factChecker') fallback('materials', manifest.assets.materials);
  if (mapping.nodeId === 'editor') fallback('opportunity', manifest.assets.opportunity);
  if (mapping.nodeId === 'voice') fallback('brief', manifest.assets.brief);
  if (['briefBuilder', 'designer', 'inspector'].includes(mapping.nodeId)) fallback('brief', manifest.assets.brief);
  if (mapping.nodeId === 'coldReader') {
    const draftVersion = inputs.draft;
    delete inputs.draft;
    if (draftVersion) inputs.manuscript = draftVersion;
    fallback('audienceProfile', manifest.assets.opportunity);
  }
  const agentNode = Object.values(roleNodes).find(role => role.nodeId === mapping.nodeId)?.nodeId;
  const steps = new Map((await api.steps(artifact.producedBy.workflowRunId)).map(step => [step.id, step]));
  const publicationStep = must(steps.get(artifact.producedBy.stepRunId), `Publication step missing for ${artifact.type}`);
  const publicationPhase = publicationStep.phasePath?.[0];
  const matchingContexts = (await api.contexts(artifact.producedBy.workflowRunId)).filter(item => item.producer === 'agent' &&
    item.nodeId === agentNode && steps.get(item.stepRunId)?.phasePath?.[0] === publicationPhase &&
    Object.entries(item.inputs).every(([slot, delivered]) => inputs[slot] === delivered.assetVersionId));
  const contexts = (await Promise.all(matchingContexts.map(async item => {
    const step = steps.get(item.stepRunId);
    if (!step || step.kind !== 'agent' || step.state !== 'succeeded' || step.validation !== 'valid' ||
      step.inputFingerprint !== workflowFingerprint(item.actualInput) ||
      step.configFingerprint !== workflowFingerprint(item.effectiveConfig)) return undefined;
    const attempts = await attemptsForStep(step.id);
    if (!attempts.some(attempt => attempt.id === item.attemptId && attempt.state === 'succeeded')) return undefined;
    const directAgentOutput = artifact.type === 'content-draft' ? withoutMarkdown(artifact.payload)
      : artifact.type === 'content-review' ? (() => {
        const { guardFailures: _guardFailures, ...raw } = object(artifact.payload);
        return raw;
      })()
      : ['content-reader', 'content-fact-check'].includes(artifact.type) ? artifact.payload : undefined;
    if (directAgentOutput !== undefined && !same(step.output, directAgentOutput)) return undefined;
    return item;
  }))).filter((item): item is NonNullable<typeof item> => !!item);
  if (contexts.length > 1) throw new Error(`Ambiguous ${mapping.nodeId} source context for ${artifact.type}`);
  const ctx = contexts[0];
  if (['content-research', 'content-draft', 'content-reader', 'content-fact-check', 'content-review', 'b3-inspection'].includes(artifact.type) && !ctx) {
    throw new Error(`Missing agent source context for ${artifact.type}`);
  }
  return {
    nodeId: mapping.nodeId, inputs, outputSlot: mapping.outputSlot,
    dependencySlots: Object.keys(inputs), ...(ctx ? { generatedByContextId: ctx.id } : {}),
    ...(await api.frozenProcess(artifact.producedBy.workflowRunId)&&contentOccurrence(publicationStep,mapping.nodeId)?{process:contentOccurrence(publicationStep,mapping.nodeId)}:{}),
    ...(await api.frozenProcess(artifact.producedBy.workflowRunId)&&['researcher','author'].includes(mapping.nodeId)?{relations:contentCitationDeclarations(mapping.nodeId,artifact.payload,Object.fromEntries(await Promise.all(Object.entries(inputs).map(async([slot,id])=>[slot,await api.readAsset(id)]))))}:{}),
  };
}

export async function createCreationSpaceRuntime(service: SpaceRuntimeService, spaceId: string,
  binding: { workflowVersionId: string; entrypoint: string; inputManifestId: string }, runner: AgentRunner,
  refs: CreationSchemaRefs) {
  return createSpaceRuntime(service, spaceId, binding, {
    underlyingRunner: runner,
    resolveDecision: resolveCreationDecision,
    resolveAgent: (request, api) => resolveCreationAgent(request, api, refs),
    resolvePublication: async (artifact, api) => {
      const ledger = await service.runtimeLedger(spaceId);
      return resolveCreationPublication(artifact, api, stepId => ledger.listAttempts(stepId));
    },
  });
}

/** Persist the native decision selection; actual traversal and budget stops remain native execution facts. */
export async function resolveCreationDecision(commit:StepResultCommit,api:SpaceRuntimeResolverApi):Promise<ProcessDecisionBinding|undefined> {
  const runId=commit.events[0]?.runId;
  if(!runId||!await api.frozenProcess(runId))return undefined;
  const step=(await api.steps(runId)).find(value=>value.id===commit.stepRunId);
  const match=/^content-route-(\d+)$/.exec(step?.key??'');
  if(!match)return undefined;
  const value=object(commit.output),round=Number(match[1]);
  if(value.round!==round||typeof value.route!=='string'||!Array.isArray(value.failures))throw new Error('CONTENT decision does not match its exact native round and payload');
  const route=value.verdict==='blocked'||value.route==='blocked'?'blocked':value.failures.length&&value.route==='pass'?'rewrite':value.route;
  const contract=await api.frozenProcess(runId);
  const edge=contract?.edges.find(value=>value.from==='route'&&value.route===route);
  if(!edge)throw new Error(`CONTENT decision route is absent from frozen process: ${route}`);
  return {nodeId:'route',edgeId:edge.id,round:round+1,observation:{route:value.route,round},
    reason:route!==value.route?'原生 guard 将请求的通过转为改稿；这里只记录选择，不宣称返工已执行。':'原生 CONTENT 决策选择；实际返工与预算停止由后续执行证据确认。'};
}

export interface ContentBriefHandoffInput {
  input: ContentInput;
  draft: ContentDraft;
  research: ContentResearch;
  review: ContentReview;
  source: { runId: string; revision: string; acceptedAt: string; reviewer: string; notesForNext: string[] };
}

/** Program-owned handoff that calls the existing accepted CONTENT brief builder. */
export function createContentBriefHandoffWorkflow(): WorkflowDefinition<ContentBriefHandoffInput, ArtifactRef> {
  return workflow('creation.content-handoff', { revision: 'content-handoff-v1' }, async (ctx, input) => {
    const result = await ctx.phase('assemble-accepted-brief', {
      title: 'Build accepted piece brief', purpose: 'Transform human-accepted content outputs into the B3 handoff', order: 1,
      expectedArtifacts: [{ role: 'brief', title: 'Accepted content handoff', required: true }],
    }, async phase => {
      const brief = briefAfterContent({
        input: input.input, draft: input.draft, research: input.research.notes,
        review: input.review, gate: input.source,
      });
      const published = await phase.publish('brief', 'content-piece-brief', brief, {
        revision: input.source.revision, validation: 'valid', review: 'not_applicable',
      });
      await phase.bindArtifact(published, { role: 'brief', title: 'Accepted content handoff', primary: true });
      return published;
    });
    return result;
  });
}

/** Deterministic fixture: program-assembles a real readable frame-spec asset without invoking a model. */
export function createB3FrameSpecFixtureWorkflow(): WorkflowDefinition<{ brief: PieceBrief }, ArtifactRef[]> {
  return workflow('creation.b3-fixture', { revision: 'b3-fixture-v1' }, async (ctx, input) => {
    const voice = await ctx.phase('build-placeholder-voice-manifest', {
      title: 'Build placeholder voice manifest', purpose: 'Use the accepted script to size the deterministic frame fixture', order: 1,
      expectedArtifacts: [{ role: 'voiceManifest', title: 'Placeholder voice manifest', required: true }],
    }, async phase => {
      const manifest = voiceFixturePayload(input.brief);
      const artifact = await phase.publish('voice-manifest', 'b3-voice-manifest', manifest, { validation: 'valid', review: 'not_applicable' });
      await phase.bindArtifact(artifact, { role: 'voiceManifest', title: 'Placeholder voice manifest', primary: true });
      return artifact;
    });
    const frames = await ctx.phase('write-readable-frame-spec-fixture', {
      title: 'Write deterministic frame spec fixture', purpose: 'Persist a readable B3 specification using the accepted brief', order: 2,
      expectedArtifacts: [{ role: 'frameSpecs', title: 'Readable frame specifications', required: true }],
    }, async phase => {
      const payload = frameFixturePayload(input.brief);
      const artifact = await phase.publish('frame-specs', 'b3-frame-specs', payload, {
        validation: 'valid', review: 'not_applicable', dependsOn: [dependency(voice)],
      });
      await phase.bindArtifact(artifact, { role: 'frameSpecs', title: 'Readable frame specifications', primary: true });
      return artifact;
    });
    return [voice, frames];
  });
}
