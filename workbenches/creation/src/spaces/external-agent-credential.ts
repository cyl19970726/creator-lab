import {randomBytes} from 'node:crypto';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {dirname,isAbsolute} from 'node:path';
import type {SpacePrincipal} from '@signal-room/workflow-spaces';

export interface ExternalAgentCredential {
  version:1;spaceId:string;token:string;principal:SpacePrincipal;
}
const validId=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=240&&!/[\u0000-\u001f]/u.test(value);

/** Trusted host configuration, never an identity supplied by the browser or Agent tool. */
export async function readExternalAgentCredential(path:string,spaceId:string):Promise<ExternalAgentCredential|null>{
  if(!isAbsolute(path))throw new Error('Agent credential path must be absolute');
  let info:Awaited<ReturnType<typeof stat>>;
  try{info=await stat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  if(!info.isFile()||(info.mode&0o077)!==0)throw new Error('Agent credential must be a private file');
  let value:ExternalAgentCredential;
  try{value=JSON.parse(await readFile(path,'utf8')) as ExternalAgentCredential;}catch{throw new Error('Invalid Agent credential configuration');}
  const actor=value?.principal?.externalAgent;
  if(value?.version!==1||value.spaceId!==spaceId||typeof value.token!=='string'||value.token.length<32||
    value.principal?.kind!=='service'||!validId(value.principal.id)||!actor||!validId(actor.id)||!validId(actor.sessionId)||
    (actor.role!==undefined&&actor.role!=='design'&&actor.role!=='observer'))
    throw new Error('Invalid Agent credential configuration');
  return {...value,principal:{...value.principal,externalAgent:{...actor,role:actor.role??'observer'}}};
}

export async function provisionExternalAgentCredential(path:string,spaceId:string,agentId:string,sessionId:string,
  role:'observer'|'design'='observer'):Promise<ExternalAgentCredential>{
  if(!isAbsolute(path)||!validId(agentId)||!validId(sessionId)||!['observer','design'].includes(role))
    throw new Error('Invalid external Agent provisioning parameters');
  const previous=await readExternalAgentCredential(path,spaceId);
  if(previous){
    if(previous.principal.externalAgent!.id!==agentId||previous.principal.externalAgent!.sessionId!==sessionId)
      throw new Error('Existing Agent credential is bound to another identity or session');
    if(previous.principal.externalAgent!.role!==role)
      throw new Error('Existing Agent credential has another role; role changes require a separate trusted credential');
    return previous;
  }
  const credential:ExternalAgentCredential={version:1,spaceId,token:randomBytes(32).toString('hex'),
    principal:{id:`external-agent:${sessionId}`,kind:'service',externalAgent:{id:agentId,sessionId,role}}};
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  await writeFile(path,JSON.stringify(credential,null,2)+'\n',{mode:0o600,flag:'wx'});
  return credential;
}
