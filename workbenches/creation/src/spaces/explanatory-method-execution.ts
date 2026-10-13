import {createHash} from 'node:crypto';
import {workflow,workflowFingerprint,runWorkflow,type RunRecord,type WorkflowTerminal,type WorkflowDefinition} from '@signal-room/workflow';
import {WorkflowExecutionManager,WorkflowExecutorRegistry,createExecutionBudgetStore,type ExecutionTask,type InputManifest,
  type SpaceCase,type WorkflowSpaceService,type WorkflowVersion} from '@signal-room/workflow-spaces';
import {check,isTerminal} from '../stages/runtime.js';
import {CONTENT_REVISION,contentResearchAgentOutputSchema,type ContentInput,type ContentResearch} from '../stages/content.js';
import {creationSchemaDefinitions} from './contracts.js';
import type {ExplanatoryMethodCapture} from './explanatory-method-provider.js';
import {createExplanatoryResearchAgent} from './explanatory-method-runner.js';

export type ExplanatoryExecutionMode='research-trial'|'case';
export interface ExplanatoryMethodExecutionOptions {
  service:WorkflowSpaceService;spaceId:string;principalId:string;capture:ExplanatoryMethodCapture;
  authorizeTask:(input:{caseId:string;versionId:string;manifest:InputManifest;parsed:ContentInput;runId?:string;
    mode:ExplanatoryExecutionMode})=>Promise<{budgetId:string}>;
  withCaseLock:<T>(caseId:string,work:()=>Promise<T>)=>Promise<T>;
  /** Set by the host only after the guarded runner and durable budget reservation are installed. */
  guardedRuntimeReady?:()=>boolean;
}
const same=(left:unknown,right:unknown)=>workflowFingerprint(left)===workflowFingerprint(right);
const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A single persisted research phase using the exact captured researcher role and model. */
export function createExplanatoryResearchTrial(capture:ExplanatoryMethodCapture):WorkflowDefinition<ContentInput,WorkflowTerminal<never>> {
  const {candidate,deployment}=capture;
  const researcher=createExplanatoryResearchAgent(deployment);
  return workflow<ContentInput,WorkflowTerminal<never>>(candidate.workflowId,{revision:CONTENT_REVISION},async(ctx,input)=>{
    const found=await ctx.phase('content-research-0',{title:'研究编辑 v1',purpose:deployment.roles.researcher.guards,order:1,
      expectedArtifacts:[{role:'research',title:'材料对答',required:true}]},async phase=>{
      const value=await phase.agent('research',researcher,{opportunity:input.opportunity,readerGoal:input.readerGoal,
        requiredQuestions:input.requiredQuestions,account:input.account,form:input.form,standards:input.standards,
        ...(input.maxSeconds!==undefined?{maxSeconds:input.maxSeconds}:{}),webResearch:false,materials:input.materials}) as ContentResearch;
      const valid=await phase.validate('check-research',value,v=>check(contentResearchAgentOutputSchema,v));
      if(!valid.valid)return phase.blocked({reason:'invalid-research',details:valid.details});
      if(value.notes.length)return phase.blocked({reason:'research-output-not-offline',details:['research.notes: offline research must return an empty array']});
      const available=new Set(input.materials.map(material=>material.id));
      const bad=value.questions.flatMap((question,index)=>question.materialRefs.filter(id=>!available.has(id)).map(id=>
        `research.questions[${index}].materialRefs: unknown source id ${id}`));
      if(bad.length)return phase.blocked({reason:'invalid-research-sources',details:bad});
      const ref=await phase.publish('research','content-research',value,{validation:'valid',review:'not_applicable',dependsOn:[]});
      await phase.bindArtifact(ref,{role:'research',title:'材料对答',primary:true});
      return {value,ref};
    });
    if(isTerminal(found))return found;
    return ctx.needsReview({stage:'CONTENT',reason:'research-trial-complete',research:found.ref});
  });
}

