import {createHash} from 'node:crypto';
import type {InputManifest,NodeContext} from '@signal-room/workflow-spaces';

/** The research deliverable is judged against its own frozen task, not complete-manuscript acceptance. */
export function researchReviewStandard(input:{context:Pick<NodeContext,'id'|'hash'|'nodeId'|'producer'|'instructions'|'inputs'>;
  manifest:Pick<InputManifest,'id'|'hash'|'assets'>;opportunity:unknown;schemaHash:string}){
  const {context,manifest}=input;
  if(context.producer!=='agent'||context.nodeId!=='researcher'||
    context.inputs.opportunity?.assetVersionId!==manifest.assets.opportunity||
    typeof input.opportunity!=='object'||input.opportunity===null||Array.isArray(input.opportunity))return null;
  const opportunity=input.opportunity as {readerGoal?:unknown;requiredQuestions?:unknown;opportunity?:unknown;webResearch?:unknown};
  if(typeof opportunity.readerGoal!=='string'||!opportunity.readerGoal.trim()||
    !Array.isArray(opportunity.requiredQuestions)||!opportunity.requiredQuestions.length||
    opportunity.requiredQuestions.some(question=>typeof question!=='string'||!question.trim())||!context.instructions.trim())return null;
  const taskMarker=context.instructions.indexOf('你是研究编辑。');
  const instructions=taskMarker<0?context.instructions:context.instructions.slice(taskMarker);
  const content=[
    '# 研究资产评价依据',
    '评价本次研究问答是否兑现当时的读者目标与研究职责。它是后续内容的依据；此评价不宣称完整稿、冷读或事实核查已经完成。',
    '## 当时的读者目标',opportunity.readerGoal,
    '## 当时的必答问题',...opportunity.requiredQuestions.map((question,index)=>`${index+1}. ${question}`),
    '## 研究节点当时的职责（冻结原文）',instructions,
    '## 准确依据',`冻结输入清单：${manifest.id} · ${manifest.hash}`,
    `研究生产上下文：${context.id} · ${context.hash}`,
    '上述输入用于确定评价口径，不是评价 Agent 已经阅读所有材料的证明。Agent 的阅读凭据另绑定准确研究资产及其内容哈希。',
  ].join('\n\n');
  const revision=createHash('sha256').update(JSON.stringify({basis:'research-frozen-standard-v1',manifestHash:manifest.hash,
    contextHash:context.hash,schemaHash:input.schemaHash,content})).digest('hex');
  return {id:'content-research-frozen-standard',revision,content};
}
