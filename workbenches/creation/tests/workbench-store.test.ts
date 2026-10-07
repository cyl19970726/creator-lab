import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { ArtifactRef } from '@signal-room/workflow';
import { WorkbenchStore, WorkbenchStoreError, workbenchSha256 } from '../src/workbench/store.js';
import type { Actor, CaseInput, RunRequest } from '../src/workbench/contracts.js';
import type { PieceBrief } from '../src/stages/brief.js';

const roots: string[] = [];
const stores: WorkbenchStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });
const open = (root?: string) => { const path = root ?? mkdtempSync(join(tmpdir(),'creation-wb-')); if (!root) roots.push(path); const store = new WorkbenchStore(path); stores.push(store); return store; };
const user: Actor = { kind:'user', id:'creator-1' };
const agent: Actor = { kind:'agent', id:'reviewer-a' };
const caseInput: CaseInput = { title:'A piece', opportunity:'Explain a gap', readerGoal:'Understand the gap', requiredQuestions:['Why?'], account:{name:'Account',positioning:'Explainers',currentAudience:'Beginners',referencePieces:[]}, form:'article', materials:[{id:'m1',title:'Source',text:'Evidence'}], webResearch:false };
const request = (commandId: string=randomUUID()): RunRequest => ({commandId,workflowId:'creation.content',model:'test',workerEffort:'low',judgeEffort:'low',maxRevisions:2,hypothesis:'A clearer opening helps'});
const revision = { workflowId:'creation.content' as const, code:{commit:'abc'},config:{worker:'test'},standards:{content:'v1'} };
function seedRun(store: WorkbenchStore, caseId: string) {
  const run = store.createRun(caseId,request(),user,() => ({input:{caseId, text:'frozen'},revision}));
  expect(store.claimNext()?.id).toBe(run.id);
  store.database.exec('CREATE TABLE IF NOT EXISTS workflow_runs(id TEXT PRIMARY KEY, document TEXT NOT NULL)');
  store.database.prepare('INSERT INTO workflow_runs(id,document) VALUES (?,?)').run(`native-${run.id}`,'{}');
  store.bindRun(run.id,`native-${run.id}`);
  store.database.exec('CREATE TABLE IF NOT EXISTS workflow_artifacts(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, document TEXT NOT NULL, payload TEXT NOT NULL)');
  return store.getRun(run.id);
}
function artifact(store: WorkbenchStore, runId: string, payload: unknown = {text:'draft'}, type = 'content-draft') {
  const run=store.getRun(runId), id=randomUUID();
  const ref: ArtifactRef={id,type,schemaVersion:'1',revision:'1',sha256:workbenchSha256(payload),uri:`artifact://${id}`,producedBy:{workflowRunId:run.nativeRunId!,stepRunId:'s',attemptId:'a'},dependsOn:[],validation:'valid',review:'passed'};
  store.database.prepare('INSERT INTO workflow_artifacts(id,run_id,document,payload) VALUES (?,?,?,?)').run(id,run.nativeRunId,JSON.stringify(ref),JSON.stringify(payload));
  return store.saveArtifact(runId,ref,payload);
}
function brief(caseId: string, runId: string, version=1): PieceBrief {
  return { schemaVersion:'brief-v1',topicId:caseId,version,sources:[{stage:'content',runId,revision:'1',acceptedAt:'2026-10-03T00:00:00Z',reviewer:'creator'}],
    creator:{opportunity:'Explain a gap',account:caseInput.account,form:'article'},audienceQuestion:{readerGoal:'Understand'},decision:{},materials:caseInput.materials,notesForB2:[],notesForB3:[],script:{} };
}
function review(store: WorkbenchStore, caseId: string, artifactId: string, sha256: string, actor: Actor=user, standardVersion='v1') {
  return store.saveReview(caseId,{commandId:randomUUID(),artifactId,sha256,standardVersion,good:'Clear opening',bad:'Needs one citation',improvement:'Baseline established',unsatisfied:'Source quality',verdict:'pass',...(actor.kind==='agent'?{evaluator:{model:'test',promptRevision:'p1',visibleMaterials:['draft']}}:{})},actor);
}