/** Exact candidate deployment; queue and dispatch are separate authorized actions. */
export async function createExplanatoryMethodExecution(options:ExplanatoryMethodExecutionOptions){
  const {service,spaceId,capture}=options,{candidate,deployment}=capture,versionDraft=candidate.version;
  if(candidate.workflowId!=='content.explanatory-method'||candidate.entrypoint!=='content'||
    versionDraft.entrypoints.content?.workflowId!==candidate.workflowId||
    versionDraft.entrypoints.content.storageContract.workflowVersion!==versionDraft.id||!versionDraft.designBasis)
    throw new Error('Explanatory candidate scope or design basis is invalid');
  deployment.verify();
  if(!same(deployment.candidate().version,versionDraft))throw new Error('Explanatory deployment differs from captured candidate');
  const definition=await deployment.frozenDefinition();
  const registry=new WorkflowExecutorRegistry<typeof deployment>();
  registry.register({versionId:versionDraft.id,entrypoint:'content',config:versionDraft.config,definition,
    executor:deployment,verify:deployment.verify});
  const budgets=createExecutionBudgetStore(service);
  const managers=new Map<string,WorkflowExecutionManager>();
  const managerFor=(runId:string)=>{
    let manager=managers.get(runId);
    if(!manager){manager=new WorkflowExecutionManager({service,spaceId,concurrency:1,runId,
      executorKeys:()=>registry.keys(),execute});managers.set(runId,manager);}
    return manager;
  };
  const ready=()=>options.guardedRuntimeReady?.()===true;
  async function published():Promise<WorkflowVersion>{
    const value=await service.readWorkflowVersion(spaceId,versionDraft.id);
    if(value.id!==versionDraft.id||value.spaceId!==spaceId||!same(value.designBasis,versionDraft.designBasis)||
      value.entrypoints.content?.workflowId!==candidate.workflowId||value.predecessorId!==versionDraft.predecessorId)
      throw new Error('Published explanatory method differs from captured candidate');
    await registry.resolve(value,'content');
    return value;
  }
  async function availability(){
    try{if(!ready())throw new Error('Guarded explanatory-method runtime is unavailable');await published();return {available:true as const};}
    catch(error){return {available:false as const,reason:error instanceof Error?error.message:String(error)};}
  }
  async function frozenInput(caseId:string,manifestId:string):Promise<{manifest:InputManifest;parsed:ContentInput}>{
    const manifest=await service.readManifest(spaceId,manifestId);
    if(manifest.id!==manifestId||manifest.spaceId!==spaceId||manifest.caseId!==caseId||
      !manifest.assets.opportunity||!manifest.assets.materials||
      Object.keys(manifest.assets).some(slot=>!['opportunity','materials'].includes(slot)))
      throw new Error('Explanatory input manifest requires exact opportunity and materials slots');
    const refs=deployment.candidate().refs;
    const [opportunity,materials]=await Promise.all([
      service.readAsset(spaceId,manifest.assets.opportunity),service.readAsset(spaceId,manifest.assets.materials)]);
    if(opportunity.source.kind!=='import'||materials.source.kind!=='import'||
      !same(opportunity.schema,refs.opportunity)||!same(materials.schema,refs.materials))
      throw new Error('Explanatory input assets do not match frozen schemas');
    const parsed=deployment.parseInput({...opportunity.payload as object,materials:materials.payload});
    if(parsed.prior||parsed.webResearch!==false||parsed.maxRevisions!==1)
      throw new Error('Explanatory input requires no prior draft, offline research, and two business rounds');
    return {manifest,parsed};
  }
  async function authorized(caseId:string,manifest:InputManifest,parsed:ContentInput,mode:ExplanatoryExecutionMode,runId?:string){
    if(!ready())throw new Error('Guarded explanatory-method runtime is unavailable');
    const result=await options.authorizeTask({caseId,versionId:versionDraft.id,manifest,parsed,mode,...(runId?{runId}:{})});
    if(!result.budgetId?.trim())throw new Error('Explanatory execution budget ID is required');
    const budget=await budgets.read(spaceId,result.budgetId);
    if(budget.workflowVersionId!==versionDraft.id||budget.validationSha256!==
      (versionDraft.config.validation as {sha256?:string})?.sha256)
      throw new Error('Execution budget does not match explanatory method validation');
    return result.budgetId;
  }
  async function native(runId:string){const value=await(await service.runtimeLedger(spaceId)).getRun(runId);
    if(!value)throw new Error('Native explanatory run is missing');return value;}
  async function queue(input:{caseId:string;inputManifestId:string;idempotencyKey:string;mode:ExplanatoryExecutionMode}){
    if(!input.idempotencyKey.trim())throw new Error('Explanatory run requires an idempotency key');
    const version=await published(),{manifest,parsed}=await frozenInput(input.caseId,input.inputManifestId);
    const item=await service.readCase(spaceId,input.caseId);
    if(item.spaceId!==spaceId||item.id!==input.caseId)throw new Error('Explanatory Case belongs to another Space');
    const commandKey=`content:${input.caseId}:${input.mode}:${input.idempotencyKey}`;
    return options.withCaseLock(input.caseId,async()=>{
      const prior=await service.caseRunsPage(spaceId,input.caseId,candidate.workflowId,'content',undefined,101);
      const modeRuns=await Promise.all(prior.map(async run=>({binding:run,native:await native(run.runId)})));
      for(const run of modeRuns){
        if(run.binding.workflowVersionId!==version.id||run.binding.inputManifestId!==manifest.id)
          throw new Error('Explanatory Case already has a run for another version or frozen input');
        if(!['research-trial','case'].includes(String(run.native.metadata?.executionMode)))
          throw new Error('Explanatory Case contains an unscoped prior run');
      }
      const matching=modeRuns.filter(run=>run.native.metadata?.executionMode===input.mode);
      if(matching.length){
        if(matching.length!==1||matching[0]!.native.metadata?.commandKey!==commandKey)
          throw new Error('Explanatory Case already has a different run in this mode');
        const task=await service.getExecutionTask(spaceId,matching[0]!.binding.runId);
        if(!task||task.workflowVersionId!==version.id||task.inputManifestId!==manifest.id||
          task.executorKey!==WorkflowExecutorRegistry.key(version.id,'content'))
          throw new Error('Prior explanatory execution task differs from its command');
        const completion=managerFor(task.runId).completion(task.runId);void completion.catch(()=>undefined);
        return {runId:task.runId,workflowVersionId:version.id,inputManifestId:manifest.id,task,completion};
      }
      const budgetId=await authorized(input.caseId,manifest,parsed,input.mode);
      const draft:Omit<RunRecord,'id'>={workflowId:candidate.workflowId,workflowRevision:version.entrypoints.content!.codeRevision,
        inputFingerprint:workflowFingerprint(parsed),state:'queued',metadata:{spaceId,caseId:input.caseId,inputManifestId:manifest.id,
          workflowVersionId:version.id,entrypoint:'content',commandKey,budgetId,executionMode:input.mode,
          commandFingerprint:sha({spaceId,caseId:input.caseId,versionId:version.id,manifestId:manifest.id,manifestHash:manifest.hash,
            commandKey,budgetId,mode:input.mode})}};
      const receipt=await service.enqueueExecution(spaceId,{workflowVersionId:version.id,entrypoint:'content',inputManifestId:manifest.id},draft,
        {executorKey:WorkflowExecutorRegistry.key(version.id,'content')});
      const completion=managerFor(receipt.run.id).completion(receipt.run.id);void completion.catch(()=>undefined);
      return {runId:receipt.run.id,workflowVersionId:version.id,inputManifestId:manifest.id,task:receipt.task,completion};
    });
  }
  async function execute(task:ExecutionTask,signal:AbortSignal){
    const version=await published();
    if(task.spaceId!==spaceId||task.workflowVersionId!==version.id||task.entrypoint!=='content'||
      task.executorKey!==WorkflowExecutorRegistry.key(version.id,'content'))
      throw new Error('Claimed task is not the explanatory deployment');
    const {manifest,parsed}=await frozenInput(task.caseId,task.inputManifestId);
    const stored=await native(task.runId),mode=stored.metadata?.executionMode;
    if((mode!=='research-trial'&&mode!=='case')||stored.state!=='queued'||stored.workflowId!==candidate.workflowId||
      stored.workflowRevision!==version.entrypoints.content!.codeRevision||stored.inputFingerprint!==workflowFingerprint(parsed))
      throw new Error('Queued explanatory run differs from frozen input or mode');
    const budgetId=await authorized(task.caseId,manifest,parsed,mode,task.runId);
    if(stored.metadata?.budgetId!==budgetId)throw new Error('Queued execution budget identity changed');
    const budget=await budgets.read(spaceId,budgetId);
    const remaining=budget.startedAt?Date.parse(budget.startedAt)+budget.limits.maxDurationMs-Date.now():budget.limits.maxDurationMs;
    if(remaining<=0)throw new Error('Execution budget duration exceeded');
    const runtime=await deployment.createRuntime(service,spaceId,{workflowVersionId:version.id,entrypoint:'content',inputManifestId:manifest.id});
    const selected=mode==='research-trial'?createExplanatoryResearchTrial(capture):deployment.workflow(parsed);
    return runWorkflow({workflow:selected,input:parsed,...runtime,resumeRunId:task.runId,
      signal:AbortSignal.any([signal,AbortSignal.timeout(Math.max(1,remaining))])});
  }
  async function dispatch(input:{runId:string}){
    const version=await published(),task=await service.getExecutionTask(spaceId,input.runId);
    if(!task||task.status!=='queued'||task.workflowVersionId!==version.id||task.entrypoint!=='content'||
      task.executorKey!==WorkflowExecutorRegistry.key(version.id,'content'))
      throw new Error('No queued task belongs to this explanatory version');
    const {manifest,parsed}=await frozenInput(task.caseId,task.inputManifestId);
    const stored=await native(task.runId),mode=stored.metadata?.executionMode;
    if(mode!=='research-trial'&&mode!=='case')throw new Error('Queued explanatory mode is missing');
    const budgetId=await authorized(task.caseId,manifest,parsed,mode,task.runId);
    if(stored.metadata?.budgetId!==budgetId)throw new Error('Queued execution budget identity changed');
    await managerFor(input.runId).wake();
  }
  const createCase=(requestSpaceId:string,input:Omit<SpaceCase,'spaceId'>)=>{
    if(requestSpaceId!==spaceId)throw new Error('Explanatory Case belongs to another Space');
    return service.createCase(spaceId,input);
  };
  async function freezeInput(input:{spaceId:string;caseId:string;input:ContentInput;idempotencyKey:string}){
    if(input.spaceId!==spaceId||!input.idempotencyKey.trim())throw new Error('Explanatory input scope or key is invalid');
    const parsed=deployment.parseInput(input.input);
    if(parsed.prior||parsed.webResearch!==false||parsed.maxRevisions!==1)
      throw new Error('Explanatory input requires no prior draft, offline research, and two business rounds');
    await service.registerSchemas(spaceId,creationSchemaDefinitions());
    const refs=deployment.candidate().refs,{materials,...opportunity}=parsed;
    const prefix=`explanatory:${input.caseId}:${input.idempotencyKey}`;
    const opportunityAsset=await service.importAsset(spaceId,{schema:refs.opportunity,payload:opportunity,
      description:'Frozen explanatory opportunity',idempotencyKey:`${prefix}:opportunity`});
    const materialsAsset=await service.importAsset(spaceId,{schema:refs.materials,payload:materials,
      description:'Frozen explanatory materials',idempotencyKey:`${prefix}:materials`});
    return service.freezeInputs(spaceId,input.caseId,{opportunity:opportunityAsset.id,materials:materialsAsset.id});
  }
  async function startFromManifest(input:{spaceId:string;caseId:string;workflowVersionId:string;entrypoint?:string;
    inputManifestId:string;idempotencyKey:string;dispatch?:boolean;mode?:ExplanatoryExecutionMode}){
    if(input.spaceId!==spaceId||input.workflowVersionId!==versionDraft.id||
      (input.entrypoint!==undefined&&input.entrypoint!=='content'))throw new Error('Explanatory version or Space is unavailable');
    if(input.dispatch!==false)throw new Error('Explanatory start only queues; dispatch is a separate action');
    return queue({...input,mode:input.mode??'case'});
  }
  const dispatchRun=async(requestSpaceId:string,runId:string)=>{
    if(requestSpaceId!==spaceId)throw new Error('Explanatory run belongs to another Space');
    return dispatch({runId});
  };
  async function runStatus(requestSpaceId:string,runId:string){
    if(requestSpaceId!==spaceId)throw new Error('Explanatory run belongs to another Space');
    const binding=await service.readRun(spaceId,runId);
    if(binding.workflowVersionId!==versionDraft.id||binding.entrypoint!=='content')throw new Error('Run belongs to another method');
    const run=await native(runId);
    const output=run.output as {details?:{draft?:{id?:string}}}|undefined;
    const draftVersionId=output?.details?.draft?.id?(await service.resolveRuntimeArtifact(spaceId,output.details.draft.id)).id:undefined;
    return {binding,run,draftVersionId,executionTask:await service.getExecutionTask(spaceId,runId)};
  }
  const methodAvailability=async(requestSpaceId:string,versionId:string,entrypoint:string)=>
    requestSpaceId!==spaceId||versionId!==versionDraft.id||entrypoint!=='content'
      ?{available:false as const,reason:'This host does not deploy that exact explanatory version'}:availability();
  async function stop(){await Promise.all([...managers.values()].map(manager=>manager.stop()));}
  return {availability,published,frozenInput,createCase,freezeInput,startFromManifest,dispatchRun,runStatus,methodAvailability,
    resolveRunBudget:async(runId:string)=>{const run=await native(runId),mode=run.metadata?.executionMode,budgetId=run.metadata?.budgetId;
      if((mode!=='case'&&mode!=='research-trial')||typeof budgetId!=='string')throw new Error('Run budget metadata is invalid');
      return {budgetId,mode};},stop};
}
