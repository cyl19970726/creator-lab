import {describe,expect,it,vi} from 'vitest';
import type {AssetVersion,InputManifest} from '@signal-room/workflow-spaces';
import {createContentBusinessCommands,createContentBusinessImportedAssetScope,type ContentBusinessCommandOptions} from '../src/spaces/content-business-commands.js';

const spaceId='test-content',versionId='creation-content-test',principalId='owner';
const values={title:'新业务',objective:'解释一个技术过程',requiredQuestions:['前后发生了什么？'],accountName:'实验室',positioning:'说清技术',currentAudience:'普通读者',form:'短视频',standards:'事实有据',materials:[{id:'source-1',title:'一手笔记',source:'原作者访谈',text:'具体原文'}]};
function fixture(){
  const cases=new Map<string,{id:string;spaceId:string;title:string;objective:string;constraints:string[]}>();
  const assets=new Map<string,AssetVersion>();const commits=new Map<string,{fingerprint:string;asset:AssetVersion}>();let manifest:InputManifest|undefined;
  const refs=[{namespace:'creation/content-business-preparation',revision:'1',hash:'prep-hash',dialect:'https://json-schema.org/draft/2020-12/schema' as const,schema:{}},
    {namespace:'creation/content-handling-note',revision:'1',hash:'note-hash',dialect:'https://json-schema.org/draft/2020-12/schema' as const,schema:{}}];
  const importAsset=vi.fn(async(_space:string,input:{schema:{namespace:string;revision:string;hash:string};payload:unknown;dependencies?:string[];idempotencyKey:string;description:string})=>{
    const fingerprint=JSON.stringify(input),prior=commits.get(input.idempotencyKey);
    if(prior){if(prior.fingerprint!==fingerprint)throw new Error('Idempotency conflict');return prior.asset;}
    const asset={id:`asset-${assets.size+1}`,assetId:`logical-${assets.size+1}`,version:1,spaceId,schema:input.schema,payload:input.payload,payloadHash:'payload-hash',
      source:{kind:'import' as const,actorId:principalId,description:input.description},dependencies:input.dependencies??[],attachments:[],initialState:'imported',createdAt:'2026-10-07T00:00:00.000Z'};
    assets.set(asset.id,asset);commits.set(input.idempotencyKey,{fingerprint,asset});return asset;
  });
  const service={
    readCase:vi.fn(async(_space:string,id:string)=>{const value=cases.get(id);if(!value)throw new Error('Case absent');return value;}),
    readWorkflowVersion:vi.fn(async()=>({spaceId,id:versionId,revision:'content-v2',entrypoints:{content:{workflowId:'creation.content'}}})),
    readManifest:vi.fn(async()=>{if(!manifest)throw new Error('Manifest absent');return manifest;}),
    readAsset:vi.fn(async(_space:string,id:string)=>{const value=assets.get(id);if(!value)throw new Error('Asset absent');return value;}),
    registerSchemas:vi.fn(async()=>refs),importAsset,
    importedAssetsBySchema:vi.fn(async(_space:string,namespace:string,filter:{caseId?:string;runId?:string;subjectAssetId?:string},limit:number)=>
      [...assets.values()].filter(a=>a.schema.namespace===namespace&&a.source.kind==='import'&&Object.entries(filter).every(([k,v])=>v===undefined||(a.payload as Record<string,string>)[k]===v)).slice(0,limit)),
    caseRunsPage:vi.fn(async()=>[]),runAssets:vi.fn(async()=>[]),getExecutionTask:vi.fn(async()=>undefined),executionTasks:vi.fn(async()=>[]),
    process:vi.fn(async()=>({run:{runId:'run-1'},relations:[{typeId:'assesses',from:{assetVersionId:'reader-1'},to:{assetVersionId:'draft-1'},provenance:'recorded'}]})),
  };
  const workbench={
    createCase:vi.fn(async(_space:string,input:{id:string;title:string;objective:string;constraints:string[]})=>{const next={...input,spaceId},prior=cases.get(input.id);if(prior&&JSON.stringify(prior)!==JSON.stringify(next))throw new Error('Case ID conflicts with a different request');cases.set(input.id,next);return next;}),
    freezeInput:vi.fn(async(input:{spaceId:string;caseId:string;input:Record<string,unknown>;idempotencyKey:string})=>{
      const {materials:materialPayload,...opportunityPayload}=input.input;
      const opportunity=await importAsset(spaceId,{schema:{namespace:'creation/content-opportunity',revision:'1',hash:'op-hash'},payload:opportunityPayload,description:'opportunity',idempotencyKey:`${input.idempotencyKey}:op`});
      const materials=await importAsset(spaceId,{schema:{namespace:'creation/content-materials',revision:'1',hash:'mat-hash'},payload:materialPayload,description:'materials',idempotencyKey:`${input.idempotencyKey}:materials`});
      manifest={id:'manifest-1',hash:'manifest-hash',spaceId,caseId:input.caseId,assets:{opportunity:opportunity.id,materials:materials.id}};return manifest;
    }),
    startFromManifest:vi.fn(async()=>({runId:'run-1'})),dispatchRun:vi.fn(async()=>undefined),
    runStatus:vi.fn(async()=>({binding:{runId:'run-1',spaceId,caseId:'case-1',entrypoint:'content',workflowVersionId:versionId,inputManifestId:'manifest-1'},run:{state:'queued',metadata:undefined as {commandKey:string}|undefined},draftVersionId:undefined as string|undefined})),
    methodAvailability:vi.fn(async()=>({available:true,reason:null})),
  };
  const options={spaceId,principalId,models:{worker:{model:'gpt-5.6-luna',reasoningEffort:'high'},judge:{model:'gpt-5.6-luna',reasoningEffort:'high'}},
    loadRelease:vi.fn(async()=>null),verifyExclusive:vi.fn(async()=>true),service,workbench} as unknown as ContentBusinessCommandOptions;
  return {commands:createContentBusinessCommands(options),options,service,workbench,cases,assets,importAsset};
}

