import {createHash} from 'node:crypto';
import {createMethodDesignStore,type WorkflowSpaceService,type MethodDesignRevision} from '@signal-room/workflow-spaces';
import {buildCurrentAnalysisPostMethod} from './method.js';

/** The native domain code owns executable behavior; design explains its sourced contract. */
export function compileLapianMethod(design:MethodDesignRevision,reviewerOnly=false){
 const base={revision:reviewerOnly?'post-review-v6-harness-2':'post-analyze-v11-harness-2',changeReason:design.changeReason,registrationEnabled:false,reviewerOnly};
 const probe=buildCurrentAnalysisPostMethod({...base,id:'lapian-method-preview'});
 const digest=createHash('sha256').update(JSON.stringify({design:design.payloadHash,source:probe.methodSnapshot,reviewerOnly})).digest('hex').slice(0,20);
 const projection=buildCurrentAnalysisPostMethod({...base,id:`lapian-${reviewerOnly?'reviewer':'current'}-${digest}`});
 projection.version.config={...projection.version.config,methodKind:reviewerOnly?'auxiliary':'primary'};
 projection.version.designBasis={designRevisionId:design.id,designPayloadHash:design.payloadHash,understandingRevisionId:design.understanding.revisionId,understandingPayloadHash:design.understanding.payloadHash};
 return projection;
}
export function lapianMethodDesignHost(service:WorkflowSpaceService,spaceId:string,publisher:WorkflowSpaceService=service){
 const store=createMethodDesignStore(service);
 const read=async(space:string,id:string)=>{if(space!==spaceId)throw new Error('Space mismatch');const d=await store.read(space,id);if(d.workflowId!=='post.analyze'||d.entrypoint!=='post')throw new Error('Method design scope mismatch');return d;};
 return {current:(space:string)=>store.current(space,'post.analyze'),read,history:(space:string)=>store.history(space,'post.analyze'),save:store.save,basis:(space:string,id:string)=>store.readBasis(space,id),
  preview:async(space:string,id:string)=>{const d=await read(space,id),p=compileLapianMethod(d);return {versionId:p.version.id!,workflowId:'post.analyze',entrypoint:'post',designRevisionId:d.id,designHash:d.payloadHash,understandingRevisionId:d.understanding.revisionId,understandingHash:d.understanding.payloadHash,availability:'available' as const,blockers:['仅支持显式有界执行；可执行不代表质量通过或采用']};},
  publish:async(space:string,input:{designRevisionId:string;expectedCandidateId:string})=>{
   const d=await read(space,input.designRevisionId),p=compileLapianMethod(d);
   if(p.version.id!==input.expectedCandidateId)throw new Error('Current source changed; preview exact method again');
   let auxiliary=await store.current(space,'post.review');
   if(!auxiliary?.sources.some(source=>source.kind==='asset'&&source.ref===d.id)){
    auxiliary=await store.save(space,{workflowId:'post.review',entrypoint:'post',understanding:d.understanding,expectedRevisionId:auxiliary?.id??null,idempotencyKey:`lapian-reviewer-design:${d.id}`,title:'准确旧候选的 Reviewer-only 局部复核',content:`此辅助方法依据整体设计 ${d.id}（${d.payloadHash}）的独立 Reviewer 部分。它只消费准确候选和冻结证据，沿当前 post.review@v6 的 prompt/tools/I/O 执行一次审阅；不构建、不修订、不登记。程序完成或空 findings 不代表质量接受。固定一次15分钟，Luna medium，禁止自动重跑。\n\n整体设计原文：\n${d.content}`,sources:[{kind:'asset',ref:d.id,title:d.title,excerpt:'整体设计的 Reviewer-only 能力与预算边界'}],authorship:d.authorship,changeReason:'从已认证Agent保存的整体设计投影辅助方法范围；不是新增模型设计实验'});
   }
   const reviewer=compileLapianMethod(d,true);reviewer.version.designBasis={designRevisionId:auxiliary.id,designPayloadHash:auxiliary.payloadHash,understandingRevisionId:auxiliary.understanding.revisionId,understandingPayloadHash:auxiliary.understanding.payloadHash};
   for(const projection of [p,reviewer]){
    await publisher.registerSchemas(space,projection.schemaDefinitions);
    const v=await publisher.publishWorkflow(space,projection.version);
    await publisher.registerPresentation(space,projection.presentation);
    const bound=await service.resolvePresentation(space,v.id,'post');
    if(!bound)await publisher.bindPresentation(space,{workflowVersionId:v.id,entrypoint:'post',presentationId:projection.presentation.id,revision:projection.presentation.revision});
   }
   return {versionId:p.version.id!,designRevisionId:d.id,understandingRevisionId:d.understanding.revisionId};
  },
 };
}
