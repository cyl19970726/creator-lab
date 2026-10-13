import {describe,expect,it} from 'vitest';
import {MemoryRunStore,runWorkflow,type AgentRunRequest,type AgentRunResult,type AgentRunner} from '@signal-room/workflow';
import {CONTENT_ROLES,type ContentInput} from '../src/stages/content.js';
import {createExplanatoryResearchTrial} from '../src/spaces/explanatory-method-execution.js';
import {createExplanatoryMethodExecution} from '../src/spaces/explanatory-method-execution.js';
import type {ExplanatoryMethodCapture} from '../src/spaces/explanatory-method-provider.js';
import {EXECUTION_BUDGET_SCHEMA_REF,executionBudgetAssetId,type WorkflowSpaceService,type WorkflowVersion,type InputManifest,type SpaceRun,type ExecutionTask} from '@signal-room/workflow-spaces';
import type {AssetVersion} from '@signal-room/workflow-spaces';

const input:ContentInput={topicId:'case',opportunity:'Explain costs',readerGoal:'Understand why cost rises',requiredQuestions:['Why?'],
  account:{name:'Account',positioning:'Explain',currentAudience:'New viewer',referencePieces:[]},form:'Video',
  materials:[{id:'m1',title:'Primary',text:'The cost grows with trials'}],standards:'Explain',webResearch:false,maxRevisions:1};
function capture():ExplanatoryMethodCapture{return {candidate:{workflowId:'content.explanatory-method'} as ExplanatoryMethodCapture['candidate'],
  deployment:{verify(){},roles:{...CONTENT_ROLES,researcher:{...CONTENT_ROLES.researcher,prompt:'Exact frozen researcher prompt',preamble:''}},
    roleModels:{researcher:{model:'exact-researcher-model',reasoningEffort:'high'}}} as unknown as ExplanatoryMethodCapture['deployment']};}
function scripted(notes:unknown[]=[]){
  const calls:AgentRunRequest<unknown>[]=[];
  const agentRunner:AgentRunner={async run<I,O>(request:AgentRunRequest<I>):Promise<AgentRunResult<O>>{
    calls.push(request as AgentRunRequest<unknown>);
    return {output:{questions:[{question:'Why?',answer:'More trials use more resources',materialRefs:['m1'],gap:''}],
      notes,remainingGaps:[]} as O};
  }};
  return {agentRunner,calls};
}
describe('explanatory researcher trial',()=>{
  it('runs only the captured researcher and saves a real research artifact',async()=>{
    const {agentRunner,calls}=scripted(),store=new MemoryRunStore();
    const {run}=await runWorkflow({workflow:createExplanatoryResearchTrial(capture()),input,store,agentRunner});
    expect(calls).toHaveLength(1);
    expect(calls[0]?.definition.id).toBe(CONTENT_ROLES.researcher.id);
    expect(calls[0]?.definition.model).toBe('exact-researcher-model');
    expect(calls[0]?.definition.config?.prompt).toBe('Exact frozen researcher prompt');
    expect(store.artifacts.filter(asset=>asset.type==='content-research')).toHaveLength(1);
    expect(store.artifacts.filter(asset=>['content-draft','content-reader','content-fact-check','content-review'].includes(asset.type))).toHaveLength(0);
    expect(run.output).toMatchObject({details:{reason:'research-trial-complete'}});
  });
  it('rejects invented offline notes before publication',async()=>{
    const {agentRunner,calls}=scripted([{id:'new',title:'New',url:'https://example.com',publisher:'Publisher',date:'2026-10-11',
      keyPoints:['Claim'],fillsGap:'Gap',sourceKind:'primary'}]),store=new MemoryRunStore();
    const {run}=await runWorkflow({workflow:createExplanatoryResearchTrial(capture()),input,store,agentRunner});
    expect(calls).toHaveLength(1);
    expect(run.output).toMatchObject({details:{reason:'research-output-not-offline'}});
    expect(store.artifacts.filter(asset=>asset.type==='content-research')).toHaveLength(0);
  });
});

