import type { ProcessContractDraft, NodeOccurrenceAnnotation, HistoricalProcessResolver, WorkflowSpaceService, NodeRelationWrite, AssetVersion } from '@signal-room/workflow-spaces';
import type { StepRecord } from '@signal-room/workflow';
import type { CreationSchemaRefs } from './contracts.js';

export const CONTENT_PROCESS_REVISION='content-process-2';
export const CONTENT_PROCESS_RESOLVER_REVISION='content-observation-2';

/** Observational contract for the existing CONTENT code; it does not execute or alter its routing. */
export function buildContentProcess(refs:CreationSchemaRefs):ProcessContractDraft {
  const ports=(...slots:string[])=>Object.fromEntries(slots.map(slot=>[slot,{slot}]));
  const dataBindings:NonNullable<ProcessContractDraft['dataBindings']>=[];
  const frozen=(name:string,node:string,port=name,when?:'initial-round'|'later-rounds')=>dataBindings.push({id:`input-${name}-${node}-${port}`,from:{runInput:name},to:{node,port},selection:'frozen-input',...(when?{when}:{})});
  const output=(from:string,sourcePort:string,to:string,targetPort:string,selection:'latest-successful-in-this-run'|'previous-business-round'|'current-business-round',when?:'initial-round'|'later-rounds')=>dataBindings.push({id:`${from}-${sourcePort}-${to}-${targetPort}`,from:{node:from,port:sourcePort},to:{node:to,port:targetPort},selection,...(when?{when}:{})});
  for(const node of ['researcher','author']) {
    frozen('opportunity',node);frozen('materials',node);frozen('feedback',node,'creatorFeedback');
    frozen('priorDraft',node,'priorDraft','initial-round');
    output('author','draft',node,'priorDraft','previous-business-round','later-rounds');
    output('editor','review',node,'priorReview','previous-business-round','later-rounds');
  }
  output('researcher','research','researcher','priorResearch','latest-successful-in-this-run','later-rounds');
  for(const node of ['author','factChecker','editor','creatorDraftGate'])output('researcher','research',node,'research','latest-successful-in-this-run');
  output('author','draft','coldReader','manuscript','current-business-round');
  frozen('opportunity','coldReader','audienceProfile');frozen('materials','factChecker');frozen('opportunity','editor');
  for(const node of ['factChecker','editor','creatorDraftGate'])output('author','draft',node,'draft','current-business-round');
  output('coldReader','reader','editor','reader','current-business-round');
  output('factChecker','factCheck','editor','factCheck','current-business-round');
  output('editor','review','creatorDraftGate','review','current-business-round');
  return {
    revision:CONTENT_PROCESS_REVISION,
    runInputs:{opportunity:refs.opportunity,materials:refs.materials,feedback:refs.humanFeedback,priorDraft:refs.draft},dataBindings,
    nodes:[
      {id:'researcher',kind:'agent',storageNodeId:'researcher',inputs:ports('opportunity','materials','priorResearch','priorDraft','priorReview','creatorFeedback'),outputs:ports('research')},
      {id:'author',kind:'agent',storageNodeId:'author',inputs:ports('opportunity','materials','research','priorDraft','priorReview','creatorFeedback'),outputs:ports('draft')},
      {id:'coldReader',kind:'agent',storageNodeId:'coldReader',inputs:ports('manuscript','audienceProfile'),outputs:ports('reader')},
      {id:'factChecker',kind:'agent',storageNodeId:'factChecker',inputs:ports('draft','research','materials'),outputs:ports('factCheck')},
      {id:'editor',kind:'agent',storageNodeId:'editor',inputs:ports('opportunity','draft','research','reader','factCheck'),outputs:ports('review')},
      {id:'route',kind:'decision'},
      {id:'creatorDraftGate',kind:'human',storageNodeId:'creatorDraftGate',inputs:ports('draft','review','research')},
      {id:'stop',kind:'group'},
    ],
    edges:[
      {id:'research-to-draft',from:'researcher',to:'author',kind:'sequence'},
      {id:'draft-to-reader',from:'author',to:'coldReader',kind:'fork',route:'reviewers',branch:'reader'},
      {id:'draft-to-facts',from:'author',to:'factChecker',kind:'fork',route:'reviewers',branch:'checker'},
      {id:'reader-to-editor',from:'coldReader',to:'editor',kind:'join',route:'reviewers',branch:'reader'},
      {id:'facts-to-editor',from:'factChecker',to:'editor',kind:'join',route:'reviewers',branch:'checker'},
      {id:'editor-to-route',from:'editor',to:'route',kind:'sequence'},
      {id:'route-pass',from:'route',to:'creatorDraftGate',kind:'condition',route:'pass'},
      {id:'route-blocked',from:'route',to:'stop',kind:'condition',route:'blocked'},
      {id:'route-budget',from:'route',to:'stop',kind:'condition',route:'not-converged'},
      {id:'route-rewrite',from:'route',to:'author',kind:'rework',route:'rewrite',maxTraversals:5},
      {id:'route-research',from:'route',to:'researcher',kind:'rework',route:'research',maxTraversals:5},
      {id:'route-reframe',from:'route',to:'researcher',kind:'rework',route:'reframe',maxTraversals:5},
    ],
    results:[{role:'final-draft',nodeId:'author',outputPort:'draft'},{role:'research',nodeId:'researcher',outputPort:'research'}],
    relationTypes:[
      {id:'revision-of',revision:'1',fromSchemas:[refs.draft,refs.research],toSchemas:[refs.draft,refs.research],scope:'case',maxPerFrom:1,allowCycle:false},
      {id:'assesses',revision:'1',fromSchemas:[refs.reader,refs.factCheck,refs.review],toSchemas:[refs.draft],scope:'run',maxPerFrom:1,allowCycle:false},
      {id:'uses-feedback',revision:'1',fromSchemas:[refs.draft,refs.research],toSchemas:[refs.review,refs.humanFeedback],scope:'case',allowCycle:false},
      {id:'cites',revision:'1',fromSchemas:[refs.research,refs.draft],toSchemas:[refs.materials,refs.research],scope:'case',allowFromPointer:true,allowToPointer:true,allowCycle:true},
    ],
    relationMappings:[
      {id:'draft-revision',typeId:'revision-of',nodeId:'author',outputPort:'draft',inputPort:'priorDraft'},
      {id:'research-revision',typeId:'revision-of',nodeId:'researcher',outputPort:'research',inputPort:'priorResearch'},
      {id:'draft-feedback',typeId:'uses-feedback',nodeId:'author',outputPort:'draft',inputPort:'priorReview'},
      {id:'research-feedback',typeId:'uses-feedback',nodeId:'researcher',outputPort:'research',inputPort:'priorReview'},
      {id:'reader-target',typeId:'assesses',nodeId:'coldReader',outputPort:'reader',inputPort:'manuscript',required:true},
      {id:'facts-target',typeId:'assesses',nodeId:'factChecker',outputPort:'factCheck',inputPort:'draft',required:true},
      {id:'editor-target',typeId:'assesses',nodeId:'editor',outputPort:'review',inputPort:'draft',required:true},
      {id:'research-material-cites',typeId:'cites',nodeId:'researcher',outputPort:'research',inputPort:'materials',policy:'explicit'},
      {id:'research-note-cites',typeId:'cites',nodeId:'researcher',outputPort:'research',toOutputPort:'research',policy:'explicit'},
      {id:'draft-material-cites',typeId:'cites',nodeId:'author',outputPort:'draft',inputPort:'materials',policy:'explicit'},
      {id:'draft-note-cites',typeId:'cites',nodeId:'author',outputPort:'draft',inputPort:'research',policy:'explicit'},
    ],
  };
}