test('restart retains immutable input and command replay is actor/body exact', () => {
  const store=open(), root=store.stateRoot;
  const created=store.createCase({...caseInput,commandId:'case-1'},user);
  expect(store.createCase({...caseInput,commandId:'case-1'},user)).toEqual(created);
  expect(() => store.createCase({...caseInput,commandId:'case-1',title:'Changed'},user)).toThrow(WorkbenchStoreError);
  expect(() => store.createCase({...caseInput,commandId:'case-1'},agent)).toThrow(WorkbenchStoreError);
  let prepared=0;
  const cmd=request('run-1');
  const first=store.createRun(created.id,cmd,user,() => {prepared++;return {input:{x:1},revision};});
  expect(store.createRun(created.id,cmd,user,() => {throw Error('prepare called twice');})).toEqual(first);
  expect(prepared).toBe(1);
  expect(() => store.createRun(created.id,{...cmd,hypothesis:'different'},user,() => ({input:{},revision}))).toThrow(WorkbenchStoreError);
  expect(() => store.createRun(created.id,request(),user,() => ({input:{},revision}))).toThrow(WorkbenchStoreError);
  store.close(); stores.splice(stores.indexOf(store),1);
  const reopened=open(root);
  expect(reopened.getRun(first.id).inputHash).toBe(workbenchSha256({x:1}));
  expect(reopened.getCase(created.id).input).toEqual(caseInput);
  expect(reopened.getRevision(first.revisionId).sha256).toBe(workbenchSha256(revision));
});

test('native artifact and exact case/hash associations are enforced', () => {
  const store=open(); const a=store.createCase({...caseInput,commandId:'a'},user); const b=store.createCase({...caseInput,commandId:'b'},user);
  const run=seedRun(store,a.id); const asset=artifact(store,run.id); store.finishRun(run.id,'succeeded'); const another=seedRun(store,b.id); const other=artifact(store,another.id,{text:'other'});
  expect(store.getArtifact(asset.id).payload).toEqual({text:'draft'});
  expect(() => store.saveReview(a.id,{commandId:'wrong',artifactId:other.id,sha256:other.sha256,standardVersion:'v1',good:'g',bad:'b',improvement:'i',unsatisfied:'u',verdict:'pass'},user)).toThrow(WorkbenchStoreError);
  expect(() => store.saveReview(a.id,{commandId:'hash',artifactId:asset.id,sha256:'wrong',standardVersion:'v1',good:'g',bad:'b',improvement:'i',unsatisfied:'u',verdict:'pass'},user)).toThrow(WorkbenchStoreError);
  const badRef={...asset.nativeRef,id:randomUUID(),sha256:'bad'};
  expect(() => store.saveArtifact(run.id,badRef,{text:'draft'})).toThrow(WorkbenchStoreError);
});

test('reviews never adopt; only exact human reviewed artifact with gate acceptance can be adopted', () => {
  const store=open(); const c=store.createCase({...caseInput,commandId:'case'},user); const run=seedRun(store,c.id); const asset=artifact(store,run.id);
  const agentReview=review(store,c.id,asset.id,asset.sha256,agent);
  expect(store.detail(c.id).decisions).toHaveLength(0);
  const input={kind:'artifact' as const,action:'adopt' as const,artifactId:asset.id,sha256:asset.sha256,reviewId:agentReview.id,reason:'Good',commandId:'adopt-agent'};
  expect(() => store.decide(c.id,input,user,{kind:'artifact',actorId:user.id,artifactId:asset.id,sha256:asset.sha256,reviewId:agentReview.id})).toThrow(WorkbenchStoreError);
  const humanReview=review(store,c.id,asset.id,asset.sha256);
  const decision={...input,reviewId:humanReview.id,commandId:'adopt-human'};
  expect(() => store.decide(c.id,decision,user)).toThrow(WorkbenchStoreError);
  expect(() => store.decide(c.id,decision,agent,{kind:'artifact',actorId:agent.id,artifactId:asset.id,sha256:asset.sha256,reviewId:humanReview.id})).toThrow(WorkbenchStoreError);
  const accepted=store.decide(c.id,decision,user,{kind:'artifact',actorId:user.id,artifactId:asset.id,sha256:asset.sha256,reviewId:humanReview.id,brief:brief(c.id,run.nativeRunId!)});
  expect(store.decide(c.id,decision,user)).toEqual(accepted);
  expect(store.detail(c.id).decisions).toHaveLength(1);
});

