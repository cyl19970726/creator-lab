import {createHash} from 'node:crypto';
import {z} from 'zod';
import type {AgentRunRequest} from '@signal-room/workflow';
import type {SiwcAuth} from '@signal-room/workflow-agent-sdk';
import {JSON_SCHEMA_DIALECT,SchemaRegistry,type SchemaDefinition,type SchemaRef} from '@signal-room/workflow-space-contracts';
import {createBusinessUnderstandingStore,createExecutionBudgetStore,createMethodCapabilityStore,createMethodDesignStore,
  type ExecutionBudgetLimits,type InputManifest,type SpacePrincipal,type WorkflowSpaceService} from '@signal-room/workflow-spaces';
import type {SpaceApiHost} from '@signal-room/workflow-space-api/server';
import type {MethodExecutionCommandDto} from '@signal-room/workflow-space-api/contracts';
import {contentInputSchema,type ContentInput} from '../stages/content.js';
import {captureExplanatoryMethod} from './explanatory-method-provider.js';
import {createExplanatoryMethodExecution,type ExplanatoryExecutionMode} from './explanatory-method-execution.js';
import {createExplanatoryMethodRunner} from './explanatory-method-runner.js';

const workflowId='content.explanatory-method',entrypoint='content';
const sha=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)
  ?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const id=z.string().trim().min(1);
const caseCreate=z.object({workflowVersionId:id,case:z.object({id,title:id,objective:id,constraints:z.array(z.string()).optional()}).strict(),idempotencyKey:id}).strict();
const originRef=z.object({assetVersionId:id,payloadHash:z.string().regex(/^[a-f0-9]{64}$/u)}).strict();
const originSchema=z.object({spaceId:id,opportunity:originRef,materials:originRef,description:z.string().optional()}).strict();
const inputsFreeze=z.object({workflowVersionId:id,caseId:id,input:contentInputSchema,idempotencyKey:id,origin:originSchema.optional()}).strict();
const releaseInput=z.object({workflowVersionId:id,caseId:id,inputManifestId:id,inputManifestHash:id,idempotencyKey:id}).strict();
const startInput=z.object({workflowVersionId:id,caseId:id,inputManifestId:id,idempotencyKey:id,mode:z.enum(['research-trial','case'])}).strict();
const dispatchInput=z.object({workflowVersionId:id,runId:id}).strict();
const RELEASE_NAMESPACE='creation/explanatory-execution-release';
const ORIGIN_NAMESPACE='creation/explanatory-input-origin';
const string={type:'string',minLength:1};
const releaseDefinition:SchemaDefinition={namespace:RELEASE_NAMESPACE,revision:'1',dialect:JSON_SCHEMA_DIALECT,
  schema:{$schema:JSON_SCHEMA_DIALECT,type:'object',properties:{workflowVersionId:string,caseId:string,inputManifestId:string,
    inputManifestHash:string,validationSha256:string,principalId:string,budgetId:string,creationKey:string},
    required:['workflowVersionId','caseId','inputManifestId','inputManifestHash','validationSha256','principalId','budgetId','creationKey'],additionalProperties:false}};
const originDefinition:SchemaDefinition={namespace:ORIGIN_NAMESPACE,revision:'1',dialect:JSON_SCHEMA_DIALECT,
  schema:{$schema:JSON_SCHEMA_DIALECT,type:'object',properties:{caseId:string,workflowVersionId:string,inputManifestId:string,
    declaration:{type:'object',properties:{spaceId:string,opportunity:{type:'object',properties:{assetVersionId:string,payloadHash:string},required:['assetVersionId','payloadHash'],additionalProperties:false},
      materials:{type:'object',properties:{assetVersionId:string,payloadHash:string},required:['assetVersionId','payloadHash'],additionalProperties:false},description:{type:'string'}},
      required:['spaceId','opportunity','materials'],additionalProperties:false},verification:{type:'string',enum:['declared-unverified']}},
    required:['caseId','workflowVersionId','inputManifestId','declaration','verification'],additionalProperties:false}};
const registry=new SchemaRegistry();
const releaseFrozen=registry.registerSchema(releaseDefinition),originFrozen=registry.registerSchema(originDefinition);
const releaseRef:SchemaRef={namespace:releaseFrozen.namespace,revision:releaseFrozen.revision,hash:releaseFrozen.hash};
const originRefSchema:SchemaRef={namespace:originFrozen.namespace,revision:originFrozen.revision,hash:originFrozen.hash};
const releaseAssetId=(validationSha256:string)=>`explanatory-release:${validationSha256}`;
const originAssetId=(versionId:string,caseId:string,manifestId:string)=>`explanatory-origin:${sha(`${versionId}\0${caseId}\0${manifestId}`)}`;
type ReleasePayload={workflowVersionId:string;caseId:string;inputManifestId:string;inputManifestHash:string;
  validationSha256:string;principalId:string;budgetId:string;creationKey:string};