function executionFixture(){
  const workflowId='content.explanatory-method',versionId='explanatory-v1',budgetId='budget-1',validationSha256='a'.repeat(64);
  const frozen={workflowId,codeRevision:'content-v2',storageContract:{workflowVersion:versionId}};
  const config={validation:{sha256:validationSha256}};
  const versionDraft={id:versionId,revision:'1',changeReason:'Method',config,designBasis:{designRevisionId:'design',designPayloadHash:'design-hash',
    understandingRevisionId:'understanding',understandingPayloadHash:'understanding-hash'},entrypoints:{content:frozen}};
  const version={...versionDraft,spaceId:'space',hash:'version-hash',createdAt:'2026-10-11T00:00:00Z'} as unknown as WorkflowVersion;
  const manifest:InputManifest={id:'manifest',spaceId:'space',caseId:'case',assets:{opportunity:'opportunity',materials:'materials'},hash:'manifest-hash'};
  const schema={namespace:'creation/test',revision:'1',hash:'schema-hash'};
  const source={kind:'import' as const,actorId:'writer',description:'Frozen'};
  const assets:Record<string,AssetVersion>={
    opportunity:{id:'opportunity',spaceId:'space',assetId:'opportunity',version:1,schema,payload:{topicId:'case'},payloadHash:'opportunity-hash',
      source,dependencies:[],attachments:[],initialState:'imported',createdAt:'2026-10-11T00:00:00Z'},
    materials:{id:'materials',spaceId:'space',assetId:'materials',version:1,schema,payload:input.materials,payloadHash:'materials-hash',
      source,dependencies:[],attachments:[],initialState:'imported',createdAt:'2026-10-11T00:00:00Z'},
  };
  const budget:AssetVersion={id:'budget-revision',spaceId:'space',assetId:executionBudgetAssetId(budgetId),version:1,schema:EXECUTION_BUDGET_SCHEMA_REF,
    payload:{budgetId,workflowVersionId:versionId,validationSha256,limits:{maxCalls:15,maxDurationMs:3_600_000,maxNodeDurationMs:900_000,
      maxTrialCalls:2,maxTechnicalRepairsPerOccurrence:1},creationKey:'budget-key',startedAt:null,reservations:[]},payloadHash:'budget-hash',
    source,dependencies:[],attachments:[],initialState:'imported',createdAt:'2026-10-11T00:00:00Z'};
  const bindings:SpaceRun[]=[],tasks:ExecutionTask[]=[],native=new Map<string,Record<string,unknown>>();
  const service={
    async readWorkflowVersion(){return version;},async readManifest(){return manifest;},async readAsset(_spaceId:string,id:string){return assets[id];},
    async readCase(){return {id:'case',spaceId:'space',title:'Case',objective:'Explain',constraints:[]};},
    async caseRunsPage(){return bindings;},async getExecutionTask(_spaceId:string,runId:string){return tasks.find(task=>task.runId===runId)??null;},
    async readAssetHead(_spaceId:string,id:string){return id===budget.assetId?budget:null;},
    async runtimeLedger(){return {getRun:async(id:string)=>native.get(id)};},
    async enqueueExecution(_spaceId:string,binding:{workflowVersionId:string;entrypoint:string;inputManifestId:string},run:Record<string,unknown>,taskInput:{executorKey:string}){
      const runId=`run-${bindings.length+1}`;
      bindings.push({runId,spaceId:'space',caseId:'case',workflowVersionId:binding.workflowVersionId,entrypoint:binding.entrypoint,
        inputManifestId:binding.inputManifestId,effectiveConfig:{},configHash:'config-hash'});
      const task={runId,spaceId:'space',caseId:'case',workflowVersionId:binding.workflowVersionId,entrypoint:binding.entrypoint,
        inputManifestId:binding.inputManifestId,executorKey:taskInput.executorKey,status:'queued'} as ExecutionTask;
      tasks.push(task);native.set(runId,{...run,id:runId});return {run:{...run,id:runId},task};
    },
  } as unknown as WorkflowSpaceService;
  let parsed=input;
  const deployment={verify(){},candidate:()=>({version:versionDraft,refs:{opportunity:schema,materials:schema}}),frozenDefinition:async()=>frozen,
    parseInput:()=>parsed,roles:CONTENT_ROLES,roleModels:{researcher:{model:'researcher',reasoningEffort:'high'}}} as unknown as ExplanatoryMethodCapture['deployment'];
  const captured={candidate:{workflowId,entrypoint:'content',version:versionDraft},deployment} as unknown as ExplanatoryMethodCapture;
  const authorizations:string[]=[];
  return {captured,service,manifest,bindings,native,authorizations,version,setParsed:(value:ContentInput)=>{parsed=value;},
    options:{service,spaceId:'space',principalId:'writer',capture:captured,guardedRuntimeReady:()=>true,
      authorizeTask:async(value:{mode:string})=>{authorizations.push(value.mode);return {budgetId};},
      withCaseLock:async<T>(_caseId:string,work:()=>Promise<T>)=>work()}};
}