test('comparison binds two exact reviewed assets and records observed condition differences', () => {
  const store=open(); const c=store.createCase({...caseInput,commandId:'case'},user);
  const first=seedRun(store,c.id); const a=artifact(store,first.id); store.finishRun(first.id,'succeeded');
  const second=seedRun(store,c.id); const b=artifact(store,second.id,{text:'better'});
  const ra=review(store,c.id,a.id,a.sha256), rb=review(store,c.id,b.id,b.sha256);
  const comparison=store.saveComparison(c.id,{commandId:'compare',baselineArtifactId:a.id,baselineSha256:a.sha256,candidateArtifactId:b.id,candidateSha256:b.sha256,baselineReviewId:ra.id,candidateReviewId:rb.id,conditions:{visible:'same'},differences:'Clearer opening',conclusion:'Better on this case'},user);
  expect((comparison.conditions.observed as { sameInput:boolean }).sameInput).toBe(true);
  expect(() => store.saveComparison(c.id,{commandId:'bad-compare',baselineArtifactId:a.id,baselineSha256:a.sha256,candidateArtifactId:b.id,candidateSha256:b.sha256,baselineReviewId:rb.id,candidateReviewId:ra.id,conditions:{},differences:'X',conclusion:'Y'},user)).toThrow(WorkbenchStoreError);
  expect(store.detail(c.id).comparisons).toHaveLength(1);
});

test('comparison rejects a candidate review written against another baseline', () => {
  const store=open(); const c=store.createCase({...caseInput,commandId:'case'},user);
  const baselineRun=seedRun(store,c.id); const baseline=artifact(store,baselineRun.id,{text:'baseline'});
  const other=artifact(store,baselineRun.id,{text:'other baseline'}); store.finishRun(baselineRun.id,'succeeded');
  const candidateRun=seedRun(store,c.id); const candidate=artifact(store,candidateRun.id,{text:'candidate'});
  const baselineReview=review(store,c.id,baseline.id,baseline.sha256);
  const candidateReview=store.saveReview(c.id,{commandId:'review-against-other',artifactId:candidate.id,sha256:candidate.sha256,
    baselineArtifactId:other.id,baselineSha256:other.sha256,standardVersion:'v1',good:'Clear',bad:'Needs evidence',improvement:'Better',unsatisfied:'Source',verdict:'pass'},user);
  expect(() => store.saveComparison(c.id,{commandId:'wrong-review-baseline',baselineArtifactId:baseline.id,baselineSha256:baseline.sha256,
    candidateArtifactId:candidate.id,candidateSha256:candidate.sha256,baselineReviewId:baselineReview.id,candidateReviewId:candidateReview.id,
    conditions:{},differences:'Changed',conclusion:'Better'},user)).toThrow(/Candidate review baseline/);
});

test('interrupted native run can resume only by explicit user command; active run stays unique', () => {
  const store=open();const c=store.createCase({...caseInput,commandId:'case'},user);const run=seedRun(store,c.id);
  expect(store.interruptOrphanedRuns().map(x=>x.id)).toEqual([run.id]);
  expect(() => store.resumeRun(run.id,{commandId:'agent-resume'},agent)).toThrow(WorkbenchStoreError);
  const queued=store.resumeRun(run.id,{commandId:'resume'},user);
  expect(queued.state).toBe('queued');
  expect(store.resumeRun(run.id,{commandId:'resume'},user)).toEqual(queued);
  expect(() => store.createRun(c.id,request(),user,()=>({input:{},revision}))).toThrow(WorkbenchStoreError);
  expect(store.claimNext()?.state).toBe('running');
  store.cancelRun(run.id,{commandId:'cancel'},user);
  expect(store.getRun(run.id).cancelRequested).toBe(true);
});

