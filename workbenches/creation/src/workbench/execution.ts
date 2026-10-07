import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync } from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { CodexSdkRunner } from '@signal-room/workflow-codex';
import { runWorkflow, type AgentRunner, type AgentRunRequest } from '@signal-room/workflow';
import { createContentWorkflow, contentInputSchema } from '../stages/content.js';
import { b3InputSchema, createB3Workflow } from '../stages/b3.js';
import { acquireWorkerLock } from '../infrastructure/process-lock.js';
import { RecoveryRunStore } from '../infrastructure/recovery-run-store.js';
import type { ControlRun, RunState } from './contracts.js';
import { currentWorkflowCodeSnapshot, currentWorkflowRevision } from './registry.js';
import { WorkbenchStore, workbenchSha256 } from './store.js';

export const traceRootForRun = (store: Pick<WorkbenchStore, 'stateRoot'>): string => path.join(store.stateRoot, 'traces');
const brief = (error: unknown) => error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
// Imported workflow functions are fixed for this process. A later file edit must never be run under its new revision ID.
const loadedDefinitionHashes = {
  'creation.content': workbenchSha256(currentWorkflowCodeSnapshot('creation.content')),
  'creation.b3': workbenchSha256(currentWorkflowCodeSnapshot('creation.b3')),
};
export function assertLoadedDefinitionMatches(recordedCode: unknown, liveCode: unknown, loadedHash: string): void {
  if (workbenchSha256(recordedCode) !== loadedHash) throw new Error('Worker loaded workflow definition differs from the queued revision; restart the worker');
  if (workbenchSha256(liveCode) !== loadedHash) throw new Error('Workflow source changed after worker startup; restart the worker');
}

