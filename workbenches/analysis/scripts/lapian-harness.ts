import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Pool} from 'pg';
import {PostgresWorkflowRunStore} from '@signal-room/workflow-postgres';
import {WorkflowSpaceService,PostgresBlobStore,migrateWorkflowSpaces,createBusinessUnderstandingStore,createMethodDesignStore,createRunDispositionStore,createRunDiagnosisStore,createExternalAgentObservationStore,type SpacePrincipal} from '@signal-room/workflow-spaces';
import {createSpaceWorkbenchApp} from '@signal-room/workflow-space-api/workbench-server';
import {provisionDesignWorkbenchCredential,readDesignWorkbenchCredential} from '@signal-room/workflow-space-api/workbench-credentials';
import {buildCurrentAnalysisPostMethod} from '../packages/adapters/src/harness/method.js';
import {importLapianHistory,HISTORY_SCHEMA} from '../packages/adapters/src/harness/history.js';
import {importFailedBuilderDrafts} from '../packages/adapters/src/harness/failed-drafts.js';
import {createHash} from 'node:crypto';
import {lapianReaders} from '../packages/adapters/src/harness/readers.js';
import {createBoundedPostExecutionProvider} from '../packages/adapters/src/harness/execution.js';

const analysisRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=path.resolve(analysisRoot,'../..');
const runtime=path.resolve(process.env.LAPIAN_HARNESS_DIR??path.join(root,'.local/lapian-harness'));
const spaceId=process.env.LAPIAN_SPACE_ID??'lapian-harness-20261014';
const sourceWorkspaceId=process.env.SELF_MEDIA_WORKSPACE_ID??'creator-lab-analysis';
const credentialFile=path.join(runtime,'agent.json');
const command=process.argv[2]??'help';
if(command==='help'){
 console.log('lapian:harness setup | import ROOT_RUN_ID TITLE | serve | status PREPARED_ID\nReads existing private SELF_MEDIA_DATABASE_URL and SELF_MEDIA_RUNTIME_DIR. setup explicitly creates a separate Space; import preserves historical identity and does not run models. Execution is through the authenticated Operator CLI method-command.');process.exit(0);
}
fs.mkdirSync(runtime,{recursive:true,mode:0o700});
const pool=new Pool({connectionString:process.env.SELF_MEDIA_DATABASE_URL,max:6});
const owner:SpacePrincipal={id:'lapian-local-owner',kind:'human'};
const blobs=new PostgresBlobStore(pool);
const serviceFor=(principal:SpacePrincipal)=>new WorkflowSpaceService(pool,blobs,principal,{readerIds:Object.keys(lapianReaders),resultRoleIds:['report','review','evidence'],historicalSourceWorkspaceIds:[sourceWorkspaceId]});
const service=serviceFor(owner);
const execution=createBoundedPostExecutionProvider({receiptsDir:path.join(runtime,'execution'),analysisRoot});
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
 }else if(command==='method'){
  const design=await createMethodDesignStore(service).current(spaceId,'post.analyze');if(!design)throw new Error('Save sourced method design through Operator CLI first');
  const projection=buildCurrentAnalysisPostMethod({id:'lapian-current-20261014',revision:'post-analyze-v11-harness-1',changeReason:'接入当前真实拉片能力；不更改方法、不采用',registrationEnabled:false});
  await service.registerSchemas(spaceId,projection.schemaDefinitions);
  projection.version.designBasis={designRevisionId:design.id,designPayloadHash:design.payloadHash,understandingRevisionId:design.understanding.revisionId,understandingPayloadHash:design.understanding.payloadHash};
  const version=await service.publishWorkflow(spaceId,projection.version);console.log(JSON.stringify({versionId:version.id,hash:version.hash,entrypoint:projection.entrypoint,methodSnapshot:projection.methodSnapshot}));
 }else if(command==='import'){
  const rootRunId=process.argv[3],title=process.argv[4];if(!rootRunId||!title)throw new Error('Exact run ID and title required');
  const store=new PostgresWorkflowRunStore(pool,{workspaceId:sourceWorkspaceId});
  const receipt=await importLapianHistory({service,store,spaceId,sourceWorkspaceId,rootRunId,title,description:process.argv[5]??'历史拉片证据；原方法与已知缺陷保留，导入不表示新执行或质量接受。'});
  if((await store.getRun(rootRunId))?.state==='failed'&&process.env.SELF_MEDIA_RUNTIME_DIR){try{const [schema]=await service.registerSchemas(spaceId,[HISTORY_SCHEMA]);const failed=await importFailedBuilderDrafts({service,spaceId,schema:schema!,store,rootRunId,runtimeRoot:process.env.SELF_MEDIA_RUNTIME_DIR!});Object.assign(receipt,{unpublishedDraftAssetId:failed.asset.id});}catch(error){Object.assign(receipt,{unpublishedDraftGap:error instanceof Error?error.message:String(error)});}}
  fs.writeFileSync(path.join(runtime,`import-${rootRunId}.json`),JSON.stringify(receipt,null,2),{mode:0o600});console.log(JSON.stringify(receipt,null,2));
 }else if(command==='document'){
  const runId=process.argv[3],file=process.argv[4];if(!runId||!file||!path.isAbsolute(file))throw new Error('Exact run and absolute document path required');const run=await service.readRun(spaceId,runId);const bytes=fs.readFileSync(file);const [schema]=await service.registerSchemas(spaceId,[HISTORY_SCHEMA]);const hash=createHash('sha256').update(bytes).digest('hex');const asset=await service.importAsset(spaceId,{schema:schema!,payload:{title:path.basename(file),content:bytes.toString('utf8'),source:{rootRunId:runId,caseId:run.caseId,documentPath:file,sha256:hash},description:'独立外部审计/来源说明；不冒充workflow Reviewer'},description:'Explicit external evidence document',idempotencyKey:`document:${runId}:${hash}`});console.log(JSON.stringify({assetId:asset.id,payloadHash:asset.payloadHash}));
 }else if(command==='status')console.log(JSON.stringify(await execution.status(process.argv[3]!),null,2));
 else if(command==='serve'){
  const credential=await readDesignWorkbenchCredential(credentialFile);if(!credential)throw new Error('Private Agent credential missing or invalid');
  const port=Number(process.env.LAPIAN_HARNESS_PORT??4417);
  const app=createSpaceWorkbenchApp({principal:owner,publicOrigin:`http://127.0.0.1:${port}`,trustedLoopback:true,credentials:[credential],spaceId,
   webRoot:path.join(root,'workbenches/creation/apps/space-workbench/web/dist'),
   listSpaces:async principal=>serviceFor(principal).listSpaces(),
   hostFor:async principal=>{
    const s=serviceFor(principal);const understanding=createBusinessUnderstandingStore(s),design=createMethodDesignStore(s),disposition=createRunDispositionStore(s),diagnosis=createRunDiagnosisStore(s);
    return {service:s,scope:{workflowId:'post.analyze',entrypoint:'post',auxiliaryWorkflowIds:['post.build','post.review','post.repair','post.source-check','research.input','post.prepare','post.review-seed']},displayTimeZone:'Asia/Taipei',readers:lapianReaders,
     importedAssetScope:async({asset})=>{const p=asset.payload as {rootRunId?:string;source?:{rootRunId?:string}};const id=p.source?.rootRunId??p.rootRunId;if(!id)return null;const r=await s.readRun(spaceId,id);return {caseId:r.caseId,runId:r.runId,versionId:r.workflowVersionId};},
     understanding:{current:understanding.current,read:understanding.read,history:understanding.history,save:understanding.save},methodDesign:{current:space=>design.current(space,'post.analyze'),read:design.read,history:space=>design.history(space,'post.analyze'),save:design.save,basis:(space,id)=>design.readBasis(space,id)},runDisposition:disposition,runDiagnosis:diagnosis,
     availability:()=>({state:'unavailable' as const,reason:'历史方法仅供读取；新的有界运行使用 execution-state 与 method-command 准备、复验并显式发起'}),
     runExecutionMode:async({runId})=>(await s.readRun(spaceId,runId)).executionMode??null,
     reviewStandard:async()=>({id:'lapian-evidence-standard',revision:'1',content:'按原片与冻结证据判断内容还原是否连续准确，编导和剪辑因果是否有依据，综合总结是否完整且数据口径准确。区分主文、Reviewer、修订后未复核、外部审计；空findings与技术完成不等于质量通过。'}),
     methodExecution:{status:async()=>({spaceId,release:'lapian-initial-20261014',limits:{full:1,reviewer:1,fullMinutes:60,reviewerMinutes:15},operations:['inputs-freeze','start'],note:'不自动运行，不采用；准备与开始均需准确对象。'}),command:async(_space,input)=>{
      if(input.operation==='inputs-freeze')return await execution.prepare({...input.input,scopeKey:'lapian-initial-20261014'} as Parameters<typeof execution.prepare>[0]) as unknown as Record<string,unknown>;
      if(input.operation==='start')return await execution.start(String(input.input.preparedId)) as unknown as Record<string,unknown>;
      throw new Error('Unsupported lapian operation');
     }}
    };
   }});
  const server=app;server.listen(port,'127.0.0.1',()=>console.log(`http://127.0.0.1:${port}/space-workbench/${spaceId}`));
  await new Promise<void>(resolve=>{process.on('SIGTERM',()=>server.close(()=>resolve()));process.on('SIGINT',()=>server.close(()=>resolve()));});
 }else throw new Error('Unknown command');
}finally{await pool.end();}
