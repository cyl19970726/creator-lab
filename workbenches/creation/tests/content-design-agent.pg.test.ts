import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createBusinessUnderstandingStore,type SpacePrincipal} from '@signal-room/workflow-spaces';
import {openContentDesignHost} from '../src/spaces/content-design-host.js';

const databaseUrl=process.env.WORKFLOW_TEST_DATABASE_URL;
const integration=databaseUrl?it:it.skip;
const schema=`method_design_agent_${randomUUID().replaceAll('-','')}`;
let admin:Pool;let host:Awaited<ReturnType<typeof openContentDesignHost>>;
let previousDatabase:string|undefined;let previousConfig:string|undefined;let previousPrincipal:string|undefined;

beforeAll(async()=>{
  if(!databaseUrl)return;
  admin=new Pool({connectionString:databaseUrl});
  await admin.query(`CREATE SCHEMA ${schema}`);
  previousDatabase=process.env.WORKFLOW_DATABASE_URL;
  previousConfig=process.env.CONTENT_WORKBENCH_CONFIG;
  previousPrincipal=process.env.WORKFLOW_SPACE_PRINCIPAL;
  const isolated=new URL(databaseUrl);
  isolated.searchParams.set('options',`-csearch_path=${schema}`);
  process.env.WORKFLOW_DATABASE_URL=isolated.toString();
  process.env.CONTENT_WORKBENCH_CONFIG='/nonexistent/method-design-agent-test-config.json';
  process.env.WORKFLOW_SPACE_PRINCIPAL='method-design-test-owner';
  host=await openContentDesignHost({probeExecution:false});
  await host.setup({migrate:true});
},120_000);

afterAll(async()=>{
  if(host)await host.pool.end();
  if(admin){await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
  if(previousDatabase===undefined)delete process.env.WORKFLOW_DATABASE_URL;else process.env.WORKFLOW_DATABASE_URL=previousDatabase;
  if(previousConfig===undefined)delete process.env.CONTENT_WORKBENCH_CONFIG;else process.env.CONTENT_WORKBENCH_CONFIG=previousConfig;
  if(previousPrincipal===undefined)delete process.env.WORKFLOW_SPACE_PRINCIPAL;else process.env.WORKFLOW_SPACE_PRINCIPAL=previousPrincipal;
});

integration('trusted design Agent publishes its own exact first draft through the scoped host, preserving history and no adoption/run',async()=>{
  const owner=host.service,spaceId=host.spaceId;
  const understanding=await createBusinessUnderstandingStore(owner).save(spaceId,{
    expectedRevisionId:null,idempotencyKey:'understanding-test',title:'Test basis',content:'# Test basis\n',
    sources:[{kind:'document',ref:'test:source',title:'Fixture'}],authorship:{kind:'human',name:'Test owner'},changeReason:'Fixture'});
  const humanInput={workflowId:'content.first-method',entrypoint:'content',
    understanding:{revisionId:understanding.id,payloadHash:understanding.payloadHash},
    title:'Human draft',content:'# Human draft\n',sources:[{kind:'document' as const,ref:'test:source',title:'Fixture'}],
    authorship:{kind:'human' as const,name:'Test owner'},changeReason:'Fixture',expectedRevisionId:null,idempotencyKey:'human-design-test'};
  const ownerDesign=host.methodDesign;
  const human=await ownerDesign.save(spaceId,humanInput);
  const principal:SpacePrincipal={id:'external-agent:thread-test-1',kind:'service',
    externalAgent:{id:'design-agent',sessionId:'thread-test-1',role:'design'}};
  await owner.grant(spaceId,principal.id,'operator');
  const design=host.hostFor(principal).methodDesign!;
  const agent=await design.save!(spaceId,{...humanInput,title:'Agent design',content:'# Agent design\n',
    authorship:{kind:'agent',name:'design-agent',sessionId:'thread-test-1'},
    expectedRevisionId:human.id,idempotencyKey:'agent-design-test'});
  expect(agent).toMatchObject({previousRevisionId:human.id,recordedBy:principal.id,confirmation:'unconfirmed'});
  const observer=host.hostFor({...principal,externalAgent:{...principal.externalAgent!,role:'observer'}}).methodDesign!;
  expect(observer.save).toBeUndefined();expect(observer.publish).toBeUndefined();
  await expect(design.publish!(spaceId,{designRevisionId:human.id,expectedCandidateId:'anything'})).rejects.toThrow('does not belong');
  const preview=await design.preview!(spaceId,agent.id);
  const receipt=await design.publish!(spaceId,{designRevisionId:agent.id,expectedCandidateId:preview.versionId});
  expect(receipt).toEqual({versionId:preview.versionId,designRevisionId:agent.id,understandingRevisionId:understanding.id});
  expect(await design.publish!(spaceId,{designRevisionId:agent.id,expectedCandidateId:preview.versionId})).toEqual(receipt);
  expect((await ownerDesign.history(spaceId)).map(revision=>revision.id)).toEqual([human.id,agent.id]);
  expect((await ownerDesign.read(spaceId,human.id)).payloadHash).toBe(human.payloadHash);
  const overview=await owner.overview(spaceId);
  expect(overview.workflows.map(version=>version.id)).toEqual([preview.versionId]);
  expect(overview.runs).toHaveLength(0);expect(overview.adoptions).toHaveLength(0);
  const next=await design.save!(spaceId,{...humanInput,title:'Another first draft',content:'# Another first draft\n',
    authorship:{kind:'agent',name:'design-agent',sessionId:'thread-test-1'},
    expectedRevisionId:agent.id,idempotencyKey:'next-design-test'});
  const nextPreview=await design.preview!(spaceId,next.id);
  expect(nextPreview.versionId).not.toBe(preview.versionId);
  await expect(design.publish!(spaceId,{designRevisionId:next.id,expectedCandidateId:nextPreview.versionId}))
    .rejects.toThrow('already has a first method version');
  expect((await owner.overview(spaceId)).workflows.map(version=>version.id)).toEqual([preview.versionId]);
},120_000);
