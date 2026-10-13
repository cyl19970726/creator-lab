import {describe,expect,it} from 'vitest';
import type {BusinessUnderstandingRevision,MethodDesignRevision,SpacePrincipal,WorkflowVersionDraft} from '@signal-room/workflow-spaces';
import {assertPublishableDesignDraft,buildFirstMethodVersion,CONTENT_FIRST_METHOD_WORKFLOW_ID} from '../src/spaces/content-design-host.js';

const understanding={id:'understanding-5',payloadHash:'understanding-hash'} as BusinessUnderstandingRevision;
const design={id:'design-2',payloadHash:'design-hash',workflowId:CONTENT_FIRST_METHOD_WORKFLOW_ID,
  entrypoint:'content',title:'首版完整内容',changeReason:'明确首版方法',
  understanding:{revisionId:understanding.id,payloadHash:understanding.payloadHash}} as MethodDesignRevision;
const declaration={id:'legacy-id',revision:'content-v2',predecessorId:'legacy-predecessor',changeReason:'legacy',
  config:{models:{worker:{model:'gpt-6-luna',reasoningEffort:'high'},judge:{model:'gpt-6-luna',reasoningEffort:'high'}}},
  entrypoints:{content:{workflowId:'creation.content',codeRevision:'content-v2',
    storageContract:{workflowVersion:'legacy-id',nodes:{},stateRules:[]}}}} as WorkflowVersionDraft;

describe('first method candidate identity',()=>{
  it('freezes exact design basis and declaration while preserving the actual code revision',()=>{
    const first=buildFirstMethodVersion(declaration,design,understanding);
    expect(first.id).toMatch(/^content-first-[a-f0-9]{32}$/);
    expect(buildFirstMethodVersion(declaration,design,understanding)).toEqual(first);
    expect(first).toMatchObject({revision:'first-method-v1',designBasis:{designRevisionId:design.id,
      designPayloadHash:design.payloadHash,understandingRevisionId:understanding.id,
      understandingPayloadHash:understanding.payloadHash},
      entrypoints:{content:{workflowId:CONTENT_FIRST_METHOD_WORKFLOW_ID,codeRevision:'content-v2',
        storageContract:{workflowVersion:first.id}}},
      config:{designSelection:{status:'unexecuted-pending-validation',executionAvailability:'unavailable'}}});
    expect(first.predecessorId).toBeUndefined();
    expect(declaration.entrypoints.content?.workflowId).toBe('creation.content');
    expect(declaration.predecessorId).toBe('legacy-predecessor');
    expect(buildFirstMethodVersion(declaration,{...design,payloadHash:'new-design-hash'},understanding).id).not.toBe(first.id);
    expect(buildFirstMethodVersion({...declaration,config:{...declaration.config,codeChange:'new'}},design,understanding).id).not.toBe(first.id);
  });
  it('rejects a design tied to another understanding or workflow',()=>{
    expect(()=>buildFirstMethodVersion(declaration,{...design,understanding:{...design.understanding,payloadHash:'wrong'}},understanding))
      .toThrow('understanding basis');
    expect(()=>buildFirstMethodVersion(declaration,{...design,workflowId:'other'},understanding))
      .toThrow('another workflow');
  });
});

describe('first method publication authority',()=>{
  const principal:SpacePrincipal={id:'external-agent:thread-1',kind:'service',
    externalAgent:{id:'cognition-root',sessionId:'thread-1',role:'design'}};
  const own={...design,recordedBy:principal.id,authorship:{kind:'agent' as const,name:'cognition-root',sessionId:'thread-1'}};
  it('allows only the trusted design Agent’s own recorded session draft',()=>{
    expect(()=>assertPublishableDesignDraft(principal,own)).not.toThrow();
    expect(()=>assertPublishableDesignDraft(principal,{...own,recordedBy:'local-owner'})).toThrow('does not belong');
    expect(()=>assertPublishableDesignDraft(principal,{...own,authorship:{kind:'human',name:'Owner'}})).toThrow('does not belong');
    expect(()=>assertPublishableDesignDraft(principal,{...own,authorship:{...own.authorship,sessionId:'other-thread'}})).toThrow('does not belong');
    expect(()=>assertPublishableDesignDraft({...principal,externalAgent:{...principal.externalAgent!,role:'observer'}},own))
      .toThrow('Design Agent credential required');
  });
  it('preserves the existing human owner publication path',()=>{
    expect(()=>assertPublishableDesignDraft({id:'local-owner',kind:'human'},design)).not.toThrow();
  });
});
