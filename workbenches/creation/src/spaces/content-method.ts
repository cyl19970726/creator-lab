import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type AgentRunner } from '@signal-room/workflow';
import { SchemaRegistry, publishStorageContract } from '@signal-room/workflow-space-contracts';
import { publishProcessContract, type WorkflowVersion, type WorkflowVersionDraft, type WorkflowSpaceService } from '@signal-room/workflow-spaces';
import { CONTENT_REVISION, CONTENT_ROLES, contentInputSchema, createContentWorkflow, type ContentInput } from '../stages/content.js';
import { stageAgent, type StageModel } from '../stages/runtime.js';
import { creationStorageContracts, registerCreationSchemas, type CreationSchemaRefs } from './contracts.js';
import { buildContentProcess } from './process.js';
import { buildContentPresentation } from './presentation.js';
import type { contentSiwcExecutorManifest } from './content-runner.js';
import { createCreationSpaceRuntime } from './runtime.js';

const sha = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const methodFiles = ['../stages/content.ts', '../stages/runtime.ts', './contracts.ts', './runtime.ts',
  './content-runner.ts', './content-workbench.ts', './content-method.ts', './process.ts'];
const methodSnapshot = () => Object.fromEntries(methodFiles.map(file => [file,
  sha(readFileSync(fileURLToPath(new URL(file, import.meta.url))))]));
const loadedSnapshot = methodSnapshot();
const dependencyPackages = ['core', 'spaces', 'space-contracts', 'postgres', 'agent-sdk'];
const runtimeFiles: Record<string, ReadonlySet<string>> = {
  spaces: new Set(['blob-store.js', 'errors.js', 'execution-tasks.js', 'executor-registry.js',
    'node-tools.js', 'presentation.js', 'process-contract.js', 'process-projection.js',
    'relation.js', 'runtime.js', 'service.js', 'types.js']),
  'agent-sdk': new Set(['src/auth.js', 'src/responses.js']),
};
function runtimeDependencyIdentity() {
  const packages = Object.fromEntries(dependencyPackages.map(name => {
    const dir = fileURLToPath(new URL(`../../../../vendor/agent-workflow/packages/${name}/dist/`, import.meta.url));
    const visit = (path: string, prefix = ''): Array<[string, string]> => readdirSync(path, { withFileTypes: true })
      .flatMap(item => item.isDirectory() ? visit(`${path}/${item.name}`, `${prefix}${item.name}/`)
        : item.name.endsWith('.js') ? [[`${prefix}${item.name}`, sha(readFileSync(`${path}/${item.name}`))] as [string, string]] : []);
    const files = visit(dir).filter(([path]) => !runtimeFiles[name] || runtimeFiles[name].has(path))
      .sort(([a], [b]) => a.localeCompare(b));
    if (!files.length) throw new Error(`CONTENT runtime dependency ${name} has no built JavaScript`);
    return [name, files];
  }));
  return { nodeVersion: process.version, packages };
}
const loadedDependencies = runtimeDependencyIdentity();

export const contentEntrypoint = 'content';
export const contentWorkflowId = 'creation.content';
export const canonicalContentDefinition = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

export interface ContentDeploymentProfile {
  models: { worker: StageModel; judge: StageModel };
  runner: AgentRunner;
  /** Complete author instruction; omitted preserves the original role. */
  authorPrompt?: string;
  executorManifest?: ReturnType<typeof contentSiwcExecutorManifest>;
}

/** A trusted, deployed factory. Older source revisions require their own retained module. */
export interface ContentDeployment {
  readonly runner: AgentRunner;
  readonly models: Readonly<{ worker: StageModel; judge: StageModel }>;
  verify(): void;
  candidate(): { version: WorkflowVersionDraft; entrypoint: 'content'; refs: CreationSchemaRefs;
    presentation: ReturnType<typeof buildContentPresentation> };
  frozenDefinition(): Promise<WorkflowVersion['entrypoints'][string]>;
  parseInput(value: unknown): ContentInput;
  createRuntime(service: WorkflowSpaceService, spaceId: string,
    binding: { workflowVersionId: string; entrypoint: string; inputManifestId: string }): ReturnType<typeof createCreationSpaceRuntime>;
  workflow(input: ContentInput): ReturnType<typeof createContentWorkflow>;
}

