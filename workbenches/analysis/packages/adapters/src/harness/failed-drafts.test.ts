import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {RunStore,RunRecord,StepRecord,AttemptRecord,WorkflowEvent} from '@signal-room/workflow';
import type {WorkflowSpaceService} from '@signal-room/workflow-spaces';
import {importFailedBuilderDrafts,readFailedBuilderDrafts} from './failed-drafts.js';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});

function fixture(){
  const runtimeRoot=fs.mkdtempSync(path.join(os.tmpdir(),'failed-drafts-'));roots.push(runtimeRoot);
  const creatorRunId=randomUUID(),rootRunId=randomUUID(),childRunId=randomUUID(),stepRunId=randomUUID(),attemptId=randomUUID();
  const root:RunRecord={id:rootRunId,workflowId:'post.analyze',workflowRevision:'1',inputFingerprint:'root',state:'failed',metadata:{creatorRunId}};
  const child:RunRecord={id:childRunId,workflowId:'post.build',workflowRevision:'1',inputFingerprint:'child',parentRunId:rootRunId,state:'failed',metadata:{creatorRunId}};
  const step={id:stepRunId,runId:childRunId} as StepRecord;
  const attempt={id:attemptId,runId:childRunId,stepRunId} as AttemptRecord;
  const events:WorkflowEvent[]=[];
  const store={
    getRun:vi.fn(async(id:string)=>id===rootRunId?root:id===childRunId?child:undefined),
    listRuns:vi.fn(async(filter?:{parentRunId?:string})=>filter?.parentRunId===rootRunId?[child]:[]),
    listEvents:vi.fn(async(id:string)=>id===childRunId?events:[]),
    listSteps:vi.fn(async(id:string)=>id===childRunId?[step]:[]),
    listAttempts:vi.fn(async(id:string)=>id===stepRunId?[attempt]:[]),
  } as unknown as Pick<RunStore,'getRun'|'listRuns'|'listEvents'|'listSteps'|'listAttempts'>;
  function stage(slot:'contentRestoration'|'directingLogic'|'visualEditing',value:unknown,options:{hash?:boolean}={}){
    const draftId=randomUUID(),instanceId=randomUUID();
    const directory=path.join(runtimeRoot,'runs',creatorRunId,'workflow-responses',childRunId,attemptId,
      `.builder-lens-${slot}`,`.validated-drafts-builder-lens-${slot}-${instanceId}`);
    fs.mkdirSync(directory,{recursive:true});
    const file=path.join(directory,`${draftId}.json`),bytes=Buffer.from(`${JSON.stringify(value)}\n`),sha256=createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(file,bytes);
    fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify({namespace:`builder-lens-${slot}`,instanceId,
      entries:{[draftId]:{draftId,sha256,pass:false,errors:[],createdAt:Date.now()}}}));
    events.push({id:randomUUID(),runId:childRunId,seq:events.length+1,type:'responses.draft_staged',timestamp:new Date(2026,0,1,0,0,events.length).toISOString(),
      stepRunId,attemptId,data:{phase:`builder-lens-${slot}`,slot,draftId,...(options.hash===false?{}:{sha256}),pass:false}});
    return {file,sha256,draftId};
  }
  return {runtimeRoot,creatorRunId,rootRunId,childRunId,stepRunId,attemptId,root,child,events,store,stage};
}

describe('failed Builder drafts',()=>{
  it('reads three exact saved lenses as unpublished prose with original provenance',async()=>{
    const f=fixture();
    f.stage('contentRestoration',{narrative:'第一段。\n\n第二段。'});
    f.stage('directingLogic',{reason:'编导判断。'});
    const visual=f.stage('visualEditing',{rhythm:'剪辑判断。'});
    const result=await readFailedBuilderDrafts(f);
    expect(result.payload.publication).toBe('unpublished');
    expect(result.payload.source).toEqual({rootRunId:f.rootRunId,creatorRunId:f.creatorRunId});
    expect(result.sections.map(section=>section.text)).toEqual(['第一段。\n\n第二段。','编导判断。','剪辑判断。']);
    expect(result.payload.drafts).toHaveLength(3);
    expect(result.payload.drafts[2]).toMatchObject({runId:f.childRunId,stepRunId:f.stepRunId,attemptId:f.attemptId,
      eventId:f.events[2]?.id,eventSeq:3,draftId:visual.draftId,path:fs.realpathSync(visual.file),sha256:visual.sha256,integrity:'verified',pass:false});
    expect(result.payload.missingSlots).toEqual([]);
  });

  it('rejects changed bytes and paths outside the bound creator run',async()=>{
    const f=fixture();
    const saved=f.stage('visualEditing',{rhythm:'原稿'});
    fs.writeFileSync(saved.file,'{"rhythm":"改稿"}\n');
    await expect(readFailedBuilderDrafts(f)).rejects.toThrow('bytes changed');
    fs.writeFileSync(saved.file,'{"rhythm":"原稿"}\n');
    f.child.metadata={creatorRunId:randomUUID()};
    await expect(readFailedBuilderDrafts(f)).rejects.toThrow('outside the bounded creator lineage');
  });

  it('does not read content whose event lacks a saved hash',async()=>{
    const f=fixture();f.stage('contentRestoration',{narrative:'不可验证'}, {hash:false});
    const result=await readFailedBuilderDrafts(f);
    expect(result.sections).toEqual([]);
    expect(result.payload.report.builderLenses).toEqual({});
    expect(result.payload.drafts[0]).toMatchObject({integrity:'unknown',sha256:null,path:null});
    expect(result.payload.missingSlots).toContain('contentRestoration');
  });

  it('rejects a symlink that escapes the attempt directory even with matching bytes',async()=>{
    const f=fixture();const saved=f.stage('visualEditing',{rhythm:'保存原稿'});
    const elsewhere=path.join(f.runtimeRoot,'outside.json');
    fs.copyFileSync(saved.file,elsewhere);fs.unlinkSync(saved.file);fs.symlinkSync(elsewhere,saved.file);
    await expect(readFailedBuilderDrafts(f)).rejects.toThrow('exact file unavailable');
  });

  it('imports an ordinary evidence asset without publishing a historical artifact',async()=>{
    const f=fixture();f.stage('contentRestoration',{narrative:'未发布稿'});
    const importAsset=vi.fn(async()=>({id:'asset-version-1'}));
    const service={importAsset,publishHistoricalArtifact:vi.fn()} as unknown as WorkflowSpaceService;
    const schema={namespace:'analysis/historical-evidence',revision:'1',hash:'schema-hash'};
    const result=await importFailedBuilderDrafts({...f,service,spaceId:'space-1',schema});
    expect(result.asset).toEqual({id:'asset-version-1'});
    expect(importAsset).toHaveBeenCalledWith('space-1',expect.objectContaining({schema,
      assetId:`failed-builder-drafts:${f.rootRunId}`,idempotencyKey:`failed-builder-drafts:${f.rootRunId}`,
      payload:expect.objectContaining({publication:'unpublished'})}));
    expect(service.publishHistoricalArtifact).not.toHaveBeenCalled();
  });
});
