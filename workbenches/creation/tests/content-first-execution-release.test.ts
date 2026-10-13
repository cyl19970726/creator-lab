import {describe,it,expect,vi} from 'vitest';
import type {InputManifest} from '@signal-room/workflow-spaces';
import type {ContentInput} from '../src/stages/content.js';
import {createContentFirstExecutionGate,CONTENT_FIRST_EXECUTION_BUDGET,type ContentFirstExecutionRelease} from '../src/spaces/content-first-execution-release.js';

const models={worker:{model:'gpt-6-luna',reasoningEffort:'high' as const},judge:{model:'gpt-6-luna',reasoningEffort:'high' as const}};
const manifest={id:'manifest',spaceId:'space',caseId:'case',hash:'input-hash',assets:{opportunity:'op',materials:'mat'}} as InputManifest;
const parsed={topicId:'case',webResearch:false,maxRevisions:2} as ContentInput;
const release:ContentFirstExecutionRelease={revision:1,spaceId:'space',principalId:'owner',caseId:'case',versionId:'version',inputManifestId:'manifest',inputManifestHash:'input-hash',models,
  expiresAt:'2026-10-10T00:00:00Z',exclusive:{confirmedAt:'2026-10-09T00:00:00Z',disabledPorts:[4393,4394,4396]},maxRevisions:2,webResearch:false,
  authorizedAction:'one-frontend-start',executionBudget:CONTENT_FIRST_EXECUTION_BUDGET};
function fixture(value:ContentFirstExecutionRelease|null=release){
  const loadRelease=vi.fn(async()=>value),verifyExclusive=vi.fn(async()=>true);
  return {loadRelease,verifyExclusive,gate:createContentFirstExecutionGate({spaceId:'space',principalId:'owner',models,loadRelease,verifyExclusive,now:()=>Date.parse('2026-10-09T12:00:00Z')})};
}
describe('first method exact execution release',()=>{
  it('rejects online input before loading authorization or starting calls',async()=>{
    const f=fixture();await expect(f.gate({caseId:'case',versionId:'version',manifest,parsed:{...parsed,webResearch:true}})).rejects.toThrow('联网输入');
    expect(f.loadRelease).not.toHaveBeenCalled();expect(f.verifyExclusive).not.toHaveBeenCalled();
  });
  it('requires the exact input hash, model, bounded policy and unexpired scope',async()=>{
    for(const value of [null,{...release,inputManifestHash:'other'},{...release,models:{...models,worker:{...models.worker,model:'other'}}},
      {...release,expiresAt:'2026-10-08T00:00:00Z'},{...release,executionBudget:{...CONTENT_FIRST_EXECUTION_BUDGET,maxAgentCalls:16}}]){
      const f=fixture(value as ContentFirstExecutionRelease|null);
      await expect(f.gate({caseId:'case',versionId:'version',manifest,parsed})).rejects.toThrow('未匹配');
      expect(f.verifyExclusive).not.toHaveBeenCalled();
    }
  });
  it('returns limits only after exact scope and exclusive conditions hold',async()=>{
    const f=fixture();expect(await f.gate({caseId:'case',versionId:'version',manifest,parsed})).toEqual(CONTENT_FIRST_EXECUTION_BUDGET);
    f.verifyExclusive.mockResolvedValueOnce(false);await expect(f.gate({caseId:'case',versionId:'version',manifest,parsed})).rejects.toThrow('独占条件');
  });
});
