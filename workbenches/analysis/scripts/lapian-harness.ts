import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';
import {PostgresWorkflowRunStore} from '@signal-room/workflow-postgres';
import {WorkflowSpaceService,PostgresBlobStore,migrateWorkflowSpaces,createBusinessUnderstandingStore,createMethodDesignStore,createRunDispositionStore,createRunDiagnosisStore,createExternalAgentObservationStore,type SpacePrincipal} from '@signal-room/workflow-spaces';
import {createSpaceWorkbenchApp} from '@signal-room/workflow-space-api/workbench-server';
import {provisionDesignWorkbenchCredential} from '@signal-room/workflow-space-api/workbench-credentials';
import {compileLapianMethod,lapianMethodDesignHost} from '../packages/adapters/src/harness/design.js';
import {importLapianHistory,HISTORY_SCHEMA} from '../packages/adapters/src/harness/history.js';
import {importFailedBuilderDrafts} from '../packages/adapters/src/harness/failed-drafts.js';
import {createHash} from 'node:crypto';
import {lapianReaders} from '../packages/adapters/src/harness/readers.js';
import {analysisPostProcessResolvers} from '../packages/adapters/src/harness/process.js';
import {prepareSpaceExecution,bindSpaceExecution,syncSpaceExecution} from '../packages/adapters/src/harness/space-execution.js';
import {createBoundedPostExecutionProvider} from '../packages/adapters/src/harness/execution.js';
import {implementationCredentialFile,observerCredentialFile,provisionLapianObserverCredential,
 readLapianCredentials} from './lapian-credentials.js';
import {lapianHostMode} from './lapian-host-mode.js';

const analysisRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=path.resolve(analysisRoot,'../..');
const runtime=path.resolve(process.env.LAPIAN_HARNESS_DIR??path.join(root,'.local/lapian-harness'));
const spaceId=process.env.LAPIAN_SPACE_ID??'lapian-harness-20261014';
const sourceWorkspaceId=process.env.SELF_MEDIA_WORKSPACE_ID??'creator-lab-analysis';
const credentialFile=implementationCredentialFile(runtime);
const readOnly=process.env.LAPIAN_HARNESS_READ_ONLY==='true';
const command=process.argv[2]??'help';
if(command==='help'){
 console.log('lapian:harness setup | observer-setup | import ROOT_RUN_ID TITLE | document RUN_ID ABS_FILE | method | serve | status PREPARED_ID | follow PREPARED_ID\nReads existing private SELF_MEDIA_DATABASE_URL and SELF_MEDIA_RUNTIME_DIR. setup explicitly creates a separate Space; observer-setup grants only a separate observer on the existing Space and does not migrate or run models. LAPIAN_HARNESS_READ_ONLY=true serves evidence and observer assessments without execution or design mutation.');process.exit(0);
}
fs.mkdirSync(runtime,{recursive:true,mode:0o700});
const pool=new Pool({connectionString:process.env.SELF_MEDIA_DATABASE_URL,max:6});
const owner:SpacePrincipal={id:'lapian-local-owner',kind:'human'};
const blobs=new PostgresBlobStore(pool);
const serviceFor=(principal:SpacePrincipal)=>new WorkflowSpaceService(pool,blobs,principal,{processResolvers:analysisPostProcessResolvers,readerIds:Object.keys(lapianReaders),resultRoleIds:['report','review','evidence','candidate','revision','registered-version'],historicalSourceWorkspaceIds:[sourceWorkspaceId]});
const service=serviceFor(owner);
const store=new PostgresWorkflowRunStore(pool,{workspaceId:sourceWorkspaceId});
const execution=createBoundedPostExecutionProvider({receiptsDir:path.join(runtime,'execution'),analysisRoot,onRunCreated:async receipt=>{let binding;try{binding=await bindSpaceExecution(service,store,spaceId,sourceWorkspaceId,receipt);}catch(error){fs.writeFileSync(path.join(runtime,'last-binding-error.json'),JSON.stringify({preparedId:receipt.id,error:error instanceof Error?error.message:String(error)},null,2),{mode:0o600});throw error;}fs.writeFileSync(path.join(runtime,'execution',`${receipt.id}.binding.json`),JSON.stringify(binding,null,2),{mode:0o600});return binding;}});
const syncing=new Set<string>();
async function syncOne(id:string){
 const receipt=await execution.status(id);if(!receipt)return null;
 if(syncing.has(id))return receipt;
 const syncFile=path.join(runtime,'execution',`${id}.sync.json`);
 if(!['prepared','launching','running'].includes(receipt.state)&&fs.existsSync(syncFile)){const prior=JSON.parse(fs.readFileSync(syncFile,'utf8'));if(!prior.syncGap&&prior.receipt?.state===receipt.state)return prior;}
 syncing.add(id);
 try{
  if(receipt.state==='failed'&&receipt.nativeWorkflowRunId&&receipt.spaceBinding){
   let bound;try{bound=await service.readRun(spaceId,receipt.nativeWorkflowRunId);}catch(error){if(!String(error).includes('not found'))throw error;}
   if(!bound){const binding=await bindSpaceExecution(service,store,spaceId,sourceWorkspaceId,receipt);fs.writeFileSync(path.join(runtime,'execution',`${id}.binding.json`),JSON.stringify(binding,null,2),{mode:0o600});receipt.spaceBinding=binding;}
  }
  const result=await syncSpaceExecution(service,store,spaceId,sourceWorkspaceId,receipt);fs.writeFileSync(path.join(runtime,'execution',`${id}.sync.json`),JSON.stringify(result,null,2),{mode:0o600});return result;}
 catch(error){const gap={receipt,syncGap:error instanceof Error?error.message:String(error)};fs.writeFileSync(path.join(runtime,'execution',`${id}.sync.json`),JSON.stringify(gap,null,2),{mode:0o600});return gap;}
 finally{syncing.delete(id);}
}
function executionReceipts(){const dir=path.join(runtime,'execution');return fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>/^[a-f0-9]{64}\.json$/.test(f)).map(f=>execution.status(f.slice(0,-5))).filter(Boolean):[];}