function configuredHome(value: string | undefined): string {
  if (!value || !path.isAbsolute(value)) throw new Error('CREATION_WORKBENCH_CODEX_HOME must be an explicit absolute directory');
  if (!existsSync(value) || !lstatSync(value).isDirectory()) throw new Error('Configured isolated CODEX_HOME does not exist');
  const real = realpathSync(value);
  const personalHome = path.join(os.homedir(), '.codex');
  if (existsSync(personalHome) && real === realpathSync(personalHome)) throw new Error('Workbench CODEX_HOME must be isolated from the operator’s personal Codex home');
  return real;
}
function runnerFor(store: WorkbenchStore, run: ControlRun, home?: string, binary?: string): AgentRunner {
  const dedicatedHome = configuredHome(home ?? process.env.CREATION_WORKBENCH_CODEX_HOME);
  const resolvedBinary = binary ?? process.env.CREATION_CODEX_BIN;
  if (resolvedBinary && (!path.isAbsolute(resolvedBinary) || !existsSync(resolvedBinary))) throw new Error('Configured Codex binary is missing or not absolute');
  const names = ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'OPENAI_API_KEY'];
  const env = Object.fromEntries(names.flatMap(name => process.env[name] ? [[name, process.env[name]!]] : []));
  env.HOME = dedicatedHome; env.CODEX_HOME = dedicatedHome;
  const native = new CodexSdkRunner(undefined, traceRootForRun(store), { codexOptions: {
    ...(resolvedBinary ? { codexPathOverride: resolvedBinary } : {}),
    config: { project_doc_max_bytes: 0 }, env,
  } });
  const runRoot = path.join(store.stateRoot, 'runs', run.id);
  const roleDir = path.join(store.stateRoot, 'role-workspaces', run.id);
  return {
    run<Input, Output>(request: AgentRunRequest<Input>) {
      const role = request.definition.id;
      const isolated = role === 'content-cold-reader' ? path.join(roleDir, 'cold-reader') : role === 'content-fact-checker' ? path.join(roleDir, 'fact-checker') : runRoot;
      mkdirSync(isolated, { recursive: true, mode: 0o700 });
      const config = request.definition.config ?? {};
      const currentThread = (config.threadOptions ?? {}) as Record<string, unknown>;
      const outputDirectory = run.workflowId === 'creation.b3' && role === 'b3-designer' ? (run.input as { episodeDir: string }).episodeDir : isolated;
      const definition = { ...request.definition, config: { ...config, outputDirectory, threadOptions: { ...currentThread, skipGitRepoCheck: true },
        ...(run.workflowId === 'creation.content' ? { codexConfig: { ...(config.codexConfig as object ?? {}), features: { shell_tool: false }, apps: { _default: { enabled: false } } } } : {}) } };
      return native.run<Input, Output>({ ...request, definition });
    },
  };
}
function requireCurrent(store: WorkbenchStore, run: ControlRun): void {
  const revision = store.getRevision(run.revisionId);
  const current = currentWorkflowRevision(run.workflowId);
  assertLoadedDefinitionMatches(revision.code, current.code, loadedDefinitionHashes[run.workflowId]);
  if (workbenchSha256(revision.standards) !== workbenchSha256(current.standards) ||
      workbenchSha256(revision.deployment) !== workbenchSha256(current.deployment)) {
    throw new Error('Workflow source, standards or deployment changed; create a new candidate run');
  }
  const storedConfig = revision.config as Record<string, unknown>;
  const currentConfig = current.config as Record<string, unknown>;
  for (const key of Object.keys(currentConfig)) if (workbenchSha256(storedConfig[key]) !== workbenchSha256(currentConfig[key])) {
    throw new Error(`Workflow runtime configuration changed (${key}); create a new candidate run`);
  }
  const inputFile = path.join(store.stateRoot, 'runs', run.id, 'input.json');
  if (!existsSync(inputFile) || workbenchSha256(JSON.parse(readFileSync(inputFile, 'utf8'))) !== run.inputHash) {
    throw new Error('Frozen run input is missing or changed');
  }
  if (run.workflowId === 'creation.b3') {
    const sidecar = path.join(store.stateRoot, 'runs', run.id, 'frozen-sources.json');
    if (!existsSync(sidecar)) throw new Error('B3 frozen source evidence is missing');
    const frozen = JSON.parse(readFileSync(sidecar, 'utf8')) as Record<string, unknown>;
    if (!run.preparedHash || workbenchSha256(frozen) !== run.preparedHash) throw new Error('B3 frozen source evidence changed');
    if (frozen.briefSha256 !== workbenchSha256((run.input as { brief: unknown }).brief)) throw new Error('B3 accepted brief changed');
    for (const key of ['template', 'reference'] as const) {
      const snapshot = frozen[key] as { files?: Record<string, string> } | undefined;
      const input = run.input as { templateDir: string; referenceDir: string };
      const root = key === 'template' ? input.templateDir : input.referenceDir;
      if (!snapshot?.files || !root.startsWith(path.join(store.stateRoot, 'runs', run.id, 'inputs'))) throw new Error('B3 frozen source manifest is missing');
      const original = key === 'template' ? currentConfig.templateRoot : currentConfig.referenceRoot;
      if (typeof original !== 'string' || workbenchSha256(treeHashes(original)) !== workbenchSha256(snapshot.files)) throw new Error(`B3 configured ${key} source changed`);
      for (const [relative, hash] of Object.entries(snapshot.files)) {
        const file = path.join(root, relative);
        if (!existsSync(file)) throw new Error('B3 source snapshot is missing');
        const actual = awaitHash(file);
        if (actual !== hash) throw new Error(`B3 source snapshot changed: ${relative}`);
      }
    }
  }
}
const awaitHash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
function treeHashes(source: string): Record<string, string> {
  const files: Record<string, string> = {};
  const ignored = new Set(['.git', 'node_modules', '.local', 'dist', 'exports', 'snapshots', '.hf']);
  const visit = (dir: string, prefix = '') => {
    for (const name of readdirSync(dir).sort()) {
      if (ignored.has(name)) continue;
      const relative = prefix ? `${prefix}/${name}` : name;
      const full = path.join(dir, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`B3 source contains a symlink: ${relative}`);
      if (stat.isDirectory()) visit(full, relative);
      else if (stat.isFile()) files[relative] = awaitHash(full);
    }
  };
  visit(source);
  return files;
}
export interface WorkbenchWorkerOptions { agentRunner?: AgentRunner; codexHome?: string; codexBinary?: string; pollMs?: number }
export class WorkbenchWorker {
  private lock?: { release(): Promise<void> };
  private active?: { id: string; controller: AbortController };
  private stopping = false;
  constructor(readonly store: WorkbenchStore, readonly options: WorkbenchWorkerOptions = {}) {}
  async start(): Promise<void> {
    if (this.lock) return;
    this.lock = await acquireWorkerLock(this.store.stateRoot);
    this.store.interruptOrphanedRuns();
  }
  private async reconcile(native: RecoveryRunStore, control: ControlRun): Promise<void> {
    if (!control.nativeRunId) return;
    for (const ref of await native.listArtifacts(control.nativeRunId)) {
      this.store.saveArtifact(control.id, ref, await native.getArtifactPayload(ref.id));
    }
  }
  async runNext(): Promise<ControlRun | undefined> {
    if (!this.lock) throw new Error('Worker lock is not held');
    if (this.stopping || this.active) return undefined;
    const control = this.store.claimNext();
    if (!control) return undefined;
    const controller = new AbortController();
    this.active = { id: control.id, controller };
    const cancelMonitor = setInterval(() => {
      if (this.store.getRun(control.id).cancelRequested) controller.abort('cancel requested');
    }, this.options.pollMs ?? 500);
    const originalCwd = process.cwd();
    const runRoot = path.join(this.store.stateRoot, 'runs', control.id);
    try {
      requireCurrent(this.store, control);
      const expectedRuntime = this.store.getRevision(control.revisionId).config as { codexHome?: string | null; codexBinary?: string | null; codexExecutable?: { issue?: string | null } };
      if (!this.options.agentRunner && expectedRuntime.codexExecutable?.issue) throw new Error(`Codex executable unavailable: ${expectedRuntime.codexExecutable.issue}`);
      if (this.options.codexHome && path.resolve(this.options.codexHome) !== expectedRuntime.codexHome) throw new Error('Worker CODEX_HOME differs from frozen runtime configuration');
      if (this.options.codexBinary && path.resolve(this.options.codexBinary) !== expectedRuntime.codexBinary) throw new Error('Worker Codex binary differs from frozen runtime configuration');
      mkdirSync(runRoot, { recursive: true, mode: 0o700 });
      process.chdir(runRoot);
      const native = new RecoveryRunStore(this.store.database,
        id => { this.store.bindRun(control.id, id); },
        (ref, payload) => { this.store.saveArtifact(control.id, ref, payload); });
      await this.reconcile(native, control);
      const models = { worker: { model: control.config.model, reasoningEffort: control.config.workerEffort as 'low' | 'medium' | 'high' },
        judge: { model: control.config.model, reasoningEffort: control.config.judgeEffort as 'low' | 'medium' | 'high' } };
      const input = control.workflowId === 'creation.content' ? contentInputSchema.parse(control.input) : b3InputSchema.parse(control.input);
      const workflow = control.workflowId === 'creation.content' ? createContentWorkflow(models) : createB3Workflow(input as ReturnType<typeof b3InputSchema.parse>, models);
      const runner = this.options.agentRunner ?? runnerFor(this.store, control, this.options.codexHome, this.options.codexBinary);
      const result = await runWorkflow({ workflow: workflow as typeof workflow & { execute: never }, input: input as never,
        store: native, agentRunner: runner, signal: controller.signal,
        ...(control.nativeRunId ? { resumeRunId: control.nativeRunId } : {}),
        metadata: { controlRunId: control.id, caseId: control.caseId, revisionId: control.revisionId, revisionSha256: this.store.getRevision(control.revisionId).sha256,
          codexHome: (this.store.getRevision(control.revisionId).config as { codexHome?: string | null }).codexHome ?? null,
          codexBinary: (this.store.getRevision(control.revisionId).config as { codexBinary?: string | null }).codexBinary ?? null } });
      await this.reconcile(native, this.store.getRun(control.id));
      const nativeState: string = result.run.state;
      const state: RunState = nativeState === 'waiting' ? 'interrupted' : nativeState as RunState;
      return this.store.finishRun(control.id, state, result.run.output ?? result.output ?? null);
    } catch (error) {
      const interrupted = controller.signal.aborted && this.stopping;
      const canceled = controller.signal.aborted && !this.stopping && this.store.getRun(control.id).cancelRequested;
      this.store.saveIncident(control.id, brief(error));
      return this.store.finishRun(control.id, interrupted ? 'interrupted' : canceled ? 'canceled' : 'failed', null, brief(error));
    } finally {
      clearInterval(cancelMonitor);
      process.chdir(originalCwd);
      this.active = undefined;
    }
  }
  async runLoop(): Promise<void> {
    await this.start();
    while (!this.stopping) {
      if (!this.active) await this.runNext();
      if (this.stopping) break;
      await new Promise(resolve => setTimeout(resolve, this.options.pollMs ?? 500));
    }
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.active?.controller.abort('worker stopping');
    while (this.active) await new Promise(resolve => setTimeout(resolve, 50));
    if (this.lock) { await this.lock.release(); this.lock = undefined; }
  }
}
