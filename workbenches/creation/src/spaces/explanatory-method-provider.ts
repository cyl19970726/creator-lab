import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentRunner } from '@signal-room/workflow';
import { JSON_SCHEMA_DIALECT, SchemaRegistry, publishStorageContract, type SchemaDefinition } from '@signal-room/workflow-space-contracts';
import { publishProcessContract, type BusinessUnderstandingRevision, type MethodCapabilityRevision, type MethodDesignRevision,
  nodeReadTools, type WorkflowVersionDraft } from '@signal-room/workflow-spaces';
import { CONTENT_ROLES, type ContentRoleSpecs } from '../stages/content.js';
import type { StageModel } from '../stages/runtime.js';
import { createContentDeployment, canonicalContentDefinition, type ContentDeployment } from './content-method.js';
import { contentSiwcExecutorManifest } from './content-runner.js';
import { creationSchemaDefinitions, creationStorageContracts, registerCreationSchemas } from './contracts.js';
import { buildContentPresentation } from './presentation.js';

export const EXPLANATORY_METHOD_PROVIDER = { id: 'creation.explanatory-method', contractRevision: '1' } as const;
const roleKeys = ['researcher', 'author', 'coldReader', 'factChecker', 'editor'] as const;
type RoleKey = typeof roleKeys[number];
const stageKey: Record<RoleKey, keyof ContentRoleSpecs> = {
  researcher: 'researcher', author: 'author', coldReader: 'reader', factChecker: 'checker', editor: 'editor',
};
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const canonicalHash = (value: unknown) => digest(canonicalContentDefinition(value));
const unavailableReason = 'Execution requires an exact published deployment, SIWC authorization, a persisted budget and a per-Case release';
const unavailableRunner: AgentRunner = { async run() { throw new Error(unavailableReason); } };

export interface ExplanatoryMethodCandidate {
  candidateId: string;
  workflowId: string;
  entrypoint: string;
  designRevisionId: string;
  designPayloadHash: string;
  understandingRevisionId: string;
  understandingPayloadHash: string;
  capabilityRevisionId: string;
  capabilityPayloadHash: string;
  provider: typeof EXPLANATORY_METHOD_PROVIDER & { fingerprint: string };
  version: WorkflowVersionDraft;
  schemas: SchemaDefinition[];
  presentation: ReturnType<typeof buildContentPresentation>;
  availability: { state: 'unavailable'; reason: string };
}

/** A capture contains all five role definitions and one code identity for declaration and later execution. */
export interface ExplanatoryMethodCapture {
  candidate: ExplanatoryMethodCandidate;
  deployment: ContentDeployment;
}

function exactContent(value: { content: string; sha256: string }, label: string): string {
  if (!value || typeof value.content !== 'string' || !value.content.trim() ||
    !/^[a-f0-9]{64}$/.test(value.sha256) || digest(value.content) !== value.sha256)
    throw new Error(`${label} content/hash mismatch`);
  return value.content;
}

