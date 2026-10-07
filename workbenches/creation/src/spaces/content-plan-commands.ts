import {createHash,randomUUID} from 'node:crypto';
import {WorkflowExecutorRegistry} from '@signal-room/workflow-spaces';
import type {WorkflowSpaceService,ValidationPlan,ValidationEntrySummary,ExecutionTask} from '@signal-room/workflow-spaces';
import type {EntryActionsDto,PlanCommandReceiptDto} from '@signal-room/workflow-space-api/contracts';
import type {createContentWorkbench} from './content-workbench.js';
import type {StageModel} from '../stages/runtime.js';

type Workbench=Pick<ReturnType<typeof createContentWorkbench>,'validation'|'methodAvailability'|'dispatchRun'|'runStatus'>;
type Service=Pick<WorkflowSpaceService,'validationSummary'|'readManifest'|'executionTasks'>;
type EntryInput={spaceId:string;planId:string;entryId:string;attempt:number};
export interface ContentExecutionRelease {
 revision:1;spaceId:string;principalId:string;planId:string;planHash:string;expiresAt:string;
 models:{worker:StageModel;judge:StageModel};
 exclusive:{confirmedAt:string;disabledPorts:number[]};
 entries:Array<{entryId:string;attempt:number;versionId:string;inputManifestId:string;inputManifestHash:string}>;
}
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value;
export const contentExecutionPlanHash=(plan:ValidationPlan)=>createHash('sha256').update(JSON.stringify(canonical(plan))).digest('hex');
class CommandFailure extends Error {
 constructor(readonly status:number,readonly code:string,message:string){super(message);}
}
function fail(status:number,code:string,message:string):never {throw new CommandFailure(status,code,message);}

