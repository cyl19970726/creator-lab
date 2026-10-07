import { z } from 'zod';
import {
  JSON_SCHEMA_DIALECT,
  SchemaRegistry,
  type FrozenSchemaRevision,
  type JsonValue,
  type SchemaDefinition,
  type SchemaRef,
  type StorageContractDraft,
} from '@signal-room/workflow-space-contracts';
import {
  b3AssemblyReportSchema,
  b3DesignAgentOutputSchema,
  b3FrameSpecsStoredSchema,
  b3InspectionOutputSchema,
  b3VoiceManifestStoredSchema,
} from '../stages/b3.js';
import {
  contentAccountSchema,
  contentDecisionSchema,
  contentDraftAgentOutputSchema,
  contentDraftStoredSchema,
  contentFactCheckOutputSchema,
  contentHumanFeedbackSchema,
  contentMaterialSchema,
  contentOpportunitySchema,
  contentReaderOutputSchema,
  contentResearchAgentOutputSchema,
  contentReviewAgentOutputSchema,
  contentReviewStoredSchema,
  contentScriptSchema,
} from '../stages/content.js';

const CONTENT_NS = 'creation';
const REVISION = '1';

const schema = (value: z.ZodType): JsonValue => {
  const json = z.toJSONSchema(value, { target: 'draft-2020-12' });
  return { ...(json as Record<string, JsonValue>), $schema: JSON_SCHEMA_DIALECT };
};

const object = (properties: Record<string, JsonValue>, required = Object.keys(properties)): JsonValue => ({
  type: 'object', properties, required, additionalProperties: false,
});

const text = { type: 'string' } as const;
/** Exact, versioned business payload schemas derived from the stage Zod definitions. */
export function creationSchemaDefinitions(): SchemaDefinition[] {
  const viewerDraft = object({
    script: object({
      title: text,
      coverText: text,
      segments: { type: 'array', items: schema(contentScriptSchema.shape.segments.element) },
    }),
  });
  const opportunity = contentOpportunitySchema;
  const materials = { type: 'array', minItems: 1, items: schema(contentMaterialSchema) } as JsonValue;
  const readerProfile = object({ account: object({ currentAudience: { type: 'string', minLength: 1 } }) });
  const pieceBrief = z.object({
    schemaVersion: z.literal('brief-v1'),
    topicId: z.string().min(1),
    version: z.number().int().positive(),
    sources: z.array(z.object({
      stage: z.literal('content'), runId: z.string().min(1), revision: z.string().min(1),
      acceptedAt: z.string().min(1), reviewer: z.string().min(1),
    }).strict()).min(1),
    creator: z.object({
      opportunity: z.string().min(1), account: contentAccountSchema, form: z.string().min(1),
    }).strict(),
    audienceQuestion: z.object({
      readerGoal: z.string().min(1), requiredQuestions: z.array(z.string().min(1)).min(1),
      questionInAudienceWords: z.string().min(1),
    }).strict(),
    decision: contentDecisionSchema,
    materials: z.array(contentMaterialSchema).min(1),
    notesForB2: z.array(z.object({ from: z.string().min(1), note: z.string().min(1) }).strict()),
    script: contentScriptSchema,
    notesForB3: z.array(z.object({ from: z.string().min(1), note: z.string().min(1) }).strict()),
  }).strict();

  const definitions: Array<[string, z.ZodType | JsonValue]> = [
    ['content-material', contentMaterialSchema],
    ['content-materials', materials],
    ['content-opportunity', opportunity],
    ['content-human-feedback', contentHumanFeedbackSchema],
    ['content-reader-profile', readerProfile],
    ['content-research-agent-output', contentResearchAgentOutputSchema],
    ['content-research', contentResearchAgentOutputSchema],
    ['content-draft-agent-output', contentDraftAgentOutputSchema],
    ['content-draft', contentDraftStoredSchema],
    ['content-reader-agent-output', contentReaderOutputSchema],
    ['content-reader', contentReaderOutputSchema],
    ['content-fact-check-agent-output', contentFactCheckOutputSchema],
    ['content-fact-check', contentFactCheckOutputSchema],
    ['content-review-agent-output', contentReviewAgentOutputSchema],
    ['content-review', contentReviewStoredSchema],
    ['content-piece-brief', pieceBrief],
    ['content-viewer-draft', viewerDraft],
    ['b3-frame-design-agent-output', b3DesignAgentOutputSchema],
    ['b3-frame-specs', b3FrameSpecsStoredSchema],
    ['b3-assembly', b3AssemblyReportSchema],
    ['b3-voice-manifest', b3VoiceManifestStoredSchema],
    ['b3-inspection-agent-output', b3InspectionOutputSchema],
    ['b3-inspection', b3InspectionOutputSchema],
  ];
  return definitions.map(([name, value]) => ({
    namespace: `${CONTENT_NS}/${name}`,
    revision: REVISION,
    dialect: JSON_SCHEMA_DIALECT,
    schema: value instanceof z.ZodType ? schema(value) : value,
  }));
}

