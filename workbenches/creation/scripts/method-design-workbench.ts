import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {createSpaceWorkbenchApp} from '../apps/space-workbench/app.js';
import {openContentDesignHost} from '../src/spaces/content-design-host.js';
import {readExternalAgentCredential,provisionExternalAgentCredential} from '../src/spaces/external-agent-credential.js';

const {values,positionals}=parseArgs({allowPositionals:true,options:{
  help:{type:'boolean'},migrate:{type:'boolean'},design:{type:'string'},'expected-candidate':{type:'string'},
  'agent-id':{type:'string'},'agent-session':{type:'string'},'credential-file':{type:'string'},
  role:{type:'string'},
}});
const command=positionals[0]??'serve';
if(values.help){
  console.log(`Independent first-method Space workbench
  setup [--migrate]                          explicit Space and schema setup; migrations only when requested
  setup-agent --agent-id ID --agent-session CODEX_THREAD_ID [--role observer|design] [--credential-file ABSOLUTE_PATH]
                                             provision an independent Agent credential; default observer; no run
  serve                                      local workbench on 127.0.0.1:4398; no run on startup
  status                                     read-only Space and design status
  preview --design REVISION_ID               read-only exact candidate
  publish --design REVISION_ID --expected-candidate VERSION_ID

Publication records only this Space's first method version. Execution requires the exact Case release and an explicit frontend start.`);
  await new Promise<void>(resolve=>process.stdout.write('',()=>resolve()));
  process.exit(0);
}
if(!['setup','setup-agent','serve','status','preview','publish'].includes(command))throw new Error(`Unknown command: ${command}`);
const required=(name:'design'|'expected-candidate'):string=>{
  const value=values[name];if(!value?.trim())throw new Error(`--${name} is required`);return value;
};
const credentialPath=values['credential-file']??process.env.METHOD_DESIGN_AGENT_CREDENTIAL_FILE??fileURLToPath(new URL('../../../.local/content-space/design-agent-credential.json',import.meta.url));
const host=await openContentDesignHost({probeExecution:!['setup','setup-agent'].includes(command)});
const emit=(value:unknown)=>console.log(JSON.stringify(value,null,2));
let serving=false;
try{
  if(command==='setup')emit(await host.setup({migrate:values.migrate===true}));
  else if(command==='setup-agent'){
    await host.assertInitialized();
    if(!values['agent-id']||!values['agent-session'])throw new Error('--agent-id and --agent-session are required');
    if(values.role!==undefined&&values.role!=='observer'&&values.role!=='design')throw new Error('--role must be observer or design');
    const credential=await provisionExternalAgentCredential(resolve(credentialPath),host.spaceId,values['agent-id'],values['agent-session'],values.role??'observer');
    await host.service.grant(host.spaceId,credential.principal.id,'operator');
    emit({spaceId:host.spaceId,credentialFile:resolve(credentialPath),principal:credential.principal,role:'operator',note:'Host-provisioned Agent identity; no workflow execution or user acceptance'});
  }
  else{
    await host.assertInitialized();
    if(command==='status'){
      const [overview,design,understanding]=await Promise.all([
        host.service.overview(host.spaceId),host.methodDesign.current(host.spaceId),
        host.hostFor(host.principal).understanding!.current(host.spaceId),
      ]);
      emit({spaceId:host.spaceId,workflowVersions:overview.workflows.map(value=>({id:value.id,revision:value.revision})),
        currentDesignRevisionId:design?.id??null,currentUnderstandingRevisionId:understanding?.id??null,
        executableDeployment:host.executionAvailability});
    }else if(command==='preview')emit(await host.methodDesign.preview(host.spaceId,required('design')));
    else if(command==='publish')emit(await host.methodDesign.publish(host.spaceId,{
      designRevisionId:required('design'),expectedCandidateId:required('expected-candidate')}));
    else{
      const port=Number(process.env.METHOD_DESIGN_WORKBENCH_PORT??4398);
      if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid method design workbench port');
      const publicOrigin=process.env.METHOD_DESIGN_WORKBENCH_ORIGIN??`http://127.0.0.1:${port}`;
      const agentCredential=await readExternalAgentCredential(resolve(credentialPath),host.spaceId);
      const additionalPaths:unknown=JSON.parse(process.env.METHOD_DESIGN_AGENT_CREDENTIAL_FILES??'[]');
      if(!Array.isArray(additionalPaths)||additionalPaths.some(path=>typeof path!=='string'))throw new Error('Invalid additional Agent credential paths');
      const agentCredentials=agentCredential?[agentCredential]:[];
      for(const path of additionalPaths as string[]){
        if(resolve(path)===resolve(credentialPath))continue;
        const credential=await readExternalAgentCredential(resolve(path),host.spaceId);
        if(!credential)throw new Error('Configured additional Agent credential is missing');
        agentCredentials.push(credential);
      }
      const server=createSpaceWorkbenchApp({spaceId:host.spaceId,principal:host.principal,publicOrigin,
        webRoot:fileURLToPath(new URL('../apps/space-workbench/web/dist/',import.meta.url)),
        accessToken:process.env.METHOD_DESIGN_WORKBENCH_ACCESS_TOKEN,
        trustedLoopback:!process.env.METHOD_DESIGN_WORKBENCH_ACCESS_TOKEN,
        credentials:agentCredentials.map(({token,principal})=>({token,principal})),
        hostFor:host.hostFor});
      await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)});
      serving=true;
      console.log(`First-method design workbench: ${publicOrigin}/space-workbench/${encodeURIComponent(host.spaceId)}`);
      let closing=false;
      const stop=async()=>{
        if(closing)return;closing=true;
        await new Promise<void>(resolve=>server.close(()=>resolve()));
        await host.execution?.stop();
        await host.pool.end();
      };
      process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
    }
  }
}finally{if(!serving)await host.pool.end();}