describe('ordinary CONTENT commands',()=>{
  it('freezes an explicit request with sources and survives a second host instance',async()=>{
    const f=fixture();const first=await f.commands.prepare({spaceId,key:'request-1',versionId,values});
    expect(first.caseId).toMatch(/^content-business-/);
    expect(first.sections.find(s=>s.title==='准确材料及来源')?.text).toContain('来源：原作者访谈');
    expect(first.conditions).toContain('联网研究：关闭');
    expect(first.inputs).toHaveLength(2);
    expect(f.workbench.freezeInput.mock.calls[0]?.[0].input).toMatchObject({webResearch:false,maxRevisions:2,account:{referencePieces:[]}});
    const second=createContentBusinessCommands(f.options);
    expect((await second.preparation({spaceId,caseId:first.caseId}))?.inputManifestId).toBe(first.inputManifestId);
    await expect(second.prepare({spaceId,key:'request-1',versionId,values:{...values,materials:[{...values.materials[0],text:'different'}]}})).rejects.toMatchObject({status:409,code:'CONFLICT'});
  });

  it('rejects invalid business fields before creating a case or importing assets',async()=>{
    const f=fixture();
    for(const [key,invalid,message] of [
      ['invalid-duration',{...values,maxSeconds:'not-a-number'},/时长上限/],
      ['duplicate-materials',{...values,materials:[values.materials[0],values.materials[0]]},/材料的 ID/],
    ] as const){
      await expect(f.commands.prepare({spaceId,key,versionId,values:invalid})).rejects.toMatchObject({status:400,code:'INVALID_REQUEST',message:expect.stringMatching(message)});
    }
    expect(f.workbench.createCase).not.toHaveBeenCalled();
    expect(f.workbench.freezeInput).not.toHaveBeenCalled();
    expect(f.importAsset).not.toHaveBeenCalled();
  });

  it('does not turn an unrelated storage failure into a conflict',async()=>{
    const f=fixture();f.workbench.createCase.mockRejectedValueOnce(new Error('database connection failed'));
    await expect(f.commands.prepare({spaceId,key:'storage-failure',versionId,values})).rejects.toThrow('database connection failed');
  });

  it('attributes only the uniquely verified frozen preparation asset',async()=>{
    const f=fixture();const prepared=await f.commands.prepare({spaceId,key:'scope-prep',versionId,values});
    const scope=createContentBusinessImportedAssetScope(f.options);
    const saved=[...f.assets.values()].find(a=>a.schema.namespace==='creation/content-business-preparation')!;
    expect(await scope({spaceId,asset:saved})).toEqual({caseId:prepared.caseId,runId:null,versionId});
    expect(await scope({spaceId,asset:{...saved,payload:{...saved.payload as object,caseId:'forged-case'}}})).toBeNull();
    expect(await scope({spaceId,asset:{...saved,schema:{...saved.schema,revision:'2'}}})).toBeNull();
    expect(await scope({spaceId,asset:[...f.assets.values()].find(a=>a.schema.namespace==='creation/content-materials')!})).toBeNull();
    await f.importAsset(spaceId,{schema:saved.schema,payload:{...saved.payload as object},description:'duplicate preparation',idempotencyKey:'duplicate-prep'});
    await expect(scope({spaceId,asset:saved})).rejects.toMatchObject({code:'RELATION_MISMATCH'});
  });

  it('cannot enqueue or dispatch without a matching release',async()=>{
    const f=fixture();const prepared=await f.commands.prepare({spaceId,key:'request-2',versionId,values});
    expect(prepared.actions.start).toBe(false);
    await expect(f.commands.start({spaceId,caseId:prepared.caseId,versionId,inputManifestId:prepared.inputManifestId,key:'start-1'})).rejects.toMatchObject({code:'EXECUTION_DISABLED'});
    expect(f.workbench.startFromManifest).not.toHaveBeenCalled();
  });

  it('keeps the exact queued receipt when target dispatch fails',async()=>{
    const f=fixture();const prepared=await f.commands.prepare({spaceId,key:'request-queue',versionId,values});
    (f.options.loadRelease as ReturnType<typeof vi.fn>).mockResolvedValue({revision:1,spaceId,principalId,caseId:prepared.caseId,versionId,
      inputManifestId:prepared.inputManifestId,inputManifestHash:prepared.inputManifestHash,models:f.options.models,
      expiresAt:new Date(Date.now()+60_000).toISOString(),exclusive:{confirmedAt:new Date().toISOString(),disabledPorts:[]},maxRevisions:2,webResearch:false});
    f.workbench.runStatus.mockResolvedValue({binding:{runId:'run-1',spaceId,caseId:prepared.caseId,entrypoint:'content',workflowVersionId:versionId,inputManifestId:prepared.inputManifestId},run:{state:'queued',metadata:{commandKey:`content:${prepared.caseId}:start-1`}},draftVersionId:undefined});
    (f.service.getExecutionTask as ReturnType<typeof vi.fn>).mockResolvedValue({spaceId,runId:'run-1',caseId:prepared.caseId,workflowVersionId:versionId,inputManifestId:prepared.inputManifestId,entrypoint:'content',executorKey:JSON.stringify([versionId,'content']),status:'queued'});
    f.workbench.dispatchRun.mockRejectedValue(new Error('Host unavailable'));
    const result=await f.commands.start({spaceId,caseId:prepared.caseId,versionId,inputManifestId:prepared.inputManifestId,key:'start-1'});
    expect(result.runId).toBe('run-1');expect(result.dispatched).toBe(false);expect(result.status).toBe('queued');expect(result.dispatchError).toContain('原排队回执');
    expect(f.workbench.startFromManifest).toHaveBeenCalledWith(expect.objectContaining({dispatch:false,inputManifestId:prepared.inputManifestId}));
    (f.service.caseRunsPage as ReturnType<typeof vi.fn>).mockResolvedValue([{runId:'run-1',spaceId,caseId:prepared.caseId,workflowVersionId:versionId,inputManifestId:prepared.inputManifestId,entrypoint:'content'}]);
    (f.options.loadRelease as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const recovered=await createContentBusinessCommands(f.options).start({spaceId,caseId:prepared.caseId,versionId,inputManifestId:prepared.inputManifestId,key:'start-1'});
    expect(recovered.runId).toBe(result.runId);expect(recovered.status).toBe('queued');expect(recovered.dispatched).toBe(false);
    expect(f.workbench.startFromManifest).toHaveBeenCalledTimes(1);expect(f.workbench.dispatchRun).toHaveBeenCalledTimes(1);
    await expect(f.commands.start({spaceId,caseId:prepared.caseId,versionId,inputManifestId:prepared.inputManifestId,key:'another-key'})).rejects.toMatchObject({code:'CONFLICT'});
  });

  it('rejects mismatched, expired, and model-changed releases before enqueue',async()=>{
    const f=fixture();const prepared=await f.commands.prepare({spaceId,key:'release-check',versionId,values});
    const release={revision:1,spaceId,principalId,caseId:prepared.caseId,versionId,inputManifestId:prepared.inputManifestId,
      inputManifestHash:prepared.inputManifestHash,models:f.options.models,expiresAt:new Date(Date.now()+60_000).toISOString(),
      exclusive:{confirmedAt:new Date().toISOString(),disabledPorts:[]},maxRevisions:2,webResearch:false};
    const request={spaceId,caseId:prepared.caseId,versionId,inputManifestId:prepared.inputManifestId,key:'attempt'};
    for(const wrong of [{...release,inputManifestId:'other-manifest'},
      {...release,expiresAt:'2000-01-01T00:00:00.000Z'},
      {...release,models:{worker:{model:'other',reasoningEffort:'high'},judge:release.models.judge}}]){
      (f.options.loadRelease as ReturnType<typeof vi.fn>).mockResolvedValue(wrong);
      await expect(f.commands.start(request)).rejects.toMatchObject({code:'EXECUTION_DISABLED'});
    }
    expect(f.workbench.startFromManifest).not.toHaveBeenCalled();
  });

  it('rejects opinion IDs that do not assess the exact draft',async()=>{
    const f=fixture();const prepared=await f.commands.prepare({spaceId,key:'request-3',versionId,values});
    f.workbench.runStatus.mockResolvedValue({binding:{runId:'run-1',spaceId,caseId:prepared.caseId,entrypoint:'content',workflowVersionId:versionId,inputManifestId:prepared.inputManifestId},run:{state:'needs_review',metadata:undefined},draftVersionId:'draft-1'});
    f.assets.set('draft-1',{id:'draft-1',assetId:'draft-logical',version:1,spaceId,schema:{namespace:'creation/content-draft',revision:'1',hash:'draft-hash'},payload:{},payloadHash:'draft-payload',source:{kind:'node',runId:'run-1',stepRunId:'step',attemptId:'attempt',nodeId:'author',producer:'agent',sessionId:'session',contextId:'context'},dependencies:[],attachments:[],initialState:'candidate',createdAt:'2026-10-07T00:00:00.000Z'});
    f.assets.set('reader-1',{...f.assets.get('draft-1')!,id:'reader-1',schema:{namespace:'creation/content-reader',revision:'1',hash:'reader-hash'}});
    f.assets.set('reader-other',{...f.assets.get('reader-1')!,id:'reader-other'});
    const request={key:'note-1',author:{kind:'external-agent' as const,name:'认知 Agent',threadId:'thread-1'},answers:{good:'清楚',bad:'不足',improvement:'需改',unresolved:'待核'},recommendation:'needs_revision' as const,nextStep:'补充证据',referencedAssetIds:['reader-other']};
    await expect(f.commands.addHandlingNote({spaceId,caseId:prepared.caseId,runId:'run-1',assetId:'draft-1',input:request,importedBy:principalId})).rejects.toMatchObject({code:'RELATION_MISMATCH'});
    await expect(f.commands.addHandlingNote({spaceId,caseId:prepared.caseId,runId:'run-1',assetId:'draft-1',input:{...request,referencedAssetIds:['reader-1']},importedBy:'browser-claimed-user'})).rejects.toMatchObject({code:'FORBIDDEN'});
    expect(f.importAsset.mock.calls.filter(call=>call[1].schema.namespace==='creation/content-handling-note')).toHaveLength(0);
  });

  it('hides GET handling notes for research and earlier drafts but rejects a forged case',async()=>{
    const f=fixture();const prepared=await f.commands.prepare({spaceId,key:'note-visibility',versionId,values});
    f.workbench.runStatus.mockResolvedValue({binding:{runId:'run-1',spaceId,caseId:prepared.caseId,entrypoint:'content',workflowVersionId:versionId,inputManifestId:prepared.inputManifestId},run:{state:'needs_review',metadata:undefined},draftVersionId:'draft-final'});
    const node={kind:'node' as const,runId:'run-1',stepRunId:'step',attemptId:'attempt',nodeId:'author',producer:'agent' as const,sessionId:'session',contextId:'context'};
    const asset={id:'research-1',assetId:'research-logical',version:1,spaceId,schema:{namespace:'creation/content-research',revision:'1',hash:'research-hash'},payload:{},payloadHash:'research-payload',source:node,dependencies:[],attachments:[],initialState:'candidate' as const,createdAt:'2026-10-07T00:00:00.000Z'};
    f.assets.set(asset.id,asset);f.assets.set('draft-old',{...asset,id:'draft-old',schema:{namespace:'creation/content-draft',revision:'1',hash:'draft-hash'}});
    for(const assetId of ['research-1','draft-old']){
      await expect(f.commands.handlingNotes({spaceId,caseId:prepared.caseId,runId:'run-1',assetId,limit:101})).rejects.toMatchObject({status:404,code:'NOT_FOUND'});
      await expect(f.commands.addHandlingNote({spaceId,caseId:prepared.caseId,runId:'run-1',assetId,input:{key:'bad',author:{kind:'external-agent',name:'外部',threadId:'thread'},answers:{good:'',bad:'',improvement:'',unresolved:''},recommendation:'defer',nextStep:'待定',referencedAssetIds:[]},importedBy:principalId})).rejects.toMatchObject({status:409,code:'RELATION_MISMATCH'});
    }
    await expect(f.commands.handlingNotes({spaceId,caseId:'forged-case',runId:'run-1',assetId:'research-1',limit:101})).rejects.toMatchObject({status:409,code:'RELATION_MISMATCH'});
    expect(f.service.importedAssetsBySchema).not.toHaveBeenCalledWith(spaceId,'creation/content-handling-note',expect.anything(),101);
  });

  it('keeps failed-run notes on the latest bound author draft with same-round assessments',async()=>{
    const f=fixture();const prepared=await f.commands.prepare({spaceId,key:'failed-process-note',versionId,values});
    const runId='run-1',older='draft-round-1',latest='draft-round-2',reader='reader-round-2',factCheck='facts-round-2',wrongRound='reader-round-1';
    const binding={runId,spaceId,caseId:prepared.caseId,entrypoint:'content',workflowVersionId:versionId,inputManifestId:prepared.inputManifestId};
    f.workbench.runStatus.mockResolvedValue({binding,run:{state:'failed',metadata:undefined},draftVersionId:undefined});
    const asset=(id:string,namespace:string,nodeId:string,contextId:string,stepRunId:string,generatedByContextId?:string):AssetVersion=>({id,assetId:`logical-${id}`,version:1,spaceId,
      schema:{namespace,revision:'1',hash:`hash-${namespace}`},payload:{},payloadHash:`payload-${id}`,
      source:{kind:'node',runId,stepRunId,attemptId:`attempt-${id}`,nodeId,producer:generatedByContextId?'program':'agent',sessionId:`session-${id}`,contextId,...(generatedByContextId?{generatedByContextId}:{})},
      dependencies:[],attachments:[],initialState:'candidate',createdAt:'2026-10-07T00:00:00.000Z'});
    for(const value of [asset(older,'creation/content-draft','author','author-context-1','author-step-1'),
      asset(latest,'creation/content-draft','author','author-context-2','author-step-2'),
      asset(reader,'creation/content-reader','coldReader','reader-publish-2','reader-publish-step-2','reader-agent-2'),
      asset(factCheck,'creation/content-fact-check','factChecker','facts-publish-2','facts-publish-step-2','facts-agent-2'),
      asset(wrongRound,'creation/content-reader','coldReader','reader-publish-1','reader-publish-step-1','reader-agent-1')])f.assets.set(value.id,value);
    const occurrence=(nodeId:string,round:number,contextId:string,stepRunId:string,slot:string,outputId:string,inputId?:string)=>({
      id:stepRunId,nodeId,round,provenance:'observed',state:'succeeded',contextIds:[contextId],stepRunIds:[stepRunId],
      outputBindings:[{contextId,slot,assetVersionId:outputId}],inputBindings:inputId?[{contextId,slot:'manuscript',assetVersionId:inputId}]:[],
    });
    const reviewOccurrence=(nodeId:'coldReader'|'factChecker',prefix:'reader'|'facts',branch:'reader'|'checker',round:number,outputId:string,inputId:string)=>({id:`${prefix}-agent-step-${round}`,nodeId,branch,round,provenance:'derived',state:'succeeded',
      contextIds:[`${prefix}-agent-${round}`,`${prefix}-publish-${round}`],stepRunIds:[`${prefix}-agent-step-${round}`,`${prefix}-publish-step-${round}`],
      outputBindings:[{contextId:`${prefix}-publish-${round}`,slot:prefix==='reader'?'reader':'factCheck',assetVersionId:outputId}],
      inputBindings:[{contextId:`${prefix}-agent-${round}`,slot:prefix==='reader'?'manuscript':'draft',assetVersionId:inputId},{contextId:`${prefix}-publish-${round}`,slot:prefix==='reader'?'manuscript':'draft',assetVersionId:inputId}],
    });
    const process={run:binding,contract:{nodes:[{id:'author',storageNodeId:'author',outputs:{draft:{slot:'draft'}}}]},
      occurrences:[occurrence('author',1,'author-context-1','author-step-1','draft',older),
        occurrence('author',2,'author-context-2','author-step-2','draft',latest),
        reviewOccurrence('coldReader','reader','reader',1,wrongRound,older),
        reviewOccurrence('coldReader','reader','reader',2,reader,latest),
        reviewOccurrence('factChecker','facts','checker',2,factCheck,latest)],
      relations:[reader,factCheck,wrongRound].map(id=>({typeId:'assesses',from:{assetVersionId:id},to:{assetVersionId:latest},provenance:'recorded'}))};
    (f.service.process as ReturnType<typeof vi.fn>).mockResolvedValue(process);
    const request={spaceId,caseId:prepared.caseId,runId,assetId:latest,importedBy:principalId,
      input:{key:'failed-note',author:{kind:'external-agent' as const,name:'认知 Agent',threadId:'external-thread'},answers:{good:'可读',bad:'主编失败',improvement:'人工补改',unresolved:'待核'},recommendation:'needs_revision' as const,nextStep:'修复编辑输入',referencedAssetIds:[reader,factCheck]}};
    expect(await f.commands.handlingNotes({spaceId,caseId:prepared.caseId,runId,assetId:latest,limit:101})).toEqual([]);
    const saved=await f.commands.addHandlingNote(request);
    expect(saved.subjectAssetId).toBe(latest);expect(saved.verification).toBe('declared-external');
    expect((await f.commands.readHandlingNote({...request,noteId:saved.id}))?.id).toBe(saved.id);
    expect((await f.commands.handlingNotes({spaceId,caseId:prepared.caseId,runId,assetId:latest,limit:101})).map(item=>item.id)).toEqual([saved.id]);
    expect(await createContentBusinessImportedAssetScope(f.options)({spaceId,asset:f.assets.get(saved.id)!})).toEqual({caseId:prepared.caseId,runId,versionId});
    for(const assetId of [older,reader])await expect(f.commands.handlingNotes({spaceId,caseId:prepared.caseId,runId,assetId,limit:101})).rejects.toMatchObject({status:404,code:'NOT_FOUND'});
    await expect(f.commands.addHandlingNote({...request,assetId:older,input:{...request.input,key:'older'}})).rejects.toMatchObject({status:409,code:'RELATION_MISMATCH'});
    await expect(f.commands.addHandlingNote({...request,input:{...request.input,key:'wrong-round',referencedAssetIds:[wrongRound]}})).rejects.toMatchObject({status:409,code:'RELATION_MISMATCH'});
    const cross=f.assets.get(reader)!;
    for(const [key,source] of [['wrong-node',{...cross.source,nodeId:'factChecker'}],['wrong-step',{...cross.source,stepRunId:'unbound-step'}]] as const){
      f.assets.set(reader,{...cross,source} as AssetVersion);
      await expect(f.commands.addHandlingNote({...request,input:{...request.input,key}})).rejects.toMatchObject({status:409,code:'RELATION_MISMATCH'});
    }
    f.assets.set(reader,{...cross,source:{...cross.source,generatedByContextId:'other-origin'}} as AssetVersion);
    await expect(f.commands.addHandlingNote({...request,input:{...request.input,key:'wrong-origin'}})).rejects.toMatchObject({status:409,code:'RELATION_MISMATCH'});
    f.assets.set(reader,cross);
    f.workbench.runStatus.mockResolvedValue({binding,run:{state:'running',metadata:undefined},draftVersionId:undefined});
    await expect(f.commands.handlingNotes({spaceId,caseId:prepared.caseId,runId,assetId:latest,limit:101})).rejects.toMatchObject({status:404,code:'NOT_FOUND'});
    f.workbench.runStatus.mockResolvedValue({binding,run:{state:'failed',metadata:undefined},draftVersionId:undefined});
    (f.service.process as ReturnType<typeof vi.fn>).mockResolvedValue({...process,run:{...binding,workflowVersionId:'other-version'}});
    await expect(f.commands.handlingNotes({spaceId,caseId:prepared.caseId,runId,assetId:latest,limit:101})).rejects.toMatchObject({status:409,code:'RELATION_MISMATCH'});
    (f.service.process as ReturnType<typeof vi.fn>).mockResolvedValue(process);
    f.assets.set(reader,{...cross,source:{...cross.source,runId:'other-run'}} as AssetVersion);
    await expect(f.commands.addHandlingNote({...request,input:{...request.input,key:'cross-run'}})).rejects.toMatchObject({status:409,code:'RELATION_MISMATCH'});
    expect((await f.workbench.runStatus()).draftVersionId).toBeUndefined();
  });

  it('persists an external note with declared author and authenticated importer',async()=>{
    const f=fixture();const prepared=await f.commands.prepare({spaceId,key:'request-note',versionId,values});
    f.workbench.runStatus.mockResolvedValue({binding:{runId:'run-1',spaceId,caseId:prepared.caseId,entrypoint:'content',workflowVersionId:versionId,inputManifestId:prepared.inputManifestId},run:{state:'needs_review',metadata:undefined},draftVersionId:'draft-1'});
    const node={kind:'node' as const,runId:'run-1',stepRunId:'step',attemptId:'attempt',nodeId:'author',producer:'agent' as const,sessionId:'session',contextId:'context'};
    f.assets.set('draft-1',{id:'draft-1',assetId:'draft-logical',version:1,spaceId,schema:{namespace:'creation/content-draft',revision:'1',hash:'draft-hash'},payload:{},payloadHash:'draft-payload',source:node,dependencies:[],attachments:[],initialState:'candidate',createdAt:'2026-10-07T00:00:00.000Z'});
    f.assets.set('reader-1',{...f.assets.get('draft-1')!,id:'reader-1',schema:{namespace:'creation/content-reader',revision:'1',hash:'reader-hash'}});
    const input={key:'note-1',author:{kind:'external-agent' as const,name:'认知 Agent',threadId:'external-thread'},answers:{good:'清楚',bad:'不足',improvement:'需改',unresolved:'待核'},recommendation:'needs_revision' as const,nextStep:'补充证据',referencedAssetIds:['reader-1']};
    const saved=await f.commands.addHandlingNote({spaceId,caseId:prepared.caseId,runId:'run-1',assetId:'draft-1',input,importedBy:principalId});
    expect(saved.importedBy).toBe(principalId);expect(saved.verification).toBe('declared-external');expect(saved.author.threadId).toBe('external-thread');
    expect((await createContentBusinessCommands(f.options).handlingNotes({spaceId,caseId:prepared.caseId,runId:'run-1',assetId:'draft-1',limit:101})).map(x=>x.id)).toEqual([saved.id]);
    expect((await f.commands.readHandlingNote({spaceId,caseId:prepared.caseId,runId:'run-1',assetId:'draft-1',noteId:saved.id}))?.id).toBe(saved.id);
    expect(await f.commands.readHandlingNote({spaceId,caseId:prepared.caseId,runId:'run-1',assetId:'draft-1',noteId:'reader-1'})).toBeNull();
    await expect(f.commands.addHandlingNote({spaceId,caseId:prepared.caseId,runId:'run-1',assetId:'draft-1',input:{...input,nextStep:'另一个动作'},importedBy:principalId})).rejects.toThrow('Idempotency conflict');
    const scope=createContentBusinessImportedAssetScope(f.options);
    const noteAsset=f.assets.get(saved.id)!;
    expect(await scope({spaceId,asset:noteAsset})).toEqual({caseId:prepared.caseId,runId:'run-1',versionId});
    expect(await scope({spaceId,asset:{...noteAsset,payload:{...noteAsset.payload as object,subjectAssetId:'another-draft'}}})).toBeNull();
    f.workbench.runStatus.mockResolvedValue({...await f.workbench.runStatus(),draftVersionId:'another-draft'});
    await expect(scope({spaceId,asset:noteAsset})).rejects.toMatchObject({code:'RELATION_MISMATCH'});
  });
});
