import type { Decision, ExecutionView, Job, Work, WorkDetail, Workspace } from '../../../src/contracts/index.js';

type Json = Record<string, unknown>;

async function request<T>(path: string, options: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      signal,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('无法连接创作服务。请确认 API 已启动。');
  }
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(data?.error || `请求失败（${response.status}）`);
  }
  return await response.json() as T;
}

const scope = (workspaceId: string) => `?workspaceId=${encodeURIComponent(workspaceId)}`;
const post = <T>(path: string, body: Json): Promise<T> => request<T>(path, { method: 'POST', body: JSON.stringify({ commandId: crypto.randomUUID(), ...body }) });

export const api = {
  workspaces: (signal?: AbortSignal) => request<Workspace[]>('/workspaces', {}, signal),
  createWorkspace: (name: string, positioning: string) => post<Workspace>('/workspaces', { name, positioning }),
  works: (workspaceId: string, signal?: AbortSignal) => request<Work[]>(`/workspaces/${encodeURIComponent(workspaceId)}/works`, {}, signal),
  createWork: (workspaceId: string, body: Json) => post<Work>(`/workspaces/${encodeURIComponent(workspaceId)}/works`, { workspaceId, ...body }),
  detail: (workspaceId: string, workId: string, signal?: AbortSignal) => request<WorkDetail>(`/works/${encodeURIComponent(workId)}${scope(workspaceId)}`, {}, signal),
  start: (workspaceId: string, workId: string, body: Json) => post<Job>(`/works/${encodeURIComponent(workId)}/start${scope(workspaceId)}`, body),
  revise: (workspaceId: string, workId: string, body: Json) => post<Job>(`/works/${encodeURIComponent(workId)}/revise${scope(workspaceId)}`, body),
  decide: (workspaceId: string, workId: string, body: Json) => post<Decision>(`/works/${encodeURIComponent(workId)}/decisions${scope(workspaceId)}`, body),
  cancel: (workspaceId: string, jobId: string) => post<Job>(`/jobs/${encodeURIComponent(jobId)}/cancel${scope(workspaceId)}`, {}),
  resume: (workspaceId: string, jobId: string) => post<Job>(`/jobs/${encodeURIComponent(jobId)}/resume${scope(workspaceId)}`, {}),
  execution: (workspaceId: string, jobId: string, signal?: AbortSignal) => request<ExecutionView>(`/jobs/${encodeURIComponent(jobId)}/execution${scope(workspaceId)}`, {}, signal),
};
