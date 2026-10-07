import {createHash,randomUUID} from 'node:crypto';
import {WorkflowExecutorRegistry,type AssetVersion,type ExecutionTask,type InputManifest,type SpaceCase,type SpaceRun,type WorkflowSpaceService,type WorkflowVersion} from '@signal-room/workflow-spaces';
import type {SpaceApiHost} from '@signal-room/workflow-space-api/server';
import type {AssetSummaryDto,BusinessCommandReceiptDto,BusinessPreparationDto,HandlingNoteDto,HandlingNoteRequestDto,RunSummaryDto} from '@signal-room/workflow-space-api/contracts';
import type {StageModel} from '../stages/runtime.js';
import type {createContentWorkbench} from './content-workbench.js';
import {contentBusinessPreparationSchema,contentBusinessRequestSchema,contentBusinessSchemaDefinitions,contentBusinessSchemaRefs,contentHandlingNotePayloadSchema,type ContentBusinessRequest} from './content-business-schemas.js';

type Business=NonNullable<SpaceApiHost['business']>;
type Workbench=Pick<ReturnType<typeof createContentWorkbench>,'createCase'|'freezeInput'|'startFromManifest'|'dispatchRun'|'runStatus'|'methodAvailability'>;
type Service=Pick<WorkflowSpaceService,'readCase'|'readWorkflowVersion'|'readManifest'|'readAsset'|'registerSchemas'|'importAsset'|'importedAssetsBySchema'|'caseRunsPage'|'runAssets'|'getExecutionTask'|'executionTasks'|'process'>;
export interface ContentBusinessExecutionRelease {
  revision:1;spaceId:string;principalId:string;caseId:string;versionId:string;inputManifestId:string;inputManifestHash:string;
  models:{worker:StageModel;judge:StageModel};expiresAt:string;
  exclusive:{confirmedAt:string;disabledPorts:number[]};maxRevisions:2;webResearch:false;
}
export interface ContentBusinessCommandOptions {
  service:Service;workbench:Workbench;spaceId:string;principalId:string;
  models:{worker:StageModel;judge:StageModel};loadRelease:()=>Promise<ContentBusinessExecutionRelease|null>;
  verifyExclusive:(release:ContentBusinessExecutionRelease)=>Promise<boolean>;now?:()=>number;
}
class CommandFailure extends Error {constructor(readonly status:number,readonly code:string,message:string){super(message);}}
function fail(status:number,code:string,message:string):never {throw new CommandFailure(status,code,message);}
function requestIssue(path:PropertyKey[]):string {
  const field=path[0];
  if(field==='maxSeconds')return '时长上限必须是正整数秒。';
  if(field==='materials'){
    const position=typeof path[1]==='number'?`第 ${path[1]+1} 条`:'';
    return path[2]==='id'?`${position}材料的 ID 无效或重复。`:`${position}材料的名称、来源和正文均须填写。`;
  }
  const labels:Record<string,string>={title:'业务名称',objective:'目标',requiredQuestions:'必答问题',accountName:'账号名称',positioning:'账号定位',currentAudience:'当前受众',form:'表达形式',standards:'内容标准'};
  return typeof field==='string'&&field in labels?`${labels[field]}填写无效。`:'业务输入含有未知或无效字段。';
}
async function preparationWrite<T>(work:()=>Promise<T>):Promise<T>{
  try{return await work();}
  catch(error){
    if(error instanceof Error&&['Case ID conflicts with a different request','Idempotency conflict'].includes(error.message))
      fail(409,'CONFLICT','相同准备 key 对应的业务输入已改变。');
    throw error;
  }
}
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;
const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const caseIdFor=(spaceId:string,key:string)=>`content-business-${sha([spaceId,key]).slice(0,32)}`;
const expectedScope=(input:{spaceId:string},options:ContentBusinessCommandOptions)=>{if(input.spaceId!==options.spaceId)fail(403,'FORBIDDEN','当前宿主不能操作这个 Space。');};
function contentInputFor(caseId:string,descriptor:ContentBusinessRequest){
  return {topicId:caseId,opportunity:descriptor.objective,account:{name:descriptor.accountName,positioning:descriptor.positioning,
    currentAudience:descriptor.currentAudience,referencePieces:[]},form:descriptor.form,
    materials:descriptor.materials.map(m=>({id:m.id,title:m.title,text:`来源：${m.source}\n${m.text}`})),
    standards:descriptor.standards,webResearch:false,readerGoal:descriptor.objective,requiredQuestions:descriptor.requiredQuestions,
    maxRevisions:2,...(descriptor.maxSeconds?{maxSeconds:descriptor.maxSeconds}:{})};
}
const summary=(asset:AssetVersion&{state?:string},caseId:string|null,versionId:string|null):AssetSummaryDto&{payloadHash:string}=>({
  id:asset.id,title:(asset.payload&&typeof asset.payload==='object'&&'title' in asset.payload&&typeof asset.payload.title==='string'?asset.payload.title:asset.schema.namespace),
  kind:asset.schema.namespace,state:asset.state??asset.initialState,createdAt:asset.createdAt,schema:asset.schema,payloadHash:asset.payloadHash,sourceKind:asset.source.kind,
  runId:asset.source.kind==='node'?asset.source.runId:null,caseId,versionId,nodeId:asset.source.kind==='node'?asset.source.nodeId:null,occurrenceId:null,round:null,
});

