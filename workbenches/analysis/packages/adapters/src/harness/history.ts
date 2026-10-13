import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {artifactPayloadSha256,type RunRecord,type StepRecord} from '@signal-room/workflow';
import {PostgresWorkflowRunStore} from '@signal-room/workflow-postgres';
import {JSON_SCHEMA_DIALECT,type SchemaRef} from '@signal-room/workflow-space-contracts';
import type {WorkflowSpaceService,WorkflowVersionDraft,WorkflowNodeDefinition} from '@signal-room/workflow-spaces';
import {artifactPath} from '../core/artifacts.js';
import {projectRoot} from '../core/config.js';

export const HISTORY_SCHEMA={namespace:'analysis/historical-evidence',revision:'1',dialect:JSON_SCHEMA_DIALECT,schema:{$schema:JSON_SCHEMA_DIALECT,type:'object',additionalProperties:true}};
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const sha=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const nodeId=(s:StepRecord)=>`step-${s.id}`;
/** Reconstruct only saved execution facts. A current file is usable only if its bytes match the saved hash. */
async function historicalVersion(store:PostgresWorkflowRunStore,run:RunRecord):Promise<WorkflowVersionDraft>{
 const steps=await store.listSteps(run.id),events=await store.listEvents(run.id);
 const methods=events.filter(e=>e.type==='responses.method').map(e=>object(e.data));
 const definitions:Record<string,WorkflowNodeDefinition>={};
 for(const step of steps){
  const savedMethod=events.find(e=>e.type==='responses.method'&&e.stepRunId===step.id);
  const method=savedMethod?object(savedMethod.data):undefined;
  let instructions:string|undefined;
  if(method&&typeof method.promptPath==='string'&&typeof method.promptSha256==='string'){
   const file=path.join(projectRoot,'prompts',path.basename(method.promptPath));
   if(fs.existsSync(file)&&sha(fs.readFileSync(file))===method.promptSha256)instructions=fs.readFileSync(file,'utf8');
  }
  definitions[nodeId(step)]={purpose:`历史实际步骤 ${step.key}；${instructions?'指令原文已与保存SHA匹配':'未保存或未恢复准确指令，不能用当前方法代替'}`,
   ...(instructions?{instructions}:{}),...(method?{model:String(method.model),tools:Array.isArray(method.toolNames)?method.toolNames as string[]:[],configuration:{reasoningEffort:method.reasoningEffort,promptSha256:method.promptSha256,methodRevision:method.methodRevision}}:{}),
   executor:{family:step.kind==='agent'?'agent-sdk':'program'}};
 }
 const id=`lapian-history-${run.id}`;
 return {id,revision:run.workflowRevision,changeReason:'历史运行观察投影；不是原始设计史，也不是当前新执行方法',config:{historical:true,sourceRunId:run.id,methodEvents:methods},
  entrypoints:{post:{workflowId:run.workflowId,codeRevision:run.workflowRevision,storageContract:{workflowVersion:id,nodes:{history:{actorKinds:['program'],inputs:{},outputs:{},actions:[]}},stateRules:[]},nodeDefinitions:definitions,
   process:{revision:'observed-history-1',nodes:steps.map(s=>({id:nodeId(s),kind:s.kind==='agent'?'agent' as const:'program' as const})),edges:[],results:[]}}}};
}
export async function collectHistoricalRunSet(store:PostgresWorkflowRunStore,rootRunId:string,maxRuns=32){
 const all=await store.listRuns(),byId=new Map(all.map(r=>[r.id,r]));
 const selected=new Map<string,RunRecord>();
 async function add(id:string,children:boolean){
  if(selected.has(id))return;const run=byId.get(id);if(!run)throw new Error(`Historical run unavailable: ${id}`);
  if(selected.size>=maxRuns)throw new Error('Historical run set exceeds explicit bounded limit');selected.set(id,run);
  if(run.parentRunId)await add(run.parentRunId,false);
  if(children)for(const child of all.filter(r=>r.parentRunId===id))await add(child.id,true);
  for(const artifact of await store.listArtifacts(id))for(const dep of artifact.dependsOn??[]){
   const source=await store.getArtifact(dep.artifactId);if(!source||source.sha256!==dep.sha256||source.revision!==dep.revision)throw new Error('Historical dependency mismatch');
   await add(source.producedBy.workflowRunId,false);
  }
 }
 await add(rootRunId,true);return [...selected.values()];
}
export async function importLapianHistory(options:{service:WorkflowSpaceService;store:PostgresWorkflowRunStore;spaceId:string;sourceWorkspaceId:string;rootRunId:string;title:string;description:string}){
 const {service,store,spaceId,sourceWorkspaceId,rootRunId}=options;
 const [registered]=await service.registerSchemas(spaceId,[HISTORY_SCHEMA]);const schema:SchemaRef={namespace:registered!.namespace,revision:registered!.revision,hash:registered!.hash};
 const runs=await collectHistoricalRunSet(store,rootRunId);
 await service.registerPresentation(spaceId,{id:'lapian-history',revision:'1',entrypoint:'post',label:'拉片历史方法',purpose:'从真实保存记录恢复方法与成果；缺失的历史指令保持未知。',assetViews:[{schema,label:'拉片正文与证据',reader:'analysis.lapian',sections:[]}],results:{primary:'report',supporting:['evidence'],assessments:['review']}});
 let existingRoot;try{existingRoot=await service.readRun(spaceId,rootRunId);}catch(error){if(!String(error).includes('not found'))throw error;}
 const caseId=existingRoot?.caseId??`lapian-case-${rootRunId}`;
 if(!existingRoot)await service.createCase(spaceId,{id:caseId,title:options.title,objective:options.description,constraints:['历史导入不算新harness执行','运行完成不等于质量合格','不改变当前使用选择']});
 const source=await service.importAsset(spaceId,{schema,payload:{title:options.title,description:options.description,rootRunId,sourceWorkspaceId,runIds:runs.map(r=>r.id)},description:'明确来源的历史案例索引',idempotencyKey:`history-index:${rootRunId}`});
 const manifest=await service.freezeInputs(spaceId,caseId,{historicalSource:source.id});
 const bindings=[];
 for(const run of runs){let existing;try{existing=await service.readRun(spaceId,run.id);}catch(error){if(!String(error).includes('not found'))throw error;}if(existing){bindings.push({runId:run.id,workflowVersionId:existing.workflowVersionId,entrypoint:existing.entrypoint,inputManifestId:existing.inputManifestId,effectiveConfig:existing.effectiveConfig});continue;}const draft=await historicalVersion(store,run);await service.publishWorkflow(spaceId,draft);await service.bindPresentation(spaceId,{workflowVersionId:draft.id,entrypoint:'post',presentationId:'lapian-history',revision:'1'});bindings.push({runId:run.id,workflowVersionId:draft.id,entrypoint:'post',inputManifestId:manifest.id,effectiveConfig:{historical:true,originalWorkflowId:run.workflowId}});}
 await service.importHistoricalRuns(spaceId,{sourceWorkspaceId,runs:bindings});
 const assets=[];
 for(const run of runs)for(const artifact of await store.listArtifacts(run.id)){
  const payload=object(await store.getArtifactPayload(artifact.id));
  if(await artifactPayloadSha256(payload)!==artifact.sha256)throw new Error('Historical artifact payload changed');
  if(typeof payload.reportArtifactRef==='string'&&typeof payload.reportSha256==='string'){
   const bytes=fs.readFileSync(artifactPath(payload.reportArtifactRef));if(sha(bytes)!==payload.reportSha256)throw new Error('Report bytes no longer match original candidate');
  }
  const asset=await service.publishHistoricalArtifact(spaceId,{artifactId:artifact.id,schema,idempotencyKey:`history-native:${artifact.id}`});assets.push({id:asset.id,nativeArtifactId:artifact.id,runId:run.id,payloadHash:asset.payloadHash});
 }
 return {caseId,rootRunId,inputManifestId:manifest.id,runs:bindings,assets,sourceAssetId:source.id,executionMode:'imported'};
}