export interface CreationSchemaRefs {
  material: SchemaRef;
  materials: SchemaRef;
  opportunity: SchemaRef;
  humanFeedback: SchemaRef;
  readerProfile: SchemaRef;
  researchAgent: SchemaRef;
  research: SchemaRef;
  draftAgent: SchemaRef;
  draft: SchemaRef;
  readerAgent: SchemaRef;
  reader: SchemaRef;
  factCheckAgent: SchemaRef;
  factCheck: SchemaRef;
  reviewAgent: SchemaRef;
  review: SchemaRef;
  brief: SchemaRef;
  viewerDraft: SchemaRef;
  frameDesignAgent: SchemaRef;
  frameSpecs: SchemaRef;
  assembly: SchemaRef;
  voiceManifest: SchemaRef;
  inspectionAgent: SchemaRef;
  inspection: SchemaRef;
}

const ref = (revision: FrozenSchemaRevision): SchemaRef => ({
  namespace: revision.namespace, revision: revision.revision, hash: revision.hash,
});

/** Register the complete creation payload set and return refs bound to exact content hashes. */
export function registerCreationSchemas(registry: SchemaRegistry): CreationSchemaRefs {
  const registered = new Map<string, FrozenSchemaRevision>();
  for (const definition of creationSchemaDefinitions()) registered.set(definition.namespace, registry.registerSchema(definition));
  const get = (name: string) => {
    const revision = registered.get(`${CONTENT_NS}/${name}`);
    if (!revision) throw new Error(`Creation schema registration omitted ${name}`);
    return ref(revision);
  };
  return {
    material: get('content-material'), materials: get('content-materials'), opportunity: get('content-opportunity'),
    humanFeedback: get('content-human-feedback'),
    readerProfile: get('content-reader-profile'),
    researchAgent: get('content-research-agent-output'), research: get('content-research'),
    draftAgent: get('content-draft-agent-output'), draft: get('content-draft'),
    readerAgent: get('content-reader-agent-output'), reader: get('content-reader'),
    factCheckAgent: get('content-fact-check-agent-output'), factCheck: get('content-fact-check'),
    reviewAgent: get('content-review-agent-output'), review: get('content-review'),
    brief: get('content-piece-brief'), viewerDraft: get('content-viewer-draft'),
    frameDesignAgent: get('b3-frame-design-agent-output'), frameSpecs: get('b3-frame-specs'),
    assembly: get('b3-assembly'),
    voiceManifest: get('b3-voice-manifest'),
    inspectionAgent: get('b3-inspection-agent-output'), inspection: get('b3-inspection'),
  };
}

const input = (schemaRef: SchemaRef, states: string[] = ['candidate'], optional = false) => ({ schema: schemaRef, states, ...(optional ? { optional: true } : {}) });
const output = (schemaRef: SchemaRef, requiredInputs: string[], initialState = 'candidate', agentOutputSchema?: SchemaRef) => ({
  schema: schemaRef, requiredInputs, appendVersions: true, initialState, ...(agentOutputSchema ? { agentOutputSchema } : {}),
});

