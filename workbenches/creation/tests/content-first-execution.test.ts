import {describe,expect,it,vi} from 'vitest';
import type {AgentRunRequest,AgentRunner} from '@signal-room/workflow';
import {publishProcessContract,type WorkflowSpaceService,type WorkflowVersion} from '@signal-room/workflow-spaces';
import {SchemaRegistry,publishStorageContract} from '@signal-room/workflow-space-contracts';
import {createBudgetedFirstMethodRunner,createFirstMethodExecution,
  FIRST_METHOD_VERSION_ID,type FirstMethodExecutionBudget} from '../src/spaces/content-first-execution.js';
import {createContentDeployment} from '../src/spaces/content-method.js';
import {contentSiwcExecutorManifest} from '../src/spaces/content-runner.js';
import {registerCreationSchemas} from '../src/spaces/contracts.js';

const budget:FirstMethodExecutionBudget={maxAgentCalls:15,maxDurationMs:3600000,perAgentTimeoutMs:900000};
const request={runId:'run-1',stepRunId:'step-1',attemptId:'attempt-1',
  definition:{id:'content-author',revision:'content-v2',model:'gpt-6-luna',reasoningEffort:'high',
    promptRevision:'content-v2',skillsRevision:'none',permissionsRevision:'read-only-v1'},
  input:{},signal:new AbortController().signal,emit:async()=>{}} as AgentRunRequest<unknown>;
const contexts=(count:number)=>Array.from({length:count},(_,i)=>({producer:'agent',stepRunId:i===0?'step-1':`step-${i+1}`,
  attemptId:i===0?'attempt-1':`attempt-${i+1}`}));