function schemaValue(value: { content: string; sha256: string }, label: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(exactContent(value, label)); }
  catch { throw new Error(`${label} is not valid JSON`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} is not a JSON Schema object`);
  return parsed as Record<string, unknown>;
}

function schemaMeaning(value: Record<string, unknown>): string {
  const copy = structuredClone(value);
  if (copy.$schema === JSON_SCHEMA_DIALECT) delete copy.$schema;
  return canonicalContentDefinition(copy);
}

const providerFiles = ['explanatory-method-provider.ts', 'content-method.ts', 'content-runner.ts',
    'explanatory-method-runner.ts', 'source-handles.ts', 'runtime.ts',
    'explanatory-method-execution.ts', 'explanatory-method-execution-host.ts',
    '../../../../vendor/agent-workflow/packages/spaces/dist/execution-budget.js',
    '../../../../vendor/agent-workflow/packages/spaces/dist/node-tools.js',
    'contracts.ts', 'process.ts', 'presentation.ts', '../stages/content.ts', '../stages/runtime.ts'] as const;
function currentProviderSources(): Record<string, string> {
  return Object.fromEntries(providerFiles.map(file => [file,
    (() => { const path = fileURLToPath(new URL(file, import.meta.url));
      if (!existsSync(path)) {
        throw new Error(`Explanatory provider dependency is missing: ${file}`);
      }
      return digest(readFileSync(path, 'utf8')); })()]));
}
const loadedProviderSources = Object.freeze(currentProviderSources());
export function assertExplanatoryProviderSourceSnapshot(loaded: Record<string, string>, current: Record<string, string>): void {
  if (canonicalContentDefinition(loaded) !== canonicalContentDefinition(current))
    throw new Error('Explanatory provider implementation changed after module load; restart with matching code');
}
function providerFingerprint(declaration: WorkflowVersionDraft): string {
  assertExplanatoryProviderSourceSnapshot(loadedProviderSources, currentProviderSources());
  return canonicalHash({ provider: EXPLANATORY_METHOD_PROVIDER, sources: loadedProviderSources,
    methodSnapshot: declaration.config.methodSnapshot, runtimeDependencies: declaration.config.runtimeDependencies });
}

function checkBasis(capability: MethodCapabilityRevision, design: MethodDesignRevision,
  understanding: BusinessUnderstandingRevision): void {
  if (capability.provider.id !== EXPLANATORY_METHOD_PROVIDER.id ||
    capability.provider.contractRevision !== EXPLANATORY_METHOD_PROVIDER.contractRevision)
    throw new Error('Unsupported explanatory method provider contract');
  if (capability.entrypoint !== 'content' || design.entrypoint !== 'content' ||
    capability.workflowId !== design.workflowId || !capability.workflowId.trim())
    throw new Error('Explanatory method capability/design workflow scope mismatch');
  if (capability.understanding.revisionId !== understanding.id ||
    capability.understanding.payloadHash !== understanding.payloadHash ||
    design.understanding.revisionId !== understanding.id ||
    design.understanding.payloadHash !== understanding.payloadHash)
    throw new Error('Explanatory method understanding basis mismatch');
  if (!design.capability || design.capability.revisionId !== capability.id ||
    design.capability.payloadHash !== capability.payloadHash)
    throw new Error('Method design does not name the exact capability revision');
  if (!capability.changeReason.trim()) throw new Error('Method capability changeReason is required');
  if (capability.predecessorVersionId !== null && !capability.predecessorVersionId.trim())
    throw new Error('Method capability predecessorVersionId is invalid');
  if (Object.keys(capability.nodes).length !== roleKeys.length ||
    roleKeys.some(key => !Object.hasOwn(capability.nodes, key)))
    throw new Error('Explanatory method requires exactly five supported roles');
}

/** Pure provider compilation: reads frozen revision bytes and local code, never a model or business store. */
export function captureExplanatoryMethod(capability: MethodCapabilityRevision,
  design: MethodDesignRevision, understanding: BusinessUnderstandingRevision,
  runner: AgentRunner = unavailableRunner): ExplanatoryMethodCapture {
  assertExplanatoryProviderSourceSnapshot(loadedProviderSources, currentProviderSources());
  checkBasis(capability, design, understanding);
  const validationText = exactContent(capability.validation, 'Validation plan');
  let validation: Record<string, unknown>;
  try { validation = JSON.parse(validationText) as Record<string, unknown>; }
  catch { throw new Error('Validation plan is not valid JSON'); }
  if (!validation || typeof validation !== 'object' || Array.isArray(validation))
    throw new Error('Validation plan must be a JSON object');
  const budget = validation.budget as Record<string, unknown> | undefined;
  if (validation.revision !== 3 || budget?.maxNodeCalls !== 15 || budget.maxProviderRequests !== 15 ||
    budget.clockStartsAt !== 'first provider request reservation; 60-minute wall budget continues during diagnosis and waiting' ||
    budget.maxCaseBusinessRounds !== 2 ||
    budget.maxTechnicalRepairsPerNode !== 1 || budget.maxWallMinutes !== 60 ||
    budget.maxNodeMinutes !== 15 || budget.webResearch !== false)
    throw new Error('Unsupported explanatory method validation revision or budget; v3 provider-request parity is required');
  const trial = validation.trial as Record<string, unknown> | undefined;
  if (trial?.node !== 'researcher' || trial.maxModelCalls !== 2 ||
    trial.secondCallOnly !== 'one tool continuation OR one technical repair within the same 2-request hard cap; at most one technical repair; no request added when the cap is consumed' ||
    trial.parity !== 'Use the same frozen researcher instructions, output schema, first-round context projection, and read_bound_asset tool contract as a full Case; no special no-tool shortcut.')
    throw new Error('Unsupported explanatory method bounded trial');

  const roles = {} as ContentRoleSpecs;
  const roleModels = {} as Record<keyof ContentRoleSpecs, StageModel>;
  const captureNodes: Record<string, unknown> = {};
  for (const key of roleKeys) {
    const supplied = capability.nodes[key]!;
    const outputSchema = schemaValue(supplied.outputSchema, `${key} output schema`);
    const expected = CONTENT_ROLES[stageKey[key]].outputSchema as Record<string, unknown>;
    if (schemaMeaning(outputSchema) !== schemaMeaning(expected))
      throw new Error(`${key} output schema is incompatible with the executable CONTENT role`);
    if (!['low', 'medium', 'high'].includes(supplied.reasoningEffort) || !supplied.model?.trim())
      throw new Error(`${key} model declaration is unsupported`);
    const instructionText = exactContent(supplied.instructions, `${key} instructions`);
    const effectiveInstructions = `${instructionText}\n\n【必须遵循的输出 JSON Schema】\n${JSON.stringify(outputSchema)}\n只返回一个符合该 schema 的 JSON 对象。`;
    const stage = stageKey[key];
    roles[stage] = { id: CONTENT_ROLES[stage].id, title: key, guards: `Execute the frozen ${key} method`,
      prompt: effectiveInstructions, preamble: '', instructionsCompiled: true, outputSchema, webSearch: false };
    roleModels[stage] = { model: supplied.model, reasoningEffort: supplied.reasoningEffort as StageModel['reasoningEffort'] };
    captureNodes[key] = { instructions: supplied.instructions, outputSchema: supplied.outputSchema,
      effectiveInstructionsSha256: digest(effectiveInstructions), model: supplied.model,
      reasoningEffort: supplied.reasoningEffort };
  }
  const manifest = { ...contentSiwcExecutorManifest(),
    instructionMapping: 'precompiled exact prompt including output JSON Schema; no runtime append' };
  const deployment = createContentDeployment({ models: { worker: roleModels.researcher,
    judge: roleModels.author }, runner, roles, roleModels, executorManifest: manifest,
    workflowOptions: { roleModels, includePreamble: false, textOnlyColdReader: true,
      preserveResearchOutput: true, strictReviewRouting: true, workflowId: capability.workflowId } });
  const declaration = deployment.candidate();
  const fingerprint = providerFingerprint(declaration.version);
  const provider = { ...EXPLANATORY_METHOD_PROVIDER, fingerprint };
  const designBasis = { designRevisionId: design.id, designPayloadHash: design.payloadHash,
    understandingRevisionId: understanding.id, understandingPayloadHash: understanding.payloadHash };
  const policy = {
    context: { researcher: ['opportunity', 'materials', 'sourceMap', 'priorResearch', 'priorDraft', 'priorReview', 'creatorFeedback'],
      author: ['opportunity', 'materials', 'sourceMap', 'research', 'priorDraft', 'priorReview', 'creatorFeedback'],
      coldReader: ['audienceProfile', 'manuscript.title', 'manuscript.coverText',
        'manuscript.segments.voiceover', 'manuscript.segments.onScreenText'],
      factChecker: ['materials', 'sourceMap', 'draft', 'research'],
      editor: ['opportunity', 'materials', 'research', 'draft', 'reader', 'factCheck'] },
    tools: { readBoundAsset: { name: 'read_bound_asset', scope: 'exact persisted node context only',
      write: false, webResearch: false, descriptorSource: 'installed nodeReadTools',
      boundSlots: 'exact persisted attempt; optional inputs excluded when absent',
      executionModes: { trial: 'available for bound researcher', case: 'available for bound non-reader roles' } } },
    routes: { pass: 'creatorDraftGate', rewrite: 'author', research: 'researcher',
      reframe: 'researcher', blocked: 'stop', exhausted: 'stop' },
    programRouting: {
      input: ['published editor review.verdict', 'published editor review.route',
        'contentAcceptanceFailures guardFailures', 'business round index', 'frozen maxRevisions=1'],
      beforeRoute: 'Reject structurally invalid review or reviewRouteFailures before review publication',
      decisionOrder: [
        'pass verdict and pass route with zero guardFailures => needs_review awaiting-human-review',
        'strict routing: pass verdict with guardFailures => needs_review not-converged',
        'blocked verdict or blocked route => needs_review blocked',
        'round index >= 1 => needs_review not-converged',
        'otherwise route rewrite to author; research or reframe to researcher',
      ],
      maxTotalReworkTraversals: 1,
      reworkBranchesShareLimit: true,
      decisionRecord: 'content-route-{round} with route, verdict, guardFailures, round',
    },
    creatorDraftGate: {
      input: ['current draft', 'current editor review', 'latest research'],
      runtimeBehavior: 'needs_review records a creator-facing handoff and stops this run',
      creatorAuthority: 'creator may decide acceptance, revision, or stopping outside this run',
      implementedCommands: [],
      automaticContinuation: false,
    },
    sourceResolver: { scope: 'exact frozen Case material and research parent',
      duplicateOrMissing: 'reject before publication', inference: false },
    repair: { maxTechnicalRepairsPerNode: 1, preserveRawResponse: true,
      substantiveFailure: 'stop for diagnosis' },
    budget: { ...budget, legacyMaxRevisions: 1,
      semantics: 'CONTENT rounds 0 and 1 inclusive; a technical retry does not consume a business round' },
    trial: { ...structuredClone(trial), actualProviderRequestCap: 2,
      secondPostKinds: ['tool-continuation', 'technical-repair'] },
    implemented: { guardedRuntime: true, exactProjection: true, semanticValidation: true,
      sourceResolution: true, boundedRepair: true, budgetEnforcement: true,
      caseReleaseRequired: true },
  };
  const declaredRefs = registerCreationSchemas(new SchemaRegistry());
  const [declaredStorage] = creationStorageContracts(declaredRefs, 'declaration-only', { textOnlyColdReader: true });
  if (!declaredStorage) throw new Error('Explanatory content storage declaration is missing');
  const source = declaration.version.entrypoints.content!;
  const process = structuredClone(source.process!);
  process.revision = 'explanatory-process-1';
  process.edges = process.edges.map(edge => edge.kind === 'rework' ? { ...edge, maxTraversals: 1 } : edge);
  const nodeDefinitions = structuredClone(source.nodeDefinitions ?? {});
  for (const key of roleKeys) {
    const node = nodeDefinitions[key];
    if (!node) throw new Error(`Compiled explanatory method is missing ${key}`);
    const slots = Object.keys(declaredStorage.nodes[key]?.inputs ?? {});
    let toolContract: unknown;
    if (key === 'coldReader') { node.tools = []; node.toolDefinitions = []; }
    else {
      const descriptor = nodeReadTools({ read: async () => { throw new Error('Declaration-only tool cannot execute'); } } as never,
        { boundSlots: slots })[0];
      node.tools = [descriptor.name];
      node.toolDefinitions = [{ name: descriptor.name, description: descriptor.description,
        parameters: structuredClone(descriptor.parameters), outputSchema: structuredClone(descriptor.outputSchema) }];
      toolContract = { response: structuredClone(descriptor.response),
        permissions: structuredClone(descriptor.permissions) };
    }
    node.configuration = { ...node.configuration,
      ...(key === 'coldReader' ? { executor: { ...manifest, tools: [] } } : {}),
      ...(toolContract ? { toolContract } : {}),
      contextPolicy: policy.context[key], toolPolicy: key === 'coldReader'
        ? { available: false, reason: 'text-only reader has no read tool' }
        : { ...policy.tools.readBoundAsset, declaredSlots: slots },
      sourceResolver: policy.sourceResolver, repairPolicy: policy.repair,
      budgetPolicy: policy.budget, executionAvailability: 'conditional-release' };
  }
  const routeNode = nodeDefinitions.route;
  if (!routeNode) throw new Error('Compiled explanatory method is missing the program route');
  routeNode.purpose = 'Record strict editor guard outcome and one shared business rework decision';
  routeNode.configuration = { ...routeNode.configuration, maxRevisions: 1,
    programRouting: policy.programRouting };
  const creatorGate = nodeDefinitions.creatorDraftGate;
  if (!creatorGate) throw new Error('Compiled explanatory method is missing the creator draft handoff');
  creatorGate.purpose = 'Record a creator-facing draft review handoff and stop this run';
  creatorGate.configuration = { ...creatorGate.configuration, handoff: policy.creatorDraftGate };
  const config = { ...declaration.version.config, nodeDefinitions: structuredClone(nodeDefinitions), provider,
    capabilityIdentity: { revisionId: capability.id, payloadHash: capability.payloadHash,
      assetId: capability.assetId, previousRevisionId: capability.previousRevisionId,
      recordedBy: capability.recordedBy, authorship: capability.authorship },
    designBasis, validation: capability.validation, captureNodes, policy,
    executionAvailability: 'conditional-release', executionBlocker: unavailableReason };
  const versionId = `explanatory-method-${canonicalHash({ config, workflowId: capability.workflowId,
    entrypoint: capability.entrypoint, designBasis, predecessorVersionId: capability.predecessorVersionId,
    changeReason: capability.changeReason }).slice(0, 32)}`;
  const schemas = creationSchemaDefinitions();
  const refs = registerCreationSchemas(new SchemaRegistry());
  const [storageContract] = creationStorageContracts(refs, versionId, { textOnlyColdReader: true });
  const version: WorkflowVersionDraft = {
    id: versionId, revision: capability.id,
    ...(capability.predecessorVersionId ? { predecessorId: capability.predecessorVersionId } : {}),
    changeReason: capability.changeReason, designBasis, config,
    entrypoints: { [capability.entrypoint]: { ...source, workflowId: capability.workflowId,
      codeRevision: source.codeRevision, storageContract: storageContract!,
      process, nodeDefinitions } },
  };
  const candidate: ExplanatoryMethodCandidate = {
    candidateId: versionId, workflowId: capability.workflowId, entrypoint: capability.entrypoint,
    designRevisionId: design.id, designPayloadHash: design.payloadHash,
    understandingRevisionId: understanding.id, understandingPayloadHash: understanding.payloadHash,
    capabilityRevisionId: capability.id, capabilityPayloadHash: capability.payloadHash,
    provider, version, schemas, presentation: buildContentPresentation(refs),
    availability: { state: 'unavailable', reason: unavailableReason },
  };
  const verify = () => {
    deployment.verify();
    if (providerFingerprint(declaration.version) !== fingerprint)
      throw new Error('Explanatory method provider source changed; restart with matching code');
  };
  const trustedDeployment: ContentDeployment = Object.freeze({ ...deployment, verify,
    candidate: () => { verify(); return { version: structuredClone(version), entrypoint: 'content' as const,
      refs: declaration.refs, presentation: structuredClone(candidate.presentation) }; },
    frozenDefinition: async () => {
      verify();
      const entry = version.entrypoints.content!;
      const registry = new SchemaRegistry();
      registerCreationSchemas(registry);
      const storageContract = publishStorageContract(registry, entry.storageContract);
      const process = await publishProcessContract(entry.process!, storageContract);
      return { ...entry, storageContract, process };
    },
    parseInput: (...args: Parameters<ContentDeployment['parseInput']>) => {
      verify(); return deployment.parseInput(...args);
    },
    createRuntime: (...args: Parameters<ContentDeployment['createRuntime']>) => {
      verify(); return deployment.createRuntime(...args);
    },
    workflow: (...args: Parameters<ContentDeployment['workflow']>) => {
      verify(); return deployment.workflow(...args);
    },
  });
  return { candidate: structuredClone(candidate), deployment: trustedDeployment };
}

export function buildExplanatoryMethodCandidate(capability: MethodCapabilityRevision,
  design: MethodDesignRevision, understanding: BusinessUnderstandingRevision): ExplanatoryMethodCandidate {
  return captureExplanatoryMethod(capability, design, understanding).candidate;
}