/** Round comes only from the persisted scoped phase, never from retry count or creation order. */
export function contentOccurrence(step:StepRecord,nodeId:string):NodeOccurrenceAnnotation|undefined {
  const phase=step.phasePath?.find(value=>/^content-(?:research|draft|check|editor)-\d+$/.test(value));
  const match=/^content-(?:research|draft|check|editor)-(\d+)$/.exec(phase??'');
  if(!match)return undefined;
  return {nodeId,round:Number(match[1])+1,...(nodeId==='coldReader'?{branch:'reader'}:nodeId==='factChecker'?{branch:'checker'}:{})};
}

const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const array=(value:unknown):unknown[]=>Array.isArray(value)?value:[];
const text=(value:unknown):string=>typeof value==='string'?value:'';

function citationRefs(nodeId:string,payload:unknown):Array<{ref:string;pointer:string}> {
  const refs:Array<{ref:string;pointer:string}>=[];
  if(nodeId==='researcher')array(object(payload).questions).forEach((item,index)=>array(object(item).materialRefs).forEach((ref,refIndex)=>refs.push({ref:text(ref),pointer:`/questions/${index}/materialRefs/${refIndex}`})));
  if(nodeId==='author') {
    array(object(object(payload).script).sourcesUsed).forEach((ref,index)=>refs.push({ref:text(ref),pointer:`/script/sourcesUsed/${index}`}));
    array(object(object(payload).decision).beats).forEach((item,index)=>array(object(item).evidence).forEach((ref,refIndex)=>refs.push({ref:text(ref),pointer:`/decision/beats/${index}/evidence/${refIndex}`})));
  }
  return refs;
}

/** Required-by-content reference resolution runs before atomic publication; it never searches mutable assets. */
export function contentCitationDeclarations(nodeId:string,payload:unknown,inputs:Record<string,AssetVersion>):NodeRelationWrite[] {
  const outputSlot=nodeId==='researcher'?'research':'draft',notes=nodeId==='researcher'?object(payload).notes:object(inputs.research?.payload).notes;
  return citationRefs(nodeId,payload).flatMap(({ref,pointer})=>{
    const matches:Array<NodeRelationWrite['to']>=[];
    array(inputs.materials?.payload).forEach((item,index)=>{if(text(object(item).id)===ref)matches.push({inputSlot:'materials',pointer:`/${index}`});});
    array(notes).forEach((item,index)=>{if(text(object(item).id)===ref)matches.push(nodeId==='researcher'?{outputSlot:'research',pointer:`/notes/${index}`}:{inputSlot:'research',pointer:`/notes/${index}`});});
    if(matches.length!==1) {
      throw new Error(`CONTENT citation ${ref} is ${matches.length?'ambiguous':'unresolved'} in its exact frozen parent`);
    }
    return [{typeId:'cites',from:{outputSlot,pointer},to:matches[0]!,evidence:'exact content reference in frozen material or research parent'}];
  });
}

