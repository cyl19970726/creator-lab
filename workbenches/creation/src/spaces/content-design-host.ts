import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createConnection} from 'node:net';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';
import type {AgentRunner} from '@signal-room/workflow';
import {SiwcAuth} from '@signal-room/workflow-agent-sdk';
import {WorkflowSpaceService, createBusinessUnderstandingStore, createMethodDesignStore, createRunDispositionStore,createRunDiagnosisStore,createExternalAgentObservationStore,EXTERNAL_AGENT_ASSET_OBSERVATION_SCHEMA_REF,
  migrateWorkflowSpaces, type BusinessUnderstandingRevision, type MethodDesignRevision, type SpacePrincipal, type WorkflowVersionDraft} from '@signal-room/workflow-spaces';
import type {MethodDesignPreviewDto, MethodDesignPublicationReceiptDto} from '@signal-room/workflow-space-api/contracts';
import type {SpaceApiHost} from '@signal-room/workflow-space-api/server';
import {openConfiguredContentBlobs} from './blob-configuration.js';
import {createContentDeployment, canonicalContentDefinition} from './content-method.js';
import {contentSiwcExecutorManifest,createContentSiwcRunner} from './content-runner.js';
import {createBudgetedFirstMethodRunner,createFirstMethodExecution,FIRST_METHOD_VERSION_ID,
  type FirstMethodExecutionBudget,type FirstMethodExecutionOptions} from './content-first-execution.js';
import {createContentFirstExecutionGate,type ContentFirstExecutionRelease} from './content-first-execution-release.js';
import {createContentBusinessCommands,createContentBusinessImportedAssetScope,
  type ContentBusinessCommandOptions,type ContentBusinessExecutionRelease} from './content-business-commands.js';
import {createContentProcessResolver} from './process.js';
import {createContentBusinessAdapter,createContentRunSummary} from './presentation.js';
import {contentFrozenInputSummary} from './readers.js';
import {creationAssetReaders,readContentDraftResponse} from './readers.js';
import {creationSchemaDefinitions} from './contracts.js';
import {researchReviewStandard} from './research-review-standard.js';

export const CONTENT_DESIGN_SPACE_ID = 'content-design-acceptance-20261009';
export const CONTENT_FIRST_METHOD_WORKFLOW_ID = 'content.first-method';
export const CONTENT_FIRST_METHOD_ENTRYPOINT = 'content';
const firstMethodRevision = 'first-method-v1';
const purpose = '完整内容首版 · 设计验收';
const digest = (value:unknown):string => createHash('sha256').update(canonicalContentDefinition(value)).digest('hex');

/** The candidate identity binds an exact design/understanding pair to one code declaration. */
export function buildFirstMethodVersion(declaration:WorkflowVersionDraft,design:MethodDesignRevision,
  understanding:BusinessUnderstandingRevision):WorkflowVersionDraft {
  if(design.workflowId!==CONTENT_FIRST_METHOD_WORKFLOW_ID||design.entrypoint!==CONTENT_FIRST_METHOD_ENTRYPOINT)
    throw new Error('Method design revision belongs to another workflow');
  if(design.understanding.revisionId!==understanding.id||design.understanding.payloadHash!==understanding.payloadHash)
    throw new Error('Method design understanding basis changed or is inconsistent');
  const source=declaration.entrypoints[CONTENT_FIRST_METHOD_ENTRYPOINT];
  if(!source)throw new Error('CONTENT declaration has no content entrypoint');
  const designBasis={designRevisionId:design.id,designPayloadHash:design.payloadHash,
    understandingRevisionId:understanding.id,understandingPayloadHash:understanding.payloadHash};
  const designSelection={status:'unexecuted-pending-validation',executionAvailability:'unavailable',
    models:declaration.config.models};
  const {predecessorId:_predecessorId,...firstDeclaration}=declaration;
  const declared={...firstDeclaration,config:{...firstDeclaration.config,designSelection}};
  const id=`content-first-${digest({designBasis,declarationHash:digest(declared)}).slice(0,32)}`;
  return {...firstDeclaration,id,revision:firstMethodRevision,
    changeReason:`首版方法依据设计草案「${design.title}」：${design.changeReason}`,
    config:declared.config,
    designBasis,entrypoints:{[CONTENT_FIRST_METHOD_ENTRYPOINT]:{...source,
      workflowId:CONTENT_FIRST_METHOD_WORKFLOW_ID,
      storageContract:{...source.storageContract,workflowVersion:id}}}};
}

