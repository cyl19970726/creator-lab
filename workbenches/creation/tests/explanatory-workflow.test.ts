import {describe,expect,it} from 'vitest';
import {MemoryRunStore,runWorkflow,type AgentRunRequest,type AgentRunResult,type AgentRunner} from '@signal-room/workflow';
import {CONTENT_ROLES,createContentWorkflow,textOnlyColdReaderView,type ContentDraft,type ContentFactCheck,
  type ContentInput,type ContentReview} from '../src/stages/content.js';

const models={worker:{model:'fallback-worker',reasoningEffort:'low' as const},judge:{model:'fallback-judge',reasoningEffort:'high' as const}};
const names=['researcher','author','reader','checker','editor'] as const;
const input:ContentInput={topicId:'topic',opportunity:'Explain a process',readerGoal:'Understand its cost',requiredQuestions:['What changes?'],
  account:{name:'Account',positioning:'Explainer',currentAudience:'New viewer',referencePieces:[]},form:'Video',
  materials:[{id:'m1',title:'Source',text:'Primary source'}],standards:'C1–C8',webResearch:false,maxRevisions:1};
const draft:ContentDraft={decision:{workingTitle:'Title',coreQuestion:'What changes?',oneLineAnswer:'The model changes',audience:'New viewer',
  audienceChange:'Understands cost',hook:'Why?',beats:[{beat:'Process',says:'Explain',evidence:['m1'],visualIdea:'Private visual intent'}],
  accountAngle:'Process',form:'Video',notSaying:[],biggestRisk:'Confusion',openQuestions:[],alternativesConsidered:[],changesFromPrevious:''},
  script:{title:'Title',coverText:'Cover',estimatedSeconds:30,segments:[{time:'00:00',voiceover:'Cost rises as trials repeat.',onScreenText:'Trials → cost',visual:'Private visual direction'}],
    sourcesUsed:['m1'],changesFromPrevious:''}};
const review=(route:ContentReview['route']):ContentReview=>({verdict:route==='pass'?'pass':route==='blocked'?'blocked':'revise',route,
  criteria:Array.from({length:8},(_,i)=>({id:`C${i+1}`,result:'ok' as const,reason:'Checked'})),
  questionCoverage:[{question:'What changes?',answerInDraft:'The model changes',missing:'',result:'ok'}],mustChange:route==='pass'?[]:['Explain more'],summary:'Reviewed'});

function runner(routes:ContentReview[],notes:unknown[]=[],issues:ContentFactCheck['issues']=[]){
  const calls:Array<{id:string;input:unknown;definition:AgentRunRequest<unknown>['definition']}>=[];
  let edits=0;
  const agentRunner:AgentRunner={async run<I,O>(request:AgentRunRequest<I>):Promise<AgentRunResult<O>>{
    calls.push({id:request.definition.id,input:request.input,definition:request.definition});
    const output:unknown=request.definition.id===CONTENT_ROLES.researcher.id
      ? {questions:[{question:'What changes?',answer:'The model changes',materialRefs:['m1'],gap:''}],notes,remainingGaps:[]}
      : request.definition.id===CONTENT_ROLES.author.id ? draft
      : request.definition.id===CONTENT_ROLES.reader.id ? {retell:'Trials cost money',oneLineAnswerAsUnderstood:'The model changes',unansweredQuestions:[],lostAt:[],boredAt:[],
        keepWatchingAt3s:{yes:true,why:'Clear'},keepWatchingAt30s:{yes:true,why:'Clear'},mostMemorable:'Cost'}
      : request.definition.id===CONTENT_ROLES.checker.id ? {issues,summary:'Checked'}
      : routes[edits++];
    return {output:output as O};
  }};
  return {agentRunner,calls};
}

