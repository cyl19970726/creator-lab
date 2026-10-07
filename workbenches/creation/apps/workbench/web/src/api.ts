import type { Actor, CaseDetail, CaseInput, Comparison, ComparisonInput, ControlRun, CreationCase, Decision, DecisionInput, Review, ReviewInput, Revision, RunRequest } from '../../../../src/workbench/contracts.js';

export interface Session { authenticated: boolean; actor?: Actor; authRequired: boolean }
export interface WorkflowSummary { workflowId: string; title: string; revision: string; deployedRevisionId: string | null }
export interface Capabilities { productionAvailable: boolean; productionReason: string | null; placeholderVoice: boolean }
export interface WorkflowList { workflows: WorkflowSummary[]; revisions: Revision[]; capabilities: Capabilities }
export interface CaseResponse extends CaseDetail { capabilities?: Capabilities }
export interface Execution { run: ControlRun; nativeRun: unknown; steps: unknown[]; events: unknown[]; hasMoreEvents:boolean; incidents: unknown[]; traces: Array<{stepId:string;attemptId:string;files:Array<{name:string;bytes:number}>}> }
type WithoutCommand<T> = T extends {commandId:string} ? Omit<T,'commandId'> : never;

const base = '/api/workbench';
const pendingCommands = new Map<string,string>();
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, { method, credentials: 'same-origin', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await response.text();
  let data: unknown;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) {
    const message = data && typeof data === 'object' && 'error' in data ? String((data as {error:unknown}).error) : (typeof data === 'string' ? data : `请求失败（${response.status}）`);
    throw new Error(message);
  }
  return data as T;
}
const id = (value: string) => encodeURIComponent(value);
async function write<T>(path:string,body:object):Promise<T>{
  const key=`${path}:${JSON.stringify(body)}`;
  const commandId=pendingCommands.get(key)||crypto.randomUUID();
  pendingCommands.set(key,commandId);
  const result=await request<T>(path,'POST',{commandId,...body});
  pendingCommands.delete(key);
  return result;
}
export const api = {
  session: () => request<Session>('/session'),
  login: (token: string) => request<Session>('/session','POST',{token}),
  logout: () => request<void>('/session','DELETE'),
  workflows: () => request<WorkflowList>('/workflows'),
  cases: () => request<CreationCase[]>('/cases'),
  createCase: (input: CaseInput) => write<CreationCase>('/cases',input),
  case: (caseId: string) => request<CaseResponse>(`/cases/${id(caseId)}`),
  startRun: (caseId: string, input: Omit<RunRequest,'commandId'>) => write<ControlRun>(`/cases/${id(caseId)}/runs`,input),
  review: (caseId: string, input: Omit<ReviewInput,'commandId'>) => write<Review>(`/cases/${id(caseId)}/reviews`,input),
  comparison: (caseId: string, input: Omit<ComparisonInput,'commandId'>) => write<Comparison>(`/cases/${id(caseId)}/comparisons`,input),
  decision: (caseId: string, input: WithoutCommand<DecisionInput>) => write<Decision>(`/cases/${id(caseId)}/decisions`,input),
  execution: (runId: string,afterSeq=0) => request<Execution>(`/runs/${id(runId)}/execution?afterSeq=${afterSeq}`),
  trace: (runId:string,stepId:string,attemptId:string,file:string) => request<{content:string;truncated:boolean}>(`/runs/${id(runId)}/traces/${id(stepId)}/${id(attemptId)}/${id(file)}`),
  cancel: (runId:string) => write<ControlRun>(`/runs/${id(runId)}/cancel`,{}),
  resume: (runId:string) => write<ControlRun>(`/runs/${id(runId)}/resume`,{}),
  media: (artifactId:string,index:number) => `${base}/artifacts/${id(artifactId)}/media?index=${index}`,
};
