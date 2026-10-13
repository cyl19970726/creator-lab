import {describe,expect,it,vi,beforeEach} from 'vitest';
import {createExplanatoryMethodExecutionHost} from '../src/spaces/explanatory-method-execution-host.js';
import type {WorkflowSpaceService,SpacePrincipal,AssetVersion,InputManifest} from '@signal-room/workflow-spaces';

const mocks=vi.hoisted(()=>({
  validationHash:'8de852c5f3ce32df32f954a13ed5a278a578cdc158a5380356c0b23686e06b19',
  design:{id:'design',payloadHash:'design-hash',capability:{revisionId:'capability',payloadHash:'capability-hash'}},
  capability:{id:'capability',payloadHash:'capability-hash',validation:{content:'{"revision":3,"budget":{"maxNodeCalls":15,"maxProviderRequests":15,"maxCaseBusinessRounds":2,"maxTechnicalRepairsPerNode":1,"maxWallMinutes":60,"maxNodeMinutes":15,"webResearch":false},"trial":{"node":"researcher","maxModelCalls":2,"secondCallOnly":"one tool continuation OR one technical repair within 2"}}',
    sha256:'8de852c5f3ce32df32f954a13ed5a278a578cdc158a5380356c0b23686e06b19'}},
  understanding:{id:'understanding',payloadHash:'understanding-hash'},
  budgets:new Map<string,{budgetId:string;workflowVersionId:string;validationSha256:string;limits:{maxCalls:number;maxDurationMs:number;maxNodeDurationMs:number};startedAt:null;reservations:unknown[]}>(),
  execution:{published:vi.fn(async()=>({id:'version'})),frozenInput:vi.fn(async()=>({manifest:{id:'manifest'}})),
    createCase:vi.fn(async(_space:string,value:{id:string})=>value),freezeInput:vi.fn(async()=>({id:'manifest',hash:'manifest-hash',caseId:'case',spaceId:'space',
      assets:{opportunity:'new-opportunity',materials:'new-materials'}})),startFromManifest:vi.fn(async()=>({runId:'run',inputManifestId:'manifest',task:{status:'queued'}})),
    dispatchRun:vi.fn(async()=>undefined),runStatus:vi.fn(async()=>({binding:{caseId:'case'},executionTask:{status:'queued'}})),
    availability:vi.fn(async()=>({available:true})),stop:vi.fn(async()=>undefined)},
}));
vi.mock('@signal-room/workflow-spaces',async importOriginal=>{
  const actual=await importOriginal<typeof import('@signal-room/workflow-spaces')>();
  return {...actual,
    createMethodDesignStore:()=>({read:async()=>mocks.design}),
    createMethodCapabilityStore:()=>({read:async()=>mocks.capability}),
    createBusinessUnderstandingStore:()=>({read:async()=>mocks.understanding}),
    createExecutionBudgetStore:()=>({ensure:async()=>({}),create:async(_space:string,input:{id:string;workflowVersionId:string;validationSha256:string;limits:{maxCalls:number;maxDurationMs:number;maxNodeDurationMs:number}})=>{
      const prior=mocks.budgets.get(input.id);if(prior)return prior;
      const value={budgetId:input.id,workflowVersionId:input.workflowVersionId,validationSha256:input.validationSha256,
        limits:input.limits,startedAt:null as null,reservations:[]};mocks.budgets.set(input.id,value);return value;},
      read:async(_space:string,id:string)=>{const value=mocks.budgets.get(id);if(!value)throw Error('Missing budget');return value;}}),
  };
});
vi.mock('../src/spaces/explanatory-method-provider.js',()=>({captureExplanatoryMethod:()=>({candidate:{candidateId:'version',
  version:{config:{validation:{sha256:mocks.validationHash}}}},deployment:{}})}));
vi.mock('../src/spaces/explanatory-method-runner.js',()=>({createExplanatoryMethodRunner:()=>({run:async()=>({output:{}})})}));
vi.mock('../src/spaces/explanatory-method-execution.js',()=>({createExplanatoryMethodExecution:async(options:{guardedRuntimeReady:()=>boolean})=>({
  ...mocks.execution,availability:async()=>({available:options.guardedRuntimeReady()})})}));

