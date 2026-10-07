import {describe,expect,it,vi} from 'vitest';
import {WorkflowExecutorRegistry,type ExecutionTask,type InputManifest,type ValidationEntrySummary,type ValidationPlan} from '@signal-room/workflow-spaces';
import {contentExecutionPlanHash,createContentPlanCommands,type ContentExecutionRelease} from '../src/spaces/content-plan-commands.js';

const models={worker:{model:'test-worker',reasoningEffort:'high' as const},judge:{model:'test-judge',reasoningEffort:'high' as const}};
const baseline={id:'baseline',side:'baseline' as const,caseId:'case',inputManifestId:'manifest',repeat:1,workflowVersionId:'baseline-v1',entrypoint:'main'};
const candidate={...baseline,id:'candidate',side:'candidate' as const,workflowVersionId:'candidate-v1'};
const makeEntry=(entry:typeof baseline|typeof candidate):ValidationEntrySummary=>({entry,status:'missing',requiredJudgeCoverage:[],attempts:[]});
const task=(runId:string,versionId:string,status:ExecutionTask['status']='queued'):ExecutionTask=>({spaceId:'space',runId,caseId:'case',
 workflowVersionId:versionId,entrypoint:'main',inputManifestId:'manifest',executorKey:WorkflowExecutorRegistry.key(versionId,'main'),status,
 createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'});

function fixture(){
 const plan:ValidationPlan={id:'plan',spaceId:'space',kind:'prospective',question:'Which?',hypothesis:'Candidate improves',
  baseline:{workflowVersionId:'baseline-v1',entrypoint:'main'},candidate:{workflowVersionId:'candidate-v1',entrypoint:'main'},
  cases:[{caseId:'case',inputManifestId:'manifest',repeats:1}],standard:{id:'standard',revision:'1',content:'Four questions'},
  judges:[],expectedVariables:[],exclusionRules:[],status:'frozen',createdAt:'2026-01-01T00:00:00Z',
  frozenAt:'2026-01-01T00:00:00Z',entries:[baseline,candidate]};
 const entries=[makeEntry(baseline),makeEntry(candidate)];
 const manifest:InputManifest={id:'manifest',spaceId:'space',caseId:'case',assets:{},hash:'manifest-hash'};
 const tasks:ExecutionTask[]=[];
 let release:ContentExecutionRelease|null={revision:1,spaceId:'space',principalId:'operator',planId:'plan',planHash:contentExecutionPlanHash(plan),
  expiresAt:'2026-12-31T00:00:00Z',models,exclusive:{confirmedAt:'2026-10-07T00:00:00Z',disabledPorts:[4398]},
  entries:[baseline,candidate].map(entry=>({entryId:entry.id,attempt:1,versionId:entry.workflowVersionId,inputManifestId:'manifest',inputManifestHash:manifest.hash}))};
 let exclusive=true;
 let nextRun='target-run';
 const start=vi.fn(async(_planId:string,entryId:string,attempt:number)=>{
  const entry=entries.find(item=>item.entry.id===entryId)!;
  entry.attempts.push({attempt,runId:nextRun,status:'queued',task:{status:'queued'},reviews:[],judgeEvidence:[]});
  tasks.push(task(nextRun,entry.entry.workflowVersionId));
  return {runId:nextRun};
 });
 const dispatch=vi.fn(async(_spaceId:string,runId:string)=>{tasks.find(item=>item.runId===runId)!.status='running';});
 const status=vi.fn(async()=>({run:{state:'needs_review',output:{details:{reason:'not-converged'}}},draftVersionId:'draft',
  binding:{workflowVersionId:'baseline-v1',caseId:'case',inputManifestId:'manifest'}}));
 const availability=vi.fn(async()=>({available:true}));
 const options:Parameters<typeof createContentPlanCommands>[0]={
  service:{validationSummary:async()=>({plan,entries}),readManifest:async()=>manifest,executionTasks:async()=>tasks} as unknown as Parameters<typeof createContentPlanCommands>[0]['service'],
  workbench:{validation:()=>({start}),dispatchRun:dispatch,runStatus:status,methodAvailability:availability} as unknown as Parameters<typeof createContentPlanCommands>[0]['workbench'],
  spaceId:'space',principalId:'operator',models,loadRelease:async()=>release,verifyExclusive:async()=>exclusive,
  now:()=>Date.parse('2026-10-07T12:00:00Z')};
 return {commands:createContentPlanCommands(options),plan,entries,manifest,tasks,start,dispatch,status,availability,
  setRelease:(value:ContentExecutionRelease|null)=>{release=value;},release:()=>release!,
  setExclusive:(value:boolean)=>{exclusive=value;},setNextRun:(value:string)=>{nextRun=value}};
}
const input=(entryId='baseline',attempt=1)=>({spaceId:'space',planId:'plan',entryId,attempt,inputManifestId:'manifest'});
const expectDenied=async(promise:Promise<unknown>,code:string)=>expect(promise).rejects.toMatchObject({code});

describe('CONTENT exact plan commands, controlled service fixture',()=>{
 it('requires a current matching host release and exact frozen binding before starting',async()=>{
  const f=fixture();
  f.setRelease(null);await expectDenied(f.commands.startPlanEntry(input()),'EXECUTION_DISABLED');
  f.setRelease({...f.release(),principalId:'other'});await expectDenied(f.commands.startPlanEntry(input()),'EXECUTION_DISABLED');
  f.setRelease({...f.release(),expiresAt:'2026-10-07T11:00:00Z'});await expectDenied(f.commands.startPlanEntry(input()),'EXECUTION_DISABLED');
  f.setRelease({...f.release(),planHash:'wrong'});await expectDenied(f.commands.startPlanEntry(input()),'EXECUTION_DISABLED');
  f.setRelease({...f.release(),entries:[{entryId:'baseline',attempt:1,versionId:'wrong',inputManifestId:'manifest',inputManifestHash:'manifest-hash'}]});
  await expectDenied(f.commands.startPlanEntry(input()),'EXECUTION_DISABLED');
  f.setRelease({...f.release(),entries:[{entryId:'baseline',attempt:1,versionId:'baseline-v1',inputManifestId:'manifest',inputManifestHash:'wrong'}]});
  await expectDenied(f.commands.startPlanEntry(input()),'EXECUTION_DISABLED');
  await expectDenied(f.commands.startPlanEntry({...input(),inputManifestId:'wrong'}),'CONFLICT');
  expect(f.start).not.toHaveBeenCalled();expect(f.dispatch).not.toHaveBeenCalled();
 });

 it('starts once, returns the same run on duplicate requests, and never dispatches a repeated running receipt',async()=>{
  const f=fixture();
  const [first,second]=await Promise.all([f.commands.startPlanEntry(input()),f.commands.startPlanEntry(input())]);
  expect(first.runId).toBe('target-run');expect(second.runId).toBe(first.runId);
  expect(first.versionId).toBe('baseline-v1');expect(first.inputManifestHash).toBe('manifest-hash');
  expect(f.start).toHaveBeenCalledTimes(1);expect(f.dispatch).toHaveBeenCalledTimes(1);
  const repeated=await f.commands.dispatchRun({...input(),runId:first.runId});
  expect(repeated.status).toBe('running');expect(f.dispatch).toHaveBeenCalledTimes(1);
  f.tasks[0]!.status='completed';
  expect((await f.commands.dispatchRun({...input(),runId:first.runId})).status).toBe('completed');
  expect(f.dispatch).toHaveBeenCalledTimes(1);
 });

 it('keeps a failed dispatch queued for exact resume and rejects a different run or attempt',async()=>{
  const f=fixture();f.dispatch.mockRejectedValueOnce(new Error('queue unavailable'));
  const queued=await f.commands.startPlanEntry(input());
  expect(queued).toMatchObject({runId:'target-run',status:'queued',dispatched:false});
  expect(queued.dispatchError).toBeTruthy();
  expect(await f.commands.entryActions(input())).toMatchObject({start:false,resume:true,resumeTarget:{runId:'target-run',attempt:1}});
  await expectDenied(f.commands.dispatchRun({...input(),runId:'other-run'}),'CONFLICT');
  await expectDenied(f.commands.dispatchRun({...input('baseline',2),runId:'target-run'}),'CONFLICT');
  f.tasks[0]!.executorKey='wrong-executor';
  await expectDenied(f.commands.dispatchRun({...input(),runId:'target-run'}),'CONFLICT');
  f.tasks[0]!.executorKey=WorkflowExecutorRegistry.key('baseline-v1','main');
  const resumed=await f.commands.dispatchRun({...input(),runId:'target-run'});
  expect(resumed).toMatchObject({runId:'target-run',status:'running',dispatched:true});
  expect(f.start).toHaveBeenCalledTimes(1);expect(f.dispatch).toHaveBeenCalledTimes(2);
 });

 it('blocks unconfirmed exclusivity and unrelated active work',async()=>{
  const f=fixture();f.setExclusive(false);
  await expectDenied(f.commands.startPlanEntry(input()),'EXECUTION_DISABLED');
  f.setExclusive(true);f.tasks.push(task('other-run','baseline-v1','running'));
  await expectDenied(f.commands.startPlanEntry(input()),'CONFLICT');
  expect(f.start).not.toHaveBeenCalled();
 });

 it('requires a completed, reviewable baseline before candidate and never opens attempt two automatically',async()=>{
  const f=fixture();
  await expectDenied(f.commands.startPlanEntry(input('candidate')),'BASELINE_REQUIRED');
  const baselineEntry=f.entries[0]!;
  baselineEntry.attempts.push({attempt:1,runId:'baseline-run',status:'failed',task:{status:'failed',error:'quota'},reviews:[],judgeEvidence:[]});
  f.tasks.push(task('baseline-run','baseline-v1','failed'));
  await expectDenied(f.commands.startPlanEntry(input('candidate')),'BASELINE_REQUIRED');
  await expectDenied(f.commands.startPlanEntry(input('baseline',2)),'EXECUTION_DISABLED');
  baselineEntry.attempts[0]!.task!.status='completed';f.tasks[0]!.status='completed';
  f.status.mockResolvedValueOnce({run:{state:'needs_review',output:{details:{reason:'not-converged'}}},draftVersionId:'',
   binding:{workflowVersionId:'baseline-v1',caseId:'case',inputManifestId:'manifest'}});
  await expectDenied(f.commands.startPlanEntry(input('candidate')),'BASELINE_REQUIRED');
  const candidateReceipt=await f.commands.startPlanEntry(input('candidate'));
  expect(candidateReceipt).toMatchObject({entryId:'candidate',runId:'target-run',status:'running'});
  expect(f.start).toHaveBeenCalledTimes(1);
 });
});
