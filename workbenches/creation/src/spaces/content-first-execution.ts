import {createHash} from 'node:crypto';
import {workflowFingerprint,runWorkflow,type AgentRunRequest,type AgentRunner,type RunRecord} from '@signal-room/workflow';
import {SchemaRegistry,publishStorageContract} from '@signal-room/workflow-space-contracts';
import {WorkflowExecutionManager,WorkflowExecutorRegistry,publishProcessContract,
  type ExecutionTask,type InputManifest,type SpaceCase,type WorkflowSpaceService,type WorkflowVersion,type WorkflowVersionDraft} from '@signal-room/workflow-spaces';
import type {ContentInput} from '../stages/content.js';
import {registerCreationSchemas} from './contracts.js';
import type {ContentDeployment} from './content-method.js';

export const FIRST_METHOD_VERSION_ID='content-first-1a88b59b1fedbc61a40f7ebc9bfc3c00';
export const FIRST_METHOD_WORKFLOW_ID='content.first-method';
export const FIRST_METHOD_ENTRYPOINT='content';
export interface FirstMethodExecutionBudget {maxAgentCalls:15;maxDurationMs:3600000;perAgentTimeoutMs:900000}

export interface FirstMethodExecutionOptions {
  service:WorkflowSpaceService;spaceId:string;principalId:string;deployment:ContentDeployment;
  /** The exact stage-2 candidate, reconstructed from its frozen design basis. */
  candidate:WorkflowVersionDraft;
  /** Checked before queueing, dispatching, and after a worker claim, before the runtime starts. */
  authorizeTask:(input:{caseId:string;versionId:string;manifest:InputManifest;parsed:ContentInput;runId?:string})=>Promise<FirstMethodExecutionBudget>;
  activeBudgets:Map<string,FirstMethodExecutionBudget>;
  /** Serializes all hosts preparing an execution for the same Space and Case. */
  withCaseLock:<T>(caseId:string,work:()=>Promise<T>)=>Promise<T>;
}

const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same=(a:unknown,b:unknown)=>workflowFingerprint(a)===workflowFingerprint(b);

/** Counts persisted node attempts, so a process restart cannot reset the per-run call cap. */
export function createBudgetedFirstMethodRunner(service:Pick<WorkflowSpaceService,'runtimeContexts'>,spaceId:string,
  delegate:AgentRunner,activeBudgets:Map<string,FirstMethodExecutionBudget>):AgentRunner {
  return {async run<Input,Output>(request:AgentRunRequest<Input>) {
    const budget=activeBudgets.get(request.runId);
    if(!budget)throw new Error('First-method Agent call has no active execution budget');
    const contexts=(await service.runtimeContexts(spaceId,request.runId)).filter(item=>item.producer==='agent');
    if(contexts.filter(item=>item.stepRunId===request.stepRunId&&item.attemptId===request.attemptId).length!==1)
      throw new Error('First-method Agent call lacks its exact persisted node context');
    if(contexts.length>budget.maxAgentCalls)throw new Error('First-method Agent call budget exceeded');
    const timeout=AbortSignal.timeout(budget.perAgentTimeoutMs);
    const signal=AbortSignal.any([request.signal,timeout]);
    return delegate.run<Input,Output>({...request,signal});
  }};
}