interface DesignHostConfig {databaseUrl?:string; principal?:string;spaceId?:string}

const portIsClosed=(port:number)=>new Promise<boolean>(resolve=>{
  const socket=createConnection({host:'127.0.0.1',port});let settled=false;
  const finish=(closed:boolean)=>{if(!settled){settled=true;socket.destroy();resolve(closed);}};
  socket.once('connect',()=>finish(false));
  socket.once('error',error=>finish((error as NodeJS.ErrnoException).code==='ECONNREFUSED'));
  socket.setTimeout(1500,()=>finish(false));
});

/** A declaration-only runner keeps preview and setup free of business calls. */
const disabledRunner:AgentRunner={async run(){throw new Error('This Space is for method design; execution is unavailable');}};

/** A trusted Agent may publish only a revision that its own scoped service recorded. */
export function assertPublishableDesignDraft(requestPrincipal:SpacePrincipal,design:MethodDesignRevision):void{
  if(requestPrincipal.kind==='human')return;
  const agent=requestPrincipal.externalAgent;
  if(!agent||agent.role!=='design')throw new Error('Design Agent credential required');
  if(design.recordedBy!==requestPrincipal.id||design.authorship.kind!=='agent'||
    design.authorship.name!==agent.id||design.authorship.sessionId!==agent.sessionId)
    throw new Error('Method design revision does not belong to the authenticated design Agent');
}

