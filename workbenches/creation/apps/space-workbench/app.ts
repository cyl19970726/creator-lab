import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {createWorkflowSpaceApiHandler,type SpaceApiHost} from '@signal-room/workflow-space-api/server';
import type {SpacePrincipal} from '@signal-room/workflow-spaces';

interface SpaceAppOptions{
 spaceId:string;principal:SpacePrincipal;publicOrigin:string;webRoot:string;
 hostFor:(principal:SpacePrincipal)=>Omit<SpaceApiHost,'principal'|'cacheScope'>;
 /** Omit only for a trusted local owner server bound to 127.0.0.1. */
 accessToken?:string;trustedLoopback?:boolean;
}
const cookieName='creator_space_read_session';
const equal=(a:string,b:string)=>timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function createSpaceWorkbenchApp(options:SpaceAppOptions){
 const origin=new URL(options.publicOrigin);if(!['http:','https:'].includes(origin.protocol))throw new Error('Invalid public origin');
 if(!options.accessToken&&!options.trustedLoopback)throw new Error('An authenticated host or explicitly trusted loopback mode is required.');
 if(options.accessToken&&options.accessToken.length<24)throw new Error('Space access token must contain at least 24 characters.');
 const instance=randomBytes(24).toString('hex');
 const csrfSecret=randomBytes(32);
 const csrfFor=(scope:string)=>createHmac('sha256',csrfSecret).update(scope).digest('hex');
 const sessions=new Map<string,{expiresAt:number,scope:string}>();
 const failures=new Map<string,{count:number,expiresAt:number}>();
 const expectedHost=origin.host;
 function checkOrigin(request:IncomingMessage){
  if(request.headers.host!==expectedHost)throw Object.assign(new Error('请求地址与宿主不匹配'),{status:403});
  const peer=request.socket.remoteAddress;if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer??''))throw Object.assign(new Error('本工作台只允许本机连接'),{status:403});
  if(request.headers['sec-fetch-site']==='cross-site'||request.headers.origin&&request.headers.origin!==origin.origin)throw Object.assign(new Error('不接受跨站请求'),{status:403});
 }
 function authenticate(request:IncomingMessage):{principal:SpacePrincipal;cacheScope:string}|null{
  checkOrigin(request);
  if(!options.accessToken&&options.trustedLoopback)return {principal:options.principal,cacheScope:`${options.principal.id}:${instance}`};
  const bearer=request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  if(bearer&&options.accessToken&&equal(bearer,options.accessToken))return {principal:options.principal,cacheScope:`${options.principal.id}:${instance}:bearer`};
  const cookie=(request.headers.cookie??'').split(';').map(s=>s.trim()).find(s=>s.startsWith(`${cookieName}=`))?.slice(cookieName.length+1);
  const session=cookie?sessions.get(cookie):null;
  if(session&&session.expiresAt>Date.now())return {principal:options.principal,cacheScope:`${options.principal.id}:${session.scope}`};
  if(cookie)sessions.delete(cookie);return null;
 }
 const api=createWorkflowSpaceApiHandler({cursorSecret:randomBytes(32),resolveHost:async({request,spaceId})=>{
  const auth=authenticate(request);if(!auth)return null;
  // Service membership checks still enforce the authenticated principal's access to the requested Space.
  if(spaceId!==options.spaceId)return null;
  const host=options.hostFor(auth.principal);
  return {...host,...auth,...(host.commands||host.business?{commandSecurity:{origin:origin.origin,csrfToken:csrfFor(auth.cacheScope),verifyCsrf:(incoming:IncomingMessage)=>{
   const current=authenticate(incoming),provided=incoming.headers['x-space-csrf'];
   return !!current&&current.cacheScope===auth.cacheScope&&typeof provided==='string'&&equal(provided,csrfFor(current.cacheScope));
  }}}:{})};
 }});
 const json=(res:ServerResponse,status:number,body:unknown)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
 return createServer(async(request,response)=>{
  response.setHeader('X-Content-Type-Options','nosniff');response.setHeader('Referrer-Policy','same-origin');response.setHeader('Cache-Control','no-store');
  try{
   checkOrigin(request);
   const url=new URL(request.url??'/',origin);
   if(url.pathname==='/space-workbench/session'){
    if(request.method==='GET'){const auth=authenticate(request);json(response,200,{authenticated:!!auth,subject:auth?{id:auth.principal.id,cacheScope:auth.cacheScope}:null});return;}
    if(request.method==='DELETE'){
     if(request.headers.origin!==origin.origin){json(response,403,{error:{code:'forbidden',message:'登出需要同源请求'}});return;}
     const cookie=(request.headers.cookie??'').split(';').map(s=>s.trim()).find(s=>s.startsWith(`${cookieName}=`))?.slice(cookieName.length+1);if(cookie)sessions.delete(cookie);
     response.setHeader('Set-Cookie',`${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);json(response,200,{authenticated:false});return;
    }
    if(request.method==='POST'&&options.accessToken){
     if(request.headers.origin!==origin.origin){json(response,403,{error:{code:'forbidden',message:'登录需要同源请求'}});return;}
     const key=request.socket.remoteAddress??'unknown';const past=failures.get(key);if(past&&past.expiresAt>Date.now()&&past.count>=10){json(response,429,{error:{code:'rate_limited',message:'请稍后重试'}});return;}
     let body='';for await(const part of request){body+=part.toString();if(body.length>4096){json(response,413,{error:{code:'too_large',message:'请求过大'}});return;}}
     let token='';try{token=String(JSON.parse(body).token??'');}catch{token=new URLSearchParams(body).get('token')??'';}
     if(!equal(token,options.accessToken)){failures.set(key,{count:past&&past.expiresAt>Date.now()?past.count+1:1,expiresAt:Date.now()+60000});json(response,401,{error:{code:'unauthenticated',message:'访问口令不正确'}});return;}
     failures.delete(key);const sid=randomBytes(32).toString('hex');sessions.set(sid,{expiresAt:Date.now()+8*3600000,scope:randomBytes(16).toString('hex')});
     response.setHeader('Set-Cookie',`${cookieName}=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${origin.protocol==='https:'?'; Secure':''}`);
     if(request.headers['content-type']?.startsWith('application/x-www-form-urlencoded')){response.writeHead(303,{Location:`/space-workbench/${encodeURIComponent(options.spaceId)}`});response.end();}else json(response,200,{authenticated:true});return;
    }
    json(response,405,{error:{code:'method_not_allowed',message:'不支持此操作'}});return;
   }
   if(await api(request,response))return;
   if(!['GET','HEAD'].includes(request.method??'')){json(response,405,{error:{code:'read_only',message:'这个入口保持只读'}});return;}
   const auth=authenticate(request);
   if(url.pathname==='/space-workbench/login'){
    response.setHeader('Content-Type','text/html; charset=utf-8');response.end(`<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Space 登录</title><body style="font:16px system-ui;padding:40px;max-width:480px;margin:auto"><h1>内容 Space</h1><p>使用宿主配置的访问口令登录。</p><form method="post" action="/space-workbench/session"><label>访问口令 <input name="token" type="password" autocomplete="current-password" required></label><button>登录</button></form></body></html>`);return;
   }
   if(url.pathname==='/'||url.pathname==='/space-workbench'){response.writeHead(302,{Location:`/space-workbench/${encodeURIComponent(options.spaceId)}`});response.end();return;}
   if(!url.pathname.startsWith('/space-workbench/')){response.writeHead(404);response.end();return;}
   if(!auth){response.writeHead(302,{Location:'/space-workbench/login'});response.end();return;}
   const relative=decodeURIComponent(url.pathname.slice('/space-workbench/'.length));
   let file:string;
   if(relative.startsWith('assets/')){if(!/^assets\/[a-zA-Z0-9_.-]+$/.test(relative)){response.writeHead(404);response.end();return;}file=resolve(options.webRoot,relative);}
   else{if(relative!==options.spaceId&&!relative.startsWith(`${options.spaceId}/`)){response.writeHead(404);response.end();return;}file=resolve(options.webRoot,'index.html');}
   try{const bytes=await readFile(file);response.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8'} as Record<string,string>)[extname(file)]??'application/octet-stream');response.end(request.method==='HEAD'?undefined:bytes);}
   catch{response.writeHead(503);response.end(escape('前端资源未构建；请先运行 creation build。'));}
  }catch(error){const status=(error as {status?:number}).status??500;json(response,status,{error:{code:status===403?'forbidden':'host_error',message:status===500?'工作台服务暂不可用':(error as Error).message,requestId:randomBytes(8).toString('hex')}});}
 });
}
