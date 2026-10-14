import fs from 'node:fs';
import {artifactPayloadSha256,workflowFingerprint} from '@signal-room/workflow';
import {artifactPath} from '../core/artifacts.js';
import {createHash} from 'node:crypto';
import type {WorkflowSpaceService} from '@signal-room/workflow-spaces';
import type {PostgresWorkflowRunStore} from '@signal-room/workflow-postgres';
import type {BoundedPostExecutionReceipt} from './execution.js';
import {HISTORY_SCHEMA,collectHistoricalRunSet,observedAnalysisVersion} from './history.js';
import {prepareFullWorkflowInput} from '../../../../scripts/benchmark-post-workflow-run.js';
import {methodSnapshot,skillPackageSnapshot,type PinnedResearchInput} from '../workflow/research-inputs.js';

const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const sha=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** Immutable intent, exact material and method are recorded before the one permitted launch. */
export async function prepareSpaceExecution(service:WorkflowSpaceService,store:PostgresWorkflowRunStore,spaceId:string,receipt:BoundedPostExecutionReceipt,versionId:string,caseIdOverride?:string){
 const version=await service.readWorkflowVersion(spaceId,versionId);
 const candidate=object(receipt.snapshot.sourceCandidateArtifact??receipt.snapshot.candidateArtifact);
 const native=await store.getArtifact(String(candidate.id));if(!native||native.sha256!==candidate.sha256)throw new Error('Frozen source candidate identity mismatch');
 const payload=object(await store.getArtifactPayload(native.id)),evidence=object(payload.evidence);
 if(await artifactPayloadSha256(payload)!==native.sha256)throw new Error('Source candidate bytes mismatch');
 const evidenceRef=await store.getArtifact(String(evidence.id));
 if(!evidenceRef||evidenceRef.sha256!==evidence.sha256||evidenceRef.revision!==evidence.revision)throw new Error('Source evidence identity mismatch');
 const frozen=await store.getArtifactPayload(evidenceRef.id) as PinnedResearchInput;
 if(await artifactPayloadSha256(frozen)!==evidenceRef.sha256)throw new Error('Source evidence bytes mismatch');
 if(typeof payload.reportArtifactRef!=='string'||typeof payload.reportSha256!=='string'||createHash('sha256').update(fs.readFileSync(artifactPath(payload.reportArtifactRef))).digest('hex')!==payload.reportSha256)throw new Error('Source report bytes mismatch');
 const pinned=receipt.input.kind==='full'?prepareFullWorkflowInput(frozen):{...frozen,methods:methodSnapshot('post'),skillPackages:[skillPackageSnapshot('post')]};
 if(sha(pinned)!==receipt.frozenInputSha256||sha({methods:pinned.methods,skillPackages:pinned.skillPackages})!==receipt.methodSnapshotSha256)throw new Error('Frozen Space material does not match execution receipt');
 const caseId=caseIdOverride??`lapian-execution-${receipt.id.slice(0,20)}`;
 let existingCase;try{existingCase=await service.readCase(spaceId,caseId);}catch(error){if(!String(error).includes('not found'))throw error;}if(!existingCase)await service.createCase(spaceId,{id:caseId,title:`本轮${receipt.input.kind==='full'?'完整拉片':'Reviewer-only'} · ${String(receipt.snapshot.postId)}`,objective:'通过skill+CLI实际发起当前准确方法，保留全部成果与失败；质量和采用另判',constraints:[receipt.input.kind==='full'?'最多60分钟一次':'最多15分钟一次','Luna medium','禁止自动重跑','不更改当前批次或采用']});
 const entry=version.entrypoints.post!;const schemas=Object.values(entry.process?.runInputs??{});
 const frozenSchema=schemas.find(s=>s.namespace.includes('frozen'));
 // These are real input bytes, not a historical index or a newly invented candidate.
 const [fallback]=await service.registerSchemas(spaceId,[HISTORY_SCHEMA]);
 const material=await service.importAsset(spaceId,{schema:frozenSchema??fallback!,payload:pinned,description:'准确冻结材料；与原生执行frozenInputSha256逐字节核对',idempotencyKey:`execution:${receipt.id}:material`});
 const request=await service.importAsset(spaceId,{schema:fallback!,payload:{title:'受控执行准备',receipt,workflowVersionId:version.id,workflowHash:version.hash,sourceCandidate:{...candidate},qualityAcceptance:'unknown'},description:'模型前保存执行意图、预算与准确方法',idempotencyKey:`execution:${receipt.id}:request`});
 const assets:Record<string,string>={frozenEvidence:material.id,executionRequest:request.id};
 if(receipt.input.kind==='reviewer'){
  const original=(await service.runAssets(spaceId,native.producedBy.workflowRunId)).find(asset=>(asset.source.kind==='historical-artifact'||asset.source.kind==='external-artifact')&&asset.source.artifactId===native.id);
  if(!original)throw new Error('Import and read the exact source candidate producer before this Reviewer-only preparation');
  const schema=entry.process?.runInputs?.candidate;if(!schema)throw new Error('Reviewer method candidate schema missing');
  const report=payload.report??JSON.parse(fs.readFileSync(artifactPath(String(payload.reportArtifactRef)),'utf8'));
  const projection=await service.importAsset(spaceId,{schema,payload:{...payload,report},dependencies:[original.id],description:'原生候选与已校验报告字节的准确输入投影；原artifact SHA另存于executionRequest',idempotencyKey:`execution:${receipt.id}:candidate-input`});assets.candidate=projection.id;assets.nativeCandidate=original.id;
 }
 const manifest=await service.freezeInputs(spaceId,caseId,assets);
 return {spaceId,caseId,inputManifestId:manifest.id,workflowVersionId:version.id,methodHash:version.hash};
}
export async function bindSpaceExecution(service:WorkflowSpaceService,store:PostgresWorkflowRunStore,spaceId:string,sourceWorkspaceId:string,receipt:BoundedPostExecutionReceipt){
 const b=receipt.spaceBinding;if(!b||!receipt.nativeWorkflowRunId)throw new Error('Missing prepared Space or native run identity');
 const version=await service.readWorkflowVersion(spaceId,b.workflowVersionId);if(version.hash!==b.methodHash)throw new Error('Frozen method hash mismatch');
 const native=await store.getRun(receipt.nativeWorkflowRunId);if(!native)throw new Error('Native root missing');
 const actualInput=receipt.nativeWorkflowInput;if(workflowFingerprint(actualInput)!==native.inputFingerprint)throw new Error('Native root input fingerprint mismatch');
 const manifest=await service.readManifest(spaceId,b.inputManifestId);const schema=version.entrypoints.post?.process?.runInputs?.postInput;
 let exact=manifest;const exactAssets={...manifest.assets};
 const nativeInput=object(actualInput),nativeEvidence=object(nativeInput.evidence);
 const evidenceRef=await store.getArtifact(String(nativeEvidence.id));
 if(!evidenceRef||evidenceRef.sha256!==nativeEvidence.sha256||evidenceRef.revision!==nativeEvidence.revision)throw new Error('Launched evidence reference mismatch');
 const evidencePayload=await store.getArtifactPayload(evidenceRef.id);
 const preparedMaterial=await service.readAsset(spaceId,manifest.assets.frozenEvidence!);
 // PostgreSQL JSONB changes key order. Native artifact identity is canonical, while the benchmark's raw JSON digest is kept separately.
 if(await artifactPayloadSha256(evidencePayload)!==evidenceRef.sha256||await artifactPayloadSha256(evidencePayload)!==await artifactPayloadSha256(preparedMaterial.payload))throw new Error('Launched material differs from prepared input');
 const [fallback]=await service.registerSchemas(spaceId,[HISTORY_SCHEMA]);
 const nativeInputAsset=await service.importAsset(spaceId,{schema:fallback!,payload:actualInput,description:'模型前真实原生root input，保留准确candidate/evidence引用',idempotencyKey:`execution:${receipt.id}:native-wrapper`});exactAssets.nativeRunInput=nativeInputAsset.id;
 if(receipt.input.kind==='reviewer'){
  const candidateRef=object(nativeInput.candidate),candidate=await store.getArtifact(String(candidateRef.id));
  if(!candidate||candidate.sha256!==candidateRef.sha256||candidate.revision!==candidateRef.revision)throw new Error('Launched candidate reference mismatch');
  const p=object(await store.getArtifactPayload(candidate.id));if(await artifactPayloadSha256(p)!==candidate.sha256)throw new Error('Launched candidate bytes mismatch');
  const candidateSchema=version.entrypoints.post!.process!.runInputs!.candidate!;
  const report=p.report??JSON.parse(fs.readFileSync(artifactPath(String(p.reportArtifactRef)),'utf8'));
  const projected=await service.importAsset(spaceId,{schema:candidateSchema,payload:{...p,report},description:'模型前冻结真实本次candidate内容与报告；准确原生引用保留在nativeRunInput',idempotencyKey:`execution:${receipt.id}:launched-candidate`});exactAssets.candidate=projected.id;
 }
 if(schema){
  const asset=await service.importAsset(spaceId,{schema,payload:actualInput,description:'模型前冻结真实原生root输入，包括新生成的准确evidence引用',idempotencyKey:`execution:${receipt.id}:native-input`});
  exactAssets.postInput=asset.id;
 }
 exact=await service.freezeInputs(spaceId,b.caseId,exactAssets);
 await service.bindExternalRun(spaceId,{sourceWorkspaceId,runs:[{runId:receipt.nativeWorkflowRunId,workflowVersionId:b.workflowVersionId,entrypoint:'post',inputManifestId:exact.id,effectiveConfig:version.config}]});
 return {...b,runId:native.id,inputManifestId:exact.id};
}
export async function syncSpaceExecution(service:WorkflowSpaceService,store:PostgresWorkflowRunStore,spaceId:string,sourceWorkspaceId:string,receipt:BoundedPostExecutionReceipt){
 if(!receipt.nativeWorkflowRunId||!receipt.spaceBinding)return {pending:true,receipt};
 const b=receipt.spaceBinding;const selected=new Map((await collectHistoricalRunSet(store,receipt.nativeWorkflowRunId)).map(run=>[run.id,run]));
 const rootInput=object(receipt.nativeWorkflowInput),inputProducerIds=new Set<string>();
 for(const value of [rootInput.evidence,rootInput.candidate]){
  const ref=object(value);if(typeof ref.id!=='string')continue;const artifact=await store.getArtifact(ref.id);
  if(!artifact||artifact.sha256!==ref.sha256||artifact.revision!==ref.revision)throw new Error('Native input artifact reference changed');
  inputProducerIds.add(artifact.producedBy.workflowRunId);
  for(const producer of await collectHistoricalRunSet(store,artifact.producedBy.workflowRunId))selected.set(producer.id,producer);
 }
 if(selected.size>32)throw new Error('Explicit execution source closure exceeds 32 runs');
 const runs=[...selected.values()],bindings=[];
 for(const native of runs){
  let existing;try{existing=await service.readRun(spaceId,native.id);}catch(error){if(!String(error).includes('not found'))throw error;}
  if(existing?.executionMode==='imported')continue;
  if(existing){bindings.push({runId:native.id,workflowVersionId:existing.workflowVersionId,entrypoint:existing.entrypoint,inputManifestId:existing.inputManifestId,effectiveConfig:existing.effectiveConfig});continue;}
  const steps=await store.listSteps(native.id),events=await store.listEvents(native.id);
  if(native.id!==receipt.nativeWorkflowRunId&&events[0]&&receipt.startedAt&&Date.parse(events[0].timestamp)<Date.parse(receipt.startedAt))throw new Error(`Older dependency ${native.id} must be explicitly linked as history before this execution`);
  if(native.state==='running'&&(!steps.length||steps.some(s=>s.kind==='agent')&&!events.some(e=>e.type==='responses.method')))continue;
  const observedId=`lapian-observed-${native.id}`;
  let version;try{version=await service.readWorkflowVersion(spaceId,observedId);}catch(error){if(!String(error).includes('not found'))throw error;}
  if(version){if(version.config?.sourceRunId!==native.id||version.entrypoints.post?.workflowId!==native.workflowId||version.entrypoints.post?.codeRevision!==native.workflowRevision)throw new Error('Observed native method identity mismatch');}
  else version=await service.publishWorkflow(spaceId,await observedAnalysisVersion(store,native,'external'));
  const [schema]=await service.registerSchemas(spaceId,[HISTORY_SCHEMA]);
  const presentationId=`lapian-observed-${native.id}`;
  await service.registerPresentation(spaceId,{id:presentationId,revision:'1',entrypoint:'post',label:`辅助流程 ${native.workflowId}`,purpose:'本次领域执行的实际观察；prompt只在hash吻合时恢复',stages:[{id:'native-execution',label:`${native.workflowId} 实际执行`}],assetViews:[{schema:{namespace:schema!.namespace,revision:schema!.revision,hash:schema!.hash},label:'实际正文与证据',reader:'analysis.lapian',sections:[]}],results:{primary:'report',supporting:['evidence'],assessments:['review']}});
  await service.bindPresentation(spaceId,{workflowVersionId:version.id,entrypoint:'post',presentationId,revision:'1'});
  bindings.push({runId:native.id,workflowVersionId:version.id,entrypoint:'post',inputManifestId:b.inputManifestId,effectiveConfig:version.config,...(inputProducerIds.has(native.id)?{supportingOf:receipt.nativeWorkflowRunId}:{})});
 }
 if(bindings.length)await service.syncExternalRuns(spaceId,{sourceWorkspaceId,runs:bindings});
 const [schema]=await service.registerSchemas(spaceId,[HISTORY_SCHEMA]);const assets=[];
 for(const binding of bindings)for(const artifact of await store.listArtifacts(binding.runId)){
  const asset=await service.publishExternalArtifact(spaceId,{artifactId:artifact.id,schema:schema!,idempotencyKey:`external:${artifact.id}`});assets.push({assetId:asset.id,nativeArtifactId:artifact.id,runId:binding.runId});
 }
 return {caseId:b.caseId,rootRunId:receipt.nativeWorkflowRunId,methodVersionId:b.workflowVersionId,inputManifestId:b.inputManifestId,runs:bindings.map(v=>v.runId),assets,receipt};
}
