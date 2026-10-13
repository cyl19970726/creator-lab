import {createRunDiagnosisStore,createRunDispositionStore,type WorkflowSpaceService,type NodeContext,
  type InputManifest,type SpaceRun,type WorkflowVersion} from '@signal-room/workflow-spaces';
import type {SpaceApiHost} from '@signal-room/workflow-space-api/server';
import {readContentDraftResponse} from './readers.js';
import {researchReviewStandard} from './research-review-standard.js';

type EvaluationCallbacks=Pick<SpaceApiHost,'reviewStandard'|'unpublishedResponseReader'|'runDisposition'|'runDiagnosis'>;
const WORKFLOW_ID='content.explanatory-method';

/** Review criteria come from the run's immutable Case inputs and exact producing context. */
export function createExplanatoryMethodEvaluationHost(options:{service:WorkflowSpaceService;spaceId:string}):EvaluationCallbacks {
  const {service,spaceId:ownedSpace}=options;
  const basis=async(spaceId:string,runId:string):Promise<{
    run:SpaceRun;manifest:InputManifest;version:WorkflowVersion;opportunity:unknown;standards:string|null
  }|null>=>{
    if(spaceId!==ownedSpace)throw new Error('Evaluation belongs to another Space');
    const run=await service.readRun(spaceId,runId);
    if(run.spaceId!==spaceId||run.runId!==runId)throw new Error('Evaluation run scope mismatch');
    const [manifest,version]=await Promise.all([
      service.readManifest(spaceId,run.inputManifestId),service.readWorkflowVersion(spaceId,run.workflowVersionId),
    ]);
    if(manifest.spaceId!==spaceId||manifest.id!==run.inputManifestId||manifest.caseId!==run.caseId||
      version.spaceId!==spaceId||version.id!==run.workflowVersionId||
      version.entrypoints[run.entrypoint]?.workflowId!==WORKFLOW_ID)
      throw new Error('Evaluation frozen Case/version binding mismatch');
    if(run.entrypoint!=='content'||!manifest.assets.opportunity||!manifest.assets.materials||
      Object.keys(manifest.assets).some(slot=>!['opportunity','materials'].includes(slot)))return null;
    const opportunityAsset=await service.readAsset(spaceId,manifest.assets.opportunity);
    if(opportunityAsset.id!==manifest.assets.opportunity||opportunityAsset.spaceId!==spaceId||
      opportunityAsset.schema.namespace!=='creation/content-opportunity'||
      opportunityAsset.source.kind!=='import')throw new Error('Evaluation opportunity source mismatch');
    const opportunity=opportunityAsset.payload;
    const standards=(opportunity&&typeof opportunity==='object'&&!Array.isArray(opportunity)&&
      typeof (opportunity as {standards?:unknown}).standards==='string'&&
      (opportunity as {standards:string}).standards.trim())?(opportunity as {standards:string}).standards:null;
    return {run,manifest,version,opportunity,standards};
  };
  const researchContext=(contexts:NodeContext[],runId:string,ids:{stepRunId:string;attemptId:string;
    sessionId:string;contextIds:string[]}):NodeContext|null=>{
    const exact=contexts.filter(context=>context.runId===runId&&context.stepRunId===ids.stepRunId&&
      context.attemptId===ids.attemptId&&context.sessionId===ids.sessionId&&
      ids.contextIds.includes(context.id)&&context.nodeId==='researcher'&&context.producer==='agent');
    if(exact.length>1)throw new Error('Ambiguous saved research Agent context');
    return exact[0]??null;
  };
  return {
    unpublishedResponseReader:({nodeId,output})=>nodeId==='author'?readContentDraftResponse(output):null,
    reviewStandard:async({spaceId,runId,target})=>{
      const frozen=await basis(spaceId,runId);
      if(!frozen)return null;
      if(target?.kind==='asset'){
        const asset=await service.readAsset(spaceId,target.assetVersionId);
        if(asset.spaceId!==spaceId||asset.id!==target.assetVersionId)throw new Error('Evaluation asset scope mismatch');
        if(asset.source.kind!=='node'||asset.source.runId!==runId)
          throw new Error('Review asset is not produced by the exact run');
        if(asset.schema.namespace==='creation/content-research'){
          const context=await service.readContext(spaceId,asset.source.generatedByContextId??asset.source.contextId);
          if(context.runId!==runId||context.id!==(asset.source.generatedByContextId??asset.source.contextId)||
            context.nodeId!=='researcher'||context.producer!=='agent')
            throw new Error('Research asset producer context mismatch');
          return researchReviewStandard({context,manifest:frozen.manifest,
            opportunity:frozen.opportunity,schemaHash:asset.schema.hash});
        }
      }
      if(target?.kind==='response'){
        const exact=target.target;
        if(exact.runId!==runId)throw new Error('Response target belongs to another run');
        await service.readSavedResponseTarget(spaceId,exact);
        const process=await service.process(spaceId,runId);
        const occurrence=process.occurrences.find(item=>item.id===exact.occurrenceId);
        if(!occurrence||!occurrence.stepRunIds.includes(exact.stepRunId)||
          !occurrence.attemptIds.includes(exact.attemptId))throw new Error('Saved response occurrence mismatch');
        if(occurrence.nodeId==='researcher'){
          const context=researchContext(await service.runtimeContexts(spaceId,runId),runId,{
            stepRunId:exact.stepRunId,attemptId:exact.attemptId,sessionId:exact.sessionId,
            contextIds:occurrence.contextIds});
          if(!context)throw new Error('Saved research response Agent context mismatch');
          const schemaHash=frozen.version.entrypoints.content?.storageContract.nodes.researcher
            ?.outputs.research?.agentOutputSchema?.hash;
          if(!schemaHash)return null;
          return researchReviewStandard({context,manifest:frozen.manifest,
            opportunity:frozen.opportunity,schemaHash});
        }
      }
      return frozen.standards?{id:'content-input-standard',revision:frozen.manifest.hash,content:frozen.standards}:null;
    },
    runDisposition:createRunDispositionStore(service),
    runDiagnosis:createRunDiagnosisStore(service),
  };
}