/** Explains current recorded process observations without rebuilding archived contracts. */
export function createContentProcessResolver(service:Pick<WorkflowSpaceService,'runtimeEvidence'>):HistoricalProcessResolver {
  return async input=>{
    const frozen=input.workflow.entrypoints[input.run.entrypoint]?.process;
    if(!frozen||!input.run.process||input.run.process.hash!==frozen.hash||input.run.process.revision!==frozen.revision)
      throw new Error('CONTENT requires its recorded process contract; older runs belong in the archive.');
    const contract:ProcessContractDraft=(({hash:_hash,...draft})=>draft)(frozen);
    const mappings:Array<{stepRunId:string;annotation:NodeOccurrenceAnnotation;evidence:string}>=[];
    for(const step of input.steps) {
      const contexts=input.contexts.filter(context=>context.stepRunId===step.id);
      const ids=[...new Set(contexts.map(context=>context.nodeId))];
      if(ids.length>1)throw new Error('CONTENT historical step has conflicting storage node identities');
      if(ids.length===1&&contract.nodes.some(node=>node.id===ids[0])) {
        const annotation=contentOccurrence(step,ids[0]!);
        if(annotation)mappings.push({stepRunId:step.id,annotation,evidence:`${CONTENT_PROCESS_RESOLVER_REVISION}: exact context node and phasePath ${step.phasePath?.join('/')}`});
        continue;
      }
      const routeMatch=/^content-route-(\d+)$/.exec(step.key);
      if(step.kind==='decision'&&routeMatch) {
        const value=object(step.output);
        if(value.round!==Number(routeMatch[1]))throw new Error('CONTENT decision round disagrees with its exact step key');
        mappings.push({stepRunId:step.id,annotation:{nodeId:'route',round:Number(routeMatch[1])+1,route:text(value.route)},evidence:`${CONTENT_PROCESS_RESOLVER_REVISION}: exact decision step key and output`});
        continue;
      }
      const technical:Record<string,string>={research:'researcher','check-research':'researcher',write:'author',draft:'author','check-draft':'author','cold-read':'coldReader',reader:'coldReader','check-reader':'coldReader','reviewers:reader':'coldReader','fact-check':'factChecker',checker:'factChecker','check-facts':'factChecker','reviewers:checker':'factChecker',edit:'editor',review:'editor','check-editor':'editor'};
      const phase=step.phasePath?.[0],key=phase&&step.key.startsWith(`${phase}:`)?step.key.slice(phase.length+1):undefined;
      const nodeId=key?technical[key]:undefined,annotation=nodeId?contentOccurrence(step,nodeId):undefined;
      if(annotation)mappings.push({stepRunId:step.id,annotation,evidence:`${CONTENT_PROCESS_RESOLVER_REVISION}: exact scoped ${step.kind} key ${step.key}; no context inputs inferred`});
    }
    const ledger=await service.runtimeEvidence(input.run.spaceId),native=await ledger.getRun(input.run.runId);
    if(!native)throw new Error('CONTENT process native run is missing');
    const details=object(object(native.output).details);
    const routes:NonNullable<Awaited<ReturnType<HistoricalProcessResolver>>['routes']>=[];
    for(const step of input.steps.filter(step=>step.kind==='decision')) {
      const match=/^content-route-(\d+)$/.exec(step.key);if(!match)continue;
      const value=object(step.output),round=Number(match[1])+1;
      const event=input.events.find(event=>event.type==='decision.recorded'&&event.stepRunId===step.id);
      if(!event)continue;
      const route=text(value.route),failures=array(value.failures),verdict=text(value.verdict);
      const terminal=Number(details.rounds)===round&&native.state==='needs_review';
      const effective=terminal&&details.reason==='not-converged'?'not-converged':terminal&&details.reason==='blocked'?'blocked':verdict==='pass'&&route==='pass'&&!failures.length?'pass':failures.length&&route==='pass'?'rewrite':route;
      const edge=contract.edges.find(edge=>edge.from==='route'&&edge.route===effective);
      if(edge)routes.push({edgeId:edge.id,eventSeq:event.seq,stepRunId:step.id,round,observation:{route,round:Number(value.round)},reason:terminal?`${text(details.reason)}；原始主编 route=${route}${details.reason==='not-converged'?'，轮次用尽，未继续执行返工':''}`:`主编 route=${route}；程序检查 ${failures.length} 项`});
    }
    return{resolverVersion:CONTENT_PROCESS_RESOLVER_REVISION,contract,mappings,routes};
  };
}