describe('explanatory content workflow options',()=>{
  it('uses exact five role models and prompts, keeps reader text only, and stops after two business rounds',async()=>{
    const roleModels=Object.fromEntries(names.map((name,index)=>[name,{model:`exact-${name}`,reasoningEffort:index%2?'medium':'low'}])) as
      NonNullable<Parameters<typeof createContentWorkflow>[2]>['roleModels'];
    const {agentRunner,calls}=runner([review('rewrite'),review('rewrite')]);
    const store=new MemoryRunStore();
    const {run}=await runWorkflow({workflow:createContentWorkflow(models,CONTENT_ROLES,{roleModels,includePreamble:false,textOnlyColdReader:true,
      preserveResearchOutput:true,strictReviewRouting:true,workflowId:'creation.explanatory'}),input,store,agentRunner});
    expect(run.output).toMatchObject({details:{reason:'not-converged',rounds:2}});
    expect(calls.filter(call=>call.id===CONTENT_ROLES.editor.id)).toHaveLength(2);
    for(const name of names){
      const call=calls.find(c=>c.id===CONTENT_ROLES[name].id)!;
      expect(call.definition.model).toBe(`exact-${name}`);
      expect(call.definition.config?.prompt).toBe(CONTENT_ROLES[name].prompt);
    }
    const cold=calls.find(call=>call.id===CONTENT_ROLES.reader.id)!.input;
    expect(cold).toEqual({audienceProfile:'New viewer',title:'Title',coverText:'Cover',
      segments:[{number:1,voiceover:'Cost rises as trials repeat.',onScreenText:'Trials → cost'}]});
    expect(JSON.stringify(cold)).not.toMatch(/visual|decision|research|requiredQuestions|Private/);
    expect(textOnlyColdReaderView(draft,'Viewer')).toMatchObject({audienceProfile:'Viewer'});
    expect(store.artifacts.filter(a=>a.type==='content-research')).toHaveLength(1);
  });

  it('stops inconsistent editor semantics before review publication',async()=>{
    const inconsistent={...review('rewrite'),route:'pass' as const};
    const {agentRunner}=runner([inconsistent]);const store=new MemoryRunStore();
    const {run}=await runWorkflow({workflow:createContentWorkflow(models,CONTENT_ROLES,{strictReviewRouting:true}),input,store,agentRunner});
    expect(run.output).toMatchObject({details:{reason:'invalid-editor-routing',details:['review.route: verdict revise requires rewrite, research, or reframe']}});
    expect(store.artifacts.filter(a=>a.type==='content-review')).toHaveLength(0);
  });

  it('retains guard findings without turning an invalid pass into another rewrite',async()=>{
    const bad={...review('pass'),questionCoverage:[{question:'What changes?',answerInDraft:'',missing:'Missing explanation',result:'fail' as const}]};
    const {agentRunner,calls}=runner([bad]);const store=new MemoryRunStore();
    const {run}=await runWorkflow({workflow:createContentWorkflow(models,CONTENT_ROLES,{strictReviewRouting:true}),input,store,agentRunner});
    expect(run.output).toMatchObject({details:{reason:'not-converged',rounds:1,
      guardFailures:['required question not answered: What changes?']}});
    expect(calls.filter(c=>c.id===CONTENT_ROLES.author.id)).toHaveLength(1);
    expect(store.artifacts.find(a=>a.type==='content-review')?.payload).toMatchObject({guardFailures:['required question not answered: What changes?']});
  });

  it('blocks a pass with unresolved fact issues and retains evidence for each issue',async()=>{
    const issues:ContentFactCheck['issues']=[
      {segment:'00:00',claim:'Trials cost nothing',problem:'wrong',
        evidence:'m1: source states repeated trials incur compute cost',fix:'Explain the incurred compute cost'},
      {segment:'00:10',claim:'Every trial improves the model',problem:'unsupported',
        evidence:'m1: source reports aggregate improvement but no per-trial guarantee',fix:'Remove the universal claim'},
    ];
    const {agentRunner,calls}=runner([review('pass')],[],issues);
    const store=new MemoryRunStore();
    const {run}=await runWorkflow({workflow:createContentWorkflow(models,CONTENT_ROLES,
      {strictReviewRouting:true}),
      input,store,agentRunner});
    expect(run.output).toMatchObject({details:{reason:'not-converged',rounds:1,
      guardFailures:['fact-check issues remain']}});
    expect(calls.filter(call=>call.id===CONTENT_ROLES.author.id)).toHaveLength(1);
    const fact=store.artifacts.find(artifact=>artifact.type==='content-fact-check');
    expect(fact?.payload).toMatchObject({issues});
    expect((fact?.payload as ContentFactCheck).issues.map(issue=>issue.evidence)).toEqual(issues.map(issue=>issue.evidence));
    expect(store.artifacts.find(artifact=>artifact.type==='content-review')?.payload)
      .toMatchObject({guardFailures:['fact-check issues remain']});
  });

  it('rejects offline research that claims new notes before publication',async()=>{
    const {agentRunner}=runner([review('pass')],[{id:'new',title:'New',url:'https://example.com',publisher:'Publisher',date:'2026-10-11',
      keyPoints:['Point'],fillsGap:'Gap',sourceKind:'primary'}]);const store=new MemoryRunStore();
    const {run}=await runWorkflow({workflow:createContentWorkflow(models,CONTENT_ROLES,{preserveResearchOutput:true}),input,store,agentRunner});
    expect(run.output).toMatchObject({details:{reason:'research-output-not-offline',details:['research.notes: offline research must return an empty array']}});
    expect(store.artifacts.filter(a=>a.type==='content-research')).toHaveLength(0);
  });
});
