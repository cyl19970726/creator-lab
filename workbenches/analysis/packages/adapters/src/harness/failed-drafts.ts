import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {RunStore,WorkflowEvent} from '@signal-room/workflow';
import type {SchemaRef} from '@signal-room/workflow-space-contracts';
import type {WorkflowSpaceService} from '@signal-room/workflow-spaces';
import {authoredSections} from './readers.js';

const slots=['contentRestoration','directingLogic','visualEditing'] as const;
type Slot=typeof slots[number];
type Store=Pick<RunStore,'getRun'|'listRuns'|'listEvents'|'listSteps'|'listAttempts'>;
type DraftEvidence={slot:Slot;runId:string;stepRunId:string;attemptId:string;eventId:string;eventSeq:number;
  draftId:string;sha256:string|null;path:string|null;integrity:'verified'|'unknown';pass:boolean|null};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
function inside(root:string,file:string):boolean {const rel=path.relative(root,file);return rel!==''&&!rel.startsWith('..')&&!path.isAbsolute(rel);}
function regular(file:string,root:string):boolean{
  try{return inside(root,fs.realpathSync(file))&&fs.lstatSync(file).isFile();}catch{return false;}
}
function readDraft(root:string,creatorRunId:string,runId:string,attemptId:string,slot:Slot,draftId:string,sha256:string):{value:unknown;path:string}{
  const runtime=fs.realpathSync(root);
  const base=path.join(runtime,'runs',creatorRunId,'workflow-responses',runId,attemptId);
  if(!inside(runtime,base)||!fs.existsSync(base)||!fs.lstatSync(base).isDirectory()||fs.realpathSync(base)!==base)
    throw new Error('Failed draft attempt is outside its bound creator runtime');
  const directory=path.join(base,`.builder-lens-${slot}`);
  if(!fs.existsSync(directory)||!fs.lstatSync(directory).isDirectory()||fs.realpathSync(directory)!==directory)
    throw new Error(`Failed draft directory is unavailable: ${slot}`);
  const prefix=`.validated-drafts-builder-lens-${slot}-`;
  const candidates=fs.readdirSync(directory).filter(name=>name.startsWith(prefix)&&uuid.test(name.slice(prefix.length)));
  if(candidates.length>16)throw new Error('Failed draft directory has too many instances');
  const matches:{value:unknown;path:string}[]=[];
  for(const name of candidates){
    const instance=path.join(directory,name),manifest=path.join(instance,'manifest.json'),file=path.join(instance,`${draftId}.json`);
    if(!fs.existsSync(instance)||!fs.lstatSync(instance).isDirectory()||fs.realpathSync(instance)!==instance||
      !regular(manifest,base)||!regular(file,base))continue;
    const saved=record(JSON.parse(fs.readFileSync(manifest,'utf8'))),entry=record(record(saved.entries)[draftId]);
    if(saved.namespace!==`builder-lens-${slot}`||saved.instanceId!==name.slice(prefix.length)||entry.draftId!==draftId||entry.sha256!==sha256)continue;
    const bytes=fs.readFileSync(file);
    if(digest(bytes)!==sha256)throw new Error(`Failed draft bytes changed: ${slot}`);
    matches.push({value:JSON.parse(bytes.toString('utf8')),path:file});
  }
  if(matches.length!==1)throw new Error(`Failed draft exact file unavailable or ambiguous: ${slot}`);
  return matches[0]!;
}

