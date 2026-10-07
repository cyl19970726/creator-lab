import {afterEach,describe,expect,it,vi} from 'vitest';
import {request,type Server} from 'node:http';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createSpaceWorkbenchApp} from '../apps/space-workbench/app.js';
import type {SpaceApiHost} from '@signal-room/workflow-space-api/server';

const origin='http://127.0.0.1:4397';
const token='test-only-read-token-with-enough-entropy';
const servers:Server[]=[];
const directories:string[]=[];
afterEach(async()=>{await Promise.all(servers.splice(0).map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));await Promise.all(directories.splice(0).map(directory=>rm(directory,{recursive:true,force:true})));});
async function fixture(accessToken:string|null=token,commandHost?:Omit<SpaceApiHost,'principal'|'cacheScope'>){
 const directory=await mkdtemp(join(tmpdir(),'space-host-'));directories.push(directory);
 await writeFile(join(directory,'index.html'),'<!doctype html><title>Real Space host test</title>');
 const hostFor=vi.fn(()=>commandHost??({service:{overview:vi.fn(async()=>{throw new Error('membership boundary');})},scope:{workflowId:'creation.content',entrypoint:'content'}} as unknown as Omit<SpaceApiHost,'principal'|'cacheScope'>));
 const server=createSpaceWorkbenchApp({spaceId:'creator-content',principal:{kind:'human',id:'member'},publicOrigin:origin,webRoot:directory,accessToken:accessToken??undefined,trustedLoopback:!accessToken,hostFor});servers.push(server);
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=(server.address() as {port:number}).port;
 return {hostFor,call:(path:string,method='GET',body='',headers:Record<string,string>={})=>new Promise<{status:number;headers:Record<string,string|string[]|undefined>;body:string}>((resolve,reject)=>{
  const req=request({host:'127.0.0.1',port,path,method,headers:{Host:'127.0.0.1:4397',...headers}},res=>{let text='';res.on('data',part=>text+=part);res.on('end',()=>resolve({status:res.statusCode!,headers:res.headers,body:text}));});req.on('error',reject);req.end(body);
 })};
}
describe('read-only Space host authentication',()=>{
 it('issues session-bound CSRF for ordinary business without plan commands',async()=>{
  const space={id:'creator-content',purpose:'fixture',status:'active',createdAt:'2026-01-01',owner:'member'};
  const service={listSpaces:async()=>[space],overview:async()=>({space,workflows:[],cases:[],runs:[],assets:[],reviews:[],comparisons:[],iterations:[],adoptions:[],sessions:[],knowledge:[]})};
  const prepare=vi.fn(async()=>{throw new Error('A fixture must never create a business');});
  const host=await fixture(null,{service,scope:{workflowId:'creation.content',entrypoint:'content'},business:{prepare}} as unknown as Omit<SpaceApiHost,'principal'|'cacheScope'>);
  const summary=JSON.parse((await host.call('/api/workflow-spaces/v1/spaces/creator-content/summary')).body);
  expect(summary.capabilities.write).toBe(true);
  expect(summary.csrfToken).toMatch(/^[a-f0-9]{64}$/);
  const path='/api/workflow-spaces/v1/spaces/creator-content/business/preparations';
  expect((await host.call(path,'POST','{}',{'Content-Type':'application/json',Origin:origin})).status).toBe(403);
  expect((await host.call(path,'POST','{}',{'Content-Type':'application/json',Origin:origin,'x-space-csrf':summary.csrfToken})).status).toBe(400);
  expect((await host.call(path,'POST','{}',{'Content-Type':'application/json',Origin:'http://other.example','x-space-csrf':summary.csrfToken})).status).toBe(403);
  expect(prepare).not.toHaveBeenCalled();
 });
 it('does not resolve a service before authentication, rejects writes and cross-site hosts',async()=>{
  const host=await fixture();
  expect((await host.call('/api/workflow-spaces/v1/spaces/creator-content/summary')).status).toBe(401);
  expect((await host.call('/api/workflow-spaces/v1/spaces/creator-content/summary','POST')).status).toBe(405);
  expect((await host.call('/space-workbench/creator-content','GET','',{Host:'attacker.example'})).status).toBe(403);
  expect((await host.call('/space-workbench/session','GET','',{'Sec-Fetch-Site':'cross-site'})).status).toBe(403);
  expect(host.hostFor).not.toHaveBeenCalled();
 });
 it('requires same-origin login, uses opaque cookies, invalidates them on logout and changes cache scope',async()=>{
  const host=await fixture();const login=()=>host.call('/space-workbench/session','POST',JSON.stringify({token}),{Origin:origin,'Content-Type':'application/json'});
  expect((await host.call('/space-workbench/session','POST',JSON.stringify({token}))).status).toBe(403);
  expect((await host.call('/space-workbench/session','POST',JSON.stringify({token:'wrong'}),{Origin:origin})).status).toBe(401);
  const first=await login();expect(first.status).toBe(200);
  const raw=first.headers['set-cookie'] as string[];expect(raw[0]).toContain('HttpOnly; SameSite=Strict');expect(raw[0]).not.toContain(token);
  const cookie=raw[0]!.split(';')[0]!;
  const session=await host.call('/space-workbench/session','GET','',{Cookie:cookie});const firstScope=JSON.parse(session.body).subject.cacheScope;
  expect(JSON.parse(session.body).authenticated).toBe(true);expect(session.body).not.toContain(token);
  expect((await host.call('/space-workbench/creator-content','GET','',{Cookie:cookie})).status).toBe(200);
  expect((await host.call('/space-workbench/session','DELETE','',{Origin:origin,Cookie:cookie})).status).toBe(200);
  expect(JSON.parse((await host.call('/space-workbench/session','GET','',{Cookie:cookie})).body).authenticated).toBe(false);
  const second=await login();const secondCookie=(second.headers['set-cookie'] as string[])[0]!.split(';')[0]!;
  expect(JSON.parse((await host.call('/space-workbench/session','GET','',{Cookie:secondCookie})).body).subject.cacheScope).not.toBe(firstScope);
 });
 it('serves only the configured Space and safe build assets in explicit trusted loopback mode',async()=>{
  const host=await fixture(null);
  expect((await host.call('/space-workbench/creator-content?run=exact')).status).toBe(200);
  expect((await host.call('/space-workbench/another-space')).status).toBe(404);
  expect((await host.call('/space-workbench/assets/%2e%2e%2fprivate.json')).status).toBe(404);
  expect((await host.call('/api/workflow-spaces/v1/spaces/another-space/summary')).status).toBe(401);
  expect((await host.call('/space-workbench/creator-content','DELETE')).status).toBe(405);
 });
 it('binds command CSRF to the authenticated login scope and rejects stale and foreign tokens',async()=>{
  const space={id:'creator-content',purpose:'fixture',status:'active',createdAt:'2026-01-01',owner:'member'};
  const service={listSpaces:async()=>[space],overview:async()=>({space,workflows:[],cases:[],runs:[],assets:[],reviews:[],comparisons:[],iterations:[],adoptions:[],sessions:[],knowledge:[]}),validationPlan:async()=>({status:'draft'})};
  const invoked=vi.fn(async()=>{throw new Error('A fixture must never dispatch');});
  const host=await fixture(token,{service,scope:{workflowId:'creation.content',entrypoint:'content'},commands:{entryActions:async()=>({start:false,resume:false,reason:'disabled',resumeTarget:null}),startPlanEntry:invoked,dispatchRun:invoked}} as unknown as Omit<SpaceApiHost,'principal'|'cacheScope'>);
  const login=async()=>{const response=await host.call('/space-workbench/session','POST',JSON.stringify({token}),{Origin:origin,'Content-Type':'application/json'});return (response.headers['set-cookie'] as string[])[0]!.split(';')[0]!;};
  const cookie=await login();
  const csrf=JSON.parse((await host.call('/api/workflow-spaces/v1/spaces/creator-content/summary','GET','',{Cookie:cookie})).body).csrfToken;
  expect(csrf).toMatch(/^[a-f0-9]{64}$/);expect(csrf).not.toBe(token);
  const path='/api/workflow-spaces/v1/spaces/creator-content/validation-plans/plan/entries/entry/attempts/1/start';
  const post=(session:string,nonce:string,source:string|undefined=origin)=>host.call(path,'POST',JSON.stringify({inputManifestId:'manifest'}),{Cookie:session,'Content-Type':'application/json','x-space-csrf':nonce,...(source?{Origin:source}:{})});
  expect((await post(cookie,csrf)).status).toBe(409); // Passed session checks, reached the frozen-plan guard.
  expect((await post(cookie,'foreign')).status).toBe(403);
  expect((await host.call(path,'POST','{}',{Cookie:cookie,'x-space-csrf':csrf,'Content-Type':'application/json'})).status).toBe(403);
  await host.call('/space-workbench/session','DELETE','',{Origin:origin,Cookie:cookie});
  const nextCookie=await login();
  expect((await post(nextCookie,csrf)).status).toBe(403);
  expect((await post(cookie,csrf)).status).toBe(401);
  expect(invoked).not.toHaveBeenCalled();
 });
});