/** Two independent entrypoints share the registered asset vocabulary and accepted brief handoff. */
export function creationStorageContracts(refs: CreationSchemaRefs, workflowVersion: string): StorageContractDraft[] {
  const content: StorageContractDraft = {
    workflowVersion,
    nodes: {
      researcher: {
        actorKinds: ['agent', 'program'],
        inputs: {
          opportunity: input(refs.opportunity, ['imported', 'candidate']), materials: input(refs.materials, ['imported', 'candidate']),
          priorResearch: input(refs.research, ['candidate'], true),
          priorDraft: input(refs.draft, ['candidate', 'accepted'], true), priorReview: input(refs.review, ['candidate'], true),
          creatorFeedback: input(refs.humanFeedback, ['imported', 'candidate'], true),
        },
        outputs: { research: output(refs.research, ['opportunity', 'materials'], 'candidate', refs.researchAgent) },
        actions: ['readBoundInput', 'appendOutputVersion'],
      },
      author: {
        actorKinds: ['agent', 'program'],
        inputs: {
          opportunity: input(refs.opportunity, ['imported', 'candidate']), materials: input(refs.materials, ['imported', 'candidate']), research: input(refs.research),
          priorDraft: input(refs.draft, ['candidate', 'accepted'], true), priorReview: input(refs.review, ['candidate'], true),
          creatorFeedback: input(refs.humanFeedback, ['imported', 'candidate'], true),
        },
        outputs: { draft: output(refs.draft, ['opportunity', 'materials', 'research'], 'candidate', refs.draftAgent) },
        actions: ['readBoundInput', 'appendOutputVersion'],
      },
      coldReader: {
        actorKinds: ['agent', 'program'],
        inputs: {
          manuscript: { ...input(refs.draft), projection: {
            version: 'viewer-view-v1', fields: ['/script/title', '/script/coverText', '/script/segments'], schema: refs.viewerDraft,
          } },
          audienceProfile: { ...input(refs.opportunity, ['imported', 'candidate']), projection: {
            version: 'audience-profile-v1', fields: ['/account/currentAudience'], schema: refs.readerProfile,
          } },
        },
        outputs: { reader: output(refs.reader, ['manuscript', 'audienceProfile'], 'candidate', refs.readerAgent) },
        actions: ['readBoundInputProjection', 'appendOutputVersion'],
      },
      factChecker: {
        actorKinds: ['agent', 'program'],
        inputs: { draft: input(refs.draft), research: input(refs.research), materials: input(refs.materials, ['imported', 'candidate']) },
        outputs: { factCheck: output(refs.factCheck, ['draft', 'research', 'materials'], 'candidate', refs.factCheckAgent) },
        actions: ['readBoundInput', 'appendOutputVersion'],
      },
      editor: {
        actorKinds: ['agent', 'program'],
        inputs: {
          opportunity: input(refs.opportunity, ['imported', 'candidate']), draft: input(refs.draft), research: input(refs.research),
          reader: input(refs.reader), factCheck: input(refs.factCheck),
        },
        outputs: { review: output(refs.review, ['draft', 'research', 'reader', 'factCheck'], 'candidate', refs.reviewAgent) },
        actions: ['readBoundInput', 'evaluate', 'requestRevision', 'appendOutputVersion'],
      },
      creatorDraftGate: {
        actorKinds: ['human'],
        inputs: { draft: input(refs.draft), review: input(refs.review), research: input(refs.research) },
        outputs: {},
        actions: ['readBoundInput', 'accept'],
      },
      briefBuilder: {
        actorKinds: ['program'],
        inputs: { draft: input(refs.draft, ['accepted']), review: input(refs.review), research: input(refs.research) },
        outputs: { brief: output(refs.brief, ['draft', 'review', 'research']) },
        actions: ['readBoundInput', 'appendOutputVersion'],
      },
      creatorAcceptance: {
        actorKinds: ['human'],
        inputs: { draft: input(refs.draft, ['accepted']), brief: input(refs.brief) },
        outputs: {},
        actions: ['readBoundInput', 'accept'],
      },
    },
    stateRules: [
      { schema: refs.draft, from: 'candidate', to: 'accepted', action: 'accept', actorKinds: ['human'], nodeId: 'creatorDraftGate' },
      { schema: refs.brief, from: 'candidate', to: 'accepted', action: 'accept', actorKinds: ['human'], nodeId: 'creatorAcceptance' },
    ],
  };

  const b3: StorageContractDraft = {
    workflowVersion,
    nodes: {
      voice: {
        actorKinds: ['program'],
        inputs: { brief: input(refs.brief, ['accepted']) },
        outputs: { voiceManifest: output(refs.voiceManifest, ['brief']) },
        actions: ['readBoundInput', 'appendOutputVersion'],
      },
      designer: {
        actorKinds: ['agent', 'program'],
        inputs: { brief: input(refs.brief, ['accepted']), voiceManifest: input(refs.voiceManifest) },
        outputs: { frameSpecs: output(refs.frameSpecs, ['brief', 'voiceManifest'], 'candidate', refs.frameDesignAgent) },
        actions: ['readBoundInput', 'appendOutputVersion'],
      },
      assembler: {
        actorKinds: ['program'],
        inputs: { frameSpecs: input(refs.frameSpecs) },
        outputs: { assembly: output(refs.assembly, ['frameSpecs']) },
        actions: ['readBoundInput', 'appendOutputVersion'],
      },
      inspector: {
        actorKinds: ['agent', 'program'],
        inputs: { brief: input(refs.brief, ['accepted']), assembly: input(refs.assembly) },
        outputs: { inspection: output(refs.inspection, ['brief', 'assembly'], 'candidate', refs.inspectionAgent) },
        actions: ['readBoundInput', 'evaluate', 'appendOutputVersion'],
      },
    },
    stateRules: [],
  };

  return [content, b3];
}
