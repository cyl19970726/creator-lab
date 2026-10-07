import type {AssetReader} from '@signal-room/workflow-spaces';
import {contentBusinessPreparationSchema,contentHandlingNotePayloadSchema} from './content-business-schemas.js';

/** Stored payloads are rendered as text by the Space API; these readers never emit HTML. */
export const contentBusinessAssetReaders:Record<string,AssetReader>={
  'creation/content-business-preparation@1':asset=>{
    const value=contentBusinessPreparationSchema.parse(asset.payload),input=value.input;
    return {title:`业务准备 · ${input.title}`,sections:[
      {title:'业务与方法',text:`业务：${input.title}\nCase：${value.caseId}\n方法版本：${value.versionId}\n输入清单：${value.inputManifestId}`},
      {title:'目标与必答问题',text:`${input.objective}\n\n${input.requiredQuestions.map(q=>`• ${q}`).join('\n')}`},
      {title:'账号与受众',text:`账号：${input.accountName}\n定位：${input.positioning}\n当前受众：${input.currentAudience}\n形式：${input.form}`},
      {title:'标准与运行条件',text:`${input.standards}\n\n${value.conditions.join('\n')}`},
      {title:'准确材料与来源',text:input.materials.map(m=>`${m.title}（${m.id}）\n来源：${m.source}\n${m.text}`).join('\n\n')},
    ]};
  },
  'creation/content-handling-note@1':asset=>{
    const value=contentHandlingNotePayloadSchema.parse(asset.payload);
    const source=asset.source.kind==='import'?asset.source.actorId:'来源无效';
    return {title:'认知 Agent 处理建议（外部会话）',sections:[
      {title:'归属与来源',text:`Case：${value.caseId}\nRun：${value.runId}\n准确稿件：${value.subjectAssetId}\n声明作者：${value.author.name}\n声明外部会话：${value.author.threadId}\n实际导入者：${source}\n创建于：${asset.createdAt}\n来源核验：仅声明，未经节点会话核验`},
      {title:'好的部分',text:value.answers.good},{title:'不足',text:value.answers.bad},
      {title:'改进判断',text:value.answers.improvement},{title:'未解决',text:value.answers.unresolved},
      {title:'处置建议与下一步（尚未执行）',text:`建议：${value.recommendation}\n下一步：${value.nextStep}`},
      {title:'所依据的准确资产',text:[value.subjectAssetId,...value.referencedAssetIds].join('\n'),sourceRefs:[value.subjectAssetId,...value.referencedAssetIds],view:'evidence'},
    ]};
  },
};
