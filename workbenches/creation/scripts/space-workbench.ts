import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {createConnection} from 'node:net';
import {openContentReadHost} from '../src/spaces/content-read-host.js';
import {contentFrozenInputSummary} from '../src/spaces/readers.js';
import {createContentRunSummary} from '../src/spaces/presentation.js';
import type {ContentExecutionRelease} from '../src/spaces/content-plan-commands.js';
import {createContentBusinessCommands,createContentBusinessImportedAssetScope,type ContentBusinessExecutionRelease} from '../src/spaces/content-business-commands.js';
import {createSpaceWorkbenchApp} from '../apps/space-workbench/app.js';
const host=await openContentReadHost();
const port=Number(process.env.SPACE_WORKBENCH_PORT??4397);
const publicOrigin=process.env.SPACE_WORKBENCH_ORIGIN??`http://127.0.0.1:${port}`;
// Explicit assembly never migrates, publishes, enqueues or wakes a runner on startup.
const commandMode=process.env.SPACE_WORKBENCH_COMMANDS??'read-only';
if(!['read-only','plan','business','all'].includes(commandMode))throw new Error('Unknown Space command mode.');
const execution=commandMode!=='read-only'?await (await import('../src/spaces/content-host.js')).openContentHost(false):null;
if(execution&&(execution.spaceId!==host.spaceId||execution.principal.id!==host.principal.id||execution.principal.kind!==host.principal.kind))throw new Error('Read and command hosts must share the exact Space and authenticated principal.');
const catalog=new Set<string>();
if(execution){
 const current=await execution.workbench.preview(execution.spaceId);catalog.add(current.version.id);
 // Retained profiles are resolved by methodAvailability at the command boundary. The startup catalog is only a display hint.
 const overview=await execution.service.overview(execution.spaceId);
 for(const version of overview.workflows)if(version.entrypoints.content?.workflowId==='creation.content'&&
  (await execution.workbench.methodAvailability(execution.spaceId,version.id,'content')).available)catalog.add(version.id);
}
const releasePath=process.env.CONTENT_SPACE_EXECUTION_RELEASE??fileURLToPath(new URL('../../../.local/cognition-loop/space-production-b-20261007/execution-release.json',import.meta.url));
const isClosed=(targetPort:number)=>new Promise<boolean>(resolve=>{
 const socket=createConnection({host:'127.0.0.1',port:targetPort});let settled=false;
 const finish=(closed:boolean)=>{if(!settled){settled=true;socket.destroy();resolve(closed);}};
 socket.once('connect',()=>finish(false));socket.once('error',error=>finish((error as NodeJS.ErrnoException).code==='ECONNREFUSED'));socket.setTimeout(1500,()=>finish(false));
});
const commands=execution&&['plan','all'].includes(commandMode)?(await import('../src/spaces/content-plan-commands.js')).createContentPlanCommands({service:execution.service,workbench:execution.workbench,
 spaceId:execution.spaceId,principalId:execution.principal.id,models:execution.models,
 loadRelease:async()=>{try{return JSON.parse(await readFile(releasePath,'utf8')) as ContentExecutionRelease;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}},
 verifyExclusive:async release=>Array.isArray(release.exclusive.disabledPorts)&&release.exclusive.disabledPorts.includes(4394)&&
  (await Promise.all(release.exclusive.disabledPorts.map(isClosed))).every(Boolean),
}):undefined;
const businessReleasePath=process.env.CONTENT_BUSINESS_EXECUTION_RELEASE??fileURLToPath(new URL('../../../.local/cognition-loop/ordinary-content-20261007/execution-release.json',import.meta.url));
const businessOptions=execution&&['business','all'].includes(commandMode)?{
 service:execution.service,workbench:execution.workbench,spaceId:execution.spaceId,principalId:execution.principal.id,models:execution.models,
 loadRelease:async()=>{try{return JSON.parse(await readFile(businessReleasePath,'utf8')) as ContentBusinessExecutionRelease;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}},
 verifyExclusive:async(release:ContentBusinessExecutionRelease)=>{
  const ports=release.exclusive.disabledPorts;
  return Array.isArray(ports)&&[4393,4394,4396].every(value=>ports.includes(value))&&ports.every(value=>Number.isInteger(value)&&value>0&&value<=65535&&value!==port)&&
   (await Promise.all([...new Set(ports)].map(isClosed))).every(Boolean);
 },
}:null;
const business=businessOptions?createContentBusinessCommands(businessOptions):undefined;
const importedAssetScope=businessOptions?createContentBusinessImportedAssetScope(businessOptions):undefined;
const server=createSpaceWorkbenchApp({spaceId:host.spaceId,principal:host.principal,publicOrigin,webRoot:fileURLToPath(new URL('../apps/space-workbench/web/dist/',import.meta.url)),accessToken:process.env.SPACE_WORKBENCH_ACCESS_TOKEN,trustedLoopback:!process.env.SPACE_WORKBENCH_ACCESS_TOKEN,hostFor:principal=>{
 const service=host.serviceFor(principal);
 return {service,readers:host.readers,adapter:host.adapterFor(service),runSummary:createContentRunSummary(service),scope:{workflowId:'creation.content',entrypoint:'content'},displayTimeZone:'Asia/Taipei',inputSlotOrder:['opportunity','materials'],inputSummary:contentFrozenInputSummary,
  ...(commands?{commands}:{}),...(business?{business,importedAssetScope}:{}),availability:versionId=>execution?catalog.has(versionId)?{state:'available',reason:null}:{state:'unavailable',reason:'准确版本没有当前可执行部署。'}:{state:'unknown',reason:'本只读宿主未挂接执行器部署登记；可执行性需在执行宿主核验。'}};
}});
await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)});
console.log(`Real Space workbench (${execution?`explicit ${commandMode} commands; release gate enforced`:'read-only'}): ${publicOrigin}/space-workbench/${encodeURIComponent(host.spaceId)}`);
const stop=async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));await execution?.workbench.stop();await execution?.pool.end();await host.pool.end();};
process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