export async function openContentDesignHost(options:{authorizeTask?:FirstMethodExecutionOptions['authorizeTask'];probeExecution?:boolean}={}) {
  const root=fileURLToPath(new URL('../../../../',import.meta.url));
  const configPath=resolve(process.env.CONTENT_WORKBENCH_CONFIG??`${root}/.local/content-space/runtime.json`);
  let config:DesignHostConfig={};
  try{config=JSON.parse(await readFile(configPath,'utf8')) as DesignHostConfig;}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const databaseUrl=process.env.WORKFLOW_DATABASE_URL??config.databaseUrl;
  if(!databaseUrl)throw new Error('A private Workflow Space database connection is required');
  const model=process.env.CONTENT_DESIGN_MODEL??'gpt-6-luna';
  if(!model.trim())throw new Error('CONTENT_DESIGN_MODEL must be nonempty');
  const principal:SpacePrincipal={id:process.env.WORKFLOW_SPACE_PRINCIPAL??config.principal??'local-owner',kind:'human'};
  const effort=process.env.CONTENT_DESIGN_REASONING_EFFORT??'high';
  if(!['low','medium','high'].includes(effort))throw new Error('Unsupported CONTENT_DESIGN_REASONING_EFFORT');
  const deployment=createContentDeployment({runner:disabledRunner,
    models:{worker:{model,reasoningEffort:effort as 'low'|'medium'|'high'},judge:{model,reasoningEffort:effort as 'low'|'medium'|'high'}},
    executorManifest:contentSiwcExecutorManifest()});
  const pool=new Pool({connectionString:databaseUrl,application_name:'content-first-method-design'});
  const {blobs,legacy}=await openConfiguredContentBlobs(pool);
  const serviceFor=(requestPrincipal:SpacePrincipal):WorkflowSpaceService=>{
    let scoped:WorkflowSpaceService;
    scoped=new WorkflowSpaceService(pool,blobs,requestPrincipal,{
      readerIds:Object.keys(creationAssetReaders),
      resultRoleIds:['final-draft','research','cold-read','fact-check','editorial-review'],
      processResolvers:{[CONTENT_FIRST_METHOD_WORKFLOW_ID]:input=>createContentProcessResolver(scoped)(input)},
    });
    return scoped;
  };
  const service=serviceFor(principal);
  const releasePath=resolve(process.env.CONTENT_FIRST_EXECUTION_RELEASE??`${root}/.local/cognition-loop/case-execution-stage3-20261009/execution-release.json`);
  const loadRelease=async():Promise<ContentFirstExecutionRelease|null>=>{
    try{return JSON.parse(await readFile(releasePath,'utf8')) as ContentFirstExecutionRelease;}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  };
  const verifyExclusive=async(release:ContentBusinessExecutionRelease):Promise<boolean>=>{
    const ports=release.exclusive?.disabledPorts;
    const servingPort=Number(process.env.METHOD_DESIGN_WORKBENCH_PORT??4398);
    if(!Array.isArray(ports)||![4393,4394,4396].every(port=>ports.includes(port))||
      !ports.every(port=>Number.isInteger(port)&&port>0&&port<=65535&&port!==servingPort)||
      !(await Promise.all([...new Set(ports)].map(portIsClosed))).every(Boolean))return false;
    const oldSpaceId=process.env.WORKFLOW_SPACE_ID??config.spaceId??'creator-content';
    if(oldSpaceId===CONTENT_DESIGN_SPACE_ID)return false;
    if((await service.listSpaces()).some(space=>space.id===oldSpaceId)){
      const oldTasks=await service.executionTasks(oldSpaceId);
      if(oldTasks.some(task=>['queued','running','cancel_requested','interrupted'].includes(task.status)))return false;
    }
    return true;
  };
  const executionGate=createContentFirstExecutionGate({spaceId:CONTENT_DESIGN_SPACE_ID,principalId:principal.id,
    models:deployment.models,loadRelease,verifyExclusive});
  const authorizeTask:FirstMethodExecutionOptions['authorizeTask']=async subject=>{
    const tasks=await service.executionTasks(CONTENT_DESIGN_SPACE_ID);
    if(tasks.some(task=>task.runId!==subject.runId&&
      ['queued','running','cancel_requested','interrupted'].includes(task.status)))
      throw new Error('Independent first-method Space has another unfinished execution task');
    await options.authorizeTask?.(subject);
    return executionGate(subject);
  };
  const withCaseLock:FirstMethodExecutionOptions['withCaseLock']=async(caseId,work)=>{
    const client=await pool.connect();
    const lockKey=createHash('sha256').update(`${CONTENT_DESIGN_SPACE_ID}:${caseId}`).digest().readInt32BE(0);
    try{
      await client.query('SELECT pg_advisory_lock($1,$2)',[0x464d4341,lockKey]);
      return await work();
    }finally{
      try{await client.query('SELECT pg_advisory_unlock($1,$2)',[0x464d4341,lockKey]);}
      finally{client.release();}
    }
  };

  const requireSpace=(spaceId:string):void=>{
    if(spaceId!==CONTENT_DESIGN_SPACE_ID)throw new Error('Method design request is outside the independent Space');
  };
  const checkedDesign=(design:MethodDesignRevision):MethodDesignRevision=>{
    if(design.workflowId!==CONTENT_FIRST_METHOD_WORKFLOW_ID||design.entrypoint!==CONTENT_FIRST_METHOD_ENTRYPOINT)
      throw new Error('Method design revision belongs to another workflow');
    return design;
  };
  let executionAvailability:{state:'available'|'unavailable';reason:string|null}={state:'unavailable',reason:'准确执行部署尚未核对'};
  const methodDesignFor=(requestService:WorkflowSpaceService,requestPrincipal:SpacePrincipal)=>{
    const designStore=createMethodDesignStore(requestService);
    const understandingStore=createBusinessUnderstandingStore(requestService);
    const designAgent=requestPrincipal.kind==='service'&&requestPrincipal.externalAgent?.role==='design'
      ?requestPrincipal.externalAgent:null;
    const requireDesignWriter=()=>{
      if(requestPrincipal.kind==='service'&&!designAgent)throw new Error('Design Agent credential required');
    };
    const requireOwnAgentDraft=(design:MethodDesignRevision)=>assertPublishableDesignDraft(requestPrincipal,design);
    const candidate=async(spaceId:string,revisionId:string):Promise<{version:WorkflowVersionDraft;preview:MethodDesignPreviewDto;presentation:ReturnType<typeof deployment.candidate>['presentation']}>=>{
      requireSpace(spaceId);
      const design=checkedDesign(await designStore.read(spaceId,revisionId));
      const understanding=await understandingStore.read(spaceId,design.understanding.revisionId);
      if(understanding.id!==design.understanding.revisionId||understanding.payloadHash!==design.understanding.payloadHash)
        throw new Error('Method design understanding basis changed or is inconsistent');
      await deployment.frozenDefinition();
      const declaration=deployment.candidate();
      const version=buildFirstMethodVersion(declaration.version,design,understanding);
      const availability=version.id===FIRST_METHOD_VERSION_ID?executionAvailability:
        {state:'unavailable' as const,reason:'此草案尚无对应的准确执行部署'};
      const preview:MethodDesignPreviewDto={versionId:version.id,workflowId:CONTENT_FIRST_METHOD_WORKFLOW_ID,
        entrypoint:CONTENT_FIRST_METHOD_ENTRYPOINT,designRevisionId:design.id,designHash:design.payloadHash,
        understandingRevisionId:understanding.id,understandingHash:understanding.payloadHash,
        availability:availability.state,
        ...(availability.state==='available'?{}:{blockers:[availability.reason??'准确执行部署不可用']})};
      return {version,preview,presentation:declaration.presentation};
    };
    const scoped={
      async current(spaceId:string){requireSpace(spaceId);return designStore.current(spaceId,CONTENT_FIRST_METHOD_WORKFLOW_ID);},
      async read(spaceId:string,revisionId:string){requireSpace(spaceId);return checkedDesign(await designStore.read(spaceId,revisionId));},
      async history(spaceId:string){requireSpace(spaceId);return designStore.history(spaceId,CONTENT_FIRST_METHOD_WORKFLOW_ID);},
      async basis(spaceId:string,versionId:string){
        requireSpace(spaceId);const value=await designStore.readBasis(spaceId,versionId);
        if(value)checkedDesign(value.design);
        return value;
      },
      async save(spaceId:string,input:Parameters<typeof designStore.save>[1]){
        requireSpace(spaceId);
        requireDesignWriter();
        if(designAgent&&(input.authorship.kind!=='agent'||input.authorship.name!==designAgent.id||
          input.authorship.sessionId!==designAgent.sessionId))
          throw new Error('Method design authorship must match the authenticated design Agent');
        if(input.workflowId!==CONTENT_FIRST_METHOD_WORKFLOW_ID||input.entrypoint!==CONTENT_FIRST_METHOD_ENTRYPOINT)
          throw new Error('Method design request has the wrong workflow identity');
        const saved=checkedDesign(await designStore.save(spaceId,input));
        requireOwnAgentDraft(saved);
        return saved;
      },
      async preview(spaceId:string,revisionId:string){return (await candidate(spaceId,revisionId)).preview;},
      async publish(spaceId:string,input:{designRevisionId:string;expectedCandidateId:string}):Promise<MethodDesignPublicationReceiptDto>{
        requireSpace(spaceId);
        requireDesignWriter();
        // A session lock serializes competing first-publication requests, including
        // requests served by separate local host processes.
        const client=await pool.connect();
        const lockKey=createHash('sha256').update(spaceId).digest().readInt32BE(0);
        try{
          await client.query('SELECT pg_advisory_lock($1,$2)',[0x4d445347,lockKey]);
          requireOwnAgentDraft(checkedDesign(await designStore.read(spaceId,input.designRevisionId)));
          const selected=await candidate(spaceId,input.designRevisionId);
          if(input.expectedCandidateId!==selected.version.id)throw new Error('Method candidate changed; preview the exact design revision again');
          const recorded=(await requestService.overview(spaceId)).workflows;
          if(recorded.some(version=>version.id!==selected.version.id))
            throw new Error('This independent Space already has a first method version; another first version cannot be published');
          const existing=recorded.find(version=>version.id===selected.version.id);
          if(existing&&(existing.predecessorId||existing.entrypoints.content?.workflowId!==CONTENT_FIRST_METHOD_WORKFLOW_ID||
            existing.designBasis?.designRevisionId!==input.designRevisionId))
            throw new Error('Existing method version is not this exact first design');
          // Registration is an exact, host-checked owner delegation. The Agent remains
          // an operator and authors the draft; the owner service records the version.
          const publisher=designAgent?service:requestService;
          const published=await publisher.publishWorkflow(spaceId,selected.version);
          const registered=await publisher.registerPresentation(spaceId,selected.presentation);
          const binding=await requestService.resolvePresentation(spaceId,published.id,CONTENT_FIRST_METHOD_ENTRYPOINT);
          if(binding&&(binding.presentation.hash!==registered.hash||binding.presentation.id!==registered.id||binding.presentation.revision!==registered.revision))
            throw new Error('Existing method presentation binding differs from the frozen declaration');
          if(!binding)await publisher.bindPresentation(spaceId,{workflowVersionId:published.id,
            entrypoint:CONTENT_FIRST_METHOD_ENTRYPOINT,presentationId:registered.id,revision:registered.revision});
          return {versionId:published.id,designRevisionId:input.designRevisionId,
            understandingRevisionId:selected.version.designBasis!.understandingRevisionId};
        }finally{
          try{await client.query('SELECT pg_advisory_unlock($1,$2)',[0x4d445347,lockKey]);}
          finally{client.release();}
        }
      },
    };
    return scoped;
  };
  const methodDesign=methodDesignFor(service,principal);
  let execution:Awaited<ReturnType<typeof createFirstMethodExecution>>|null=null;
  if(options.probeExecution!==false&&(await service.listSpaces()).some(space=>space.id===CONTENT_DESIGN_SPACE_ID)){
    try{
      const basis=await methodDesign.basis(CONTENT_DESIGN_SPACE_ID,FIRST_METHOD_VERSION_ID);
      if(!basis)throw new Error('Published first method has no frozen design basis');
      const activeBudgets=new Map<string,FirstMethodExecutionBudget>();
      const runner=createBudgetedFirstMethodRunner(service,CONTENT_DESIGN_SPACE_ID,
        createContentSiwcRunner({service,spaceId:CONTENT_DESIGN_SPACE_ID,auth:new SiwcAuth()}),activeBudgets);
      const executable=createContentDeployment({runner,models:deployment.models,
        executorManifest:contentSiwcExecutorManifest()});
      const candidate=buildFirstMethodVersion(executable.candidate().version,basis.design,basis.understanding);
      execution=await createFirstMethodExecution({service,spaceId:CONTENT_DESIGN_SPACE_ID,principalId:principal.id,
        deployment:executable,candidate,activeBudgets,withCaseLock,
        authorizeTask});
      const result=await execution.availability();
      executionAvailability=result.available?{state:'available',reason:null}:{state:'unavailable',reason:result.reason};
    }catch(error){executionAvailability={state:'unavailable',reason:error instanceof Error?error.message:String(error)};}
  }
  return {
    pool,service,principal,spaceId:CONTENT_DESIGN_SPACE_ID,methodDesign,execution,
    executionAvailability,
    async assertInitialized(){
      if(!(await service.listSpaces()).some(space=>space.id===CONTENT_DESIGN_SPACE_ID))
        throw new Error('Independent design Space is absent; run method-design-workbench.ts setup explicitly');
    },
    async setup(options:{migrate?:boolean}={}){
      if(options.migrate){await migrateWorkflowSpaces(pool);await legacy.migrate();}
      if(!(await service.listSpaces()).some(space=>space.id===CONTENT_DESIGN_SPACE_ID))
        await service.createSpace({id:CONTENT_DESIGN_SPACE_ID,purpose});
      await service.registerSchemas(CONTENT_DESIGN_SPACE_ID,creationSchemaDefinitions());
      const understanding=await createBusinessUnderstandingStore(service).ensure(CONTENT_DESIGN_SPACE_ID);
      const design=await createMethodDesignStore(service).ensure(CONTENT_DESIGN_SPACE_ID);
      const disposition=await createRunDispositionStore(service).ensure(CONTENT_DESIGN_SPACE_ID);
      const diagnosis=await createRunDiagnosisStore(service).ensure(CONTENT_DESIGN_SPACE_ID);
      const observation=await createExternalAgentObservationStore(service).ensure(CONTENT_DESIGN_SPACE_ID);
      return {spaceId:CONTENT_DESIGN_SPACE_ID,understandingSchema:understanding,methodDesignSchema:design,dispositionSchema:disposition,diagnosisSchema:diagnosis,
        observationSchema:observation,assetObservationSchema:EXTERNAL_AGENT_ASSET_OBSERVATION_SCHEMA_REF};
    },
    hostFor(requestPrincipal:SpacePrincipal):Omit<SpaceApiHost,'principal'|'cacheScope'>{
      const requestService=serviceFor(requestPrincipal);
      const understanding=createBusinessUnderstandingStore(requestService);
      const designAccess=methodDesignFor(requestService,requestPrincipal);
      const externalAgent=!!requestPrincipal.externalAgent;
      const designAgent=requestPrincipal.kind==='service'&&requestPrincipal.externalAgent?.role==='design';
      let businessOptions:ContentBusinessCommandOptions|undefined;
      if(execution&&requestPrincipal.id===principal.id&&requestPrincipal.kind===principal.kind)
        businessOptions={service:requestService,workbench:execution,
          spaceId:CONTENT_DESIGN_SPACE_ID,principalId:requestPrincipal.id,models:deployment.models,
          workflowId:CONTENT_FIRST_METHOD_WORKFLOW_ID,loadRelease,verifyExclusive,
          extraConditions:['执行器：SIWC Responses / read_bound_asset',
            '最多 3 个业务轮次、15 次 Agent 调用；单节点 15 分钟、整体 60 分钟',
            '未设置金额或总 token 预算；实际成本待运行核对',
            '初次发起由认知负责人前端操作；失败不自动重跑']};
      return {service:requestService,attachmentWrites:true,scope:{workflowId:CONTENT_FIRST_METHOD_WORKFLOW_ID,entrypoint:CONTENT_FIRST_METHOD_ENTRYPOINT},
        readers:creationAssetReaders,unpublishedResponseReader:({nodeId,output})=>nodeId==='author'?readContentDraftResponse(output):null,
        reviewStandard:async({spaceId,runId,target})=>{
          if(spaceId!==CONTENT_DESIGN_SPACE_ID)return null;
          const run=await requestService.readRun(spaceId,runId);
          const manifest=await requestService.readManifest(spaceId,run.inputManifestId);
          const opportunityId=manifest.assets.opportunity;
          if(!opportunityId)return null;
          const opportunity=await requestService.readAsset(spaceId,opportunityId);
          if(target?.kind==='asset'){
            const asset=await requestService.readAsset(spaceId,target.assetVersionId);
            if(asset.source.kind!=='node'||asset.source.runId!==runId||asset.schema.namespace!=='creation/content-research')return null;
            const context=await requestService.readContext(spaceId,asset.source.generatedByContextId??asset.source.contextId);
            if(context.runId!==runId)return null;
            return researchReviewStandard({context,manifest,opportunity:opportunity.payload,schemaHash:asset.schema.hash});
          }
          const payload=opportunity.payload as {standards?:unknown};
          return typeof payload.standards==='string'&&payload.standards.trim()
            ?{id:'content-input-standard',revision:manifest.hash,content:payload.standards}:null;
        },
        adapter:createContentBusinessAdapter(requestService),
        runSummary:createContentRunSummary(requestService),inputSlotOrder:['opportunity','materials'],
        inputSummary:contentFrozenInputSummary,displayTimeZone:'Asia/Taipei',
        understanding:externalAgent&&!designAgent?{current:understanding.current,read:understanding.read,history:understanding.history}:understanding,
        methodDesign:externalAgent&&!designAgent?{current:designAccess.current,read:designAccess.read,history:designAccess.history,basis:designAccess.basis,
          preview:designAccess.preview}:designAccess,
        runDisposition:createRunDispositionStore(requestService),
        runDiagnosis:createRunDiagnosisStore(requestService),
        ...(businessOptions?{business:createContentBusinessCommands(businessOptions),
          importedAssetScope:createContentBusinessImportedAssetScope(businessOptions)}:{}),
        availability:(versionId:string)=>versionId===FIRST_METHOD_VERSION_ID?executionAvailability:
          {state:'unavailable',reason:'此版本没有对应的准确执行部署。'}};
    },
  };
}
