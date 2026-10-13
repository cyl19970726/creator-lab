import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,rm,stat,chmod,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {provisionExternalAgentCredential,readExternalAgentCredential} from '../src/spaces/external-agent-credential.js';
const directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(path=>rm(path,{recursive:true,force:true})));});
async function path(){const directory=await mkdtemp(join(tmpdir(),'agent-credential-'));directories.push(directory);return join(directory,'credential.json');}
describe('trusted external Agent credential provisioning',()=>{
 it('creates a private credential, binds one actor/session and preserves it on repeated provisioning',async()=>{
  const file=await path();const credential=await provisionExternalAgentCredential(file,'space','cognition-root','thread-1');
  expect(credential.token).toMatch(/^[a-f0-9]{64}$/);
  expect(credential.principal).toEqual({id:'external-agent:thread-1',kind:'service',externalAgent:{id:'cognition-root',sessionId:'thread-1',role:'observer'}});
  expect((await stat(file)).mode&0o077).toBe(0);
  expect(await readExternalAgentCredential(file,'space')).toEqual(credential);
  expect(await provisionExternalAgentCredential(file,'space','cognition-root','thread-1')).toEqual(credential);
  await expect(provisionExternalAgentCredential(file,'space','other-agent','thread-1')).rejects.toThrow('another identity');
  await expect(provisionExternalAgentCredential(file,'space','cognition-root','thread-1','design')).rejects.toThrow('another role');
  await expect(readExternalAgentCredential(file,'other-space')).rejects.toThrow('Invalid Agent');
 });
 it('provisions an explicit design role and refuses silent downgrade',async()=>{
  const file=await path();const credential=await provisionExternalAgentCredential(file,'space','designer','thread-2','design');
  expect(credential.principal.externalAgent?.role).toBe('design');
  expect(await provisionExternalAgentCredential(file,'space','designer','thread-2','design')).toEqual(credential);
  await expect(provisionExternalAgentCredential(file,'space','designer','thread-2')).rejects.toThrow('another role');
 });
 it('defaults legacy credentials to observer and accepts an explicitly configured design role',async()=>{
  const file=await path();const credential=await provisionExternalAgentCredential(file,'space','agent','thread');
  const legacy={...credential,principal:{...credential.principal,externalAgent:{id:'agent',sessionId:'thread'}}};
  await writeFile(file,JSON.stringify(legacy),{mode:0o600});
  expect((await readExternalAgentCredential(file,'space'))?.principal.externalAgent?.role).toBe('observer');
  const design={...legacy,principal:{...legacy.principal,externalAgent:{...legacy.principal.externalAgent,role:'design'}}};
  await writeFile(file,JSON.stringify(design),{mode:0o600});
  expect((await readExternalAgentCredential(file,'space'))?.principal.externalAgent?.role).toBe('design');
  await writeFile(file,JSON.stringify({...design,principal:{...design.principal,externalAgent:{...design.principal.externalAgent,role:'owner'}}}),{mode:0o600});
  await expect(readExternalAgentCredential(file,'space')).rejects.toThrow('Invalid Agent');
 });
 it('refuses public files and human credentials instead of treating them as Agent identities',async()=>{
  const file=await path();await provisionExternalAgentCredential(file,'space','agent','thread');await chmod(file,0o644);
  await expect(readExternalAgentCredential(file,'space')).rejects.toThrow('private file');
  await chmod(file,0o600);await writeFile(file,JSON.stringify({version:1,spaceId:'space',token:'x'.repeat(64),principal:{id:'owner',kind:'human',externalAgent:{id:'agent',sessionId:'thread'}}}));
  await expect(readExternalAgentCredential(file,'space')).rejects.toThrow('Invalid Agent');
 });
});