/** The browser supplies selections only. This host-bound adapter owns identity, release and execution. */
export function createContentPlanCommands(options:{service:Service;workbench:Workbench;spaceId:string;principalId:string;
 models:{worker:StageModel;judge:StageModel};loadRelease:()=>Promise<ContentExecutionRelease|null>;
 verifyExclusive:(release:ContentExecutionRelease)=>Promise<boolean>;now?:()=>number}) {
 const now=options.now??Date.now;
 // One local command authority; idempotency remains authoritative in the existing PG enqueue/link services.
 let previous:Promise<unknown>=Promise.resolve();
 const serialized=<T>(action:()=>Promise<T>):Promise<T>=>{const result=previous.then(action,action);previous=result.catch(()=>undefined);return result;};
 async function selected(input:EntryInput){
  if(input.spaceId!==options.spaceId)fail(403,'FORBIDDEN','当前宿主不能操作这个 Space。');
  if(!Number.isInteger(input.attempt)||input.attempt<1)fail(400,'INVALID_REQUEST','尝试编号无效。');
  const summary=await options.service.validationSummary(input.spaceId,input.planId);
  if(summary.plan.status!=='frozen')fail(409,'CONFLICT','计划尚未冻结。');
  const entry=summary.entries.find(item=>item.entry.id===input.entryId);
  if(!entry)fail(409,'CONFLICT','条目不属于这个冻结计划。');
  if(entry.entry.excludedReason)fail(409,'CONFLICT','这个条目已排除。');
  const manifest=await options.service.readManifest(input.spaceId,entry.entry.inputManifestId);
  if(manifest.spaceId!==input.spaceId||manifest.caseId!==entry.entry.caseId)fail(409,'CONFLICT','冻结材料与条目不相符。');
  return {summary,entry,manifest};
 }
 async function released(input:EntryInput,binding:Awaited<ReturnType<typeof selected>>){
  const release=await options.loadRelease();
  if(!release||release.revision!==1||release.spaceId!==input.spaceId||release.principalId!==options.principalId||
   release.planId!==input.planId||release.planHash!==contentExecutionPlanHash(binding.summary.plan)||
   !Number.isFinite(Date.parse(release.expiresAt))||Date.parse(release.expiresAt)<=now())
   fail(403,'EXECUTION_DISABLED','运行前核验尚未完成或已失效。');
  if(JSON.stringify(canonical(release.models))!==JSON.stringify(canonical(options.models)))
   fail(403,'EXECUTION_DISABLED','当前模型配置与运行前核验不相符。');
  const allowed=release.entries.find(item=>item.entryId===input.entryId&&item.attempt===input.attempt);
  if(!allowed||allowed.versionId!==binding.entry.entry.workflowVersionId||allowed.inputManifestId!==binding.manifest.id||
   allowed.inputManifestHash!==binding.manifest.hash)fail(403,'EXECUTION_DISABLED','这个计划条目尚未通过运行前核验。');
  if(!release.exclusive||!Number.isFinite(Date.parse(release.exclusive.confirmedAt))||
   !(await options.verifyExclusive(release)))fail(403,'EXECUTION_DISABLED','执行宿主的独占条件尚未确认。');
  const availability=await options.workbench.methodAvailability(input.spaceId,binding.entry.entry.workflowVersionId,binding.entry.entry.entrypoint);
  if(!availability.available)fail(409,'UNAVAILABLE','准确的方法版本在当前宿主不可执行。');
 }
 async function baselineReady(input:EntryInput,binding:Awaited<ReturnType<typeof selected>>){
  if(binding.entry.entry.side!=='candidate')return;
  const baseline=binding.summary.entries.find(item=>item.entry.side==='baseline'&&item.entry.caseId===binding.entry.entry.caseId&&item.entry.repeat===binding.entry.entry.repeat);
  const attempt=baseline?.attempts.at(-1);
  if(!baseline||!attempt||attempt.task?.status!=='completed')fail(409,'BASELINE_REQUIRED','先完成同一配对的基线运行；失败的基线不能启动候选。');
  const status=await options.workbench.runStatus(input.spaceId,attempt.runId);
  if(status.run.state!=='needs_review'||!status.draftVersionId||status.binding.workflowVersionId!==baseline.entry.workflowVersionId||
   status.binding.caseId!==baseline.entry.caseId||status.binding.inputManifestId!==baseline.entry.inputManifestId)
   fail(409,'BASELINE_REQUIRED','基线还没有准确且可审阅的最终稿件。');
 }
 const existing=(entry:ValidationEntrySummary,attempt:number)=>entry.attempts.find(item=>item.attempt===attempt);
 async function exactTask(input:EntryInput,binding:Awaited<ReturnType<typeof selected>>,runId:string){
  const linked=existing(binding.entry,input.attempt);
  if(!linked||linked.runId!==runId)fail(409,'CONFLICT','运行与计划条目及尝试不相符。');
  const tasks=await options.service.executionTasks(input.spaceId);
  const task=tasks.find(item=>item.runId===runId);
  if(!task||task.spaceId!==input.spaceId||task.caseId!==binding.entry.entry.caseId||
   task.workflowVersionId!==binding.entry.entry.workflowVersionId||task.entrypoint!==binding.entry.entry.entrypoint||
   task.inputManifestId!==binding.manifest.id||task.executorKey!==WorkflowExecutorRegistry.key(binding.entry.entry.workflowVersionId,binding.entry.entry.entrypoint))fail(409,'CONFLICT','排队任务与冻结运行身份不相符。');
  return {task,tasks};
 }
 function idle(tasks:ExecutionTask[],runId?:string){
  if(tasks.some(item=>item.runId!==runId&&['running','cancel_requested','interrupted'].includes(item.status)))
   fail(409,'CONFLICT','Space 中仍有其他活动任务，请先核实执行状态。');
 }
 function receipt(input:EntryInput,binding:Awaited<ReturnType<typeof selected>>,task:ExecutionTask,dispatched=false,dispatchError:string|null=null):PlanCommandReceiptDto {
  return {requestId:randomUUID(),planId:input.planId,entryId:input.entryId,attempt:input.attempt,runId:task.runId,
   caseId:binding.entry.entry.caseId,versionId:binding.entry.entry.workflowVersionId,inputManifestId:binding.manifest.id,
   inputManifestHash:binding.manifest.hash,status:task.status,dispatched,dispatchError};
 }
 async function dispatch(input:EntryInput&{runId:string},binding:Awaited<ReturnType<typeof selected>>){
  const {task,tasks}=await exactTask(input,binding,input.runId);
  if(task.status!=='queued')return receipt(input,binding,task);
  await released(input,binding);await baselineReady(input,binding);idle(tasks,input.runId);
  try{
   await options.workbench.dispatchRun(input.spaceId,input.runId);
   const fresh=await options.service.executionTasks(input.spaceId);
   return receipt(input,binding,fresh.find(item=>item.runId===input.runId)??task,true);
  }catch{
   const fresh=await options.service.executionTasks(input.spaceId);
   return receipt(input,binding,fresh.find(item=>item.runId===input.runId)??task,false,'派发未完成；原排队回执已保留，请核实后恢复同一运行。');
  }
 }
 async function entryActions(input:EntryInput):Promise<EntryActionsDto>{
  try{
   const binding=await selected(input);await released(input,binding);await baselineReady(input,binding);
   const attempt=binding.entry.attempts.at(-1);
   const tasks=await options.service.executionTasks(input.spaceId);idle(tasks,attempt?.runId);
   if(attempt){
    if(attempt.attempt===input.attempt&&attempt.task?.status==='queued')return {start:false,resume:true,reason:null,resumeTarget:{attempt:attempt.attempt,runId:attempt.runId}};
    return {start:false,resume:false,reason:'此尝试已有运行记录；不会自动重试或增加尝试。',resumeTarget:null};
   }
   return {start:input.attempt===1,resume:false,reason:input.attempt===1?null:'新尝试需要单独核验。',resumeTarget:null};
  }catch(error){return {start:false,resume:false,reason:error instanceof CommandFailure?error.message:'运行条件暂时无法核验。',resumeTarget:null};}
 }
 const startPlanEntry=(input:EntryInput&{inputManifestId:string})=>serialized(async()=>{
  let binding=await selected(input);
  if(input.inputManifestId!==binding.manifest.id)fail(409,'CONFLICT','选择的材料与计划冻结材料不相符。');
  await released(input,binding);await baselineReady(input,binding);
  const prior=existing(binding.entry,input.attempt);
  if(prior){const {task}=await exactTask(input,binding,prior.runId);return receipt(input,binding,task);}
  // Failed attempts are evidence. No new attempt is silently granted by this minimal UI command.
  if(binding.entry.attempts.length||input.attempt!==1)fail(409,'CONFLICT','此条目已有尝试；新的尝试必须重新核验。');
  idle(await options.service.executionTasks(input.spaceId));
  const started=await options.workbench.validation(input.spaceId).start(input.planId,input.entryId,input.attempt);
  binding=await selected(input);
  // If release/exclusivity changes after enqueue, retain the exact queued receipt without invoking a model.
  try{return await dispatch({...input,runId:started.runId},binding);}
  catch(error){const {task}=await exactTask(input,binding,started.runId);return receipt(input,binding,task,false,error instanceof CommandFailure?error.message:'运行条件已变化；原排队回执已保留。');}
 });
 const dispatchRun=(input:EntryInput&{runId:string})=>serialized(async()=>{
  const binding=await selected(input);await exactTask(input,binding,input.runId);await released(input,binding);await baselineReady(input,binding);
  return dispatch(input,binding);
 });
 return {entryActions,startPlanEntry,dispatchRun};
}