function fixture(canWrite=true){
  const releases=new Map<string,AssetVersion>(),origins:AssetVersion[]=[];
  const manifest:InputManifest={id:'manifest',spaceId:'space',caseId:'case',assets:{opportunity:'new-opportunity',materials:'new-materials'},hash:'manifest-hash'};
  const version={id:'version',spaceId:'space',entrypoints:{content:{workflowId:'content.explanatory-method'}},
    config:{validation:{sha256:mocks.validationHash}},designBasis:{designRevisionId:'design',designPayloadHash:'design-hash',
      understandingRevisionId:'understanding',understandingPayloadHash:'understanding-hash'}};
  const service={
    readWorkflowVersion:vi.fn(async()=>version),readManifest:vi.fn(async()=>manifest),
    readAssetHead:vi.fn(async(_space:string,assetId:string)=>releases.get(assetId)??null),
    importedAssetsBySchema:vi.fn(async(_space:string,namespace:string)=>namespace==='creation/explanatory-execution-release'?[...releases.values()]:[]),
    overview:vi.fn(async()=>({workflows:[version]})),executionTasks:vi.fn(async()=>[]),
    runtimeLedger:vi.fn(async()=>({getRun:async()=>null})),
    registerSchemas:vi.fn(async()=>[]),
    importAsset:vi.fn(async(_space:string,input:{assetId?:string;schema:{namespace:string;revision:string;hash:string};payload:unknown;dependencies?:string[]})=>{
      const asset={id:`asset-${releases.size+origins.length+1}`,assetId:input.assetId??'asset',spaceId:'space',version:1,
        schema:input.schema,payload:input.payload,payloadHash:'payload-hash',source:{kind:'import' as const,actorId:'designer',description:'Explicit'},
        dependencies:input.dependencies??[],attachments:[],initialState:'imported',createdAt:'2026-10-11T00:00:00Z'} as AssetVersion;
      if(input.schema.namespace==='creation/explanatory-execution-release')releases.set(asset.assetId,asset);else origins.push(asset);
      return asset;
    }),
  } as unknown as WorkflowSpaceService;
  const auth={status:vi.fn(async()=>({connected:true,sharing:true})),accessToken:vi.fn(async()=> 'secret-do-not-return')};
  const principal={id:'designer',kind:'service',externalAgent:{role:'design',id:'agent',sessionId:'session'}} as SpacePrincipal;
  const cache=new Map();
  const host=createExplanatoryMethodExecutionHost({service,ownerService:service,principal,spaceId:'space',canWrite,
    withCaseLock:async(_caseId,work)=>work(),withPublicationLock:async work=>work(),auth,
    executorCache:cache});
  return {host,service,auth,releases,origins,manifest,cache,principal};
}
const command=(operation:'case-create'|'inputs-freeze'|'release'|'start'|'dispatch',input:Record<string,unknown>)=>({operation,input});
const release=command('release',{workflowVersionId:'version',caseId:'case',inputManifestId:'manifest',inputManifestHash:'manifest-hash',idempotencyKey:'release-key'});

