import fs from 'node:fs';
import path from 'node:path';
import {provisionDesignWorkbenchCredential,readDesignWorkbenchCredential,
  type DesignWorkbenchCredential} from '@signal-room/workflow-space-api/workbench-credentials';

const IMPLEMENTATION_AGENT_ID='lapian-implementation';
const IMPLEMENTATION_SESSION_ID='lapian-harness-20261014';
export const OBSERVER_AGENT_ID='lapian-cognition-owner';
export const OBSERVER_SESSION_ID='01a110bf-d315-7f32-afa5-1fb8baeed840';

export const implementationCredentialFile=(runtime:string)=>path.join(runtime,'agent.json');
export const observerCredentialFile=(runtime:string)=>path.join(runtime,'observer.json');

function exact(credential:DesignWorkbenchCredential|null,spaceId:string,agentId:string,sessionId:string,
 role:'design'|'observer'):credential is DesignWorkbenchCredential{
 return !!credential&&credential.spaceIds.length===1&&credential.spaceIds[0]===spaceId&&
  credential.principal.id===`external-agent:${sessionId}`&&credential.principal.kind==='service'&&
  credential.principal.externalAgent.id===agentId&&credential.principal.externalAgent.sessionId===sessionId&&
  credential.principal.externalAgent.role===role;
}

/** Keep the established design credential; a present but malformed observer file must fail closed. */
export async function readLapianCredentials(runtime:string,spaceId:string):Promise<DesignWorkbenchCredential[]>{
 const implementation=await readDesignWorkbenchCredential(implementationCredentialFile(runtime));
 if(!exact(implementation,spaceId,IMPLEMENTATION_AGENT_ID,IMPLEMENTATION_SESSION_ID,'design'))
  throw new Error('Private implementation Agent credential missing or invalid');
 const observerFile=observerCredentialFile(runtime);
 if(!fs.existsSync(observerFile))return [implementation];
 const observer=await readDesignWorkbenchCredential(observerFile);
 if(!exact(observer,spaceId,OBSERVER_AGENT_ID,OBSERVER_SESSION_ID,'observer'))
  throw new Error('Private observer Agent credential invalid');
 return [implementation,observer];
}

/** Explicit, idempotent local provision; the caller grants only this principal on an existing Space. */
export async function provisionLapianObserverCredential(runtime:string,spaceId:string){
 await readLapianCredentials(runtime,spaceId);
 return provisionDesignWorkbenchCredential(observerCredentialFile(runtime),{
  agentId:OBSERVER_AGENT_ID,sessionId:OBSERVER_SESSION_ID,spaceIds:[spaceId],role:'observer'});
}
