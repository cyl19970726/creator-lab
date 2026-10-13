import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {readFile,lstat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {Pool} from 'pg';
import {WorkflowSpaceService,createExternalAgentObservationStore,createRunDispositionStore,
  createRunDiagnosisStore,type SpacePrincipal} from '@signal-room/workflow-spaces';
import {createDesignWorkbench} from '@signal-room/workflow-space-api/design-workbench';
import {readDesignWorkbenchCredential,provisionDesignWorkbenchCredential} from '@signal-room/workflow-space-api/workbench-credentials';
import {openConfiguredContentBlobs} from '../src/spaces/blob-configuration.js';
import {createExplanatoryMethodDesignHost} from '../src/spaces/explanatory-method-design-host.js';
import {createExplanatoryMethodExecutionHost,type ExplanatoryMethodExecutionHostOptions} from '../src/spaces/explanatory-method-execution-host.js';
import {createExplanatoryMethodEvaluationHost} from '../src/spaces/explanatory-method-evaluation-host.js';
import {SiwcAuth} from '@signal-room/workflow-agent-sdk';
import {explanatoryMethodAssetReaders,explanatoryMethodPresentationOptions} from '../src/spaces/explanatory-method-readers.js';
import {createContentBusinessAdapter} from '../src/spaces/presentation.js';

const {values,positionals}=parseArgs({allowPositionals:true,options:{
  help:{type:'boolean'},'config-file':{type:'string'},'credential-file':{type:'string',multiple:true},
  'agent-id':{type:'string'},'agent-session':{type:'string'},'space-id':{type:'string',multiple:true},
  'allow-space':{type:'string',multiple:true},port:{type:'string'},role:{type:'string'},
}});
const command=positionals[0]??'serve';
if(values.help){
  console.log(`Blank design Space host
  setup-agent --agent-id ID --agent-session SESSION_ID --space-id SPACE_ID --credential-file ABSOLUTE_PATH [--role design|observer]
  setup-evaluation --config-file ABSOLUTE_PATH --space-id SPACE_ID
  serve --config-file ABSOLUTE_PATH --credential-file ABSOLUTE_PATH --allow-space SPACE_ID [--port 4400]

Repeat --space-id, --credential-file and --allow-space for explicit additional scopes.
The private runtime config supplies only databaseUrl and human principal. Serve checks an already initialized harness;
it does not migrate, create a Space, register schemas or methods, or start workflows.
Execution commands require the explicit private runtime setting enableExplanatoryExecution=true.
Create an empty Space through the authenticated operator CLI after serve starts.`);
  process.exit(0);
}
if(positionals.length>1||!['setup-agent','setup-evaluation','serve'].includes(command))throw new Error('Unknown blank design host command');
const required=(value:string|undefined,label:string)=>{if(!value?.trim())throw new Error(`${label} is required`);return value;};
const privatePath=async(path:string,label:string)=>{
  if(!isAbsolute(path))throw new Error(`${label} must be an absolute private file path`);
  const info=await lstat(path);
  if(!info.isFile()||(info.mode&0o077)!==0)throw new Error(`${label} must be a private regular file`);
  return path;
};
const readRuntimeConfig=async()=>{
  const configPath=await privatePath(required(values['config-file'],'--config-file'),'Runtime configuration');
  let config:Record<string,unknown>;
  try{config=JSON.parse(await readFile(configPath,'utf8')) as Record<string,unknown>;}
  catch{throw new Error('Invalid private design host configuration');}
  if(!config||typeof config!=='object'||Array.isArray(config)||typeof config.databaseUrl!=='string'||!config.databaseUrl.trim()||
    typeof config.principal!=='string'||!config.principal.trim())throw new Error('Private runtime configuration requires databaseUrl and human principal');
  if(config.enableExplanatoryExecution!==undefined&&typeof config.enableExplanatoryExecution!=='boolean')
    throw new Error('enableExplanatoryExecution must be an explicit boolean');
  return config as Record<string,unknown>&{databaseUrl:string;principal:string};
};
const credentialPaths=values['credential-file']??[];
if(command==='setup-agent'){
  if(credentialPaths.length!==1)throw new Error('setup-agent requires exactly one --credential-file');
  const role=values.role??'design';
  if(role!=='design'&&role!=='observer')throw new Error('--role must be design or observer');
  const spaceIds=values['space-id']??[];
  if(!spaceIds.length)throw new Error('--space-id is required');
  const credential=await provisionDesignWorkbenchCredential(credentialPaths[0]!,{
    agentId:required(values['agent-id'],'--agent-id'),sessionId:required(values['agent-session'],'--agent-session'),
    spaceIds,role,
  });
  console.log(JSON.stringify({credentialFile:credentialPaths[0],principal:credential.principal,spaceIds:credential.spaceIds,
    note:'Host identity prepared; no Space or business records have been created.'},null,2));
}else if(command==='setup-evaluation'){
  const spaceIds=values['space-id']??[];
  if(spaceIds.length!==1)throw new Error('setup-evaluation requires exactly one --space-id');
  const spaceId=required(spaceIds[0],'--space-id');
  const config=await readRuntimeConfig();
  const pool=new Pool({connectionString:config.databaseUrl,application_name:'workflow-design-evaluation-setup',max:2});
  try{
    const {blobs}=await openConfiguredContentBlobs(pool);
    const service=new WorkflowSpaceService(pool,blobs,{id:config.principal,kind:'human'},
      explanatoryMethodPresentationOptions);
    const space=(await service.listSpaces()).find(value=>value.id===spaceId);
    if(!space||space.designScope?.workflowId!=='content.explanatory-method'||space.designScope.entrypoint!=='content')
      throw new Error('Evaluation setup requires an existing explanatory design Space');
    const observation=await createExternalAgentObservationStore(service).ensure(spaceId);
    const disposition=await createRunDispositionStore(service).ensure(spaceId);
    const diagnosis=await createRunDiagnosisStore(service).ensure(spaceId);
    console.log(JSON.stringify({spaceId,schemas:{observation,disposition,diagnosis},
      note:'Existing technical schemas registered explicitly; no evaluation, Case or run records created.'},null,2));
  }finally{await pool.end();}
}else{
  const allowedSpaceIds=values['allow-space']??[];
  if(!allowedSpaceIds.length||new Set(allowedSpaceIds).size!==allowedSpaceIds.length)throw new Error('Explicit unique --allow-space values are required');
  if(!credentialPaths.length)throw new Error('--credential-file is required');
  const port=Number(values.port??4400);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid design workbench port');
  const config=await readRuntimeConfig();
  const credentials=[];
  for(const path of credentialPaths){
    const credential=await readDesignWorkbenchCredential(path);
    if(!credential)throw new Error('Configured design credential file is missing');
    credentials.push(credential);
  }
  const pool=new Pool({connectionString:config.databaseUrl,application_name:'workflow-blank-design-workbench',max:8});
  let serving=false;
  try{
    const initialized=await pool.query<{spaces:string|null;schemas:string|null;commits:string|null}>(
      "SELECT to_regclass('public.ws_spaces')::text AS spaces,to_regclass('public.ws_schemas')::text AS schemas,to_regclass('public.ws_commits')::text AS commits");
    if(!initialized.rows[0]?.spaces||!initialized.rows[0]?.schemas||!initialized.rows[0]?.commits)
      throw new Error('Initialize the shared PostgreSQL harness explicitly before serving');
    const {blobs}=await openConfiguredContentBlobs(pool);
    const ownerPrincipal:SpacePrincipal={id:config.principal,kind:'human'};
    const serviceFor=(principal:SpacePrincipal)=>new WorkflowSpaceService(pool,blobs,principal,
      explanatoryMethodPresentationOptions);
    const publicOrigin=`http://127.0.0.1:${port}`;
    const executionCache:NonNullable<ExplanatoryMethodExecutionHostOptions['executorCache']>=new Map();
    const auth=new SiwcAuth();
    let stopExecutions:(()=>Promise<void>)|undefined;
    const withLock=async<T>(namespace:number,keyText:string,work:()=>Promise<T>):Promise<T>=>{
      const client=await pool.connect();
      const key=createHash('sha256').update(keyText).digest().readInt32BE(0);
      try{
        await client.query('SELECT pg_advisory_lock($1,$2)',[namespace,key]);
        return await work();
      }finally{
        try{await client.query('SELECT pg_advisory_unlock($1,$2)',[namespace,key]);}
        finally{client.release();}
      }
    };
    const server=createDesignWorkbench({ownerService:serviceFor(ownerPrincipal),serviceFor,ownerPrincipal,
      credentials:credentials.map(({token,principal,spaceIds})=>({token,principal,spaceIds})),allowedSpaceIds,
      webRoot:fileURLToPath(new URL('../apps/space-workbench/web/dist/',import.meta.url)),publicOrigin,
      methodHostFor:input=>{
        if(input.scope.workflowId!=='content.explanatory-method'||input.scope.entrypoint!=='content')return {};
        const withPublicationLock=<T>(work:()=>Promise<T>)=>withLock(0x4558504c,input.spaceId,work);
        const design=createExplanatoryMethodDesignHost({...input,withPublicationLock});
        const execution=createExplanatoryMethodExecutionHost({...input,auth,executorCache:executionCache,
          withPublicationLock,withCaseLock:(caseId,work)=>withLock(0x45585043,`${input.spaceId}\0${caseId}`,work)});
        stopExecutions??=execution.stop;
        const availability=async(versionId:string)=>{
          if(config.enableExplanatoryExecution!==true)
            return {state:'unavailable' as const,reason:'本 Space 的执行入口尚未开放'};
          const status=await execution.methodExecution!.status(input.spaceId);
          const versions=Array.isArray(status.versions)?status.versions:[];
          const version=versions.find((value:unknown):value is Record<string,unknown>=>
            !!value&&typeof value==='object'&&!Array.isArray(value)&&
            (value as Record<string,unknown>).workflowVersionId===versionId);
          const readiness=version?.availability;
          if(!readiness||typeof readiness!=='object'||Array.isArray(readiness))
            return {state:'unavailable' as const,reason:'宿主未部署这个准确的方法版本'};
          const value=readiness as Record<string,unknown>;
          return {state:value.available===true?'available' as const:'unavailable' as const,
            reason:value.available===true?null:typeof value.reason==='string'?value.reason:'这个方法版本尚未满足执行条件'};
        };
        const evaluation=createExplanatoryMethodEvaluationHost({service:input.service,spaceId:input.spaceId});
        const runExecutionMode=async({spaceId,runId}:{spaceId:string;runId:string})=>{
          if(spaceId!==input.spaceId)throw new Error('Run mode belongs to another Space');
          const binding=await input.service.readRun(spaceId,runId);
          const native=await (await input.service.runtimeEvidence(spaceId)).getRun(runId);
          if(!native)return null;
          if(native.id!==runId)throw new Error('Run mode native identity mismatch');
          const mode=native.metadata?.executionMode;
          if(typeof mode!=='string')return null;
          if(native.metadata?.spaceId!==spaceId||native.metadata?.caseId!==binding.caseId||
            native.metadata?.workflowVersionId!==binding.workflowVersionId)
            throw new Error('Run mode frozen scope mismatch');
          return mode;
        };
        return {...design,...evaluation,runExecutionMode,readers:explanatoryMethodAssetReaders,adapter:createContentBusinessAdapter(input.service),availability,
          methodExecution:{status:execution.methodExecution!.status,
          ...(config.enableExplanatoryExecution===true&&execution.methodExecution!.command
            ?{command:execution.methodExecution!.command}:{})}};
      }});
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
    serving=true;
    console.log(`Blank design Space workbench: ${publicOrigin}/space-workbench`);
    let closing=false;
    const stop=async()=>{
      if(closing)return;closing=true;
      await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeIdleConnections();});
      await stopExecutions?.();
      await pool.end();
    };
    process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
  }finally{if(!serving)await pool.end();}
}