beforeEach(()=>{mocks.budgets.clear();vi.clearAllMocks();});
describe('explanatory method execution host',()=>{
  it('keeps status readonly and unavailable until one explicit release',async()=>{
    const f=fixture();
    const before=await f.host.methodExecution!.status('space');
    expect(before.versions).toMatchObject([{availability:{available:false,reason:'No exact execution release exists'}}]);
    expect(JSON.stringify(before)).not.toMatch(/secret-do-not-return|email|token/i);
    expect(f.releases.size).toBe(0);expect(mocks.budgets.size).toBe(0);
    const later=createExplanatoryMethodExecutionHost({service:f.service,ownerService:f.service,principal:f.principal,
      spaceId:'space',canWrite:true,withCaseLock:async(_caseId,work)=>work(),withPublicationLock:async work=>work(),
      auth:f.auth,executorCache:f.cache});
    const receipt=await later.methodExecution!.command!('space',release);
    expect(receipt).toMatchObject({operation:'release',budgetId:expect.stringMatching(/^explanatory-budget:/)});
    expect(f.releases.size).toBe(1);expect(mocks.budgets.size).toBe(1);
    expect([...mocks.budgets.values()][0]?.limits).toMatchObject({maxCalls:15,maxDurationMs:3_600_000,
      maxNodeDurationMs:900_000,trialSecondKinds:['tool-continuation','technical-repair']});
    expect((await f.host.methodExecution!.status('space')).versions).toMatchObject([{availability:{available:true},budget:{remainingCalls:15}}]);
    mocks.budgets.values().next().value!.reservations.push({kind:'tool-continuation',outcome:'provider-failed-after-reservation'});
    expect((await f.host.methodExecution!.status('space')).versions).toMatchObject([{budget:{usedReservedRequests:1,remainingProviderRequests:14}}]);
    const other=createExplanatoryMethodExecutionHost({service:f.service,ownerService:f.service,
      principal:{id:'other-agent',kind:'service',externalAgent:{role:'design',id:'other',sessionId:'other'}} as SpacePrincipal,
      spaceId:'space',canWrite:false,withCaseLock:async(_caseId,work)=>work(),withPublicationLock:async work=>work(),
      auth:f.auth,executorCache:f.cache});
    expect((await other.methodExecution!.status('space')).versions).toMatchObject([{availability:{available:true}}]);
    await f.host.methodExecution!.command!('space',release);
    expect(f.releases.size).toBe(1);expect(mocks.budgets.size).toBe(1);
    await expect(f.host.methodExecution!.command!('space',command('release',{...release.input,idempotencyKey:'alternate'}))).rejects.toThrow('Alternate release');
    f.manifest.caseId='other';
    await expect(f.host.methodExecution!.command!('space',command('release',{...release.input,caseId:'other'}))).rejects.toThrow('Alternate Case');
    await f.host.stop();
  });
  it('exposes no mutation to readonly callers and checks origin syntax before freezing',async()=>{
    const readonly=fixture(false);
    expect(readonly.host.methodExecution!.command).toBeUndefined();
    const f=fixture();
    const basic={topicId:'case',opportunity:'Explain',account:{name:'Account',positioning:'Explain',currentAudience:'Reader',referencePieces:[]},
      form:'Video',materials:[{id:'m1',title:'Source',text:'Body'}],standards:'C1',webResearch:false,readerGoal:'Understand',
      requiredQuestions:['Why?'],maxRevisions:1};
    await expect(f.host.methodExecution!.command!('space',command('inputs-freeze',{workflowVersionId:'version',caseId:'case',
      idempotencyKey:'input-key',input:basic,origin:{spaceId:'old-space',opportunity:{assetVersionId:'old-op',payloadHash:'bad'},
        materials:{assetVersionId:'old-mat',payloadHash:'b'.repeat(64)}}}))).rejects.toThrow();
    expect(mocks.execution.freezeInput).not.toHaveBeenCalled();
    const result=await f.host.methodExecution!.command!('space',command('inputs-freeze',{workflowVersionId:'version',caseId:'case',
      idempotencyKey:'input-key',input:basic,origin:{spaceId:'old-space',opportunity:{assetVersionId:'old-op',payloadHash:'a'.repeat(64)},
        materials:{assetVersionId:'old-mat',payloadHash:'b'.repeat(64)},description:'Supplied by operator'}}));
    expect(result).toMatchObject({originDeclared:true});
    expect(f.service.readAsset).toBeUndefined();
    expect(f.origins[0]?.payload).toMatchObject({verification:'declared-unverified',declaration:{spaceId:'old-space'}});
    expect(f.origins[0]?.dependencies).toEqual(['new-opportunity','new-materials']);
    await f.host.stop();
  });
});