export function createContentDeployment(profile: ContentDeploymentProfile): ContentDeployment {
  if (profile.authorPrompt !== undefined && !profile.authorPrompt.trim())
    throw new Error('CONTENT author prompt must be nonempty');
  const roles = structuredClone(CONTENT_ROLES);
  if (profile.authorPrompt !== undefined) roles.author.prompt = profile.authorPrompt;
  // These exact captured roles supply both declaration and execution. No caller owns them.
  const freeze = (value: object): void => {
    Object.values(value).forEach(item => { if (item && typeof item === 'object') freeze(item); });
    Object.freeze(value);
  };
  freeze(roles);
  const models = structuredClone(profile.models);
  Object.freeze(models.worker); Object.freeze(models.judge); Object.freeze(models);
  const executorManifest = profile.executorManifest ? structuredClone(profile.executorManifest) : undefined;
  if (executorManifest) { Object.freeze(executorManifest.tools); Object.freeze(executorManifest); }
  const runner = profile.runner;

  function verify() {
    if (canonicalContentDefinition(methodSnapshot()) !== canonicalContentDefinition(loadedSnapshot))
      throw new Error('CONTENT deployed method files changed; restart the host with matching code');
    if (canonicalContentDefinition(runtimeDependencyIdentity()) !== canonicalContentDefinition(loadedDependencies))
      throw new Error('CONTENT runtime dependencies changed; restart the host with matching build');
  }

  function candidate() {
    verify();
    const refs = registerCreationSchemas(new SchemaRegistry());
    const roleModels = { researcher: models.worker, author: models.judge, reader: models.worker,
      checker: models.worker, editor: models.judge };
    const roleNodeIds: Record<string, string> = { reader: 'coldReader', checker: 'factChecker' };
    const roleNodes = Object.fromEntries(Object.entries(roles).map(([name, role]) => {
      const model = roleModels[name as keyof typeof roleModels];
      const agent = stageAgent({ ...role, webSearch: false }, model, CONTENT_REVISION);
      const live = name === 'researcher' ? stageAgent({ ...role, webSearch: true }, model, CONTENT_REVISION) : undefined;
      return [roleNodeIds[name] ?? name, {
        purpose: role.guards, instructions: String(agent.config?.prompt), model: agent.model,
        tools: executorManifest?.tools ?? [],
        ...(executorManifest?.adapter === 'SIWC Responses'
          ? { executor: { family: 'agent-sdk' as const, adapter: 'SIWC Responses' } } : {}),
        configuration: { stageDeclaration: { reasoningEffort: agent.reasoningEffort,
          permissionsRevision: agent.permissionsRevision, outputSchema: agent.config?.outputSchema,
          threadOptions: agent.config?.threadOptions, timeoutMs: agent.config?.timeoutMs },
          ...(executorManifest ? { executor: executorManifest } : {}),
          ...(live ? { webSearchMode: 'run-input-dependent', whenWebResearchTrue: {
            permissionsRevision: live.permissionsRevision, threadOptions: live.config?.threadOptions } } : {}) },
      }];
    }));
    Object.assign(roleNodes, {
      route: { purpose: 'Persist the editor route and stop or rework decision', tools: [],
        executor: { family: 'decision' as const }, configuration: { maxRevisions: 'run input' } },
      creatorDraftGate: { purpose: 'Wait for creator review and explicit acceptance', tools: [],
        executor: { family: 'human' as const } },
      stop: { purpose: 'End automatic work with the recorded reason', tools: [],
        executor: { family: 'program' as const } },
    });
    const config = { adapterRevision: 'content-space-process-v3', codeRevision: CONTENT_REVISION,
      models: structuredClone(models), methodSnapshot: structuredClone(loadedSnapshot),
      runtimeDependencies: structuredClone(loadedDependencies), nodeDefinitions: structuredClone(roleNodes) };
    const versionId = `creation-content-${sha(config).slice(0, 32)}`;
    const [storageContract] = creationStorageContracts(refs, versionId);
    const version: WorkflowVersionDraft = { id: versionId, revision: CONTENT_REVISION, changeReason: '', config,
      entrypoints: { content: { workflowId: contentWorkflowId, codeRevision: CONTENT_REVISION,
        storageContract: storageContract!, process: buildContentProcess(refs), nodeDefinitions: structuredClone(roleNodes) } } };
    return { version: structuredClone(version), entrypoint: contentEntrypoint as 'content', refs,
      presentation: structuredClone(buildContentPresentation(refs)) };
  }

  async function frozenDefinition(): Promise<WorkflowVersion['entrypoints'][string]> {
    const entry = candidate().version.entrypoints.content!;
    const registry = new SchemaRegistry(); registerCreationSchemas(registry);
    const storageContract = publishStorageContract(registry, entry.storageContract);
    const process = await publishProcessContract(entry.process!, storageContract);
    return { ...entry, storageContract, process };
  }

  return Object.freeze({ runner, models, verify, candidate, frozenDefinition,
    parseInput: (value: unknown) => contentInputSchema.parse(value),
    createRuntime: (service: WorkflowSpaceService, spaceId: string,
      binding: { workflowVersionId: string; entrypoint: string; inputManifestId: string }) =>
      createCreationSpaceRuntime(service, spaceId, binding, runner, candidate().refs),
    workflow: (input: ContentInput) => createContentWorkflow(models, roles) });
}