try{
 if(command==='setup'){
  if(!process.env.SELF_MEDIA_DATABASE_URL)throw new Error('Private SELF_MEDIA_DATABASE_URL is required');
  await migrateWorkflowSpaces(pool);await blobs.migrate();
  if(!(await service.listSpaces()).some(s=>s.id===spaceId))await service.createSpace({id:spaceId,purpose:'拉片：准确理解方法、阅读成果与失败、完成业务并继续调优'});
  const credential=await provisionDesignWorkbenchCredential(credentialFile,{agentId:'lapian-implementation',sessionId:'lapian-harness-20261014',spaceIds:[spaceId],role:'design'});
  await service.grant(spaceId,credential.principal.id,'operator');
  await createBusinessUnderstandingStore(service).ensure(spaceId);await createMethodDesignStore(service).ensure(spaceId);
  await createRunDispositionStore(service).ensure(spaceId);await createRunDiagnosisStore(service).ensure(spaceId);await createExternalAgentObservationStore(service).ensure(spaceId);
  const [schema]=await service.registerSchemas(spaceId,[HISTORY_SCHEMA]);
  console.log(JSON.stringify({spaceId,credentialFile,schema,modelsRun:0}));
 }else if(command==='observer-setup'){
  if(!process.env.SELF_MEDIA_DATABASE_URL)throw new Error('Private SELF_MEDIA_DATABASE_URL is required');
  if(!(await service.listSpaces()).some(space=>space.id===spaceId))throw new Error('Existing owner Space required for observer-setup');
  const observer=await provisionLapianObserverCredential(runtime,spaceId);
  await service.grant(spaceId,observer.principal.id,'operator');
  console.log(JSON.stringify({spaceId,credentialFile:observerCredentialFile(runtime),principalId:observer.principal.id,
   agentId:observer.principal.externalAgent.id,sessionId:observer.principal.externalAgent.sessionId,
   credentialRole:'observer',spaceRole:'operator',modelsRun:0}));
 }else if(command==='method'){
  const host=lapianMethodDesignHost(service,spaceId);const design=await host.current(spaceId);if(!design)throw new Error('Save sourced design through Operator CLI first');const preview=await host.preview(spaceId,design.id);console.log(JSON.stringify(await host.publish(spaceId,{designRevisionId:design.id,expectedCandidateId:preview.versionId})));
 }else if(command==='import'){
  const rootRunId=process.argv[3],title=process.argv[4];if(!rootRunId||!title)throw new Error('Exact run ID and title required');
  const store=new PostgresWorkflowRunStore(pool,{workspaceId:sourceWorkspaceId});
  const receipt=await importLapianHistory({service,store,spaceId,sourceWorkspaceId,rootRunId,title,description:process.argv[5]??'历史拉片证据；原方法与已知缺陷保留，导入不表示新执行或质量接受。'});
  if((await store.getRun(rootRunId))?.state==='failed'&&process.env.SELF_MEDIA_RUNTIME_DIR){try{const [schema]=await service.registerSchemas(spaceId,[HISTORY_SCHEMA]);const failed=await importFailedBuilderDrafts({service,spaceId,schema:schema!,store,rootRunId,runtimeRoot:process.env.SELF_MEDIA_RUNTIME_DIR!});Object.assign(receipt,{unpublishedDraftAssetId:failed.asset.id});}catch(error){Object.assign(receipt,{unpublishedDraftGap:error instanceof Error?error.message:String(error)});}}
  fs.writeFileSync(path.join(runtime,`import-${rootRunId}.json`),JSON.stringify(receipt,null,2),{mode:0o600});console.log(JSON.stringify(receipt,null,2));
 }else if(command==='document'){
  const runId=process.argv[3],file=process.argv[4];if(!runId||!file||!path.isAbsolute(file))throw new Error('Exact run and absolute document path required');const run=await service.readRun(spaceId,runId);const bytes=fs.readFileSync(file);const [schema]=await service.registerSchemas(spaceId,[HISTORY_SCHEMA]);const hash=createHash('sha256').update(bytes).digest('hex');const asset=await service.importAsset(spaceId,{schema:schema!,payload:{title:path.basename(file),content:bytes.toString('utf8'),source:{rootRunId:runId,caseId:run.caseId,documentPath:file,sha256:hash},description:'独立外部审计/来源说明；不冒充workflow Reviewer'},description:'Explicit external evidence document',idempotencyKey:`document:${runId}:${hash}`});console.log(JSON.stringify({assetId:asset.id,payloadHash:asset.payloadHash}));
 }else if(command==='status')console.log(JSON.stringify(await syncOne(process.argv[3]!),null,2));
 else if(command==='follow'){
  const id=process.argv[3]!;let previous='';
  for(;;){const result=await syncOne(id);const receipt=execution.status(id);const summary={state:receipt?.state,rootRunId:receipt?.nativeWorkflowRunId,syncGap:result&&'syncGap'in result?result.syncGap:undefined};const value=JSON.stringify(summary);if(value!==previous){console.log(value);previous=value;}
   if(!receipt||!['running','launching'].includes(receipt.state))break;await new Promise(resolve=>setTimeout(resolve,4000));
  }
 }
 else if(command==='serve'){
  const credentials=await readLapianCredentials(runtime,spaceId);
  const port=Number(process.env.LAPIAN_HARNESS_PORT??4417);
  const app=createSpaceWorkbenchApp({principal:owner,publicOrigin:`http://127.0.0.1:${port}`,trustedLoopback:true,credentials,spaceId,
   webRoot:path.join(root,'workbenches/creation/apps/space-workbench/web/dist'),
   listSpaces:async principal=>serviceFor(principal).listSpaces(),
   hostFor:async principal=>{
    const s=serviceFor(principal);const understanding=createBusinessUnderstandingStore(s),disposition=createRunDispositionStore(s),diagnosis=createRunDiagnosisStore(s);
    const methodDesign=lapianMethodDesignHost(s,spaceId,service);
    return {service:s,scope:{workflowId:'post.analyze',entrypoint:'post',defaultVersionId:process.env.LAPIAN_DEFAULT_METHOD_VERSION_ID,auxiliaryWorkflowIds:['post.build','post.review','post.repair','post.source-check','research.input','post.prepare','post-review-benchmark.seed'],assessmentWorkflowIds:['post.build','post.review','post.repair','post.source-check']},displayTimeZone:'Asia/Taipei',readers:lapianReaders,
     importedAssetScope:async({asset})=>{const p=asset.payload as {rootRunId?:string;source?:{rootRunId?:string}};const id=p.source?.rootRunId??p.rootRunId;if(!id)return null;const r=await s.readRun(spaceId,id);return {caseId:r.caseId,runId:r.runId,versionId:r.workflowVersionId};},
     runDisposition:disposition,runDiagnosis:diagnosis,
     availability:async versionId=>{const version=await s.readWorkflowVersion(spaceId,versionId);return readOnly?({state:'unavailable' as const,reason:'当前为独立阅读验收服务；保留成果阅读与评价，不提供执行入口'}):version.config?.historical===true?({state:'unavailable' as const,reason:'历史运行观察仅供追溯'}):version.config?.observedNativeRun===true?({state:'unavailable' as const,reason:'本次辅助流程观察供阅读成果与记录，不提供独立执行入口'}):({state:'available' as const,reason:'通过CLI显式准备并启动有界流程；当前额度见execution-state'});},
     runSummary:async({run})=>{
      const native=await store.getRun(run.runId);if(!native)return {state:'unknown',reason:'原生运行不可读取'};
      const receipt=executionReceipts().find(r=>r?.nativeWorkflowRunId===run.runId);if(receipt?.state==='failed')return {state:'failed',reason:native.error??receipt.failure??(native.state==='queued'?'执行在模型前绑定阶段停止；未进入原生工作流':'执行宿主记录失败；查看执行收据与原生账本'),startedAt:receipt.startedAt};
      const events=await store.listEvents(run.runId);const last=[...events].reverse().find(e=>e.type==='phase.started'||e.type==='step.started');
      const step=typeof last?.stepRunId==='string'?(await store.listSteps(run.runId)).find(s=>s.id===last.stepRunId):undefined;
      const labels:Record<string,string>={'source-consistency':'来源核对','candidate-build':'候选构建','simple-review':'独立审阅','candidate-revision':'修订','register-analysis':'登记结果'};
      return {state:native.state,startedAt:events.find(e=>e.type==='workflow.started')?.timestamp,reason:native.error,progress:step?labels[step.key]??step.key:undefined};
     },
     runExecutionMode:async({runId})=>(await s.readRun(spaceId,runId)).executionMode??null,
     reviewStandard:async()=>({id:'lapian-evidence-standard',revision:'1',content:'按原片与冻结证据判断内容还原是否连续准确，编导和剪辑因果是否有依据，综合总结是否完整且数据口径准确。区分主文、Reviewer、修订后未复核、外部审计；空findings与技术完成不等于质量通过。'}),
     ...lapianHostMode(readOnly,{understanding:{current:understanding.current,read:understanding.read,history:understanding.history,save:understanding.save},methodDesign,
      methodExecution:{status:async()=>({spaceId,receipts:executionReceipts().map(receipt=>{const file=path.join(runtime,'execution',`${receipt!.id}.binding.json`);return {...receipt,linkedSpaceBinding:fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null};}),retryAuthorization:fs.existsSync(path.join(runtime,'full-retry-authorization.json'))?JSON.parse(fs.readFileSync(path.join(runtime,'full-retry-authorization.json'),'utf8')):null,release:'lapian-initial-20261014',limits:{full:1,reviewer:1,fullMinutes:60,reviewerMinutes:15},operations:readOnly?[]:['inputs-freeze','start'],note:readOnly?'观察服务不提供执行命令；仅保留历史状态阅读与独立评价。':'不自动运行，不采用；准备与开始均需准确对象。'}),command:async(_space,input)=>{
      try{
      if(input.operation==='inputs-freeze'){
       let executionInput={...input.input,scopeKey:'lapian-initial-20261014'} as Parameters<typeof execution.prepare>[0];let retryCaseId:string|undefined;
       if(input.input.retryOf){
        const authorization=JSON.parse(fs.readFileSync(path.join(runtime,'full-retry-authorization.json'),'utf8'));
        if(authorization.priorExecutionId!==input.input.retryOf||authorization.kind!=='full'||authorization.additionalLaunches!==1||authorization.maxMinutes!==60)throw new Error('Explicit single full retry authorization missing');
        const prior=execution.status(String(input.input.retryOf));if(!prior||prior.input.kind!=='full'||prior.state!=='failed')throw new Error('Retry must name the original failed full launch');
        executionInput={...prior.input,scopeKey:String(authorization.scopeKey),caseLabel:'harness-full-retry1-20261014'};
        retryCaseId=prior.spaceBinding?.caseId;if(!retryCaseId)throw new Error('Original Case missing');
       }
       const receipt=await execution.prepare(executionInput);
       const savedBinding=path.join(runtime,'execution',`${receipt.id}.binding.json`);
       if(fs.existsSync(savedBinding)){const binding=JSON.parse(fs.readFileSync(savedBinding,'utf8'));const method=await service.readWorkflowVersion(spaceId,binding.workflowVersionId);if(method.hash!==binding.methodHash)throw new Error('Prepared method hash mismatch');return {receipt,binding};}
       const design=await createMethodDesignStore(service).current(spaceId,'post.analyze');if(!design)throw new Error('Current sourced method design missing');
       const projection=compileLapianMethod(design,receipt.input.kind==='reviewer');
       const binding=await prepareSpaceExecution(service,store,spaceId,receipt,projection.version.id!,retryCaseId);
       fs.writeFileSync(path.join(runtime,'execution',`${receipt.id}.binding.json`),JSON.stringify(binding,null,2),{mode:0o600});
       return {receipt,binding};
      }
      if(input.operation==='start'){
       const id=String(input.input.preparedId);if(!/^[a-f0-9]{64}$/.test(id))throw new Error('Invalid prepared ID');
       const binding=JSON.parse(fs.readFileSync(path.join(runtime,'execution',`${id}.binding.json`),'utf8'));
       return await execution.start(id,binding) as unknown as Record<string,unknown>;
      }
      throw new Error('Unsupported lapian operation');
      }catch(error){fs.writeFileSync(path.join(runtime,'last-command-error.json'),JSON.stringify({message:(error instanceof Error?error.message:String(error)).replace(/sk-[A-Za-z0-9_-]+/g,'[redacted]'),stack:error instanceof Error?error.stack:undefined},null,2),{mode:0o600});throw error;}
     }}})
    };
   }});
  const poll=readOnly?undefined:setInterval(()=>{for(const r of executionReceipts())if(r?.nativeWorkflowRunId)void syncOne(r.id);},4000);poll?.unref();
  const server=app;server.listen(port,'127.0.0.1',()=>console.log(`http://127.0.0.1:${port}/space-workbench/${spaceId}`));
  await new Promise<void>(resolve=>{process.on('SIGTERM',()=>{if(poll)clearInterval(poll);server.close(()=>resolve());});process.on('SIGINT',()=>{if(poll)clearInterval(poll);server.close(()=>resolve());});});
 }else throw new Error('Unknown command');
}finally{await pool.end();}
