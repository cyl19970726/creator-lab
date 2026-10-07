import { describe, expect, it, vi } from 'vitest';
import { type WorkflowSpaceService } from '@signal-room/workflow-spaces';
import { createContentSiwcRunner } from '../src/spaces/content-runner.js';
import { objectSchema, stageAgent, str } from '../src/stages/runtime.js';

describe('CONTENT SIWC role adapter', () => {
  it('sends the actual role prompt and JSON schema, with only a bound read tool', async () => {
    let body: Record<string, unknown> | undefined;
    const service = {
      runtimeContexts: async () => [{ id: 'context-1', producer: 'agent', stepRunId: 'step-1', attemptId: 'attempt-1',
        inputs: { manuscript: {}, audienceProfile: {} } }],
      nodeClient: async () => ({ read: async (slot: string) => ({ assetVersionId: 'asset-1', stateAtBinding: 'imported',
        payloadHash: 'hash', schema: { namespace: 'test', revision: '1', hash: 'hash' }, viewVersion: 'full',
        deliveredHash: 'hash', payload: { slot } }) }),
    } as unknown as WorkflowSpaceService;
    const http = async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const completed = { type: 'response.completed', response: { id: 'response-1', output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"answer":"ok"}' }] },
      ] } };
      return new Response(`data: ${JSON.stringify(completed)}\n\n`, { status: 200,
        headers: { 'content-type': 'text/event-stream' } });
    };
    const runner = createContentSiwcRunner({ service, spaceId: 'space-1', auth: { accessToken: async () => 'secret' },
      fetch: http as typeof fetch });
    const schema = objectSchema({ answer: str });
    const definition = stageAgent<unknown, {answer: string}>({ id: 'content-author', title: '作者', guards: '',
      prompt: '写出清楚的答案', outputSchema: schema }, { model: 'test-model', reasoningEffort: 'low' }, 'test-v1');
    const events: string[] = [];
    const result = await runner.run({ runId: 'run-1', stepRunId: 'step-1', attemptId: 'attempt-1',
      definition, input: { subject: 'test' }, signal: new AbortController().signal,
      emit: async type => { events.push(type); } });
    expect(result.output).toEqual({ answer: 'ok' });
    expect(body?.instructions).toContain('写出清楚的答案');
    expect(body?.instructions).toContain(JSON.stringify(schema));
    expect(body?.store).toBe(false);
    expect(body?.stream).toBe(true);
    expect(body?.input).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'additional_tools',
      tools: [expect.objectContaining({ name: 'read_bound_asset', parameters: expect.objectContaining({
        properties: {slot: {type: 'string',enum: ['audienceProfile','manuscript'],description: 'Exact input slot bound to this attempt.'}}
      }) })] })]));
    expect(events).toContain('content.siwc.mapping');
  });

  it('lets the same scripted agent correct two denied slots and read its exact bound slot within the original budget',async()=>{
    const read=vi.fn(async(slot:string)=>({assetVersionId:'asset-1',stateAtBinding:'imported',payloadHash:'hash',
      schema:{namespace:'test',revision:'1',hash:'hash'},viewVersion:'full',deliveredHash:'hash',payload:{slot}}));
    const service={runtimeContexts:async()=>[
      {id:'unrelated',producer:'agent',stepRunId:'other-step',attemptId:'attempt-1',inputs:{decoy:{}}},
      {id:'context-1',producer:'agent',stepRunId:'step-1',attemptId:'attempt-1',inputs:{manuscript:{},audienceProfile:{}}},
    ],nodeClient:vi.fn(async()=>({read}))} as unknown as WorkflowSpaceService;
    const bodies:Record<string,unknown>[]=[];
    const http=async(_url:unknown,init?:RequestInit)=>{
      const body=JSON.parse(String(init?.body)) as Record<string,unknown>;bodies.push(body);
      const turn=bodies.length;
      const output=turn===1?[
        {type:'function_call',name:'read_bound_asset',call_id:'bad-profile',arguments:'{"slot":"profile"}'},
        {type:'function_call',name:'read_bound_asset',call_id:'bad-title',arguments:'{"slot":"title_cover_script"}'},
      ]
        :turn===2?[{type:'function_call',name:'read_bound_asset',call_id:'good',arguments:'{"slot":"manuscript"}'}]
        :[{type:'message',role:'assistant',content:[{type:'output_text',text:'{"answer":"ok"}'}]}];
      return new Response(`data: ${JSON.stringify({type:'response.completed',response:{id:`response-${turn}`,output}})}\n\n`,
        {status:200,headers:{'content-type':'text/event-stream'}});
    };
    const runner=createContentSiwcRunner({service,spaceId:'space-1',auth:{accessToken:async()=>'secret'},fetch:http as typeof fetch});
    const definition=stageAgent<unknown,{answer:string}>({id:'content-cold-reader',title:'冷读',guards:'',prompt:'按材料回答',
      outputSchema:objectSchema({answer:str})},{model:'test-model',reasoningEffort:'low'},'test-v1');
    const mapping:Record<string,unknown>[]=[];
    const events:string[]=[];
    const result=await runner.run({runId:'run-1',stepRunId:'step-1',attemptId:'attempt-1',definition,input:{title:'visible in prompt'},
      signal:new AbortController().signal,emit:async(type,data)=>{events.push(type);if(type==='content.siwc.mapping')mapping.push(data as Record<string,unknown>);}});
    expect(result.output).toEqual({answer:'ok'});
    expect(bodies).toHaveLength(3);
    expect(mapping[0]).toMatchObject({maxTurns:8,maxToolCalls:16});
    expect(result.metadata).toMatchObject({turns:3,toolCalls:3});
    expect(events.filter(type=>type==='siwc.tool_result')).toHaveLength(3);
    expect(events).not.toContain('siwc.tool_failed');
    const thirdInput=bodies[2]!.input as Record<string,unknown>[];
    expect(thirdInput).toEqual(expect.arrayContaining([
      expect.objectContaining({type:'function_call_output',call_id:'bad-profile',output:expect.stringContaining('UNBOUND_INPUT_SLOT')}),
      expect.objectContaining({type:'function_call_output',call_id:'bad-title',output:expect.stringContaining('UNBOUND_INPUT_SLOT')}),
      expect.objectContaining({type:'function_call_output',call_id:'good',output:expect.stringContaining('"payload"')}),
    ]));
    for(const callId of ['bad-profile','bad-title']){
      const result=thirdInput.find(item=>item.type==='function_call_output'&&item.call_id===callId);
      expect(JSON.parse(String(result?.output))).toEqual({ok:false,error:{code:'UNBOUND_INPUT_SLOT',
        message:'This input slot is not bound to the current attempt. Choose a slot from the tool schema.'}});
    }
    expect(read).toHaveBeenCalledExactlyOnceWith('manuscript');
    expect((service.nodeClient as ReturnType<typeof vi.fn>)).toHaveBeenCalledExactlyOnceWith('space-1','context-1');
  });

  it.each([
    {limit:'turn',callsPerResponse:1,requests:8,toolResults:7},
    {limit:'call',callsPerResponse:17,requests:1,toolResults:0},
  ])('still enforces the original $limit budget during denied-slot replies',async({callsPerResponse,requests,toolResults})=>{
    const read=vi.fn();
    const service={runtimeContexts:async()=>[{id:'context-1',producer:'agent',stepRunId:'step-1',attemptId:'attempt-1',
      inputs:{manuscript:{}}}],nodeClient:async()=>({read})} as unknown as WorkflowSpaceService;
    let sent=0;
    const http=async()=>{
      sent++;
      const output=Array.from({length:callsPerResponse},(_,index)=>({type:'function_call',name:'read_bound_asset',
        call_id:`bad-${sent}-${index}`,arguments:'{"slot":"profile"}'}));
      return new Response(`data: ${JSON.stringify({type:'response.completed',response:{id:`response-${sent}`,output}})}\n\n`,
        {status:200,headers:{'content-type':'text/event-stream'}});
    };
    const runner=createContentSiwcRunner({service,spaceId:'space-1',auth:{accessToken:async()=>'secret'},fetch:http as typeof fetch});
    const definition=stageAgent<unknown,{answer:string}>({id:'content-cold-reader',title:'冷读',guards:'',prompt:'按材料回答',
      outputSchema:objectSchema({answer:str})},{model:'test-model',reasoningEffort:'low'},'test-v1');
    const events:string[]=[];
    await expect(runner.run({runId:'run-1',stepRunId:'step-1',attemptId:'attempt-1',definition,input:{},
      signal:new AbortController().signal,emit:async type=>{events.push(type);}})).rejects.toThrow('SIWC tool or turn limit exceeded before execution');
    expect(sent).toBe(requests);
    expect(events.filter(type=>type==='siwc.tool_result')).toHaveLength(toolResults);
    expect(read).not.toHaveBeenCalled();
  });
});