describe('independent first-method executor',()=>{
  it('requires the exact persisted node attempt and enforces the run-wide agent cap',async()=>{
    const run=vi.fn(async()=>({output:{ok:true}}));
    const service={runtimeContexts:vi.fn(async()=>contexts(15))} as unknown as Pick<WorkflowSpaceService,'runtimeContexts'>;
    const activeBudgets=new Map([['run-1',budget]]);
    const runner=createBudgetedFirstMethodRunner(service,'first-space',{run} as AgentRunner,activeBudgets);
    await expect(runner.run(request)).resolves.toMatchObject({output:{ok:true}});
    expect(run).toHaveBeenCalledTimes(1);
    service.runtimeContexts=vi.fn(async()=>contexts(16)) as unknown as typeof service.runtimeContexts;
    await expect(runner.run(request)).rejects.toThrow('budget exceeded');
    expect(run).toHaveBeenCalledTimes(1);
    activeBudgets.clear();
    await expect(runner.run(request)).rejects.toThrow('no active execution budget');
  });
  it('rejects a missing exact context before any model request',async()=>{
    const run=vi.fn(async()=>({output:{ok:true}}));
    const service={runtimeContexts:vi.fn(async()=>contexts(0))} as unknown as Pick<WorkflowSpaceService,'runtimeContexts'>;
    const runner=createBudgetedFirstMethodRunner(service,'first-space',{run} as AgentRunner,new Map([['run-1',budget]]));
    await expect(runner.run(request)).rejects.toThrow('exact persisted node context');
    expect(run).not.toHaveBeenCalled();
  });
  it('refuses to label a different candidate as the published first method',async()=>{
    await expect(createFirstMethodExecution({candidate:{id:'creation-content-old',entrypoints:{},config:{},
      revision:'content-v2',changeReason:'old'},service:{} as WorkflowSpaceService,spaceId:'first-space',
      principalId:'owner',deployment:{} as never,authorizeTask:async()=>budget,activeBudgets:new Map(),
      withCaseLock:async(_caseId,work)=>work()}))
      .rejects.toThrow('cannot reproduce the frozen first-method candidate');
  });
  it('rejects webResearch in an already frozen manifest before enqueue or dispatch',async()=>{
    const deployment=createContentDeployment({runner:{run:vi.fn()},
      models:{worker:{model:'gpt-6-luna',reasoningEffort:'high'},judge:{model:'gpt-6-luna',reasoningEffort:'high'}},
      executorManifest:contentSiwcExecutorManifest()});
    const source=deployment.candidate().version;
    const original=source.entrypoints.content!;
    const candidate={...source,id:FIRST_METHOD_VERSION_ID,
      designBasis:{designRevisionId:'design-2',designPayloadHash:'design-hash',
        understandingRevisionId:'understanding-1',understandingPayloadHash:'understanding-hash'},
      entrypoints:{content:{...original,workflowId:'content.first-method',
        storageContract:{...original.storageContract,workflowVersion:FIRST_METHOD_VERSION_ID}}}};
    const schemas=new SchemaRegistry();registerCreationSchemas(schemas);
    const storageContract=publishStorageContract(schemas,candidate.entrypoints.content.storageContract);
    const process=await publishProcessContract(candidate.entrypoints.content.process!,storageContract);
    const published={...candidate,spaceId:'first-space',hash:'published-hash',createdAt:'2026-10-09T00:00:00Z',
      entrypoints:{content:{...candidate.entrypoints.content,storageContract,process}}} as WorkflowVersion;
    const {materials,...opportunity}={topicId:'case-1',opportunity:'解释流程',readerGoal:'看懂因果',
      requiredQuestions:['为什么'],account:{name:'账号',positioning:'说明',currentAudience:'读者',referencePieces:[]},
      form:'口播',materials:[{id:'m1',title:'材料',text:'具体事实'}],standards:'准确',webResearch:true,maxRevisions:2};
    const refs=deployment.candidate().refs;
    const enqueueExecution=vi.fn(async(..._args:unknown[])=>({run:{id:'run-1'},task:{runId:'run-1'}}));
    let priorRuns:Array<{runId:string;workflowVersionId:string;inputManifestId:string}>=[];
    const service={readWorkflowVersion:vi.fn(async()=>published),
      readManifest:vi.fn(async()=>({id:'manifest-1',spaceId:'first-space',caseId:'case-1',hash:'manifest-hash',
        assets:{opportunity:'asset-opportunity',materials:'asset-materials'}})),
      readCase:vi.fn(async()=>({id:'case-1',spaceId:'first-space'})),
      caseRunsPage:vi.fn(async()=>priorRuns),
      readAsset:vi.fn(async(_space:string,id:string)=>id==='asset-opportunity'
        ?{source:{kind:'import'},schema:refs.opportunity,payload:opportunity}
        :{source:{kind:'import'},schema:refs.materials,payload:materials}),
      getExecutionTask:vi.fn(async()=>({runId:'run-1',status:'completed',workflowVersionId:FIRST_METHOD_VERSION_ID,
        inputManifestId:'manifest-1',executorKey:JSON.stringify([FIRST_METHOD_VERSION_ID,'content'])})),
      runtimeLedger:vi.fn(async()=>({getRun:async()=>({id:'run-1',metadata:{commandKey:'content:case-1:business:same-key'}})})),
      runtimeEvidence:vi.fn(async()=>({getRun:async()=>({id:'run-1',state:'completed'})})),
      enqueueExecution} as unknown as WorkflowSpaceService;
    const authorizeTask=vi.fn(async()=>budget);
    const execution=await createFirstMethodExecution({service,spaceId:'first-space',principalId:'owner',
      deployment,candidate,authorizeTask,activeBudgets:new Map(),withCaseLock:async(_caseId,work)=>work()});
    await expect(execution.startFromManifest({spaceId:'first-space',caseId:'case-1',
      workflowVersionId:FIRST_METHOD_VERSION_ID,inputManifestId:'manifest-1',
      idempotencyKey:'once',dispatch:false})).rejects.toThrow('webResearch=false');
    expect(enqueueExecution).not.toHaveBeenCalled();
    expect(authorizeTask).not.toHaveBeenCalled();
    opportunity.webResearch=false;
    const input={spaceId:'first-space',caseId:'case-1',workflowVersionId:FIRST_METHOD_VERSION_ID,
      inputManifestId:'manifest-1',idempotencyKey:'business:same-key',dispatch:false};
    const first=await execution.startFromManifest(input);
    priorRuns=[{runId:'run-1',workflowVersionId:FIRST_METHOD_VERSION_ID,inputManifestId:'manifest-1'}];
    const retry=await execution.startFromManifest(input);
    expect(first.runId).toBe('run-1');
    expect(retry.runId).toBe(first.runId);
    expect(enqueueExecution).toHaveBeenCalledTimes(1);
    expect(enqueueExecution.mock.calls[0]?.[2]).toMatchObject({metadata:{commandKey:'content:case-1:business:same-key'}});
    await expect(execution.startFromManifest({...input,idempotencyKey:'business:other-key'}))
      .rejects.toThrow('different command');
    expect(enqueueExecution).toHaveBeenCalledTimes(1);
  });
});
