import Fastify, { type FastifyRequest } from 'fastify';
import { createReadStream, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z, ZodError } from 'zod';
import { SQLiteWorkflowRunStore } from '@signal-room/workflow-sqlite';
import { WorkbenchStore, workbenchSha256 } from '../../src/workbench/store.js';
import type { RunRequest, WorkflowId } from '../../src/workbench/contracts.js';
import { currentWorkflowRevision, listWorkflowDefinitions, prepareRun, workbenchCapabilities } from '../../src/workbench/registry.js';
import { mediaFilesForArtifact, validateArtifactAcceptance } from '../../src/workbench/acceptance.js';
import { actorOf, HttpError, installAuth, issueReviewAssignment, requireUser, reviewAssignmentOf, type AuthOptions } from './auth.js';

const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const text = (max = 6000) => z.string().trim().min(1).max(max);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const command = z.object({ commandId: id }).strict();
const material = z.object({ id, title: text(200), text: text(40000) }).strict();
const createCase = z.object({ commandId: id, title: text(200), opportunity: text(), readerGoal: text(), requiredQuestions: z.array(text(2000)).min(1).max(30),
  account: z.object({ name: text(200), positioning: text(), currentAudience: text(), referencePieces: z.array(z.object({ title: text(200), result: text(), lesson: text() }).strict()).max(20) }).strict(),
  form: text(1000), materials: z.array(material).min(1).max(30), webResearch: z.boolean(), maxSeconds: z.number().int().positive().max(3600).optional(),
}).strict().refine(value => new Set(value.materials.map(item => item.id)).size === value.materials.length, '材料标识不能重复');
const runRequest = z.object({ commandId: id, workflowId: z.enum(['creation.content', 'creation.b3']), model: text(100), workerEffort: z.enum(['low', 'medium', 'high']), judgeEffort: z.enum(['low', 'medium', 'high']), maxRevisions: z.number().int().min(0).max(5), hypothesis: text(), baselineRunId: id.optional(), feedback: text().optional(),
  production: z.object({ scope: z.enum(['sample', 'full']), sampleSegments: z.number().int().min(1).max(6).optional(), voice: z.enum(['placeholder', 'minimax']).optional() }).strict().optional(),
}).strict();
const review = z.object({ commandId: id, artifactId: id, sha256: hash, baselineArtifactId: id.optional(), baselineSha256: hash.optional(), standardVersion: text(200), good: text(), bad: text(), improvement: text(), unsatisfied: text(), verdict: z.enum(['pass', 'fail', 'uncertain']), visibleMaterials: z.array(text(300)).max(50).optional(), evaluator: z.object({ model: text(100), promptRevision: text(200), visibleMaterials: z.array(text(300)).max(50) }).strict().optional() }).strict();
const comparison = z.object({ commandId: id, baselineArtifactId: id, baselineSha256: hash, candidateArtifactId: id, candidateSha256: hash, baselineReviewId: id, candidateReviewId: id, conditions: z.record(z.string(), z.unknown()), differences: text(), conclusion: text() }).strict();
const decision = z.discriminatedUnion('kind', [
  z.object({ commandId: id, kind: z.literal('artifact'), action: z.enum(['adopt', 'reject', 'observe']), artifactId: id, sha256: hash, reviewId: id, reason: text() }).strict(),
  z.object({ commandId: id, kind: z.literal('workflow'), action: z.enum(['adopt', 'rollback', 'observe']), revisionId: id, comparisonId: id, reason: text() }).strict(),
]);
const param = (request: FastifyRequest, name: string) => id.parse((request.params as Record<string, unknown>)[name]);
const traceNames = new Set(['runtime.json', 'prompt.txt', 'input.json', 'skills.json', 'hashes.json', 'events.jsonl', 'last-message.txt', 'result.json', 'failure.json', 'output-files.json']);
function within(root: string, target: string): string {
  const base = realpathSync(root), resolved = realpathSync(target);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) throw new HttpError(403, '文件不在本次运行范围内');
  return resolved;
}
function redact(value: string): string {
  return value.replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, '$1[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|password|secret)\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[redacted]');
}

