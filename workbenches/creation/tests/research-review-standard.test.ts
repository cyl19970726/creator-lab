import {describe,expect,it} from 'vitest';
import type {NodeContext} from '@signal-room/workflow-spaces';
import {researchReviewStandard} from '../src/spaces/research-review-standard.js';

const context={id:'research-context',hash:'frozen-context-hash',nodeId:'researcher',producer:'agent',
  instructions:'【角色说明】工程提示\n\n你是研究编辑。逐项回答必答问题；区分证据与缺口，不虚构来源。',
  inputs:{opportunity:{assetVersionId:'opportunity-version'}}} as unknown as NodeContext;
const input={context,manifest:{id:'manifest',hash:'frozen-manifest-hash',assets:{opportunity:'opportunity-version'}},
  opportunity:{readerGoal:'理解训练反馈机制',requiredQuestions:['训练从哪里开始？','反馈如何改变行为？']},schemaHash:'research-schema-hash'};
describe('research review frozen basis',()=>{
  it('uses the actual research task and exact input goal, while keeping manuscript acceptance distinct',()=>{
    const standard=researchReviewStandard(input)!;
    expect(standard.id).toBe('content-research-frozen-standard');
    expect(standard.content).toContain('理解训练反馈机制');
    expect(standard.content).toContain('2. 反馈如何改变行为？');
    expect(standard.content).toContain('区分证据与缺口，不虚构来源');
    expect(standard.content).not.toContain('工程提示');
    expect(standard.content).toContain('不宣称完整稿、冷读或事实核查已经完成');
    expect(researchReviewStandard(input)).toEqual(standard);
    expect(researchReviewStandard({...input,context:{...context,hash:'another-frozen-context'}})!.revision).not.toBe(standard.revision);
  });
  it('does not invent a research standard if the producer or actual opportunity binding is missing',()=>{
    expect(researchReviewStandard({...input,context:{...context,producer:'program'}})).toBeNull();
    expect(researchReviewStandard({...input,manifest:{...input.manifest,assets:{opportunity:'other-version'}}})).toBeNull();
    expect(researchReviewStandard({...input,opportunity:{readerGoal:'Goal',requiredQuestions:[]}})).toBeNull();
  });
});
