import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { b3InputSchema, B3_REVISION, readB3Standards } from '../stages/b3.js';
import { contentInputSchema, CONTENT_REVISION, readContentStandards } from '../stages/content.js';
import type { PieceBrief } from '../stages/brief.js';
import type { ControlRun, CreationCase, PreparedRun, RevisionInput, RunRequest, StoredArtifact, WorkflowId } from './contracts.js';
import { workbenchSha256 } from './store.js';

const creationRoot = fileURLToPath(new URL('../../', import.meta.url));
const repoRoot = path.resolve(creationRoot, '../..');
const definitionFiles: Record<WorkflowId, string[]> = {
  'creation.content': ['src/stages/content.ts', 'src/stages/runtime.ts', 'src/stages/brief.ts', 'src/workbench/registry.ts', 'src/workbench/execution.ts', 'src/workbench/acceptance.ts', 'src/stages/standards/content.md'],
  'creation.b3': ['src/stages/b3.ts', 'src/stages/runtime.ts', 'src/stages/brief.ts', 'src/stages/video-artifacts.ts', 'src/workbench/registry.ts', 'src/workbench/execution.ts', 'src/workbench/acceptance.ts', 'src/stages/standards/b3.md', 'tooling/render-episode.sh'],
};
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fileRecord = (absolute: string) => { const bytes = readFileSync(absolute); return { sha256: sha(bytes), bytes: bytes.byteLength, content: bytes.toString('utf8') }; };
function packageVersion(file: string): string { const data = JSON.parse(readFileSync(file, 'utf8')) as { version?: string }; return data.version ?? 'unversioned'; }
/** Hash bytes on every call; stat-based caches could miss a same-path replacement before a run resumes. */
export function fileFingerprint(file: string): { sha256: string; bytes: number } {
  const handle = openSync(file, 'r');
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  try {
    for (;;) {
      const count = readSync(handle, buffer, 0, buffer.byteLength, null);
      if (!count) break;
      digest.update(buffer.subarray(0, count));
      bytes += count;
    }
  } finally { closeSync(handle); }
  return { sha256: digest.digest('hex'), bytes };
}
const platformTargets: Record<string, { triple: string; package: string }> = {
  'darwin:arm64': { triple: 'aarch64-apple-darwin', package: '@openai/codex-darwin-arm64' },
  'darwin:x64': { triple: 'x86_64-apple-darwin', package: '@openai/codex-darwin-x64' },
  'linux:arm64': { triple: 'aarch64-unknown-linux-musl', package: '@openai/codex-linux-arm64' },
  'linux:x64': { triple: 'x86_64-unknown-linux-musl', package: '@openai/codex-linux-x64' },
  'win32:arm64': { triple: 'aarch64-pc-windows-msvc', package: '@openai/codex-win32-arm64' },
  'win32:x64': { triple: 'x86_64-pc-windows-msvc', package: '@openai/codex-win32-x64' },
};
/** Matches the installed SDK's default Codex executable selection without launching it. */
export function resolveWorkbenchCodexExecutable(): { source: 'configured' | 'sdk-bundled'; path: string | null; realPath: string | null; sha256: string | null; bytes: number | null; issue: string | null } {
  const configured = process.env.CREATION_CODEX_BIN?.trim();
  let executable: string;
  let source: 'configured' | 'sdk-bundled';
  if (configured) {
    source = 'configured';
    executable = path.resolve(configured);
  } else {
    source = 'sdk-bundled';
    const target = platformTargets[`${process.platform}:${process.arch}`];
    if (!target) return { source, path: null, realPath: null, sha256: null, bytes: null, issue: `Unsupported Codex SDK target: ${process.platform}/${process.arch}` };
    try {
      const sdkEntry = typeof import.meta.resolve === 'function'
        ? fileURLToPath(import.meta.resolve('@openai/codex-sdk'))
        : path.join(creationRoot, 'node_modules/@openai/codex-sdk/dist/index.js');
      if (!existsSync(sdkEntry)) throw new Error('Installed Codex SDK entrypoint is missing');
      const sdkRequire = createRequire(realpathSync(sdkEntry));
      const codexPackage = sdkRequire.resolve('@openai/codex/package.json');
      const codexRequire = createRequire(codexPackage);
      const platformPackage = codexRequire.resolve(`${target.package}/package.json`);
      const vendor = path.join(path.dirname(platformPackage), 'vendor', target.triple);
      const binary = process.platform === 'win32' ? 'codex.exe' : 'codex';
      const current = path.join(vendor, 'bin', binary);
      const legacy = path.join(vendor, 'codex', binary);
      executable = existsSync(current) && existsSync(path.join(vendor, 'codex-package.json')) ? current : legacy;
    } catch (error) {
      return { source, path: null, realPath: null, sha256: null, bytes: null, issue: `Installed Codex SDK executable could not be resolved: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  if (!existsSync(executable) || !statSync(executable).isFile()) return { source, path: executable, realPath: null, sha256: null, bytes: null, issue: 'Codex executable is unavailable' };
  const hash = fileFingerprint(executable);
  return { source, path: executable, realPath: realpathSync(executable), ...hash, issue: null };
}

export function currentWorkflowCodeSnapshot(workflowId: WorkflowId) {
  return {
    workflowRevision: workflowId === 'creation.content' ? CONTENT_REVISION : B3_REVISION,
    files: Object.fromEntries(definitionFiles[workflowId].map(relative => [relative, fileRecord(path.join(creationRoot, relative))])),
    dependencyLock: { path: 'pnpm-lock.yaml', ...fileFingerprint(path.join(repoRoot, 'pnpm-lock.yaml')) },
    sharedFiles: Object.fromEntries(['packages/core/src/runtime.ts', 'packages/core/src/contracts.ts', 'packages/core/src/ports.ts', 'packages/codex/src/runner.ts', 'packages/sqlite/sqlite-run-store.ts'].map(relative => [relative, fileRecord(path.join(repoRoot, 'vendor/agent-workflow', relative))])),
    packages: {
      creation: packageVersion(path.join(creationRoot, 'package.json')),
      workflow: packageVersion(path.join(repoRoot, 'vendor/agent-workflow/packages/core/package.json')),
      codexAdapter: packageVersion(path.join(repoRoot, 'vendor/agent-workflow/packages/codex/package.json')),
      sqliteAdapter: packageVersion(path.join(repoRoot, 'vendor/agent-workflow/packages/sqlite/package.json')),
    },
  };
}
function runtimeConfig() {
  const home = process.env.CREATION_WORKBENCH_CODEX_HOME;
  const binary = process.env.CREATION_CODEX_BIN;
  return { codexHome: home ? path.resolve(home) : null, codexBinary: binary ? path.resolve(binary) : null,
    codexExecutable: resolveWorkbenchCodexExecutable(),
    projectDocMaxBytes: 0, agentWorkingDirectory: 'run-scoped', traceLayout: 'stateRoot/traces/nativeRunId/stepId/attemptId', platform: process.platform,
    templateRoot: process.env.CREATION_B3_TEMPLATE_DIR ? path.resolve(process.env.CREATION_B3_TEMPLATE_DIR) : null,
    referenceRoot: process.env.CREATION_B3_REFERENCE_DIR ? path.resolve(process.env.CREATION_B3_REFERENCE_DIR) : null };
}
export function currentWorkflowRevision(workflowId: WorkflowId): RevisionInput {
  const standards = workflowId === 'creation.content' ? readContentStandards() : readB3Standards();
  return { workflowId, code: currentWorkflowCodeSnapshot(workflowId), config: runtimeConfig(), standards: { text: standards, sha256: sha(standards) },
    deployment: { platform: process.platform, node: process.version } };
}
export function listWorkflowDefinitions() {
  return (['creation.content', 'creation.b3'] as const).map(workflowId => ({ workflowId,
    title: workflowId === 'creation.content' ? '内容形成' : '视频制作',
    revision: workflowId === 'creation.content' ? CONTENT_REVISION : B3_REVISION,
    configured: workflowId === 'creation.content' || Boolean(process.env.CREATION_B3_TEMPLATE_DIR && process.env.CREATION_B3_REFERENCE_DIR),
    capabilities: workflowId === 'creation.b3' ? { placeholderVoice: process.platform === 'darwin', minimaxVoice: Boolean(process.env.MINIMAX_API_KEY) } : undefined,
  }));
}
function copyTree(source: string, destination: string): { sha256: string; files: Record<string, string> } {
  if (!path.isAbsolute(source) || !existsSync(source) || !lstatSync(source).isDirectory()) throw new Error(`Configured B3 source directory missing: ${source}`);
  const files: Record<string, string> = {};
  const ignored = new Set(['.git', 'node_modules', '.local', 'dist', 'exports', 'snapshots', '.hf']);
  const visit = (dir: string, prefix = '') => {
    for (const name of readdirSync(dir).sort()) {
      if (ignored.has(name)) continue;
      const rel = prefix ? `${prefix}/${name}` : name;
      const full = path.join(dir, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`B3 source contains a symlink: ${rel}`);
      if (stat.isDirectory()) visit(full, rel);
      else if (stat.isFile()) files[rel] = sha(readFileSync(full));
    }
  };
  visit(source);
  if (!Object.keys(files).length) throw new Error(`Configured B3 source is empty: ${source}`);
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const relative of Object.keys(files)) {
    const target = path.join(destination, relative);
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    cpSync(path.join(source, relative), target);
  }
  return { sha256: sha(JSON.stringify(files)), files };
}
function acceptedBrief(store: { getAcceptedBrief?: (caseId: string) => PieceBrief | undefined }, caseId: string): PieceBrief {
  if (!store.getAcceptedBrief) throw new Error('B3 requires a store with accepted-brief lookup');
  const brief = store.getAcceptedBrief(caseId);
  if (!brief) throw new Error('B3 requires an accepted content brief');
  return brief;
}
export function prepareRun(store: { stateRoot: string; getAcceptedBrief?: (caseId: string) => PieceBrief | undefined; getRun?: (id: string) => ControlRun; listArtifacts?: (runId: string) => StoredArtifact[] },
  caseRecord: CreationCase, request: RunRequest, runId: string): PreparedRun {
  const revision = currentWorkflowRevision(request.workflowId);
  const runRoot = path.join(store.stateRoot, 'runs', runId);
  mkdirSync(runRoot, { recursive: true, mode: 0o700 });
  if (request.workflowId === 'creation.content') {
    const { title: _title, ...caseInput } = caseRecord.input;
    let prior: { draft: unknown; humanReview: { reviewer: string; notes: string[] } } | undefined;
    if (request.feedback?.trim()) {
      if (!request.baselineRunId || !store.getRun || !store.listArtifacts) throw new Error('Content feedback requires an exact baseline run');
      const baseline = store.getRun(request.baselineRunId);
      if (baseline.caseId !== caseRecord.id || baseline.workflowId !== 'creation.content') throw new Error('Feedback baseline must be a content run in this case');
      const drafts = store.listArtifacts(baseline.id).filter(a => a.nativeRef.type === 'content-draft');
      const finalId = (baseline.terminal as { details?: { draft?: { id?: string } } } | null)?.details?.draft?.id;
      const selected = (finalId ? drafts.find(a => a.id === finalId) : undefined) ?? drafts.at(-1);
      if (!selected) throw new Error('Feedback baseline has no content draft');
      const payload = selected.payload as { decision?: unknown; script?: unknown };
      if (!payload.decision || !payload.script) throw new Error('Feedback baseline draft is incomplete');
      prior = { draft: { decision: payload.decision, script: payload.script }, humanReview: { reviewer: 'creator', notes: [request.feedback.trim()] } };
    }
    const input = contentInputSchema.parse({ ...caseInput, topicId: caseRecord.id,
      standards: readContentStandards(), maxRevisions: request.maxRevisions, ...(prior ? { prior } : {}) });
    writeFileSync(path.join(runRoot, 'input.json'), `${JSON.stringify(input, null, 2)}\n`, { mode: 0o600 });
    return { input, revision };
  }
  const production = request.production;
  if (!production) throw new Error('B3 production options are required');
  if (production.scope !== 'sample' && production.scope !== 'full') throw new Error('B3 scope must be sample or full');
  const voice = production.voice ?? 'placeholder';
  if (voice !== 'placeholder' && voice !== 'minimax') throw new Error('B3 voice must be placeholder or minimax');
  if (voice === 'placeholder' && process.platform !== 'darwin') throw new Error('B3 placeholder voice uses macOS say and cannot run on Linux; configure a supported TTS voice');
  if (voice === 'minimax' && !process.env.MINIMAX_API_KEY) throw new Error('B3 minimax voice requires server-side MINIMAX_API_KEY');
  const templateSource = process.env.CREATION_B3_TEMPLATE_DIR;
  const referenceSource = process.env.CREATION_B3_REFERENCE_DIR;
  if (!templateSource || !referenceSource) throw new Error('B3 template and reference directories must be configured on the server');
  const brief = acceptedBrief(store, caseRecord.id);
  if (brief.topicId !== caseRecord.id || !brief.script) throw new Error('Accepted brief does not match this case or lacks a script');
  const inputRoot = path.join(runRoot, 'inputs');
  const templateDir = path.join(inputRoot, 'template');
  const referenceDir = path.join(inputRoot, 'reference');
  const template = copyTree(path.resolve(templateSource), templateDir);
  const reference = copyTree(path.resolve(referenceSource), referenceDir);
  const episodeDir = path.join(runRoot, 'episode');
  const generator = path.join(templateDir, 'scripts/new-episode.sh');
  if (!existsSync(generator)) throw new Error('Configured B3 template has no scripts/new-episode.sh');
  execFileSync('bash', [generator, path.basename(episodeDir), path.dirname(episodeDir)], { cwd: runRoot, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  if (!existsSync(episodeDir) || !lstatSync(episodeDir).isDirectory()) throw new Error('B3 template did not create an episode directory');
  const input = b3InputSchema.parse({ topicId: caseRecord.id, brief, episodeDir, templateDir, referenceDir,
    scope: production.scope, sampleSegments: production.sampleSegments ?? 3, voice, standards: readB3Standards(),
    maxRevisions: request.maxRevisions });
  writeFileSync(path.join(runRoot, 'input.json'), `${JSON.stringify(input, null, 2)}\n`, { mode: 0o600 });
  const evidence = { template, reference, briefSha256: workbenchSha256(brief) };
  writeFileSync(path.join(runRoot, 'frozen-sources.json'), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return { input, revision, deployment: evidence };
}

export function workbenchCapabilities(): { productionAvailable: boolean; productionReason: string | null; placeholderVoice: boolean } {
  const template = process.env.CREATION_B3_TEMPLATE_DIR;
  const reference = process.env.CREATION_B3_REFERENCE_DIR;
  const reason = !template || !reference ? 'B3 template and reference directories are not configured' :
    !existsSync(template) || !existsSync(reference) ? 'Configured B3 template or reference directory is missing' :
    !existsSync(path.join(template, 'scripts/new-episode.sh')) || !existsSync(path.join(reference, 'frames-spec')) ? 'Configured B3 template or reference files are incomplete' :
    process.platform !== 'darwin' && !process.env.MINIMAX_API_KEY ? 'Linux production needs a configured supported TTS voice' : null;
  return { productionAvailable: reason === null, productionReason: reason, placeholderVoice: process.platform === 'darwin' };
}