test('two database clients preserve one command result and separate append-only decisions', () => {
  const first=open(); const second=open(first.stateRoot);
  const c=first.createCase({...caseInput,commandId:'case'},user); const run=seedRun(first,c.id); const asset=artifact(first,run.id); const r=review(first,c.id,asset.id,asset.sha256);
  const observation={kind:'artifact' as const,action:'observe' as const,artifactId:asset.id,sha256:asset.sha256,reviewId:r.id,reason:'Collect more cases',commandId:'observe-1'};
  const a=first.decide(c.id,observation,user);
  expect(second.decide(c.id,observation,user)).toEqual(a);
  expect(() => second.decide(c.id,{...observation,reason:'Changed'},user)).toThrow(WorkbenchStoreError);
  second.decide(c.id,{...observation,commandId:'observe-2'},user);
  expect(first.detail(c.id).decisions.map(d=>d.id)).toHaveLength(2);
});

test('one running job across cases is enforced by the shared database', () => {
  const first=open(), second=open(first.stateRoot);
  const a=first.createCase({...caseInput,commandId:'a'},user), b=first.createCase({...caseInput,commandId:'b'},user);
  const r1=first.createRun(a.id,request(),user,()=>({input:{case:'a'},revision}));
  const r2=first.createRun(b.id,request(),user,()=>({input:{case:'b'},revision}));
  expect(first.claimNext()?.id).toBe(r1.id);
  expect(second.claimNext()).toBeUndefined();
  first.finishRun(r1.id,'failed',null,'test failure');
  expect(second.claimNext()?.id).toBe(r2.id);
});

test('workflow adoption is separate from artifact adoption and requires comparison gate evidence', () => {
  const store=open(); const c=store.createCase({...caseInput,commandId:'case'},user);
  const first=seedRun(store,c.id); const a=artifact(store,first.id); store.finishRun(first.id,'succeeded');
  const second=seedRun(store,c.id); const b=artifact(store,second.id,{text:'candidate'});
  const ra=review(store,c.id,a.id,a.sha256), rb=review(store,c.id,b.id,b.sha256);
  const comparison=store.saveComparison(c.id,{commandId:'compare',baselineArtifactId:a.id,baselineSha256:a.sha256,candidateArtifactId:b.id,candidateSha256:b.sha256,baselineReviewId:ra.id,candidateReviewId:rb.id,conditions:{},differences:'Changed opening',conclusion:'Candidate promising'},user);
  const input={kind:'workflow' as const,action:'adopt' as const,revisionId:second.revisionId,comparisonId:comparison.id,reason:'Representative case passed',commandId:'workflow-adopt'};
  expect(() => store.decide(c.id,input,user)).toThrow(WorkbenchStoreError);
  expect(store.detail(c.id).decisions).toHaveLength(0);
  store.decide(c.id,input,user,{kind:'workflow',actorId:user.id,revisionId:second.revisionId,comparisonId:comparison.id});
  expect(store.detail(c.id).decisions).toHaveLength(1);
  expect(store.detail(c.id).briefs).toHaveLength(0);
});