type Execution=Awaited<ReturnType<typeof createExplanatoryMethodExecution>>;

function frozenBudget(validation:{content:string;sha256:string}):ExecutionBudgetLimits {
  if(sha(validation.content)!==validation.sha256)throw new Error('Frozen validation plan content/hash mismatch');
  let parsed:unknown;
  try{parsed=JSON.parse(validation.content);}catch{throw new Error('Frozen validation plan is not JSON');}
  const plan=z.object({revision:z.number().int().optional(),
    budget:z.object({maxNodeCalls:z.number().int().positive(),maxProviderRequests:z.number().int().positive().optional(),
      maxCaseBusinessRounds:z.literal(2),maxTechnicalRepairsPerNode:z.number().int().nonnegative(),
      maxWallMinutes:z.number().positive(),maxNodeMinutes:z.number().positive(),webResearch:z.literal(false)}).passthrough(),
    trial:z.object({node:z.literal('researcher'),maxModelCalls:z.number().int().positive(),secondCallOnly:z.string().optional()}).passthrough(),
  }).passthrough().parse(parsed);
  const isV3=(plan.revision??0)>=3;
  if(isV3&&(!plan.budget.maxProviderRequests||!plan.trial.secondCallOnly?.includes('tool continuation OR one technical repair')))
    throw new Error('Frozen v3 validation plan lacks exact provider-request or second-trial policy');
  return {maxCalls:plan.budget.maxProviderRequests??plan.budget.maxNodeCalls,
    maxDurationMs:plan.budget.maxWallMinutes*60_000,maxNodeDurationMs:plan.budget.maxNodeMinutes*60_000,
    maxTrialCalls:plan.trial.maxModelCalls,maxTechnicalRepairsPerOccurrence:plan.budget.maxTechnicalRepairsPerNode,
    ...(isV3?{trialSecondKinds:['tool-continuation','technical-repair'] as Array<'tool-continuation'|'technical-repair'>}:{})};
}

export interface ExplanatoryMethodExecutionHostOptions {
  service:WorkflowSpaceService;ownerService:WorkflowSpaceService;principal:SpacePrincipal;spaceId:string;canWrite:boolean;
  withCaseLock:<T>(caseId:string,work:()=>Promise<T>)=>Promise<T>;
  withPublicationLock:<T>(work:()=>Promise<T>)=>Promise<T>;
  auth:Pick<SiwcAuth,'status'|'accessToken'>;
  fetch?:typeof fetch;
  /** Supply a host-lifetime cache when constructing facades per request. */
  executorCache?:Map<string,Promise<Execution>>;
}
const defaultCaches=new WeakMap<WorkflowSpaceService,Map<string,Promise<Execution>>>();

