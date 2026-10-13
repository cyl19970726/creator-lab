import {createHash,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {Pool} from 'pg';
import {PostgresBlobStore,WorkflowSpaceService,migrateWorkflowSpaces,
  createBusinessUnderstandingStore,createMethodCapabilityStore,createMethodDesignStore,createExecutionBudgetStore,
  type SpacePrincipal} from '@signal-room/workflow-spaces';
import {CONTENT_ROLES,type ContentInput} from '../src/stages/content.js';
import {explanatoryMethodAssetReaders,explanatoryMethodPresentationOptions} from '../src/spaces/explanatory-method-readers.js';
import {createExplanatoryMethodDesignHost} from '../src/spaces/explanatory-method-design-host.js';
import {createExplanatoryMethodExecutionHost} from '../src/spaces/explanatory-method-execution-host.js';

const databaseUrl=process.env.WORKFLOW_TEST_DATABASE_URL;
const integration=databaseUrl?it:it.skip;
const schema=`explanatory_host_${randomUUID().replaceAll('-','')}`;
const sha=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
const bytes=(content:string)=>({content,sha256:sha(content)});
const scope={workflowId:'content.explanatory-method',entrypoint:'content'};
const ownerPrincipal:SpacePrincipal={id:'synthetic-test-owner',kind:'human'};
const agentPrincipal:SpacePrincipal={id:'external-agent:synthetic-pg-design',kind:'service',
  externalAgent:{id:'synthetic-pg-design',sessionId:'synthetic-pg-session',role:'design'}};
const lock=async<T>(_caseId:string,work:()=>Promise<T>)=>work();
const publicationLock=async<T>(work:()=>Promise<T>)=>work();
const command=(operation:'case-create'|'inputs-freeze'|'release'|'start'|'dispatch',input:Record<string,unknown>)=>({operation,input});
let admin:Pool,db:Pool,owner:WorkflowSpaceService,designer:WorkflowSpaceService,spaceId:string;

beforeAll(async()=>{
  if(!databaseUrl)return;
  admin=new Pool({connectionString:databaseUrl});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const isolated=new URL(databaseUrl);
  isolated.searchParams.set('options',`-csearch_path=${schema}`);
  db=new Pool({connectionString:isolated.toString(),max:8});
  await migrateWorkflowSpaces(db);
  await new PostgresBlobStore(db).migrate();
  owner=new WorkflowSpaceService(db,new PostgresBlobStore(db),ownerPrincipal,explanatoryMethodPresentationOptions);
  designer=new WorkflowSpaceService(db,new PostgresBlobStore(db),agentPrincipal,explanatoryMethodPresentationOptions);
  spaceId=`synthetic-explanatory-${randomUUID()}`;
  await owner.provisionDesignSpace({id:spaceId,purpose:'Synthetic isolated integration test',scope,
    idempotencyKey:'provision'},agentPrincipal);
},120_000);

afterAll(async()=>{
  if(db)await db.end();
  if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});

integration('publishes and executes one durable offline research trial from an exact professional package',async()=>{
  const understanding=await createBusinessUnderstandingStore(designer).save(spaceId,{
    expectedRevisionId:null,idempotencyKey:'understanding',title:'Synthetic business basis',
    content:'# Synthetic business basis\nA bounded offline explanatory test.',
    sources:[{kind:'document',ref:'synthetic:fixture',title:'Synthetic fixture'}],
    authorship:{kind:'agent',name:'synthetic-pg-design',sessionId:'synthetic-pg-session'},changeReason:'Fixture'});
  const understandingRef={revisionId:understanding.id,payloadHash:understanding.payloadHash};
  const stages={researcher:CONTENT_ROLES.researcher,author:CONTENT_ROLES.author,
    coldReader:CONTENT_ROLES.reader,factChecker:CONTENT_ROLES.checker,editor:CONTENT_ROLES.editor};
  await createMethodCapabilityStore(owner).ensure(spaceId);
  const capability=await createMethodCapabilityStore(designer).save(spaceId,{
    ...scope,understanding:understandingRef,provider:{id:'creation.explanatory-method',contractRevision:'1'},
    nodes:Object.fromEntries(Object.entries(stages).map(([key,stage])=>[key,{
      instructions:bytes(`Synthetic professional ${key} instructions. Use only frozen materials and return the declared JSON.`),
      outputSchema:bytes(JSON.stringify(stage.outputSchema)),model:'synthetic-offline-model',reasoningEffort:'low'}])),
    validation:bytes(JSON.stringify({revision:3,budget:{maxNodeCalls:15,maxProviderRequests:15,
      clockStartsAt:'first provider request reservation; 60-minute wall budget continues during diagnosis and waiting',
      maxCaseBusinessRounds:2,maxTechnicalRepairsPerNode:1,maxWallMinutes:60,maxNodeMinutes:15,webResearch:false},
      trial:{node:'researcher',maxModelCalls:2,
        secondCallOnly:'one tool continuation OR one technical repair within the same 2-request hard cap; at most one technical repair; no request added when the cap is consumed',
        parity:'Use the same frozen researcher instructions, output schema, first-round context projection, and read_bound_asset tool contract as a full Case; no special no-tool shortcut.'}})),
    predecessorVersionId:null,changeReason:'Synthetic integration fixture',
    authorship:{kind:'agent',name:'synthetic-pg-design',sessionId:'synthetic-pg-session'},
    expectedRevisionId:null,idempotencyKey:'capability'});
  const capabilityReading=explanatoryMethodAssetReaders['workflow/method-capability@1']!(await owner.readAsset(spaceId,capability.id));
  expect(capabilityReading.sections.some(section=>section.text.includes('Synthetic professional researcher instructions.'))).toBe(true);
  const designHost=createExplanatoryMethodDesignHost({service:designer,ownerService:owner,principal:agentPrincipal,
    spaceId,scope,canWrite:true,withPublicationLock:publicationLock}).methodDesign!;
  const design=await designHost.save!(spaceId,{...scope,understanding:understandingRef,
    capability:{revisionId:capability.id,payloadHash:capability.payloadHash},
    title:'Synthetic explanatory method',content:'# Synthetic explanatory method\nUse the five captured roles.',
    sources:[{kind:'document',ref:'synthetic:fixture',title:'Synthetic fixture'}],
    authorship:{kind:'agent',name:'synthetic-pg-design',sessionId:'synthetic-pg-session'},
    changeReason:'Synthetic integration fixture',expectedRevisionId:null,idempotencyKey:'design'});
  const preview=await designHost.preview!(spaceId,design.id);
  const published=await designHost.publish!(spaceId,{designRevisionId:design.id,expectedCandidateId:preview.versionId});
  expect(published.versionId).toBe(preview.versionId);
  const bodies:Record<string,unknown>[]=[];
  const research={questions:[{question:'What happened?',answer:'The synthetic source says a cup warmed.',materialRefs:['S1'],gap:''}],
    notes:[],remainingGaps:[]};
  const fakeFetch=(async(_url:unknown,init?:RequestInit)=>{
    bodies.push(JSON.parse(String(init?.body)) as Record<string,unknown>);
    return new Response(`data: ${JSON.stringify({type:'response.completed',response:{id:`synthetic-response-${bodies.length}`,
      output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(research)}]}]}})}\n\n`,
      {status:200,headers:{'content-type':'text/event-stream'}});
  }) as typeof fetch;
  const auth={status:async()=>({connected:true,sharing:true}),accessToken:async()=> 'synthetic-test-token'};
  const createHost=()=>createExplanatoryMethodExecutionHost({service:designer,ownerService:owner,principal:agentPrincipal,
    spaceId,canWrite:true,withCaseLock:lock,withPublicationLock:publicationLock,auth,fetch:fakeFetch,
    executorCache:new Map()});
  let host=createHost();
  const method=host.methodExecution!;
  let versionId=published.versionId;const caseId=`synthetic-case-${randomUUID()}`;
  const input:ContentInput={topicId:'synthetic-original-topic',opportunity:'Why did the synthetic cup warm?',
    account:{name:'Synthetic account',positioning:'Clear explanations',currentAudience:'Curious readers',
      referencePieces:[{lesson:'Explain the observation',result:'Readers understood',title:'Earlier synthetic example'}]},
    form:'short explanatory video',materials:[{id:'S1',title:'Synthetic observation',text:'The synthetic cup warmed in sunlight.'},
      ...Array.from({length:10},(_,index)=>({id:`S${index+2}`,title:`Synthetic source ${index+2}`,
        text:`Synthetic source ${index+2} gives distinct full text.`}))],
    standards:'Use only the supplied synthetic source.',webResearch:false,readerGoal:'Understand the observation',
    requiredQuestions:['What happened?','When?','What was observed?','Which source supports it?','What remains unknown?'],maxRevisions:1};
  await expect(method.command!(spaceId,command('case-create',{workflowVersionId:'wrong-version',
    case:{id:caseId,title:'Synthetic case',objective:'Explain'},idempotencyKey:'wrong'}))).rejects.toThrow();
  await method.command!(spaceId,command('case-create',{workflowVersionId:versionId,
    case:{id:caseId,title:'Synthetic case',objective:'Explain a synthetic observation'},idempotencyKey:'case'}));
  const successorCapability=await createMethodCapabilityStore(designer).save(spaceId,{
    ...scope,understanding:understandingRef,provider:capability.provider,nodes:capability.nodes,
    validation:capability.validation,predecessorVersionId:versionId,
    changeReason:'Synthetic successor for the existing Case',authorship:capability.authorship,
    expectedRevisionId:capability.id,idempotencyKey:'capability-successor'});
  const successorDesign=await designHost.save!(spaceId,{...scope,understanding:understandingRef,
    capability:{revisionId:successorCapability.id,payloadHash:successorCapability.payloadHash},
    title:'Synthetic successor method',content:'# Synthetic successor\nThe same Case keeps its independent business topic ID.',
    sources:[{kind:'document',ref:'synthetic:fixture',title:'Synthetic fixture'}],
    authorship:{kind:'agent',name:'synthetic-pg-design',sessionId:'synthetic-pg-session'},
    changeReason:'Synthetic successor for the existing Case',expectedRevisionId:design.id,idempotencyKey:'design-successor'});
  const successorPreview=await designHost.preview!(spaceId,successorDesign.id);
  const successorPublished=await designHost.publish!(spaceId,{designRevisionId:successorDesign.id,
    expectedCandidateId:successorPreview.versionId});
  expect(successorPublished.versionId).not.toBe(versionId);
  versionId=successorPublished.versionId;
  const beforeInvalid=(await db.query<{assets:number;manifests:number}>(`SELECT
    (SELECT count(*)::int FROM ws_asset_versions WHERE space_id=$1) AS assets,
    (SELECT count(*)::int FROM ws_manifests WHERE space_id=$1) AS manifests`,[spaceId])).rows[0]!;
  const {materials:packedMaterials,...packedOpportunity}=input;
  await expect(method.command!(spaceId,command('inputs-freeze',{workflowVersionId:versionId,caseId,
    input:{opportunity:packedOpportunity,materials:packedMaterials},idempotencyKey:'packed-invalid'}))).rejects.toThrow();
  await expect(method.command!(spaceId,command('inputs-freeze',{workflowVersionId:versionId,caseId,
    input:{...input,maxRevisions:2},idempotencyKey:'revision-invalid'})))
    .rejects.toThrow('two business rounds');
  const afterInvalid=(await db.query<{assets:number;manifests:number}>(`SELECT
    (SELECT count(*)::int FROM ws_asset_versions WHERE space_id=$1) AS assets,
    (SELECT count(*)::int FROM ws_manifests WHERE space_id=$1) AS manifests`,[spaceId])).rows[0]!;
  expect(afterInvalid).toEqual(beforeInvalid);
  const frozen=await method.command!(spaceId,command('inputs-freeze',{workflowVersionId:versionId,caseId,input,
    idempotencyKey:'freeze',origin:{spaceId:'synthetic-other-space',
      opportunity:{assetVersionId:'declared-opportunity',payloadHash:'a'.repeat(64)},
      materials:{assetVersionId:'declared-materials',payloadHash:'b'.repeat(64)},
      description:'Synthetic declared provenance, intentionally not externally verified'}}));
  const manifestId=String(frozen.inputManifestId),manifestHash=String(frozen.inputManifestHash);
  const manifest=await owner.readManifest(spaceId,manifestId);
  expect(manifest.caseId).toBe(caseId);
  const {materials:expectedMaterials,...expectedOpportunity}=input;
  expect((await owner.readAsset(spaceId,manifest.assets.opportunity!)).payload).toEqual(expectedOpportunity);
  expect((await owner.readAsset(spaceId,manifest.assets.materials!)).payload).toEqual(input.materials);
  const materialsReading=explanatoryMethodAssetReaders['creation/content-materials@1']!(
    await owner.readAsset(spaceId,manifest.assets.materials!));
  const opportunityReading=explanatoryMethodAssetReaders['creation/content-opportunity@1']!(
    await owner.readAsset(spaceId,manifest.assets.opportunity!));
  expect(materialsReading.sections.map(section=>section.text).join('\n')).toContain('The synthetic cup warmed in sunlight.');
  expect(opportunityReading.sections.map(section=>section.text).join('\n')).toContain('Earlier synthetic example');
  await expect(method.command!(spaceId,command('start',{workflowVersionId:versionId,caseId,
    inputManifestId:manifestId,idempotencyKey:'trial-start',mode:'research-trial'}))).rejects.toThrow('release');
  const release=await method.command!(spaceId,command('release',{workflowVersionId:versionId,caseId,
    inputManifestId:manifestId,inputManifestHash:manifestHash,idempotencyKey:'release'}));
  expect(release).toMatchObject({maxProviderRequests:15,maxTrialRequests:2,
    trialSecondKinds:['tool-continuation','technical-repair']});
  const started=await method.command!(spaceId,command('start',{workflowVersionId:versionId,caseId,
    inputManifestId:manifestId,idempotencyKey:'trial-start',mode:'research-trial'}));
  expect(started.status).toBe('queued');
  await method.command!(spaceId,command('dispatch',{workflowVersionId:versionId,runId:String(started.runId)}));
  let task=await owner.getExecutionTask(spaceId,String(started.runId));
  const deadline=Date.now()+30_000;
  while(task&&!['completed','failed','canceled'].includes(task.status)&&Date.now()<deadline){
    await new Promise(resolve=>setTimeout(resolve,50));
    task=await owner.getExecutionTask(spaceId,String(started.runId));
  }
  expect(task?.status,task?.error).toBe('completed');
  expect(bodies).toHaveLength(1);
  expect(JSON.stringify(bodies[0]?.input)).toContain('sourceMap');
  expect(JSON.stringify(bodies[0]?.input)).toContain('Earlier synthetic example');
  const run=await(await owner.runtimeLedger(spaceId)).getRun(String(started.runId));
  expect(run?.state).toBe('needs_review');
  expect(run?.output).toMatchObject({details:{reason:'research-trial-complete'}});
  const researchAssets=(await owner.runAssets(spaceId,String(started.runId)))
    .filter(asset=>asset.schema.namespace==='creation/content-research');
  expect(researchAssets.map(asset=>asset.payload)).toContainEqual(research);
  const researchReading=explanatoryMethodAssetReaders['creation/content-research@1']!(researchAssets[0]!);
  expect(researchReading.sections.map(section=>section.text).join('\n')).toContain('The synthetic source says a cup warmed.');
  const overview=await owner.overview(spaceId);
  expect(overview.adoptions).toHaveLength(0);
  expect((await owner.runAssets(spaceId,String(started.runId)))
    .filter(asset=>asset.schema.namespace==='creation/content-draft')).toHaveLength(0);
  const budget=await createExecutionBudgetStore(owner).read(spaceId,String(release.budgetId));
  expect(budget.reservations).toHaveLength(1);
  expect(budget.reservations[0]).toMatchObject({stage:'trial',kind:'original',runId:started.runId});
  await host.stop();
  host=createHost();
  const replayFreeze=await host.methodExecution!.command!(spaceId,command('inputs-freeze',{workflowVersionId:versionId,caseId,input,
    idempotencyKey:'freeze',origin:{spaceId:'synthetic-other-space',
      opportunity:{assetVersionId:'declared-opportunity',payloadHash:'a'.repeat(64)},
      materials:{assetVersionId:'declared-materials',payloadHash:'b'.repeat(64)},
      description:'Synthetic declared provenance, intentionally not externally verified'}}));
  expect(replayFreeze).toMatchObject({inputManifestId:manifestId,inputManifestHash:manifestHash});
  const status=await host.methodExecution!.status(spaceId);
  expect((status.versions as Array<Record<string,unknown>>).find(version=>version.workflowVersionId===versionId))
    .toMatchObject({availability:{available:true},budget:{usedReservedRequests:1,remainingProviderRequests:14}});
  expect((await host.methodExecution!.command!(spaceId,command('release',{workflowVersionId:versionId,caseId,
    inputManifestId:manifestId,inputManifestHash:manifestHash,idempotencyKey:'release'}))).budgetId).toBe(release.budgetId);
  await expect(host.methodExecution!.command!(spaceId,command('release',{workflowVersionId:versionId,caseId,
    inputManifestId:manifestId,inputManifestHash:manifestHash,idempotencyKey:'alternate-key'}))).rejects.toThrow('Alternate release');
  await expect(host.methodExecution!.command!(spaceId,command('start',{workflowVersionId:versionId,caseId,
    inputManifestId:manifestId,idempotencyKey:'alternate-start',mode:'research-trial'}))).rejects.toThrow('different run');
  await host.stop();
},120_000);
