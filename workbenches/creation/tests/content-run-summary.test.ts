import {describe,expect,it,vi} from 'vitest';
import {createContentRunSummary} from '../src/spaces/presentation.js';
function fixture(state='queued',taskStatus='queued'){
 const sha='a'.repeat(64);
 const native={id:'run',workflowId:'creation.content',workflowRevision:'content-v2',state,output:undefined as unknown};
 const ref={id:'draft',type:'content-draft',schemaVersion:'v1',sha256:sha,producedBy:{workflowRunId:'run'}};
 const asset={id:'asset-draft',spaceId:'space',payloadHash:sha,schema:{namespace:'creation/content-draft',revision:'1'},source:{kind:'node',runId:'run'}};
 const ledger={getRun:vi.fn(async()=>native),getArtifact:vi.fn(async()=>ref),listArtifacts:vi.fn(),listEvents:vi.fn()};
 const service={runtimeEvidence:vi.fn(async()=>ledger),resolveRuntimeArtifact:vi.fn(async()=>asset),getExecutionTask:vi.fn(async()=>({status:taskStatus}))};
 const input={spaceId:'space',run:{runId:'run',spaceId:'space',workflowVersionId:'version',entrypoint:'content'},version:{id:'version',spaceId:'space',entrypoints:{content:{workflowId:'creation.content',codeRevision:'content-v2'}}},case:{id:'case',spaceId:'space'}};
 return {native,ref,asset,ledger,service,input,summary:()=>createContentRunSummary(service as never)(input as never)};
}
describe('CONTENT narrow run summary',()=>{
 it('distinguishes a saved queued task from admitted initialization',async()=>{
  const waiting=fixture();expect((await waiting.summary()).progress).toBe('等待派发');
  const admitted=fixture('queued','running');expect((await admitted.summary()).progress).toBe('已派发，准备执行');
  expect(waiting.ledger.listArtifacts).not.toHaveBeenCalled();expect(waiting.ledger.listEvents).not.toHaveBeenCalled();
  expect(waiting.ledger.getArtifact).not.toHaveBeenCalled();expect(waiting.service.resolveRuntimeArtifact).not.toHaveBeenCalled();
 });
 it('resolves only the exact terminal receipt and preserves unaccepted outcome',async()=>{
  const f=fixture('needs_review','completed');f.native.output={ok:false,state:'needs_review',details:{reason:'not-converged',draft:{id:f.ref.id,sha256:f.ref.sha256}}};
  expect(await f.summary()).toMatchObject({state:'needs_review',reason:'not-converged',progress:'自动改稿次数用尽，尚未收敛',primaryAssetVersionId:'asset-draft'});
  expect(f.ledger.getArtifact).toHaveBeenCalledExactlyOnceWith('draft');expect(f.ledger.listArtifacts).not.toHaveBeenCalled();expect(f.ledger.listEvents).not.toHaveBeenCalled();
 });
 it.each(['run','hash','schema','artifact-schema'] as const)('rejects inconsistent terminal %s identity',async failure=>{
  const f=fixture('needs_review','completed');f.native.output={ok:false,state:'needs_review',details:{draft:{id:f.ref.id,sha256:f.ref.sha256}}};
  if(failure==='run')f.asset.source.runId='other';if(failure==='hash')f.asset.payloadHash='wrong';
  if(failure==='schema')f.asset.schema.namespace='creation/content-research';if(failure==='artifact-schema')f.ref.schemaVersion='v2';
  await expect(f.summary()).rejects.toThrow(/inconsistent/);
 });
});