/** Read only the three staged Builder lenses from a failed root's original, bound creator runtime. */
export async function readFailedBuilderDrafts(options:{store:Store;rootRunId:string;runtimeRoot:string}){
  const root=await options.store.getRun(options.rootRunId);
  const creatorRunId=root?.metadata?.creatorRunId;
  if(!root||!uuid.test(root.id)||root.state!=='failed'||typeof creatorRunId!=='string'||!uuid.test(creatorRunId))
    throw new Error('A failed root with a bound creatorRunId is required');
  const runs=[root],seen=new Set([root.id]);
  for(let index=0;index<runs.length;index++){
    const children=await options.store.listRuns({parentRunId:runs[index]!.id});
    for(const child of children){
      if(seen.has(child.id))continue;
      if(runs.length>=32||!uuid.test(child.id)||child.parentRunId!==runs[index]!.id||child.metadata?.creatorRunId!==creatorRunId)
        throw new Error('Failed draft child run is outside the bounded creator lineage');
      runs.push(child);seen.add(child.id);
    }
  }
  const staged:Map<Slot,{event:WorkflowEvent;runId:string}>=new Map();
  for(const run of runs)for(const event of await options.store.listEvents(run.id)){
    if(event.type!=='responses.draft_staged'&&event.type!=='responses.draft_accepted')continue;
    const data=record(event.data),slot=slots.find(item=>data.phase===`builder-lens-${item}`&&data.slot===item);
    if(!slot||event.type!=='responses.draft_staged')continue;
    if(event.runId!==run.id||!event.stepRunId||!uuid.test(event.stepRunId)||!event.attemptId||!uuid.test(event.attemptId)||
      typeof data.draftId!=='string'||!uuid.test(data.draftId))
      throw new Error('Failed Builder draft event lacks exact step, attempt or draft ID');
    const steps=await options.store.listSteps(run.id);
    const step=steps.find(item=>item.id===event.stepRunId);
    if(!step||step.runId!==run.id||(await options.store.listAttempts(step.id)).every(item=>
      item.id!==event.attemptId||item.runId!==run.id||item.stepRunId!==step.id))
      throw new Error('Failed Builder draft event has unbound attempt provenance');
    const prior=staged.get(slot);
    if(!prior||event.timestamp>prior.event.timestamp||event.timestamp===prior.event.timestamp&&event.seq>prior.event.seq)
      staged.set(slot,{event,runId:run.id});
  }
  const values:Partial<Record<Slot,unknown>>={},drafts:DraftEvidence[]=[];
  for(const slot of slots){
    const selected=staged.get(slot);
    if(!selected)continue;
    const {event,runId}=selected,data=record(event.data);
    const savedHash=typeof data.sha256==='string'&&/^[a-f0-9]{64}$/u.test(data.sha256)?data.sha256:null;
    const evidence:DraftEvidence={slot,runId,stepRunId:event.stepRunId!,attemptId:event.attemptId!,eventId:event.id,eventSeq:event.seq,
      draftId:data.draftId as string,sha256:savedHash,path:null,integrity:savedHash?'verified':'unknown',pass:typeof data.pass==='boolean'?data.pass:null};
    if(savedHash){const exact=readDraft(options.runtimeRoot,creatorRunId,runId,event.attemptId!,slot,evidence.draftId,savedHash);
      values[slot]=exact.value;evidence.path=exact.path;}
    drafts.push(evidence);
  }
  const payload={title:'失败运行中保存的三视角草稿',description:'只读历史草稿；未发布为正式报告，未通过最终质量判断。',
    publication:'unpublished' as const,source:{rootRunId:root.id,creatorRunId},report:{builderLenses:values},
    drafts,missingSlots:slots.filter(slot=>values[slot]===undefined)};
  return {payload,sections:slots.flatMap(slot=>values[slot]===undefined?[]:authoredSections(values[slot],`/report/builderLenses/${slot}`,slot))};
}

/** Ordinary imported evidence document, deliberately separate from historical artifact publication. */
export async function importFailedBuilderDrafts(options:{service:WorkflowSpaceService;spaceId:string;schema:SchemaRef;
  store:Store;rootRunId:string;runtimeRoot:string}){
  const result=await readFailedBuilderDrafts(options);
  const asset=await options.service.importAsset(options.spaceId,{schema:options.schema,payload:result.payload,
    assetId:`failed-builder-drafts:${options.rootRunId}`,description:'Verified staged drafts from failed historical run; unpublished',
    idempotencyKey:`failed-builder-drafts:${options.rootRunId}`});
  return {...result,asset};
}