/** The authenticated host owns identity and dispatch. Browser values only describe the business request. */
export function createContentBusinessCommands(options:ContentBusinessCommandOptions):Business {
  const now=options.now??Date.now;
  const preparationNamespace='creation/content-business-preparation',noteNamespace='creation/content-handling-note';
  let previous:Promise<unknown>=Promise.resolve();
  const serialized=<T>(work:()=>Promise<T>):Promise<T>=>{const result=previous.then(work,work);previous=result.catch(()=>undefined);return result;};

  async function method(spaceId:string,versionId:string){
    const value=await options.service.readWorkflowVersion(spaceId,versionId);
    if(value.spaceId!==spaceId||value.id!==versionId||value.entrypoints.content?.workflowId!=='creation.content')fail(409,'RELATION_MISMATCH','选择的方法不属于 CONTENT。');
    return value;
  }
  async function available(spaceId:string,versionId:string){
    await method(spaceId,versionId);
    const available=await options.workbench.methodAvailability(spaceId,versionId,'content');
    if(!available.available)fail(409,'UNAVAILABLE','准确的方法版本在当前宿主不可用。');
  }
  async function caseManifest(spaceId:string,caseId:string,versionId:string,manifestId:string){
    const [item,version,manifest]=await Promise.all([options.service.readCase(spaceId,caseId),method(spaceId,versionId),options.service.readManifest(spaceId,manifestId)]);
    if(item.spaceId!==spaceId||item.id!==caseId||manifest.spaceId!==spaceId||manifest.caseId!==caseId||manifest.id!==manifestId||
      !manifest.assets.opportunity||!manifest.assets.materials||Object.keys(manifest.assets).some(k=>!['opportunity','materials'].includes(k)))fail(409,'RELATION_MISMATCH','业务、方法和冻结材料不相符。');
    return {item,version,manifest};
  }
  async function release(spaceId:string,caseId:string,versionId:string,manifest:InputManifest){
    const value=await options.loadRelease();
    if(!value)fail(403,'EXECUTION_DISABLED','运行前核验尚未完成或与当前条件不符。');
    if(value.revision!==1||value.spaceId!==spaceId||value.principalId!==options.principalId||value.caseId!==caseId||
      value.versionId!==versionId||value.inputManifestId!==manifest.id||value.inputManifestHash!==manifest.hash||
      value.maxRevisions!==2||value.webResearch!==false||!Number.isFinite(Date.parse(value.expiresAt))||Date.parse(value.expiresAt)<=now()||
      JSON.stringify(canonical(value.models))!==JSON.stringify(canonical(options.models)))fail(403,'EXECUTION_DISABLED','运行前核验尚未完成或与当前条件不符。');
    if(!value.exclusive||!Number.isFinite(Date.parse(value.exclusive.confirmedAt))||!(await options.verifyExclusive(value)))fail(403,'EXECUTION_DISABLED','执行宿主的独占条件尚未确认。');
    await available(spaceId,versionId);
    return value;
  }
  const active=(tasks:ExecutionTask[],target?:string)=>{
    if(tasks.some(t=>t.runId!==target&&['running','cancel_requested','interrupted'].includes(t.status)))fail(409,'CONFLICT','Space 中仍有其他活动任务。');
  };
  const receipt=(caseId:string,versionId:string,manifest:InputManifest,task:ExecutionTask,dispatched=false,dispatchError:string|null=null):BusinessCommandReceiptDto=>({
    requestId:randomUUID(),caseId,versionId,inputManifestId:manifest.id,inputManifestHash:manifest.hash,runId:task.runId,status:task.status,dispatched,dispatchError,
  });
  async function exactTask(spaceId:string,caseId:string,versionId:string,manifest:InputManifest,runId:string){
    const [status,task]=await Promise.all([options.workbench.runStatus(spaceId,runId),options.service.getExecutionTask(spaceId,runId)]);
    const run=status.binding;
    if(!task)fail(409,'RELATION_MISMATCH','准确运行缺少排队任务。');
    if(run.runId!==runId||run.spaceId!==spaceId||run.caseId!==caseId||run.workflowVersionId!==versionId||run.inputManifestId!==manifest.id||run.entrypoint!=='content'||
      task.spaceId!==spaceId||task.runId!==runId||task.caseId!==caseId||task.workflowVersionId!==versionId||task.inputManifestId!==manifest.id||task.entrypoint!=='content'||
      task.executorKey!==WorkflowExecutorRegistry.key(versionId,'content'))fail(409,'RELATION_MISMATCH','运行与排队任务不属于这件业务的准确版本及材料。');
    return {run,task,status};
  }
  async function tryDispatch(spaceId:string,caseId:string,versionId:string,manifest:InputManifest,runId:string){
    const {task}=await exactTask(spaceId,caseId,versionId,manifest,runId);
    if(task.status!=='queued')return receipt(caseId,versionId,manifest,task);
    await release(spaceId,caseId,versionId,manifest);active(await options.service.executionTasks(spaceId),runId);
    try{
      await options.workbench.dispatchRun(spaceId,runId);
      return receipt(caseId,versionId,manifest,(await options.service.getExecutionTask(spaceId,runId))??task,true);
    }catch{
      return receipt(caseId,versionId,manifest,(await options.service.getExecutionTask(spaceId,runId))??task,false,'派发未完成；原排队回执已保留，请核实后恢复同一运行。');
    }
  }
  async function savedPreparation(spaceId:string,caseId:string){
    const matches=await options.service.importedAssetsBySchema(spaceId,preparationNamespace,{caseId},100);
    if(matches.length>1)fail(409,'CONFLICT','这件业务存在多份准备记录，请先核对。');
    const asset=matches[0];if(!asset)return null;
    if(asset.source.kind!=='import'||asset.schema.namespace!==preparationNamespace)fail(409,'CONFLICT','业务准备记录的来源或 schema 无效。');
    const parsed=contentBusinessPreparationSchema.parse(asset.payload);
    if(parsed.caseId!==caseId)fail(409,'RELATION_MISMATCH','业务准备记录归属错误。');
    const binding=await caseManifest(spaceId,caseId,parsed.versionId,parsed.inputManifestId);
    if(parsed.inputManifestHash!==binding.manifest.hash||binding.item.title!==parsed.input.title||binding.item.objective!==parsed.input.objective||
      asset.dependencies.length!==new Set(Object.values(binding.manifest.assets)).size||!asset.dependencies.every(id=>Object.values(binding.manifest.assets).includes(id)))
      fail(409,'RELATION_MISMATCH','业务准备记录与冻结内容不相符。');
    const [opportunity,materials]=await Promise.all([options.service.readAsset(spaceId,binding.manifest.assets.opportunity!),options.service.readAsset(spaceId,binding.manifest.assets.materials!)]);
    const expected=contentInputFor(caseId,parsed.input),{materials:expectedMaterials,...expectedOpportunity}=expected;
    if(opportunity.schema.namespace!=='creation/content-opportunity'||materials.schema.namespace!=='creation/content-materials'||
      JSON.stringify(canonical(opportunity.payload))!==JSON.stringify(canonical(expectedOpportunity))||
      JSON.stringify(canonical(materials.payload))!==JSON.stringify(canonical(expectedMaterials)))
      fail(409,'RELATION_MISMATCH','业务准备记录与准确冻结输入内容不符。');
    return {asset,parsed,binding};
  }
  async function preparedDto(spaceId:string,caseId:string):Promise<BusinessPreparationDto|null>{
    const record=await savedPreparation(spaceId,caseId);if(!record)return null;
    const {parsed,binding}=record,{item,version,manifest}=binding;
    const inputs=await Promise.all([...new Set(Object.values(manifest.assets))].map(id=>options.service.readAsset(spaceId,id)));
    if(inputs.some(asset=>asset.spaceId!==spaceId||asset.source.kind!=='import'))fail(409,'RELATION_MISMATCH','冻结材料来源无效。');
    const runs=await options.service.caseRunsPage(spaceId,caseId,'creation.content','content',undefined,101);
    const matching=runs.filter(run=>run.workflowVersionId===version.id&&run.inputManifestId===manifest.id);
    const tasks=await options.service.executionTasks(spaceId);
    const runDtos:RunSummaryDto[]=await Promise.all(matching.slice(0,100).map(async run=>{
      const task=tasks.find(t=>t.runId===run.runId),assets=await options.service.runAssets(spaceId,run.runId);
      const result=await options.workbench.runStatus(spaceId,run.runId);
      return {id:run.runId,label:`${run.runId.slice(0,8)}`,versionId:run.workflowVersionId,caseId:run.caseId,entrypoint:run.entrypoint,
        state:result.run.state,taskState:task?.status??null,reason:task?.error??null,progress:null,startedAt:task?.createdAt??null,
        assetCount:assets.length,draftCount:assets.filter(a=>a.schema.namespace==='creation/content-draft').length,primaryAssetId:result.draftVersionId??null};
    }));
    let reason:string|null=null,start=false,dispatch=false;
    try{await release(spaceId,caseId,version.id,manifest);active(tasks,matching[0]?.runId);
      start=matching.length===0;dispatch=matching.length===1&&tasks.some(t=>t.runId===matching[0]!.runId&&t.status==='queued');
      if(!start&&!dispatch)reason='此业务已有运行记录；不会自动重试。';
    }catch(error){reason=error instanceof Error?error.message:'运行条件尚未核验。';}
    const sourceLines=parsed.input.materials.map(m=>`${m.title}（${m.id}）\n来源：${m.source}\n${m.text}`);
    return {caseId,caseTitle:item.title,objective:item.objective,versionId:version.id,versionLabel:`${version.revision} · ${version.id.slice(-8)}`,
      inputManifestId:manifest.id,inputManifestHash:manifest.hash,inputs:inputs.map(a=>summary(a,caseId,version.id)),
      sections:[{title:'业务要求',text:`${parsed.input.objective}\n必答问题：\n${parsed.input.requiredQuestions.map(q=>`- ${q}`).join('\n')}`},
        {title:'账号、受众与形式',text:`账号：${parsed.input.accountName}\n定位：${parsed.input.positioning}\n当前受众：${parsed.input.currentAudience}\n形式：${parsed.input.form}`},
        {title:'标准',text:parsed.input.standards},{title:'准确材料及来源',text:sourceLines.join('\n\n')},
        {title:'冻结输入契约',text:`topicId：${caseId}\nreaderGoal：${parsed.input.objective}\nreferencePieces：[]\nmaxRevisions：2\nwebResearch：false\nmaxSeconds：${parsed.input.maxSeconds??'未设置'}`},
        {title:'冻结输入槽位',text:Object.entries(manifest.assets).map(([slot,id])=>`${slot}: ${id}`).join('\n')}],
      conditions:parsed.conditions,runs:runDtos,actions:{start,dispatch,reason}};
  }

  const form:Business['form']=async({spaceId})=>{
    expectedScope({spaceId},options);
    return {title:'新建内容业务',description:'填写要求与材料，先预览并冻结；开始运行需另行放行。',fields:[
      {key:'title',label:'业务名称',kind:'text',required:true},{key:'objective',label:'目标',kind:'multiline',required:true},
      {key:'requiredQuestions',label:'必答问题（每行一问）',kind:'lines',required:true},
      {key:'accountName',label:'账号名称',kind:'text',required:true},{key:'positioning',label:'账号定位',kind:'multiline',required:true},
      {key:'currentAudience',label:'当前受众',kind:'multiline',required:true},{key:'form',label:'表达形式',kind:'text',required:true},
      {key:'standards',label:'内容标准',kind:'multiline',required:true},{key:'materials',label:'材料与来源',kind:'materials',required:true},
      {key:'maxSeconds',label:'可选时长上限（秒）',kind:'text',required:false,help:'留空则不设置固定时长。'},
    ],conditions:[`作者/研究模型：${options.models.worker.model} · ${options.models.worker.reasoningEffort}`,`内部审阅模型：${options.models.judge.model} · ${options.models.judge.reasoningEffort}`,'最多修订 2 轮','联网研究：关闭','参考作品：空列表；不注入历史样例','观众学习目标沿用填写的业务目标','全部材料来源和正文会显示在预览中']};
  };
  const prepare:Business['prepare']=input=>serialized(async()=>{
    expectedScope(input,options);if(!input.key?.trim())fail(400,'INVALID_REQUEST','准备 key 缺失。');
    const raw={...input.values};if(raw.maxSeconds===''||raw.maxSeconds===null||raw.maxSeconds===undefined)delete raw.maxSeconds;
    else if(typeof raw.maxSeconds==='string')raw.maxSeconds=Number(raw.maxSeconds);
    const checked=contentBusinessRequestSchema.safeParse(raw);
    if(!checked.success)fail(400,'INVALID_REQUEST',requestIssue(checked.error.issues[0]?.path??[]));
    const descriptor=checked.data;
    await available(input.spaceId,input.versionId);
    const caseId=caseIdFor(input.spaceId,input.key);
    await preparationWrite(()=>options.workbench.createCase(input.spaceId,{id:caseId,title:descriptor.title,objective:descriptor.objective,constraints:[]}));
    const contentInput=contentInputFor(caseId,descriptor);
    const manifest=await preparationWrite(()=>options.workbench.freezeInput({spaceId:input.spaceId,caseId,input:contentInput,idempotencyKey:`business:${input.key}`}));
    if(manifest.caseId!==caseId||manifest.spaceId!==input.spaceId)fail(409,'RELATION_MISMATCH','冻结输入归属错误。');
    const definitions=await options.service.registerSchemas(input.spaceId,contentBusinessSchemaDefinitions());
    const refs=contentBusinessSchemaRefs(definitions);
    const conditions=(await form({spaceId:input.spaceId})).conditions.concat(descriptor.maxSeconds?[`时长上限：${descriptor.maxSeconds} 秒`]:['时长上限：未设置']);
    const payload=contentBusinessPreparationSchema.parse({caseId,versionId:input.versionId,inputManifestId:manifest.id,inputManifestHash:manifest.hash,conditions,input:descriptor});
    await preparationWrite(()=>options.service.importAsset(input.spaceId,{schema:refs.preparation,payload,dependencies:[...new Set(Object.values(manifest.assets))],
      description:'Frozen ordinary CONTENT business preparation',idempotencyKey:`business:${caseId}:preparation`}));
    return (await preparedDto(input.spaceId,caseId))!;
  });
  const preparation:Business['preparation']=async input=>{expectedScope(input,options);return preparedDto(input.spaceId,input.caseId);};
  const start:Business['start']=input=>serialized(async()=>{
    expectedScope(input,options);const record=await savedPreparation(input.spaceId,input.caseId);
    if(!record||record.parsed.versionId!==input.versionId||record.parsed.inputManifestId!==input.inputManifestId)fail(409,'RELATION_MISMATCH','开始选择与冻结业务不符。');
    const {manifest}=await caseManifest(input.spaceId,input.caseId,input.versionId,input.inputManifestId);
    const prior=await options.service.caseRunsPage(input.spaceId,input.caseId,'creation.content','content',undefined,101);
    for(const run of prior){
      const status=await options.workbench.runStatus(input.spaceId,run.runId);
      if(status.run.metadata?.commandKey===`content:${input.caseId}:${input.key}`){
        const {task}=await exactTask(input.spaceId,input.caseId,input.versionId,manifest,run.runId);
        return receipt(input.caseId,input.versionId,manifest,task);
      }
    }
    if(prior.length)fail(409,'CONFLICT','此业务已有运行；不会自动增加第二次运行。');
    await release(input.spaceId,input.caseId,input.versionId,manifest);
    active(await options.service.executionTasks(input.spaceId));
    const handle=await options.workbench.startFromManifest({spaceId:input.spaceId,caseId:input.caseId,workflowVersionId:input.versionId,
      entrypoint:'content',inputManifestId:manifest.id,idempotencyKey:input.key,dispatch:false});
    const {task}=await exactTask(input.spaceId,input.caseId,input.versionId,manifest,handle.runId);
    // The enqueue receipt remains the durable result if the release changes before dispatch.
    try{return await tryDispatch(input.spaceId,input.caseId,input.versionId,manifest,task.runId);}
    catch(error){return receipt(input.caseId,input.versionId,manifest,task,false,error instanceof Error?error.message:'运行条件已变化；原排队回执已保留。');}
  });
  const dispatch:Business['dispatch']=input=>serialized(async()=>{
    expectedScope(input,options);const record=await savedPreparation(input.spaceId,input.caseId);
    if(!record||record.parsed.versionId!==input.versionId||record.parsed.inputManifestId!==input.inputManifestId)fail(409,'RELATION_MISMATCH','排队运行与冻结业务不符。');
    const {manifest}=await caseManifest(input.spaceId,input.caseId,input.versionId,input.inputManifestId);
    await release(input.spaceId,input.caseId,input.versionId,manifest);
    return tryDispatch(input.spaceId,input.caseId,input.versionId,manifest,input.runId);
  });
  type Process=Awaited<ReturnType<Service['process']>>;
  async function exactSubject(spaceId:string,caseId:string,runId:string,assetId:string,unsupportedAsNotFound=false){
    const status=await options.workbench.runStatus(spaceId,runId),run=status.binding;
    if(run.spaceId!==spaceId||run.caseId!==caseId||run.runId!==runId||run.entrypoint!=='content')fail(409,'RELATION_MISMATCH','CONTENT 稿件与业务运行不符。');
    await method(spaceId,run.workflowVersionId);
    const subject=await options.service.readAsset(spaceId,assetId);
    if(subject.id!==assetId||subject.spaceId!==spaceId)fail(409,'RELATION_MISMATCH','稿件资产归属不符。');
    if(subject.schema.namespace!=='creation/content-draft')
      fail(unsupportedAsNotFound?404:409,unsupportedAsNotFound?'NOT_FOUND':'RELATION_MISMATCH','此资产不是 CONTENT 稿件。');
    const source=subject.source;
    if(source.kind!=='node'||source.runId!==runId)fail(409,'RELATION_MISMATCH','稿件不属于准确运行。');
    if(status.draftVersionId===assetId)return {run,subject,round:null,process:null};
    if(status.draftVersionId||status.run.state!=='failed')
      fail(unsupportedAsNotFound?404:409,unsupportedAsNotFound?'NOT_FOUND':'RELATION_MISMATCH','此稿件不是可处理的当前稿。');
    const process=await options.service.process(spaceId,runId);
    if(process.run.runId!==runId||process.run.caseId!==caseId||process.run.spaceId!==spaceId||
      process.run.workflowVersionId!==run.workflowVersionId||process.run.entrypoint!=='content')
      fail(409,'RELATION_MISMATCH','过程稿与准确运行不符。');
    const draftSlot=process.contract?.nodes.find(node=>node.id==='author'&&node.storageNodeId==='author')?.outputs?.draft?.slot;
    if(!draftSlot||source.nodeId!=='author')fail(409,'RELATION_MISMATCH','过程稿缺少准确作者生产证据。');
    const authors=process.occurrences.filter(item=>item.nodeId==='author'&&item.provenance==='observed'&&
      Number.isInteger(item.round)&&item.state==='succeeded'&&item.outputBindings.some(binding=>binding.slot===draftSlot));
    const latestRound=Math.max(0,...authors.map(item=>item.round!));
    const latest=[...new Set(authors.filter(item=>item.round===latestRound).flatMap(item=>item.outputBindings.filter(binding=>binding.slot===draftSlot).map(binding=>binding.assetVersionId)))];
    const producer=authors.find(item=>item.round===latestRound&&item.contextIds.includes(source.contextId)&&
      item.stepRunIds.includes(source.stepRunId)&&item.outputBindings.some(binding=>binding.slot===draftSlot&&binding.assetVersionId===assetId&&binding.contextId===source.contextId));
    if(latest.length!==1||latest[0]!==assetId||!producer)
      fail(unsupportedAsNotFound?404:409,unsupportedAsNotFound?'NOT_FOUND':'RELATION_MISMATCH','此稿件不是失败运行中最新且可核实的过程稿。');
    return {run,subject,round:latestRound,process};
  }
  async function assessingIds(spaceId:string,runId:string,subjectId:string,process?:Process){
    process??=await options.service.process(spaceId,runId);
    if(process.run.runId!==runId)fail(409,'RELATION_MISMATCH','意见关系与运行不符。');
    return new Set(process.relations.filter(rel=>rel.typeId==='assesses'&&rel.to.assetVersionId===subjectId&&
      (rel.provenance==='recorded'||rel.provenance==='derived')).map(rel=>rel.from.assetVersionId));
  }
  async function verifiedReferences(spaceId:string,runId:string,subjectId:string,ids:string[],edges?:Set<string>,round?:number|null,process?:Process){
    const unique=[...new Set(ids)];if(unique.length!==ids.length)fail(400,'INVALID_REQUEST','意见引用不能重复。');
    const allowed=edges??await assessingIds(spaceId,runId,subjectId,process);
    if(round!==null&&round!==undefined)process??=await options.service.process(spaceId,runId);
    const assets=await Promise.all(unique.map(id=>options.service.readAsset(spaceId,id)));
    for(const asset of assets){if(!allowed.has(asset.id)||asset.source.kind!=='node'||asset.source.runId!==runId||
      !['creation/content-reader','creation/content-fact-check','creation/content-review'].includes(asset.schema.namespace))
      fail(409,'RELATION_MISMATCH','引用意见必须由准确稿件的同一轮内审产生。');}
    if(round!==null&&round!==undefined)for(const asset of assets){
      const source=asset.source;
      if(source.kind!=='node')fail(409,'RELATION_MISMATCH','意见缺少准确节点来源。');
      const originId=source.producer==='program'?source.generatedByContextId:source.contextId;
      const expected={
        'creation/content-reader':{nodeId:'coldReader',branch:'reader'},
        'creation/content-fact-check':{nodeId:'factChecker',branch:'checker'},
        'creation/content-review':{nodeId:'editor',branch:undefined},
      }[asset.schema.namespace];
      if(!originId||!expected||source.nodeId!==expected.nodeId)fail(409,'RELATION_MISMATCH','意见缺少准确生产节点或来源上下文。');
      const occurrence=process!.occurrences.find(item=>item.round===round&&['observed','derived'].includes(item.provenance)&&item.state==='succeeded'&&
        item.nodeId===expected.nodeId&&item.branch===expected.branch&&item.stepRunIds.includes(source.stepRunId)&&
        item.contextIds.includes(source.contextId)&&item.contextIds.includes(originId)&&
        item.outputBindings.some(binding=>binding.assetVersionId===asset.id&&binding.contextId===source.contextId)&&
        item.inputBindings.some(binding=>binding.assetVersionId===subjectId&&binding.contextId===originId));
      if(!occurrence)fail(409,'RELATION_MISMATCH','引用意见缺少与过程稿同轮的准确输入输出绑定。');
    }
    return unique;
  }
  const noteDto=(asset:AssetVersion):HandlingNoteDto=>{
    if(asset.source.kind!=='import'||asset.schema.namespace!==noteNamespace)fail(409,'RELATION_MISMATCH','处理建议来源无效。');
    const source=asset.source;
    const payload=contentHandlingNotePayloadSchema.parse(asset.payload);
    if(asset.dependencies.length!==new Set([payload.subjectAssetId,...payload.referencedAssetIds]).size||
      ![payload.subjectAssetId,...payload.referencedAssetIds].every(id=>asset.dependencies.includes(id)))fail(409,'RELATION_MISMATCH','处理建议依赖与声明不符。');
    return {...payload,id:asset.id,createdAt:asset.createdAt,importedBy:source.actorId};
  };
  const readHandlingNote:Business['readHandlingNote']=async input=>{
    expectedScope(input,options);const subject=await exactSubject(input.spaceId,input.caseId,input.runId,input.assetId);
    let asset:AssetVersion;
    try{asset=await options.service.readAsset(input.spaceId,input.noteId);}
    catch(error){if(error instanceof Error&&/Record not found in authorized space|Asset absent/.test(error.message))return null;throw error;}
    if(asset.id!==input.noteId||asset.spaceId!==input.spaceId||asset.schema.namespace!==noteNamespace||asset.schema.revision!=='1'||asset.source.kind!=='import')return null;
    const note=noteDto(asset);
    if(note.caseId!==input.caseId||note.runId!==input.runId||note.subjectAssetId!==input.assetId)return null;
    await verifiedReferences(input.spaceId,input.runId,input.assetId,note.referencedAssetIds,undefined,subject.round,subject.process??undefined);
    return note;
  };
  const handlingNotes:Business['handlingNotes']=async input=>{
    expectedScope(input,options);if(input.limit!==101)fail(400,'INVALID_REQUEST','处理建议读取上限必须为 101。');
    const subject=await exactSubject(input.spaceId,input.caseId,input.runId,input.assetId,true);
    const records=await options.service.importedAssetsBySchema(input.spaceId,noteNamespace,{caseId:input.caseId,runId:input.runId,subjectAssetId:input.assetId},101);
    const edges=records.length?await assessingIds(input.spaceId,input.runId,input.assetId,subject.process??undefined):new Set<string>();
    const notes=await Promise.all(records.map(async record=>{const value=noteDto(record);if(value.caseId!==input.caseId||value.runId!==input.runId||value.subjectAssetId!==input.assetId)fail(409,'RELATION_MISMATCH','处理建议归属不符。');await verifiedReferences(input.spaceId,input.runId,input.assetId,value.referencedAssetIds,edges,subject.round,subject.process??undefined);return value;}));
    return notes.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
  };
  const addHandlingNote:Business['addHandlingNote']=input=>serialized(async()=>{
    expectedScope(input,options);if(input.importedBy!==options.principalId)fail(403,'FORBIDDEN','导入者必须由认证宿主确定。');
    const subject=await exactSubject(input.spaceId,input.caseId,input.runId,input.assetId);
    const references=await verifiedReferences(input.spaceId,input.runId,input.assetId,input.input.referencedAssetIds,undefined,subject.round,subject.process??undefined);
    const payload=contentHandlingNotePayloadSchema.parse({caseId:input.caseId,runId:input.runId,subjectAssetId:input.assetId,
      author:input.input.author,answers:input.input.answers,recommendation:input.input.recommendation,nextStep:input.input.nextStep,
      referencedAssetIds:references,verification:'declared-external'});
    const defs=await options.service.registerSchemas(input.spaceId,contentBusinessSchemaDefinitions());
    const refs=contentBusinessSchemaRefs(defs);
    const saved=await options.service.importAsset(input.spaceId,{schema:refs.note,payload,dependencies:[input.assetId,...references],
      description:`Declared external-agent handling note for CONTENT run ${input.runId}`,
      idempotencyKey:`business:${input.caseId}:${input.runId}:${input.assetId}:note:${input.input.key}`});
    const note=noteDto(saved);if(note.importedBy!==input.importedBy)fail(409,'RELATION_MISMATCH','处理建议导入者不符。');return note;
  });
  return {form,prepare,preparation,start,dispatch,handlingNotes,readHandlingNote,addHandlingNote};
}

