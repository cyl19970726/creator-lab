import {describe,it,expect} from 'vitest';
import {SchemaRegistry,publishStorageContract} from '@signal-room/workflow-space-contracts';
import {publishProcessContract,type AssetVersion,type SpaceRuntimeResolverApi} from '@signal-room/workflow-spaces';
import type {StepRecord,StepResultCommit} from '@signal-room/workflow';
import {resolveCreationDecision} from '../src/spaces/runtime.js';
import {buildContentProcess,contentOccurrence,contentCitationDeclarations,createContentProcessResolver} from '../src/spaces/process.js';
import {registerCreationSchemas,creationStorageContracts} from '../src/spaces/contracts.js';

const refs=()=>{const registry=new SchemaRegistry();return{registry,refs:registerCreationSchemas(registry)};};
const parent=(id:string,payload:unknown)=>({id,payload} as AssetVersion);
describe('CONTENT observational process contract',()=>{
  it('reuses frozen storage ports, declares reviewer parallelism and bounded return paths',async()=>{
    const {registry,refs:r}=refs();const storage=publishStorageContract(registry,creationStorageContracts(r,'method')[0]!);
    const process=await publishProcessContract(buildContentProcess(r),storage);
    expect(process.nodes.find(node=>node.id==='author')?.inputs?.priorDraft?.slot).toBe('priorDraft');
    expect(process.edges.filter(edge=>edge.kind==='fork').map(edge=>edge.to)).toEqual(['coldReader','factChecker']);
    expect(process.edges.filter(edge=>edge.kind==='fork').map(edge=>edge.branch)).toEqual(['reader','checker']);
    expect(process.edges.filter(edge=>edge.kind==='join').every(edge=>edge.to==='editor')).toBe(true);
    expect(process.edges.filter(edge=>edge.kind==='rework').every(edge=>edge.maxTraversals===5)).toBe(true);
    expect(process.results.map(result=>result.role)).toContain('final-draft');
  });
  it('keeps failed and recovered technical attempts in the same recorded business round',()=>{
    const step:StepRecord={id:'failed-step',runId:'run',key:'content-draft-2:write',kind:'agent',workflowId:'creation.content',workflowRevision:'content-v2',inputFingerprint:'input',configFingerprint:'config',state:'failed',validation:'pending',phasePath:['content-draft-2']};
    expect(contentOccurrence(step,'author')).toEqual({nodeId:'author',round:3});
    expect(contentOccurrence({...step,id:'recovered-step'},'author')).toEqual({nodeId:'author',round:3});
    expect(contentOccurrence({...step,phasePath:undefined},'author')).toBeUndefined();
    expect(contentOccurrence({...step,phasePath:['content-check-1']},'coldReader')).toEqual({nodeId:'coldReader',round:2,branch:'reader'});
  });
  it('declares input provenance for each port including frozen versus previous-round drafts',async()=>{
    const {registry,refs:r}=refs();const storage=publishStorageContract(registry,creationStorageContracts(r,'method')[0]!);
    const process=await publishProcessContract(buildContentProcess(r),storage);
    for(const node of process.nodes)for(const port of Object.keys(node.inputs??{})) {
      expect(process.dataBindings?.some(binding=>binding.to.node===node.id&&binding.to.port===port),`${node.id}.${port}`).toBe(true);
    }
    expect(process.dataBindings?.filter(binding=>binding.to.node==='author'&&binding.to.port==='priorDraft')).toEqual([
      expect.objectContaining({from:{runInput:'priorDraft'},selection:'frozen-input',when:'initial-round'}),
      expect.objectContaining({from:{node:'author',port:'draft'},selection:'previous-business-round',when:'later-rounds'}),
    ]);
    expect(process.dataBindings?.find(binding=>binding.to.node==='author'&&binding.to.port==='research')?.selection).toBe('latest-successful-in-this-run');
  });
  it('uses the recorded method contract and rejects archived contracts without a run binding',async()=>{
    const {registry,refs:r}=refs();const storage=publishStorageContract(registry,creationStorageContracts(r,'method')[0]!);
    const declared=buildContentProcess(r);
    const frozen=await publishProcessContract(declared,storage);
    const resolver=createContentProcessResolver({runtimeEvidence:async()=>({getRun:async()=>({state:'needs_review'})})} as never);
    const input={run:{spaceId:'s',runId:'r',entrypoint:'content',process:{revision:frozen.revision,hash:frozen.hash}},workflow:{entrypoints:{content:{process:frozen}}},steps:[],contexts:[],events:[]} as never;
    const result=await resolver(input);
    expect(result.contract).toEqual(declared);
    expect((await publishProcessContract(result.contract,storage)).hash).toBe(frozen.hash);
    await expect(resolver({...input as object,workflow:{entrypoints:{content:{}}}} as never)).rejects.toThrow('recorded process contract');
    await expect(resolver({...input as object,run:{spaceId:'s',runId:'r',entrypoint:'content'}} as never)).rejects.toThrow('recorded process contract');
  });
  it('publishes exact immutable parent fragment references instead of floating source IDs',()=>{
    const declarations=contentCitationDeclarations('researcher',{questions:[{materialRefs:['m','n']}],notes:[{id:'n'}]},
      {materials:parent('old-package',[{id:'m',text:'Frozen'}])});
    expect(declarations.map(value=>({from:value.from,to:value.to}))).toEqual([
      {from:{outputSlot:'research',pointer:'/questions/0/materialRefs/0'},to:{inputSlot:'materials',pointer:'/0'}},
      {from:{outputSlot:'research',pointer:'/questions/0/materialRefs/1'},to:{outputSlot:'research',pointer:'/notes/0'}},
    ]);
  });
  it('resolves draft references against only its bound materials and research notes',()=>{
    const payload={script:{sourcesUsed:['n']},decision:{beats:[{evidence:['m']}]}};
    const relations=contentCitationDeclarations('author',payload,{materials:parent('old-package',[{id:'m'}]),research:parent('exact-research',{notes:[{id:'n'}]})});
    expect(relations[0]?.to).toEqual({inputSlot:'research',pointer:'/notes/0'});
    expect(relations[1]?.to).toEqual({inputSlot:'materials',pointer:'/0'});
  });
  it('rejects unresolved or ambiguous publication references',()=>{
    const payload={questions:[{materialRefs:['missing']}],notes:[]};
    expect(()=>contentCitationDeclarations('researcher',payload,{materials:parent('p',[{id:'m'}])})).toThrow('unresolved');
    expect(()=>contentCitationDeclarations('researcher',{questions:[{materialRefs:['m']}],notes:[{id:'m'}]},
      {materials:parent('p',[{id:'m'}])})).toThrow('ambiguous');
  });
  it('records a guarded decision selection without claiming a next round or changing legacy receipts',async()=>{
    const {refs:r}=refs();const contract=buildContentProcess(r);
    const api={frozenProcess:async()=>contract,steps:async()=>[{id:'decision',key:'content-route-2'}]} as unknown as SpaceRuntimeResolverApi;
    const commit={stepRunId:'decision',events:[{runId:'run'}],output:{route:'pass',verdict:'pass',failures:['guard'],round:2}} as StepResultCommit;
    expect(await resolveCreationDecision(commit,api)).toMatchObject({nodeId:'route',edgeId:'route-rewrite',round:3,observation:{route:'pass',round:2}});
    expect(await resolveCreationDecision({...commit,output:{route:'blocked',verdict:'blocked',failures:[],round:2}},api)).toMatchObject({edgeId:'route-blocked'});
    await expect(resolveCreationDecision({...commit,output:{route:'rewrite',failures:[],round:1}},api)).rejects.toThrow('exact native round');
    expect(await resolveCreationDecision(commit,{...api,frozenProcess:async()=>undefined})).toBeUndefined();
  });
});