describe('explanatory execution queue',()=>{
  it('permits one trial and one case on the same exact candidate and manifest, with mode-aware replay',async()=>{
    const f=executionFixture(),execution=await createExplanatoryMethodExecution(f.options);
    const start=(mode:'research-trial'|'case',key:string)=>execution.startFromManifest({spaceId:'space',caseId:'case',workflowVersionId:'explanatory-v1',
      inputManifestId:'manifest',idempotencyKey:key,dispatch:false,mode});
    const trial=await start('research-trial','trial-key');
    expect((await start('research-trial','trial-key')).runId).toBe(trial.runId);
    await expect(start('research-trial','changed-key')).rejects.toThrow('different run in this mode');
    const business=await start('case','case-key');
    expect(business.runId).not.toBe(trial.runId);
    expect(f.bindings).toHaveLength(2);
    expect(f.native.get(trial.runId)?.metadata).toMatchObject({executionMode:'research-trial',budgetId:'budget-1'});
    expect(await execution.resolveRunBudget(business.runId)).toEqual({mode:'case',budgetId:'budget-1'});
    expect(f.authorizations).toEqual(['research-trial','case']);
    await execution.stop();
  });
  it('denies wrong version, manifest, and revision budget before queueing',async()=>{
    const f=executionFixture(),execution=await createExplanatoryMethodExecution(f.options);
    await expect(execution.startFromManifest({spaceId:'space',caseId:'case',workflowVersionId:'other',inputManifestId:'manifest',
      idempotencyKey:'wrong',dispatch:false})).rejects.toThrow('version or Space');
    await expect(execution.startFromManifest({spaceId:'space',caseId:'case',workflowVersionId:'explanatory-v1',inputManifestId:'other',
      idempotencyKey:'wrong',dispatch:false})).rejects.toThrow('manifest requires exact');
    f.setParsed({...input,maxRevisions:2});
    await expect(execution.startFromManifest({spaceId:'space',caseId:'case',workflowVersionId:'explanatory-v1',inputManifestId:'manifest',
      idempotencyKey:'wrong',dispatch:false})).rejects.toThrow('two business rounds');
    f.setParsed(input);
    f.version.config={validation:{sha256:'changed'}};
    await expect(execution.startFromManifest({spaceId:'space',caseId:'case',workflowVersionId:'explanatory-v1',inputManifestId:'manifest',
      idempotencyKey:'wrong',dispatch:false})).rejects.toThrow('冻结定义不一致');
    expect(f.bindings).toHaveLength(0);
    await execution.stop();
  });
});
