import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {Pool} from 'pg';
import {PostgresBlobStore,WorkflowSpaceService,type SpacePrincipal} from '@signal-room/workflow-spaces';
import {creationAssetReaders} from './readers.js';
import {createContentBusinessAdapter} from './presentation.js';
import {createContentProcessResolver} from './process.js';
/** Read-only assembly: no execution-host construction, runner dispatch, initialization, or migrations. */
export async function openContentReadHost(){
 const root=fileURLToPath(new URL('../../../../',import.meta.url));
 const configPath=resolve(process.env.CONTENT_WORKBENCH_CONFIG??`${root}/.local/content-space/runtime.json`);
 let config:{databaseUrl?:string;principal?:string;spaceId?:string}={};
 try{config=JSON.parse(await readFile(configPath,'utf8'));}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const databaseUrl=process.env.WORKFLOW_DATABASE_URL??config.databaseUrl;
 if(!databaseUrl)throw new Error('A private Workflow Space database connection is required.');
 const principal:SpacePrincipal={id:process.env.WORKFLOW_SPACE_PRINCIPAL??config.principal??'local-owner',kind:'human'};
 const spaceId=process.env.WORKFLOW_SPACE_ID??config.spaceId??'creator-content';
 // This is per-connection, not a change to database defaults. Accidental writes fail closed.
 const pool=new Pool({connectionString:databaseUrl,options:'-c default_transaction_read_only=on',application_name:'space-workbench-readonly'});
 const serviceFor=(requestPrincipal:SpacePrincipal)=>{
  let service:WorkflowSpaceService;
  service=new WorkflowSpaceService(pool,new PostgresBlobStore(pool),requestPrincipal,{readerIds:Object.keys(creationAssetReaders),resultRoleIds:['final-draft','research','cold-read','fact-check','editorial-review'],processResolvers:{'creation.content':input=>createContentProcessResolver(service)(input)}});
  return service;
 };
 const service=serviceFor(principal);
 try{if(!(await service.listSpaces()).some(s=>s.id===spaceId))throw new Error('Configured CONTENT Space is unavailable to this principal.');}
 catch(error){await pool.end();throw error;}
 return {pool,principal,spaceId,serviceFor,readers:creationAssetReaders,adapterFor:createContentBusinessAdapter};
}
