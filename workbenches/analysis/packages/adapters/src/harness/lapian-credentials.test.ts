import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionDesignWorkbenchCredential } from '@signal-room/workflow-space-api/workbench-credentials';
import { implementationCredentialFile, observerCredentialFile, provisionLapianObserverCredential,
  readLapianCredentials, OBSERVER_AGENT_ID, OBSERVER_SESSION_ID } from '../../../../scripts/lapian-credentials.js';

const temporary:string[]=[];
afterEach(()=>{for(const dir of temporary.splice(0))rmSync(dir,{recursive:true,force:true});});

async function fixture(){
 const runtime=mkdtempSync(join(tmpdir(),'lapian-credentials-'));temporary.push(runtime);
 const original=await provisionDesignWorkbenchCredential(implementationCredentialFile(runtime),{
  agentId:'lapian-implementation',sessionId:'lapian-harness-20261014',spaceIds:['space-1'],role:'design'});
 return {runtime,original,originalBytes:readFileSync(implementationCredentialFile(runtime),'utf8')};
}

describe('independent lapian observer credential',()=>{
 it('preserves the implementation credential and provisions one private, repeatable observer identity',async()=>{
  const {runtime,original,originalBytes}=await fixture();
  expect(await readLapianCredentials(runtime,'space-1')).toEqual([original]);
  const observer=await provisionLapianObserverCredential(runtime,'space-1');
  expect(observer.principal).toEqual({id:`external-agent:${OBSERVER_SESSION_ID}`,kind:'service',
   externalAgent:{id:OBSERVER_AGENT_ID,sessionId:OBSERVER_SESSION_ID,role:'observer'}});
  expect(observer.spaceIds).toEqual(['space-1']);
  expect(statSync(observerCredentialFile(runtime)).mode&0o777).toBe(0o600);
  expect(await provisionLapianObserverCredential(runtime,'space-1')).toEqual(observer);
  expect(await readLapianCredentials(runtime,'space-1')).toEqual([original,observer]);
  expect(readFileSync(implementationCredentialFile(runtime),'utf8')).toBe(originalBytes);
 });

 it('rejects an invalid or cross-Space observer file instead of silently serving the design identity alone',async()=>{
  const {runtime}=await fixture();
  await provisionLapianObserverCredential(runtime,'space-1');
  await expect(readLapianCredentials(runtime,'other-space')).rejects.toThrow('implementation Agent credential');
  const file=observerCredentialFile(runtime);
  const altered=JSON.parse(readFileSync(file,'utf8'));
  altered.principal.externalAgent.role='design';
  const {writeFileSync}=await import('node:fs');writeFileSync(file,JSON.stringify(altered),{mode:0o600});
  await expect(readLapianCredentials(runtime,'space-1')).rejects.toThrow('observer Agent credential invalid');
 });
});
