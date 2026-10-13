import {describe,expect,it,vi} from 'vitest';
import type {WorkflowSpaceService,AssetVersion,NodeContext,SavedResponseTarget} from '@signal-room/workflow-spaces';
import {createExplanatoryMethodEvaluationHost} from '../src/spaces/explanatory-method-evaluation-host.js';
import {researchReviewStandard} from '../src/spaces/research-review-standard.js';

const target:SavedResponseTarget={runId:'run',occurrenceId:'research-occurrence',stepRunId:'step',attemptId:'attempt',
  sessionId:'session',eventId:'event',eventSeq:1,outputHash:'response-hash'};
const opportunity={topicId:'original-topic',opportunity:'Explain the synthetic observation',readerGoal:'Understand why the cup warmed',
  requiredQuestions:['What happened?','Which source supports it?','What remains unknown?'],standards:'C1-C8 frozen manuscript standard',
  account:{name:'Test',positioning:'Explain',currentAudience:'Curious readers',referencePieces:[]},form:'Video',webResearch:false,maxRevisions:1};
const manifest={id:'manifest',hash:'manifest-hash',spaceId:'space',caseId:'commission-case',assets:{opportunity:'opportunity',materials:'materials'}};
const context={id:'context',spaceId:'space',runId:'run',stepRunId:'step',attemptId:'attempt',nodeId:'researcher',
  sessionId:'session',producer:'agent',hash:'context-hash',instructions:'你是研究编辑。研究冻结材料并回答问题。',
  inputs:{opportunity:{assetVersionId:'opportunity'}}} as unknown as NodeContext;
const researchAsset={id:'research-asset',spaceId:'space',schema:{namespace:'creation/content-research',revision:'1',hash:'stored-research-hash'},
  source:{kind:'node',runId:'run',contextId:'publication-context',generatedByContextId:'context'}} as unknown as AssetVersion;
const otherAsset={...researchAsset,id:'draft-asset',schema:{namespace:'creation/content-draft',revision:'1',hash:'draft-hash'}} as AssetVersion;
function fixture(){
  const calls={readSavedResponseTarget:vi.fn(async()=>({target,output:{questions:[]}})),
    runtimeContexts:vi.fn(async()=>[context,{...context,id:'decoy',attemptId:'other-attempt',hash:'decoy-hash'}])};
  const service={
    readRun:async()=>({runId:'run',spaceId:'space',caseId:'commission-case',workflowVersionId:'version',
      entrypoint:'content',inputManifestId:'manifest'}),
    readManifest:async()=>manifest,
    readWorkflowVersion:async()=>({id:'version',spaceId:'space',entrypoints:{content:{workflowId:'content.explanatory-method',
      storageContract:{nodes:{researcher:{outputs:{research:{agentOutputSchema:{hash:'frozen-agent-schema-hash'}}}}}}}}}),
    readAsset:async(_space:string,id:string)=>id==='opportunity'?{id:'opportunity',spaceId:'space',
      schema:{namespace:'creation/content-opportunity',revision:'1',hash:'opportunity-hash'},
      source:{kind:'import'},payload:opportunity}:id==='research-asset'?researchAsset:otherAsset,
    readContext:async()=>context,
    process:async()=>({occurrences:[{id:'research-occurrence',nodeId:'researcher',stepRunIds:['step'],
      attemptIds:['attempt'],contextIds:['context'],state:'failed',outputBindings:[]}]}),
    runtimeContexts:calls.runtimeContexts,readSavedResponseTarget:calls.readSavedResponseTarget,
  } as unknown as WorkflowSpaceService;
  return {host:createExplanatoryMethodEvaluationHost({service,spaceId:'space'}),service,calls};
}

describe('explanatory evaluation callbacks',()=>{
  it('judges a published research asset using its exact frozen Case goal, questions and producer prompt',async()=>{
    const {host}=fixture();
    const value=await host.reviewStandard!({spaceId:'space',runId:'run',target:{kind:'asset',assetVersionId:'research-asset'}});
    expect(value).toEqual(researchReviewStandard({context,manifest,opportunity,schemaHash:'stored-research-hash'}));
    expect(value?.content).toContain('Understand why the cup warmed');
    expect(value?.content).toContain('Which source supports it?');
    expect(value?.content).toContain('你是研究编辑。');
    expect(value?.content).not.toContain('C1-C8 frozen manuscript standard');
    expect(await host.reviewStandard!({spaceId:'space',runId:'run',target:{kind:'asset',assetVersionId:'draft-asset'}}))
      .toEqual({id:'content-input-standard',revision:'manifest-hash',content:opportunity.standards});
  });
  it('uses only the exact failed response occurrence, Agent context and published output schema',async()=>{
    const {host,calls}=fixture();
    const value=await host.reviewStandard!({spaceId:'space',runId:'run',target:{kind:'response',target}});
    expect(calls.readSavedResponseTarget).toHaveBeenCalledWith('space',target);
    expect(value).toEqual(researchReviewStandard({context,manifest,opportunity,schemaHash:'frozen-agent-schema-hash'}));
    expect(value?.content).toContain('What remains unknown?');
    await expect(host.reviewStandard!({spaceId:'space',runId:'run',target:{kind:'response',target:{...target,runId:'other'}}}))
      .rejects.toThrow('another run');
    const missing=fixture();
    missing.calls.runtimeContexts.mockResolvedValue([{...context,attemptId:'other-attempt'}]);
    await expect(missing.host.reviewStandard!({spaceId:'space',runId:'run',target:{kind:'response',target}}))
      .rejects.toThrow('Agent context mismatch');
  });
  it('exposes existing disposition and diagnosis stores without setup writes',async()=>{
    const {host}=fixture();
    expect(host.runDisposition?.save).toBeTypeOf('function');
    expect(host.runDiagnosis?.current).toBeTypeOf('function');
    expect(host.unpublishedResponseReader?.({nodeId:'researcher',output:{}})).toBeNull();
  });
});
