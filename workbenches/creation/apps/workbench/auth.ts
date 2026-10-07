import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Actor } from '../../src/workbench/contracts.js';

export interface AuthOptions { token: string; publicOrigin: string; devOrigin?: string; actorId?: string }
export interface ReviewAssignment { id: string; caseId: string; artifactId: string; sha256: string; baselineArtifactId?: string; baselineSha256?: string; standardVersion: string; expiresAt: number; issuedBy: string }
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
const cookieName = 'creation_workbench';
const actors = new WeakMap<FastifyRequest, Actor>();
const assignments = new WeakMap<FastifyRequest, ReviewAssignment>();
const equal = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
export function actorOf(request: FastifyRequest): Actor {
  const actor = actors.get(request);
  if (!actor) throw new HttpError(401, '请先登录工作台');
  return actor;
}
export function requireUser(request: FastifyRequest): Actor {
  const actor = actorOf(request);
  if (actor.kind !== 'user') throw new HttpError(403, '此操作需要创作者身份；Agent 评价不会自动采用或执行');
  return actor;
}
export const reviewAssignmentOf = (request: FastifyRequest) => assignments.get(request);
export function issueReviewAssignment(options: AuthOptions, assignment: ReviewAssignment): string {
  const payload = Buffer.from(JSON.stringify(assignment)).toString('base64url');
  const signature = createHmac('sha256', options.token).update(`review:${payload}`).digest('base64url');
  return `review.${payload}.${signature}`;
}

export function installAuth(app: FastifyInstance, options: AuthOptions): void {
  if (options.token.length < 24 || /change.?me|replace.?me|example/i.test(options.token)) throw new Error('WORKBENCH_ACCESS_TOKEN must be a unique secret of at least 24 characters');
  const origin = new URL(options.publicOrigin).origin;
  const secure = origin.startsWith('https:');
  const origins = new Set([origin, ...(options.devOrigin ? [new URL(options.devOrigin).origin] : [])]);
  const hosts = new Set([...origins].map(value => new URL(value).host));
  const owner: Actor = { kind: 'user', id: options.actorId ?? 'creator' };
  const sign = (payload: string) => createHmac('sha256', options.token).update(payload).digest('base64url');
  const issue = () => {
    const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 8 * 60 * 60 * 1000, nonce: randomBytes(16).toString('hex') })).toString('base64url');
    return `${payload}.${sign(payload)}`;
  };
  const valid = (cookie: string) => {
    const [payload, signature, extra] = cookie.split('.');
    if (!payload || !signature || extra || !equal(sign(payload), signature)) return false;
    try { const data = JSON.parse(Buffer.from(payload, 'base64url').toString()); return typeof data.exp === 'number' && data.exp > Date.now(); } catch { return false; }
  };
  const cookie = (value: string, age = 28800) => `${cookieName}=${value}; Path=/api/workbench; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const failures = new Map<string, { count: number; until: number }>();
  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff').header('Referrer-Policy', 'same-origin');
    if (!hosts.has(request.headers.host ?? '')) throw new HttpError(403, '请求地址与配置的工作台地址不一致');
    if (request.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, '不接受跨站请求');
    if (request.headers.origin && !origins.has(request.headers.origin)) throw new HttpError(403, '请求来源不被允许');
    if (!request.url.startsWith('/api/workbench')) return;
    reply.header('Cache-Control', 'no-store');
    const bearer = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const encodedCookie = (request.headers.cookie ?? '').split(';').map(item => item.trim()).find(item => item.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    let actor: Actor | undefined;
    if (bearer && equal(bearer, options.token)) actor = owner;
    else if (bearer?.startsWith('review.')) {
      const [prefix, payload, signature, extra] = bearer.split('.');
      if (prefix && payload && signature && !extra && equal(createHmac('sha256', options.token).update(`review:${payload}`).digest('base64url'), signature)) {
        try {
          const scope = JSON.parse(Buffer.from(payload, 'base64url').toString()) as ReviewAssignment;
          if (typeof scope.expiresAt === 'number' && scope.expiresAt > Date.now() && typeof scope.id === 'string' && typeof scope.artifactId === 'string' && typeof scope.caseId === 'string') {
            actor = { kind: 'agent', id: `agent-a:${scope.id}` }; assignments.set(request, scope);
          }
        } catch { /* Invalid credential stays unauthenticated. */ }
      }
    }
    else if (encodedCookie && valid(encodedCookie)) actor = owner;
    if (actor) actors.set(request, actor);
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (mutation && !bearer && !request.headers.origin) throw new HttpError(403, '浏览器写入需要同源校验');
    if (request.url.split('?')[0] === '/api/workbench/session') return;
    if (!actor) throw new HttpError(401, '请先登录工作台');
    if (actor.kind === 'agent') {
      const target = request.url.split('?')[0]!;
      const allowed = request.method === 'GET' && /^\/api\/workbench\/artifacts\/[\w-]+(?:\/media)?$/.test(target)
        || request.method === 'POST' && /^\/api\/workbench\/cases\/[\w-]+\/reviews$/.test(target);
      if (!allowed) throw new HttpError(403, 'Agent 凭证仅允许读取指定交付产物并提交评价');
    }
  });
  app.get('/api/workbench/session', async request => ({ authenticated: actors.has(request), actor: actors.get(request), authRequired: true }));
  app.post('/api/workbench/session', async (request, reply) => {
    const key = request.socket.remoteAddress ?? 'unknown';
    const entry = failures.get(key);
    if (entry && entry.until > Date.now() && entry.count >= 10) throw new HttpError(429, '尝试次数较多，请稍后再试');
    const body = request.body as { token?: unknown } | null;
    if (!body || typeof body.token !== 'string' || !equal(body.token, options.token)) {
      failures.set(key, { count: entry && entry.until > Date.now() ? entry.count + 1 : 1, until: Date.now() + 60_000 });
      if (failures.size > 1000) for (const [peer, value] of failures) if (value.until < Date.now()) failures.delete(peer);
      throw new HttpError(401, '访问口令不正确');
    }
    failures.delete(key);
    reply.header('Set-Cookie', cookie(issue()));
    return { authenticated: true, actor: owner, authRequired: true };
  });
  app.delete('/api/workbench/session', async (_request, reply) => {
    reply.header('Set-Cookie', cookie('', 0));
    return { authenticated: false, authRequired: true };
  });
}