export function buildWorkbenchApp(options: { store: WorkbenchStore; auth: AuthOptions }) {
  const { store } = options;
  const secretValues = [options.auth.token, ...Object.entries(process.env)
    .filter(([key]) => /(?:TOKEN|KEY|PASSWORD|SECRET)$/.test(key)).map(([, value]) => value)]
    .filter((value): value is string => Boolean(value && value.length >= 12));
  const safeText = (value: string) => secretValues.reduce((result, secret) => result.split(secret).join('[redacted]'), redact(value));
  const diagnostics = <T>(value: T): T => {
    if (typeof value === 'string') return safeText(value) as T;
    if (Array.isArray(value)) return value.map(item => diagnostics(item)) as T;
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, diagnostics(item)])) as T;
    return value;
  };
  const safeRun = <T extends { error: string | null; terminal: unknown }>(run: T): T => ({ ...run, error: run.error === null ? null : safeText(run.error), terminal: diagnostics(run.terminal) });
  const app = Fastify({ bodyLimit: 1_500_000, logger: false });
  installAuth(app, options.auth);
  const ledger = new SQLiteWorkflowRunStore(store.database);
  const installed = listWorkflowDefinitions().map(item => ({ ...item, deployedRevisionId: store.registerRevision(currentWorkflowRevision(item.workflowId)).id }));
  const assertInstalled = (workflowId: WorkflowId) => {
    const deployed = installed.find(item => item.workflowId === workflowId)!;
    const current = currentWorkflowRevision(workflowId);
    const recorded = store.getRevision(deployed.deployedRevisionId);
    const { id: _id, sha256: _sha, createdAt: _created, ...snapshot } = recorded;
    if (workbenchSha256(current) !== workbenchSha256(snapshot)) throw new HttpError(409, '服务器上的流程代码或配置已改变，请重新启动服务后建立新候选。');
    return deployed.deployedRevisionId;
  };
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') });
    if (error instanceof Error && 'status' in error && typeof error.status === 'number' && error.status >= 400 && error.status < 500) return reply.code(error.status).send({ error: safeText(error.message) });
    if (error && typeof error === 'object' && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500) return reply.code(error.statusCode).send({ error: '请求格式不正确' });
    return reply.code(500).send({ error: '操作未完成；请检查服务器记录，勿重复启动运行。' });
  });
  const capabilities = () => workbenchCapabilities();
  const scopedAgentArtifact = (request: FastifyRequest, artifactId: string) => {
    const artifact = store.getArtifact(artifactId);
    if (actorOf(request).kind !== 'agent') return artifact;
    const scope = reviewAssignmentOf(request);
    const expectedHash = scope?.artifactId === artifactId ? scope.sha256 : scope?.baselineArtifactId === artifactId ? scope.baselineSha256 : undefined;
    if (!scope || artifact.caseId !== scope.caseId || artifact.sha256 !== expectedHash || !['content-draft', 'b3-video'].includes(artifact.nativeRef.type)) throw new HttpError(403, '该产物不在本次 Agent 评价授权范围内');
    return artifact;
  };
  app.post('/api/workbench/review-assignments', async request => {
    const actor = requireUser(request);
    const input = z.object({ artifactId: id, sha256: hash, baselineArtifactId: id.optional(), baselineSha256: hash.optional(), standardVersion: text(200), expiresInMinutes: z.number().int().min(1).max(480).default(60) }).strict().parse(request.body);
    const artifact = store.getArtifact(input.artifactId);
    if (artifact.sha256 !== input.sha256 || !['content-draft', 'b3-video'].includes(artifact.nativeRef.type)) throw new HttpError(409, '评价必须指定确切交付产物');
    if (Boolean(input.baselineArtifactId) !== Boolean(input.baselineSha256)) throw new HttpError(400, '基线标识和哈希须同时提供');
    if (input.baselineArtifactId) {
      const baseline = store.getArtifact(input.baselineArtifactId);
      if (baseline.caseId !== artifact.caseId || baseline.sha256 !== input.baselineSha256 || baseline.nativeRef.type !== artifact.nativeRef.type) throw new HttpError(409, '基线与候选范围不一致');
    }
    const { expiresInMinutes, ...target } = input;
    const assignment = { ...target, id: randomUUID(), caseId: artifact.caseId, expiresAt: Date.now() + expiresInMinutes * 60_000, issuedBy: actor.id };
    return { assignment, bearerToken: issueReviewAssignment(options.auth, assignment) };
  });
  app.get('/api/workbench/workflows', async () => ({ workflows: installed, revisions: store.listRevisions(), capabilities: capabilities() }));
  app.get('/api/workbench/cases', async () => store.listCases());
  app.post('/api/workbench/cases', async request => store.createCase(createCase.parse(request.body), requireUser(request)));
  app.get('/api/workbench/cases/:caseId', async request => {
    const detail = store.detail(param(request, 'caseId'));
    return { ...detail, runs: detail.runs.map(safeRun), incidents: diagnostics(detail.incidents), capabilities: capabilities() };
  });
  app.post('/api/workbench/cases/:caseId/runs', async request => {
    const actor = requireUser(request), caseId = param(request, 'caseId'), body = runRequest.parse(request.body);
    assertInstalled(body.workflowId);
    const item = store.detail(caseId).case;
    return store.createRun(caseId, body, actor, runId => {
      try { return prepareRun(store, item, body as RunRequest, runId); }
      catch (error) { if (error instanceof ZodError) throw error; throw new HttpError(409, safeText(error instanceof Error ? error.message : '运行条件尚未满足')); }
    });
  });
  app.post('/api/workbench/cases/:caseId/reviews', async request => {
    const actor = actorOf(request), body = review.parse(request.body), caseId = param(request, 'caseId');
    if (actor.kind === 'agent') {
      scopedAgentArtifact(request, body.artifactId);
      const scope = reviewAssignmentOf(request)!;
      if (caseId !== scope.caseId || body.artifactId !== scope.artifactId || body.sha256 !== scope.sha256 || body.standardVersion !== scope.standardVersion || body.baselineArtifactId !== scope.baselineArtifactId || body.baselineSha256 !== scope.baselineSha256) throw new HttpError(403, '评价对象、基线或标准与本次授权不一致');
      if (!body.evaluator) throw new HttpError(400, 'Agent 评价须记录模型、提示词版本与实际可见材料');
      const visible = [scope.artifactId, ...(scope.baselineArtifactId ? [scope.baselineArtifactId] : [])];
      if (body.evaluator.visibleMaterials.some(item => !visible.includes(item)) || body.visibleMaterials?.some(item => !visible.includes(item))) throw new HttpError(403, '评价材料超出本次授权范围');
      body.visibleMaterials = visible;
    }
    return store.saveReview(caseId, body, actor);
  });
  app.post('/api/workbench/cases/:caseId/comparisons', async request => {
    const actor = requireUser(request), body = comparison.parse(request.body);
    const baseline = store.getRun(store.getArtifact(body.baselineArtifactId).runId);
    const candidate = store.getRun(store.getArtifact(body.candidateArtifactId).runId);
    return store.saveComparison(param(request, 'caseId'), { ...body, conditions: { reported: body.conditions,
      observed: { baseline: { inputHash: baseline.inputHash, revisionId: baseline.revisionId, config: baseline.config }, candidate: { inputHash: candidate.inputHash, revisionId: candidate.revisionId, config: candidate.config },
        sameInput: baseline.inputHash === candidate.inputHash, sameRevision: baseline.revisionId === candidate.revisionId,
        attribution: '多个条件改变时属于方案比较；模型输出不保证逐字复现。' } } }, actor);
  });
  app.post('/api/workbench/cases/:caseId/decisions', async request => {
    const actor = requireUser(request), caseId = param(request, 'caseId'), body = decision.parse(request.body);
    // The gate runs inside the command transaction, after replay detection. A
    // retried adoption must return its original receipt without rebuilding a brief.
    if (body.kind === 'workflow') return store.decide(caseId, body, actor, () => {
      if (body.action !== 'observe') {
        const detail = store.detail(caseId), compared = detail.comparisons.find(item => item.id === body.comparisonId);
        if (!compared) throw new HttpError(409, '缺少本案例的比较依据');
        const artifactId = body.action === 'rollback' ? compared.baselineArtifactId : compared.candidateArtifactId;
        const reviewId = body.action === 'rollback' ? compared.baselineReviewId : compared.candidateReviewId;
        const judged = detail.reviews.find(item => item.id === reviewId);
        if (judged?.actor.kind !== 'user' || judged.verdict !== 'pass') throw new HttpError(409, '保留或回退流程需要对相应产物的人工通过评价');
        try { validateArtifactAcceptance(store, store.getArtifact(artifactId), actor.id); }
        catch (error) { throw new HttpError(409, safeText(error instanceof Error ? error.message : '流程产物未达到采用条件')); }
      }
      return { kind: 'workflow', actorId: actor.id, revisionId: body.revisionId, comparisonId: body.comparisonId };
    });
    if (body.action !== 'adopt') return store.decide(caseId, body, actor);
    return store.decide(caseId, body, actor, () => {
      const artifact = store.getArtifact(body.artifactId);
      if (artifact.caseId !== caseId || artifact.sha256 !== body.sha256) throw new HttpError(409, '采用对象与当前产物不一致');
      const exactReview = store.detail(caseId).reviews.find(item => item.id === body.reviewId && item.artifactId === artifact.id && item.sha256 === artifact.sha256);
      let gate;
      try { gate = validateArtifactAcceptance(store, artifact, actor.id, [`创作者采用说明：${body.reason}`, ...(exactReview ? [`创作者仍不满意（仅在制作职责内处理，稿件问题反馈上游）：${exactReview.unsatisfied}`] : [])]); }
      catch (error) { throw new HttpError(409, safeText(error instanceof Error ? error.message : '产物未达到采用条件')); }
      return { ...gate, kind: 'artifact', actorId: actor.id, artifactId: artifact.id, sha256: artifact.sha256, reviewId: body.reviewId };
    });
  });
  app.post('/api/workbench/runs/:runId/cancel', async request => store.cancelRun(param(request, 'runId'), command.parse(request.body), requireUser(request)));
  app.post('/api/workbench/runs/:runId/resume', async request => {
    const actor = requireUser(request), run = store.getRun(param(request, 'runId'));
    const currentId = assertInstalled(run.workflowId);
    if (currentId !== run.revisionId) throw new HttpError(409, '当前流程定义已改变，请建立新候选；不能用新代码恢复旧运行。');
    return store.resumeRun(run.id, command.parse(request.body), actor);
  });
  app.get('/api/workbench/artifacts/:artifactId', async request => {
    return scopedAgentArtifact(request, param(request, 'artifactId'));
  });
  app.get('/api/workbench/artifacts/:artifactId/media', async (request, reply) => {
    const artifact = scopedAgentArtifact(request, param(request, 'artifactId'));
    const query = z.object({ index: z.coerce.number().int().min(0).default(0) }).strict().parse(request.query);
    const files = await mediaFilesForArtifact(store, artifact);
    const file = files[query.index];
    if (!file) throw new HttpError(404, '未找到已核验的媒体');
    reply.header('Content-Type', file.mimeType).header('Content-Disposition', 'inline');
    return reply.send(createReadStream(file.path));
  });
  app.get('/api/workbench/runs/:runId/execution', async request => {
    requireUser(request);
    const run = store.getRun(param(request, 'runId'));
    const query = z.object({ afterSeq: z.coerce.number().int().min(0).default(0) }).strict().parse(request.query);
    const nativeRun = run.nativeRunId ? await ledger.getRun(run.nativeRunId) : null;
    const steps = nativeRun ? await ledger.listSteps(nativeRun.id) : [];
    const events = nativeRun ? (await ledger.listEvents(nativeRun.id, query.afterSeq)).slice(0, 500) : [];
    const traces: Array<{ stepId: string; attemptId: string; files: Array<{ name: string; bytes: number }> }> = [];
    const detailedSteps = await Promise.all(steps.map(async step => {
      const attempts = await ledger.listAttempts(step.id);
      for (const attempt of attempts) {
        const dir = path.join(store.stateRoot, 'traces', run.nativeRunId!, step.id, attempt.id);
        if (existsSync(dir)) {
          const safeDir = within(path.join(store.stateRoot, 'traces'), dir);
          traces.push({ stepId: step.id, attemptId: attempt.id, files: readdirSync(safeDir).filter(name => traceNames.has(name)).map(name => ({ name, bytes: statSync(within(safeDir, path.join(safeDir, name))).size })) });
        }
      }
      return { ...step, attempts };
    }));
    return { run: safeRun(run), nativeRun: diagnostics(nativeRun), steps: diagnostics(detailedSteps), events: diagnostics(events), traces, incidents: diagnostics(store.detail(run.caseId).incidents?.filter(item => item.runId === run.id) ?? []), hasMoreEvents: events.length === 500 };
  });
  app.get('/api/workbench/runs/:runId/traces/:stepId/:attemptId/:file', async request => {
    requireUser(request);
    const run = store.getRun(param(request, 'runId')), stepId = param(request, 'stepId'), attemptId = param(request, 'attemptId');
    const file = String((request.params as Record<string, unknown>).file);
    if (!run.nativeRunId || !traceNames.has(file)) throw new HttpError(404, '记录不存在');
    const step = (await ledger.listSteps(run.nativeRunId)).find(value => value.id === stepId);
    if (!step || !(await ledger.listAttempts(step.id)).some(value => value.id === attemptId)) throw new HttpError(404, '记录不属于本次运行');
    const target = path.join(store.stateRoot, 'traces', run.nativeRunId, stepId, attemptId, file);
    if (!existsSync(target)) throw new HttpError(404, '此记录尚未保存');
    const contents = readFileSync(within(path.join(store.stateRoot, 'traces'), target));
    return { content: safeText(contents.subarray(0, 1_000_000).toString('utf8')), truncated: contents.length > 1_000_000, bytes: contents.length };
  });
  return app;
}