/** Domain adapter for the generic method-execution command surface. No writes occur during construction or status. */
export function createExplanatoryMethodExecutionHost(options:ExplanatoryMethodExecutionHostOptions):
  Pick<SpaceApiHost,'methodExecution'>&{stop:()=>Promise<void>} {
  const {service,ownerService,spaceId,principal}=options;
  const cache=options.executorCache??(()=>{let value=defaultCaches.get(ownerService);if(!value){value=new Map();defaultCaches.set(ownerService,value);}return value;})();
  const budgets=createExecutionBudgetStore(ownerService),designs=createMethodDesignStore(service),capabilities=createMethodCapabilityStore(service),
    understandings=createBusinessUnderstandingStore(service);
  const requireSpace=(selected:string)=>{if(selected!==spaceId)throw new Error('Explanatory execution belongs to another Space');};
  const requireDesigner=()=>{if(!options.canWrite||principal.kind!=='service'||principal.externalAgent?.role!=='design')
    throw new Error('Only the authenticated design Agent can mutate explanatory execution');};
  const published=async(versionId:string)=>{
    const version=await service.readWorkflowVersion(spaceId,versionId);
    if(version.id!==versionId||version.spaceId!==spaceId||version.entrypoints.content?.workflowId!==workflowId||!version.designBasis)
      throw new Error('Published explanatory method scope or design basis mismatch');
    const basis=version.designBasis,design=await designs.read(spaceId,basis.designRevisionId);
    if(design.payloadHash!==basis.designPayloadHash||!design.capability)throw new Error('Published design basis hash/capability mismatch');
    const [capability,understanding]=await Promise.all([capabilities.read(spaceId,design.capability.revisionId),
      understandings.read(spaceId,basis.understandingRevisionId)]);
    if(capability.payloadHash!==design.capability.payloadHash||understanding.payloadHash!==basis.understandingPayloadHash)
      throw new Error('Published capability or understanding hash mismatch');
    return {version,capability,design,understanding};
  };
  const releaseFor=async(versionId:string,caseId:string,manifest:InputManifest,validationSha256:string)=>{
    const asset=await service.readAssetHead(spaceId,releaseAssetId(validationSha256));
    if(!asset)return null;
    if(asset.schema.namespace!==releaseRef.namespace||asset.schema.revision!==releaseRef.revision||
      asset.schema.hash!==releaseRef.hash||asset.source.kind!=='import')throw new Error('Explanatory release asset type mismatch');
    const value=asset.payload as ReleasePayload;
    if(value.workflowVersionId!==versionId||value.caseId!==caseId||value.inputManifestId!==manifest.id||
      value.inputManifestHash!==manifest.hash||value.validationSha256!==validationSha256)
      throw new Error('Alternate Case, manifest, or version for the frozen validation plan is forbidden');
    return {asset,value};
  };
  const exactManifest=async(caseId:string,manifestId:string,manifestHash?:string)=>{
    const manifest=await service.readManifest(spaceId,manifestId);
    if(manifest.id!==manifestId||manifest.spaceId!==spaceId||manifest.caseId!==caseId||
      (manifestHash&&manifest.hash!==manifestHash))throw new Error('Frozen input manifest scope/hash mismatch');
    return manifest;
  };
  const runBudget=async(request:AgentRunRequest<unknown>)=>{
    const run=await(await service.runtimeLedger(spaceId)).getRun(request.runId);
    const mode=run?.metadata?.executionMode,budgetId=run?.metadata?.budgetId;
    if(run?.workflowId!==workflowId||(mode!=='research-trial'&&mode!=='case')||typeof budgetId!=='string')
      throw new Error('Persisted explanatory run budget metadata is missing');
    const budget=await budgets.read(spaceId,budgetId);
    if(budget.workflowVersionId!==run.metadata?.workflowVersionId)throw new Error('Run budget/version mismatch');
    return {budgetId,mode,stage:mode==='research-trial'?'trial' as const:'case' as const,budget};
  };
  const runner=createExplanatoryMethodRunner({service:ownerService,spaceId,auth:options.auth,fetch:options.fetch,budget:{
    current:async request=>{
      const {budget,stage}=await runBudget(request);
      const occurrence=budget.reservations.find(item=>item.runId===request.runId&&item.stepRunId===request.stepRunId);
      return {stage,deadlineAt:budget.startedAt?new Date(Date.parse(budget.startedAt)+budget.limits.maxDurationMs).toISOString():null,
        nodeDeadlineAt:occurrence?new Date(Date.parse(occurrence.reservedAt)+budget.limits.maxNodeDurationMs).toISOString():null};
    },
    reserve:async({request,turn,kind})=>{
      const {budgetId,stage}=await runBudget(request);
      return budgets.reserve(spaceId,budgetId,{runId:request.runId,stepRunId:request.stepRunId,attemptId:request.attemptId,
        turn,stage,kind});
    },
  }});
  const executionFor=async(versionId:string):Promise<Execution>=>{
    const key=`${spaceId}\0${principal.id}\0${versionId}`;
    let pending=cache.get(key);
    if(!pending){pending=(async()=>{
      const {version,capability,design,understanding}=await published(versionId);
      const capture=captureExplanatoryMethod(capability,design,understanding,runner);
      if(capture.candidate.candidateId!==versionId||!version.designBasis||
        canonical(capture.candidate.version.config)!==canonical(version.config))
        throw new Error('Published explanatory candidate config differs from recaptured provider');
      return createExplanatoryMethodExecution({service:ownerService,spaceId,principalId:principal.id,capture,
        withCaseLock:options.withCaseLock,guardedRuntimeReady:()=>true,
        authorizeTask:async({caseId,versionId:subjectVersion,manifest,parsed,mode,runId})=>{
          if(subjectVersion!==versionId||parsed.maxRevisions!==1||parsed.webResearch!==false||parsed.prior)
            throw new Error('Explanatory execution input or revision budget mismatch');
          const release=await releaseFor(versionId,caseId,manifest,capability.validation.sha256);
          if(!release||release.value.principalId!==principal.id||release.value.validationSha256!==capability.validation.sha256)
            throw new Error('Exact explanatory execution release is absent');
          const budget=await budgets.read(spaceId,release.value.budgetId);
          if(budget.workflowVersionId!==versionId||budget.validationSha256!==capability.validation.sha256)
            throw new Error('Explanatory release budget/validation mismatch');
          if(budget.reservations.length>=budget.limits.maxCalls||
            (budget.startedAt!==null&&Date.now()>=Date.parse(budget.startedAt)+budget.limits.maxDurationMs))
            throw new Error('Explanatory execution budget is exhausted');
          const tasks=await service.executionTasks(spaceId);
          if(tasks.some(task=>task.runId!==runId&&['running','cancel_requested','interrupted'].includes(task.status)))
            throw new Error('Another execution task is active in this Space');
          if(mode!=='research-trial'&&mode!=='case')throw new Error('Unsupported explanatory execution mode');
          return {budgetId:release.value.budgetId};
        }});
    })();cache.set(key,pending);pending.catch(()=>{if(cache.get(key)===pending)cache.delete(key);});}
    return pending;
  };
  const command=async(selected:string,request:MethodExecutionCommandDto):Promise<Record<string,unknown>>=>{
    requireSpace(selected);requireDesigner();
    if(request.operation==='case-create'){
      const input=caseCreate.parse(request.input),execution=await executionFor(input.workflowVersionId);
      const item=await execution.createCase(spaceId,{...input.case,constraints:input.case.constraints??[]});
      return {operation:'case-create',caseId:item.id,workflowVersionId:input.workflowVersionId};
    }
    if(request.operation==='inputs-freeze'){
      const input=inputsFreeze.parse(request.input),execution=await executionFor(input.workflowVersionId);
      if(input.origin){
        if(input.origin.description!==undefined&&!input.origin.description.trim())throw new Error('Origin description must be nonempty when supplied');
      }
      const manifest=await execution.freezeInput({spaceId,caseId:input.caseId,input:input.input,idempotencyKey:input.idempotencyKey});
      if(input.origin){
        await ownerService.registerSchemas(spaceId,[originDefinition]);
        await ownerService.importAsset(spaceId,{assetId:originAssetId(input.workflowVersionId,input.caseId,manifest.id),schema:originRefSchema,
          payload:{caseId:input.caseId,workflowVersionId:input.workflowVersionId,inputManifestId:manifest.id,
            declaration:input.origin,verification:'declared-unverified'},
          dependencies:Object.values(manifest.assets),description:'Declared unverified source origin for explanatory input',
          idempotencyKey:`explanatory-origin:${input.caseId}:${manifest.id}:${input.idempotencyKey}`});
      }
      return {operation:'inputs-freeze',caseId:input.caseId,workflowVersionId:input.workflowVersionId,
        inputManifestId:manifest.id,inputManifestHash:manifest.hash,originDeclared:!!input.origin};
    }
    if(request.operation==='release'){
      const input=releaseInput.parse(request.input);
      return options.withPublicationLock(async()=>{
        const {capability}=await published(input.workflowVersionId);
        const limits=frozenBudget(capability.validation);
        const execution=await executionFor(input.workflowVersionId);
        await execution.published();
        const manifest=await exactManifest(input.caseId,input.inputManifestId,input.inputManifestHash);
        await execution.frozenInput(input.caseId,manifest.id);
        const auth=await options.auth.status();
        if(!auth.connected||!auth.sharing)throw new Error('SIWC direct-use authorization is not connected');
        await options.auth.accessToken();
        const budgetId=`explanatory-budget:${sha(`${spaceId}\0${capability.validation.sha256}`)}`;
        const existing=await releaseFor(input.workflowVersionId,input.caseId,manifest,capability.validation.sha256);
        const payload:ReleasePayload={workflowVersionId:input.workflowVersionId,caseId:input.caseId,inputManifestId:manifest.id,
          inputManifestHash:manifest.hash,validationSha256:capability.validation.sha256,principalId:principal.id,
          budgetId,creationKey:input.idempotencyKey};
        if(existing&&canonical(existing.value)!==canonical(payload))throw new Error('Alternate release or budget for this frozen plan is forbidden');
        await budgets.ensure(spaceId);
        if(existing){
          const persisted=await budgets.read(spaceId,budgetId);
          if(persisted.workflowVersionId!==input.workflowVersionId||
            persisted.validationSha256!==capability.validation.sha256||canonical(persisted.limits)!==canonical(limits))
            throw new Error('Existing explanatory release budget differs from its frozen plan');
        }else await budgets.create(spaceId,{id:budgetId,workflowVersionId:input.workflowVersionId,
          validationSha256:capability.validation.sha256,limits,
          idempotencyKey:`explanatory-budget:${budgetId}`});
        if(!existing){await ownerService.registerSchemas(spaceId,[releaseDefinition]);
          await ownerService.importAsset(spaceId,{assetId:releaseAssetId(capability.validation.sha256),
            schema:releaseRef,payload,dependencies:Object.values(manifest.assets),
            description:'Explicit explanatory method execution release',idempotencyKey:`explanatory-release:${budgetId}`});}
        return {operation:'release',workflowVersionId:input.workflowVersionId,caseId:input.caseId,
          inputManifestId:manifest.id,inputManifestHash:manifest.hash,budgetId,validationSha256:capability.validation.sha256,
          maxProviderRequests:limits.maxCalls,maxDurationMs:limits.maxDurationMs,maxNodeDurationMs:limits.maxNodeDurationMs,
          maxTrialRequests:limits.maxTrialCalls,
          trialSecondKinds:(limits as ExecutionBudgetLimits&{trialSecondKinds?:string[]}).trialSecondKinds??['technical-repair'],
          tokenOrMoneyCap:false};
      });
    }
    if(request.operation==='start'){
      const input=startInput.parse(request.input),execution=await executionFor(input.workflowVersionId);
      const result=await execution.startFromManifest({spaceId,caseId:input.caseId,workflowVersionId:input.workflowVersionId,
        inputManifestId:input.inputManifestId,idempotencyKey:input.idempotencyKey,mode:input.mode,dispatch:false});
      return {operation:'start',workflowVersionId:input.workflowVersionId,caseId:input.caseId,
        runId:result.runId,inputManifestId:result.inputManifestId,status:result.task.status,mode:input.mode};
    }
    const input=dispatchInput.parse(request.input),execution=await executionFor(input.workflowVersionId);
    const prior=await execution.runStatus(spaceId,input.runId);
    const status=await options.withCaseLock(prior.binding.caseId,async()=>{
      await execution.dispatchRun(spaceId,input.runId);
      return execution.runStatus(spaceId,input.runId);
    });
    return {operation:'dispatch',workflowVersionId:input.workflowVersionId,runId:input.runId,
      status:status.executionTask?.status??'unknown'};
  };
  const status=async(selected:string):Promise<Record<string,unknown>>=>{
    requireSpace(selected);
    const auth=await options.auth.status();
    const versions=(await service.overview(spaceId)).workflows.filter(value=>value.entrypoints.content?.workflowId===workflowId);
    const entries=await Promise.all(versions.map(async version=>{
      try{
        const execution=await executionFor(version.id),deployment=await execution.availability();
        const {capability}=await published(version.id);
        const release=await service.readAssetHead(spaceId,releaseAssetId(capability.validation.sha256));
        if(release&&(release.schema.hash!==releaseRef.hash||release.source.kind!=='import'))
          throw new Error('Explanatory release asset type mismatch');
        const payload=release&&(release.payload as ReleasePayload).workflowVersionId===version.id
          ?release.payload as ReleasePayload:undefined;
        const budget=payload?await budgets.read(spaceId,payload.budgetId):null;
        const remaining=budget?budget.limits.maxCalls-budget.reservations.length:0;
        const expired=!!budget?.startedAt&&Date.now()>=Date.parse(budget.startedAt)+budget.limits.maxDurationMs;
        const available=auth.connected&&auth.sharing&&!!payload&&!!budget&&remaining>0&&!expired&&deployment.available;
        return {workflowVersionId:version.id,deployed:deployment.available,
          availability:{available,reason:available?null:!auth.connected||!auth.sharing?'SIWC direct-use authorization is not connected':
            !payload?'No exact execution release exists':expired?'Execution budget duration exceeded':remaining<=0?'Execution budget call limit exceeded':deployment.reason},
          budget:budget?{maxCalls:budget.limits.maxCalls,usedCalls:budget.reservations.length,remainingCalls:remaining,
            usedReservedRequests:budget.reservations.length,remainingProviderRequests:remaining,
            startedAt:budget.startedAt,maxDurationMs:budget.limits.maxDurationMs,maxNodeDurationMs:budget.limits.maxNodeDurationMs,
            maxTrialRequests:budget.limits.maxTrialCalls,tokenOrMoneyCap:false}:null};
      }
      catch(error){return {workflowVersionId:version.id,availability:{available:false,reason:error instanceof Error?error.message:String(error)}};}
    }));
    return {workflowId,entrypoint,auth:{connected:auth.connected,sharing:auth.sharing},versions:entries};
  };
  return {methodExecution:{status,...(options.canWrite?{command}:{})},stop:async()=>{
    await Promise.allSettled([...cache.values()].map(async pending=>(await pending).stop()));
  }};
}