/** Pure attribution for imported business records; never represents them as node outputs. */
export function contentBusinessImportedAssetAttribution(asset:AssetVersion):{caseId:string;runId:string|null;subjectAssetId:string|null}|null{
  if(asset.source.kind!=='import'||asset.schema.revision!=='1')return null;
  if(asset.schema.namespace==='creation/content-business-preparation'){
    const parsed=contentBusinessPreparationSchema.safeParse(asset.payload);
    return parsed.success?{caseId:parsed.data.caseId,runId:null,subjectAssetId:null}:null;
  }
  if(asset.schema.namespace==='creation/content-handling-note'){
    const parsed=contentHandlingNotePayloadSchema.safeParse(asset.payload);
    return parsed.success?{caseId:parsed.data.caseId,runId:parsed.data.runId,subjectAssetId:parsed.data.subjectAssetId}:null;
  }
  return null;
}

/** Trusted scope for only the two imported business schemas. Never infers provenance from payload alone. */
export function createContentBusinessImportedAssetScope(options:ContentBusinessCommandOptions){
  const commands=createContentBusinessCommands(options);
  return async(input:{spaceId:string;asset:AssetVersion}):Promise<{caseId:string;runId:string|null;versionId:string|null}|null>=>{
    expectedScope(input,options);
    const supplied=input.asset;
    if(supplied.spaceId!==input.spaceId||supplied.source.kind!=='import'||supplied.schema.revision!=='1'||
      !['creation/content-business-preparation','creation/content-handling-note'].includes(supplied.schema.namespace))return null;
    let stored:AssetVersion;
    try{stored=await options.service.readAsset(input.spaceId,supplied.id);}
    catch(error){if(error instanceof Error&&/Record not found in authorized space|Asset absent/.test(error.message))return null;throw error;}
    if(stored.id!==supplied.id||stored.spaceId!==supplied.spaceId||stored.source.kind!=='import'||
      stored.schema.namespace!==supplied.schema.namespace||stored.schema.revision!==supplied.schema.revision||stored.schema.hash!==supplied.schema.hash||
      stored.payloadHash!==supplied.payloadHash||JSON.stringify(canonical(stored.payload))!==JSON.stringify(canonical(supplied.payload)))return null;
    if(stored.schema.namespace==='creation/content-business-preparation'){
      const parsed=contentBusinessPreparationSchema.safeParse(stored.payload);if(!parsed.success)return null;
      const matching=await options.service.importedAssetsBySchema(input.spaceId,'creation/content-business-preparation',{caseId:parsed.data.caseId},100);
      if(matching.length!==1||matching[0]!.id!==stored.id)fail(409,'RELATION_MISMATCH','准备资产不是这件业务的唯一准确准备记录。');
      const prepared=await commands.preparation({spaceId:input.spaceId,caseId:parsed.data.caseId});
      if(!prepared||prepared.caseId!==parsed.data.caseId||prepared.versionId!==parsed.data.versionId||
        prepared.inputManifestId!==parsed.data.inputManifestId||prepared.inputManifestHash!==parsed.data.inputManifestHash)
        fail(409,'RELATION_MISMATCH','准备资产与已冻结业务不符。');
      return {caseId:prepared.caseId,runId:null,versionId:prepared.versionId};
    }
    const parsed=contentHandlingNotePayloadSchema.safeParse(stored.payload);if(!parsed.success)return null;
    const note=await commands.readHandlingNote({spaceId:input.spaceId,caseId:parsed.data.caseId,runId:parsed.data.runId,
      assetId:parsed.data.subjectAssetId,noteId:stored.id});
    if(!note||note.id!==stored.id)fail(409,'RELATION_MISMATCH','处理建议与准确运行、稿件或意见不符。');
    const run=(await options.workbench.runStatus(input.spaceId,parsed.data.runId)).binding;
    if(run.caseId!==parsed.data.caseId||run.runId!==parsed.data.runId||run.spaceId!==input.spaceId)fail(409,'RELATION_MISMATCH','处理建议运行归属不符。');
    return {caseId:parsed.data.caseId,runId:parsed.data.runId,versionId:run.workflowVersionId};
  };
}