test('rollback targets the comparison baseline and never changes deployed revision implicitly', () => {
  const store=open(); const c=store.createCase({...caseInput,commandId:'case'},user);
  const first=seedRun(store,c.id), a=artifact(store,first.id); store.finishRun(first.id,'succeeded');
  const candidateRevision={...revision,code:{commit:'candidate'}};
  const second=store.createRun(c.id,request(),user,()=>({input:{caseId:c.id,text:'frozen'},revision:candidateRevision}));
  expect(store.claimNext()?.id).toBe(second.id);
  store.database.prepare('INSERT INTO workflow_runs(id,document) VALUES (?,?)').run(`native-${second.id}`,'{}');
  store.bindRun(second.id,`native-${second.id}`);
  const b=artifact(store,second.id,{text:'candidate'}), ra=review(store,c.id,a.id,a.sha256), rb=review(store,c.id,b.id,b.sha256);
  const comparison=store.saveComparison(c.id,{commandId:'compare',baselineArtifactId:a.id,baselineSha256:a.sha256,candidateArtifactId:b.id,candidateSha256:b.sha256,baselineReviewId:ra.id,candidateReviewId:rb.id,conditions:{},differences:'Different',conclusion:'Rollback preferred'},user);
  const rollback={kind:'workflow' as const,action:'rollback' as const,revisionId:first.revisionId,comparisonId:comparison.id,reason:'Baseline works better',commandId:'rollback'};
  expect(() => store.decide(c.id,{...rollback,revisionId:second.revisionId,commandId:'wrong-side'},user,{kind:'workflow',actorId:user.id,revisionId:second.revisionId,comparisonId:comparison.id})).toThrow(WorkbenchStoreError);
  store.decide(c.id,rollback,user,{kind:'workflow',actorId:user.id,revisionId:first.revisionId,comparisonId:comparison.id});
  expect(store.detail(c.id).decisions.at(-1)?.input).toEqual(rollback);
  expect(store.listRevisions()).toHaveLength(2);
});

test('per-run prepared evidence is frozen without changing the workflow definition revision', () => {
  const store=open(); const c=store.createCase({...caseInput,commandId:'case'},user);
  const first=store.createRun(c.id,request(),user,()=>({input:{x:1},revision,deployment:{briefSha256:'first'}}));
  expect(first.preparedHash).toBe(workbenchSha256({briefSha256:'first'}));
  expect(store.claimNext()?.id).toBe(first.id); store.finishRun(first.id,'failed');
  const second=store.createRun(c.id,request(),user,()=>({input:{x:1},revision,deployment:{briefSha256:'second'}}));
  expect(second.revisionId).toBe(first.revisionId);
  expect(second.preparedHash).not.toBe(first.preparedHash);
  expect(store.getRun(first.id).preparedEvidence).toEqual({briefSha256:'first'});
});

test('acceptance callback runs only for a new command and allocates successive brief versions', () => {
  const store=open(); const c=store.createCase({...caseInput,commandId:'case'},user); const run=seedRun(store,c.id);
  const a=artifact(store,run.id,{text:'A'}), b=artifact(store,run.id,{text:'B'});
  const ra=review(store,c.id,a.id,a.sha256), rb=review(store,c.id,b.id,b.sha256);
  let calls=0;
  const adopt=(asset:typeof a, reviewId:string, commandId:string) => store.decide(c.id,{kind:'artifact',action:'adopt',artifactId:asset.id,sha256:asset.sha256,reviewId,reason:'Accepted',commandId},user,() => {
    calls++;
    return {kind:'artifact',actorId:user.id,artifactId:asset.id,sha256:asset.sha256,reviewId,brief:brief(c.id,run.nativeRunId!,(store.getBrief(c.id)?.version ?? 0)+1)};
  });
  const first=adopt(a,ra.id,'adopt-a');
  expect(adopt(a,ra.id,'adopt-a')).toEqual(first);
  expect(calls).toBe(1);
  adopt(b,rb.id,'adopt-b');
  expect(calls).toBe(2);
  expect(store.getBrief(c.id)?.version).toBe(2);
});