/** Explicit, single-version deployment. Reading this object cannot create a run or claim a task. */
export async function createFirstMethodExecution(options:FirstMethodExecutionOptions) {
  const {service,spaceId,deployment,candidate}=options;
  if(candidate.id!==FIRST_METHOD_VERSION_ID||candidate.entrypoints.content?.workflowId!==FIRST_METHOD_WORKFLOW_ID||
    candidate.entrypoints.content.storageContract.workflowVersion!==candidate.id||
    candidate.entrypoints.content.codeRevision!=='content-v2'||!candidate.designBasis)
    throw new Error('Current factory cannot reproduce the frozen first-method candidate');
  deployment.verify();
  const declaration=deployment.candidate().version;
  if(!same(declaration.config.models,candidate.config.models))throw new Error('First-method model declaration changed');
  const entry=candidate.entrypoints.content;
  const schemas=new SchemaRegistry();registerCreationSchemas(schemas);
  const storageContract=publishStorageContract(schemas,entry.storageContract);
  const {process:processDraft,...rest}=entry;
  const definition={...rest,storageContract,
    ...(processDraft?{process:await publishProcessContract(processDraft,storageContract)}:{})};
  const registry=new WorkflowExecutorRegistry<ContentDeployment>();
  registry.register({versionId:candidate.id,entrypoint:FIRST_METHOD_ENTRYPOINT,
    config:candidate.config,definition,executor:deployment,verify:deployment.verify});
  const managers=new Map<string,WorkflowExecutionManager>();
  const managerFor=(runId:string)=>{
    let manager=managers.get(runId);
    if(!manager){manager=new WorkflowExecutionManager({service,spaceId,concurrency:1,runId,
      executorKeys:()=>registry.keys(),execute});managers.set(runId,manager);}
    return manager;
  };

  async function published():Promise<WorkflowVersion>{
    const version=await service.readWorkflowVersion(spaceId,FIRST_METHOD_VERSION_ID);
    if(version.id!==candidate.id||version.spaceId!==spaceId||version.predecessorId||
      !same(version.designBasis,candidate.designBasis)||
      version.entrypoints.content?.workflowId!==FIRST_METHOD_WORKFLOW_ID)
      throw new Error('Published first method or its frozen design basis differs from this deployment');
    await registry.resolve(version,FIRST_METHOD_ENTRYPOINT);
    return version;
  }
  async function availability(){
    try{await published();return {available:true as const};}
    catch(error){return {available:false as const,reason:error instanceof Error?error.message:String(error)};}
  }
  async function frozenInput(caseId:string,manifestId:string):Promise<{manifest:InputManifest;parsed:ContentInput}>{
    const manifest=await service.readManifest(spaceId,manifestId);
    if(manifest.id!==manifestId||manifest.spaceId!==spaceId||manifest.caseId!==caseId||
      !manifest.assets.opportunity||!manifest.assets.materials||
      Object.keys(manifest.assets).some(slot=>!['opportunity','materials'].includes(slot)))
      throw new Error('First-method input manifest must contain exact opportunity and materials slots');
    const refs=deployment.candidate().refs;
    const [opportunity,materials]=await Promise.all([
      service.readAsset(spaceId,manifest.assets.opportunity),service.readAsset(spaceId,manifest.assets.materials)]);
    if(opportunity.source.kind!=='import'||materials.source.kind!=='import'||
      !same(opportunity.schema,refs.opportunity)||!same(materials.schema,refs.materials))
      throw new Error('First-method input assets do not match frozen source schemas');
    const parsed=deployment.parseInput({...opportunity.payload as object,materials:materials.payload});
    if(parsed.prior||parsed.webResearch)throw new Error('First method requires original supplied materials and webResearch=false');
    return {manifest,parsed};
  }
  async function authorized(caseId:string,manifest:InputManifest,parsed:ContentInput,runId?:string){
    if(parsed.webResearch)throw new Error('First method cannot dispatch webResearch=true');
    return options.authorizeTask({caseId,versionId:candidate.id,manifest,parsed,...(runId?{runId}:{})});
  }
  async function queue(input:{caseId:string;inputManifestId:string;idempotencyKey:string}){
    if(!input.idempotencyKey.trim())throw new Error('First-method run requires an idempotency key');
    const version=await published();
    const {manifest,parsed}=await frozenInput(input.caseId,input.inputManifestId);
    const caseRecord=await service.readCase(spaceId,input.caseId);
    if(caseRecord.spaceId!==spaceId||caseRecord.id!==input.caseId)throw new Error('First-method Case belongs to another Space');
    // Shared business command idempotency reads this key from the native run.
    const commandKey=`content:${input.caseId}:${input.idempotencyKey}`;
    return options.withCaseLock(input.caseId,async()=>{
      const prior=await service.caseRunsPage(spaceId,input.caseId,FIRST_METHOD_WORKFLOW_ID,
        FIRST_METHOD_ENTRYPOINT,undefined,101);
      if(prior.length){
        if(prior.length!==1||prior[0]!.workflowVersionId!==version.id||
          prior[0]!.inputManifestId!==manifest.id)
          throw new Error('This first-method Case already has a run for another version or frozen input');
        const previous=await(await service.runtimeLedger(spaceId)).getRun(prior[0]!.runId);
        const task=await service.getExecutionTask(spaceId,prior[0]!.runId);
        if(!previous||previous.metadata?.commandKey!==commandKey||!task||
          task.workflowVersionId!==version.id||task.inputManifestId!==manifest.id||
          task.executorKey!==WorkflowExecutorRegistry.key(version.id,FIRST_METHOD_ENTRYPOINT))
          throw new Error('This first-method Case already has a run under a different command');
        const completion=managerFor(task.runId).completion(task.runId);
        void completion.catch(()=>undefined);
        return {runId:task.runId,workflowVersionId:version.id,inputManifestId:manifest.id,task,completion};
      }
      await authorized(input.caseId,manifest,parsed);
      const commandFingerprint=sha({spaceId,caseId:input.caseId,versionId:version.id,
        manifestId:manifest.id,manifestHash:manifest.hash,commandKey});
      const draft:Omit<RunRecord,'id'>={workflowId:FIRST_METHOD_WORKFLOW_ID,
        workflowRevision:version.entrypoints.content!.codeRevision,inputFingerprint:workflowFingerprint(parsed),
        state:'queued',metadata:{spaceId,caseId:input.caseId,inputManifestId:manifest.id,
          workflowVersionId:version.id,entrypoint:FIRST_METHOD_ENTRYPOINT,commandKey,commandFingerprint}};
      const receipt=await service.enqueueExecution(spaceId,
        {workflowVersionId:version.id,entrypoint:FIRST_METHOD_ENTRYPOINT,inputManifestId:manifest.id},draft,
        {executorKey:WorkflowExecutorRegistry.key(version.id,FIRST_METHOD_ENTRYPOINT)});
      const completion=managerFor(receipt.run.id).completion(receipt.run.id);
      void completion.catch(()=>undefined);
      return {runId:receipt.run.id,workflowVersionId:version.id,inputManifestId:manifest.id,
        task:receipt.task,completion};
    });
  }
  async function execute(task:ExecutionTask,signal:AbortSignal){
    const version=await published();
    if(task.spaceId!==spaceId||task.workflowVersionId!==version.id||task.entrypoint!==FIRST_METHOD_ENTRYPOINT||
      task.executorKey!==WorkflowExecutorRegistry.key(version.id,FIRST_METHOD_ENTRYPOINT))
      throw new Error('Claimed task is not this exact first-method deployment');
    const {manifest,parsed}=await frozenInput(task.caseId,task.inputManifestId);
    const budget=await authorized(task.caseId,manifest,parsed,task.runId);
    const native=await(await service.runtimeLedger(spaceId)).getRun(task.runId);
    if(!native||native.state!=='queued'||native.workflowId!==FIRST_METHOD_WORKFLOW_ID||
      native.workflowRevision!==version.entrypoints.content!.codeRevision||
      native.inputFingerprint!==workflowFingerprint(parsed))
      throw new Error('Queued native run differs from its exact frozen first-method input');
    const runtime=await deployment.createRuntime(service,spaceId,{workflowVersionId:version.id,
      entrypoint:FIRST_METHOD_ENTRYPOINT,inputManifestId:manifest.id});
    const workflow={...deployment.workflow(parsed),id:FIRST_METHOD_WORKFLOW_ID};
    options.activeBudgets.set(task.runId,budget);
    try{return await runWorkflow({workflow,input:parsed,...runtime,resumeRunId:task.runId,
      signal:AbortSignal.any([signal,AbortSignal.timeout(budget.maxDurationMs)])});}
    finally{options.activeBudgets.delete(task.runId);}
  }
  async function dispatch(input:{runId:string}){
    await published();
    const task=await service.getExecutionTask(spaceId,input.runId);
    if(!task||task.status!=='queued'||task.workflowVersionId!==candidate.id||
      task.entrypoint!==FIRST_METHOD_ENTRYPOINT||
      task.executorKey!==WorkflowExecutorRegistry.key(candidate.id,FIRST_METHOD_ENTRYPOINT))
      throw new Error('No queued task belongs to this exact first-method version');
    const {manifest,parsed}=await frozenInput(task.caseId,task.inputManifestId);
    await authorized(task.caseId,manifest,parsed,input.runId);
    await managerFor(input.runId).wake();
  }
  const methodAvailability=async(requestSpaceId:string,versionId:string,entrypoint:string)=>{
    if(requestSpaceId!==spaceId||versionId!==candidate.id||entrypoint!==FIRST_METHOD_ENTRYPOINT)
      return {available:false,reason:'This host does not deploy that exact first-method version'};
    return availability();
  };
  const createCase=(requestSpaceId:string,input:Omit<SpaceCase,'spaceId'>)=>{
    if(requestSpaceId!==spaceId)throw new Error('First-method Case belongs to another Space');
    return service.createCase(spaceId,input);
  };
  async function freezeInput(input:{spaceId:string;caseId:string;input:ContentInput;idempotencyKey:string}){
    if(input.spaceId!==spaceId||!input.idempotencyKey.trim())throw new Error('First-method input scope or key is invalid');
    const parsed=deployment.parseInput(input.input);
    if(parsed.prior||parsed.webResearch)throw new Error('First method requires original supplied materials and webResearch=false');
    await service.registerSchemas(spaceId,(await import('./contracts.js')).creationSchemaDefinitions());
    const refs=deployment.candidate().refs;
    const {materials,...opportunity}=parsed;
    const prefix=`first-method:${input.caseId}:${input.idempotencyKey}`;
    const opportunityAsset=await service.importAsset(spaceId,{schema:refs.opportunity,payload:opportunity,
      description:'Frozen first-method opportunity and role input',idempotencyKey:`${prefix}:opportunity`});
    const materialsAsset=await service.importAsset(spaceId,{schema:refs.materials,payload:materials,
      description:'Frozen first-method supplied materials',idempotencyKey:`${prefix}:materials`});
    return service.freezeInputs(spaceId,input.caseId,{opportunity:opportunityAsset.id,materials:materialsAsset.id});
  }
  async function startFromManifest(input:{spaceId:string;caseId:string;workflowVersionId:string;entrypoint?:string;
    inputManifestId:string;idempotencyKey:string;dispatch?:boolean}){
    if(input.spaceId!==spaceId||input.workflowVersionId!==candidate.id||
      (input.entrypoint!==undefined&&input.entrypoint!==FIRST_METHOD_ENTRYPOINT))
      throw new Error('First-method version or Space is unavailable');
    if(input.dispatch!==false)throw new Error('First-method start only queues; dispatch is a separate explicit action');
    return queue(input);
  }
  const dispatchRun=async(requestSpaceId:string,runId:string)=>{
    if(requestSpaceId!==spaceId)throw new Error('First-method run belongs to another Space');
    return dispatch({runId});
  };
  async function runStatus(requestSpaceId:string,runId:string){
    if(requestSpaceId!==spaceId)throw new Error('First-method run belongs to another Space');
    const binding=await service.readRun(spaceId,runId);
    if(binding.workflowVersionId!==candidate.id||binding.entrypoint!==FIRST_METHOD_ENTRYPOINT)
      throw new Error('Run belongs to another method');
    const run=await(await service.runtimeLedger(spaceId)).getRun(runId);
    if(!run)throw new Error('Native first-method run is missing');
    const output=run.output as {details?:{draft?:{id?:string}}}|undefined;
    const draftVersionId=output?.details?.draft?.id
      ?(await service.resolveRuntimeArtifact(spaceId,output.details.draft.id)).id:undefined;
    return {binding,run,draftVersionId,executionTask:await service.getExecutionTask(spaceId,runId)};
  }
  async function stop(){await Promise.all([...managers.values()].map(manager=>manager.stop()));}
  return {availability,published,frozenInput,createCase,freezeInput,startFromManifest,dispatchRun,
    runStatus,methodAvailability,stop};
}