test('accepted brief follows explicit selection; rejecting it clears selection without fallback', () => {
  const store=open(); const c=store.createCase({...caseInput,commandId:'case'},user); const run=seedRun(store,c.id);
  const a=artifact(store,run.id,{text:'A'}), b=artifact(store,run.id,{text:'B'});
  const ra=review(store,c.id,a.id,a.sha256), rb=review(store,c.id,b.id,b.sha256);
  const adopt=(asset: typeof a, reviewId:string, version:number, commandId:string) => store.decide(c.id,{kind:'artifact',action:'adopt',artifactId:asset.id,sha256:asset.sha256,reviewId,reason:'Accepted',commandId},user,
    {kind:'artifact',actorId:user.id,artifactId:asset.id,sha256:asset.sha256,reviewId,brief:brief(c.id,run.nativeRunId!,version)});
  adopt(a,ra.id,1,'adopt-a'); adopt(b,rb.id,2,'adopt-b');
  expect(store.getAcceptedBrief(c.id)?.version).toBe(2);
  store.decide(c.id,{kind:'artifact',action:'reject',artifactId:b.id,sha256:b.sha256,reviewId:rb.id,reason:'Revised judgment',commandId:'reject-b'},user);
  expect(store.getBrief(c.id)?.version).toBe(2);
  expect(store.getAcceptedBrief(c.id)).toBeUndefined();
  adopt(a,ra.id,1,'readopt-a');
  expect(store.getAcceptedBrief(c.id)?.version).toBe(1);
  store.decide(c.id,{kind:'artifact',action:'reject',artifactId:a.id,sha256:a.sha256,reviewId:ra.id,reason:'Withdrawn',commandId:'reject-a'},user);
  expect(store.getAcceptedBrief(c.id)).toBeUndefined();
  adopt(a,ra.id,1,'readopt-a-again');
  expect(store.getAcceptedBrief(c.id)?.version).toBe(1);
});

test('reviews and comparisons enforce deliverable type, actor, and standard comparability', () => {
  const store=open(); const c=store.createCase({...caseInput,commandId:'case'},user); const first=seedRun(store,c.id);
  const a=artifact(store,first.id), internal=artifact(store,first.id,{notes:'internal'},'content-research');
  expect(() => review(store,c.id,internal.id,internal.sha256)).toThrow(WorkbenchStoreError);
  expect(() => store.saveReview(c.id,{commandId:'bad-baseline',artifactId:a.id,sha256:a.sha256,baselineArtifactId:internal.id,baselineSha256:internal.sha256,standardVersion:'v1',good:'g',bad:'b',improvement:'i',unsatisfied:'u',verdict:'pass'},user)).toThrow(WorkbenchStoreError);
  expect(() => store.saveReview(c.id,{commandId:'spoof',artifactId:a.id,sha256:a.sha256,standardVersion:'v1',good:'g',bad:'b',improvement:'i',unsatisfied:'u',verdict:'pass',evaluator:{model:'fake',promptRevision:'fake',visibleMaterials:[]}},user)).toThrow(WorkbenchStoreError);
  store.finishRun(first.id,'succeeded'); const second=seedRun(store,c.id), b=artifact(store,second.id,{text:'B'});
  const ra=review(store,c.id,a.id,a.sha256), rb=review(store,c.id,b.id,b.sha256,user,'v2');
  const compare={commandId:'comparison',baselineArtifactId:a.id,baselineSha256:a.sha256,candidateArtifactId:b.id,candidateSha256:b.sha256,baselineReviewId:ra.id,candidateReviewId:rb.id,conditions:{},differences:'Changed',conclusion:'Cannot isolate quality'};
  expect(() => store.saveComparison(c.id,compare,agent)).toThrow(WorkbenchStoreError);
  const result=store.saveComparison(c.id,compare,user);
  expect((result.conditions.observed as {sameStandard:boolean;comparabilityLimitation:string}).sameStandard).toBe(false);
  expect((result.conditions.observed as {comparabilityLimitation:string}).comparabilityLimitation).toMatch(/different standard versions/);
  expect(() => store.decide(c.id,{kind:'workflow',action:'adopt',revisionId:second.revisionId,comparisonId:result.id,reason:'Changed',commandId:'adopt-different-standards'},user,
    {kind:'workflow',actorId:user.id,revisionId:second.revisionId,comparisonId:result.id})).toThrow(WorkbenchStoreError);
});
