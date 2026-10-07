import type { AssetReader, AssetVersion } from '@signal-room/workflow-spaces';
import {contentBusinessAssetReaders} from './content-business-readers.js';

/** Returned strings are untrusted stored data; render them as text, never markup. */
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const str = (value: unknown): string => typeof value === 'string' ? value : '';
const field = (name: string, value: unknown): string => `${name}：${str(value) || (typeof value === 'number' ? value : '未填写')}`;
const bullets = (value: unknown, empty = '未列出'): string => {
  const items = arr(value).map(str).filter(Boolean);
  return items.length ? items.map(item => `• ${item}`).join('\n') : empty;
};
const section = (title: string, text: string, view: 'body'|'visual'|'evidence' = 'body') => ({ title, text, view });
const data = (asset: AssetVersion) => obj(asset.payload);
const verdictLabels: Record<string, string> = { pass: '通过流程内审阅', revise: '仍需修改', blocked: '存在阻塞问题' };
const routeLabels: Record<string, string> = { pass: '等待创作者判断', rewrite: '改写稿件', research: '补充研究', reframe: '重新组织解释', blocked: '先解决阻塞问题' };
const resultLabels: Record<string, string> = { ok: '满足', weak: '薄弱', fail: '未满足' };
const problemLabels: Record<string, string> = { wrong: '与材料不符', overclaim: '表述超出证据', unsupported: '缺少材料支持' };

const manuscript: AssetReader = asset => {
  const draft = data(asset), decision = obj(draft.decision), script = obj(draft.script);
  const segments = arr(script.segments).map(obj), beats = arr(decision.beats).map(obj);
  return { title: str(script.title) || '完整稿件', sections: [
    section('内容目标', [field('核心问题', decision.coreQuestion), field('一句话回答', decision.oneLineAnswer),
      field('目标读者', decision.audience), field('希望读者获得', decision.audienceChange)].join('\n\n')),
    section('连续口播', segments.map(segment => str(segment.voiceover)).filter(Boolean).join('\n\n') || '尚无可读口播'),
    section('逐段画面与节拍', segments.length ? segments.map((segment, index) => [
      `${index + 1}. ${str(segment.time) || '未标时间'}`, field('口播', segment.voiceover),
      field('屏幕文字', segment.onScreenText), field('画面意图', segment.visual),
    ].join('\n')).join('\n\n') : '尚无段落', 'visual'),
    ...beats.map((beat,index)=>({...section(index===0?'叙事节拍与依据':`叙事节拍与依据 · ${index+1}`, [
      str(beat.beat)||`节拍 ${index+1}`, field('表达',beat.says),
      `依据：${arr(beat.evidence).map(str).filter(Boolean).join('、')||'未列出'}`, field('画面构想',beat.visualIdea),
    ].join('\n'), 'evidence'),sourceRefs:arr(beat.evidence).map(str).filter(Boolean)})),
    ...(beats.length?[]:[section('叙事节拍与依据','尚无节拍','evidence')]),
    section('封面与形式', [field('封面文字', script.coverText), field('形式', decision.form),
      field('预计秒数', script.estimatedSeconds)].join('\n'), 'visual'),
    {...section('来源标识', bullets(script.sourcesUsed, '未列出来源标识；请查看准确绑定的研究与材料。'), 'evidence'),sourceRefs:arr(script.sourcesUsed).map(str).filter(Boolean)},
    section('作者自述的改动', str(script.changesFromPrevious) || str(decision.changesFromPrevious) || '未填写', 'evidence'),
  ] };
};

const research: AssetReader = asset => {
  const research = data(asset), questions = arr(research.questions).map(obj), notes = arr(research.notes).map(obj);
  return { title: '研究问答与来源', sections: [
    ...questions.map((question, index) => ({ ...section(str(question.question) || `问题 ${index + 1}`, [
      str(question.answer) || '未填写回答',
      `依据标识：${arr(question.materialRefs).map(str).filter(Boolean).join('、') || '未列出'}`,
      field('证据缺口', question.gap),
    ].join('\n\n')), sourceRefs: arr(question.materialRefs).map(str).filter(Boolean) })),
    ...notes.map((note,index)=>({ ...section(str(note.title)||`新增来源 ${index+1}`, [
      [str(note.publisher),str(note.date),({primary:'一手来源',secondary:'二手来源'} as Record<string,string>)[str(note.sourceKind)]||str(note.sourceKind)].filter(Boolean).join(' · '),
      field('链接',note.url), `要点：\n${bullets(note.keyPoints)}`, field('填补的缺口',note.fillsGap),
    ].filter(Boolean).join('\n\n')), pointer:`/notes/${index}` })),
    ...(notes.length?[]:[section('研究新增来源','没有新增来源')]),
    section('尚未解决的问题', bullets(research.remainingGaps, '未列出剩余缺口')),
  ] };
};

/** Index locators belong only to this exact immutable materials package. */
const materials:AssetReader=asset=>({title:'材料原文与来源',sections:arr(asset.payload).map((value,index)=>{
  const material=obj(value);
  return {...section(str(material.title)||`材料 ${index+1}`,[field('材料标识',material.id),str(material.text)||'未保存材料正文'].join('\n\n')),pointer:`/${index}`};
})});
/** Concise domain facts for a frozen input; generic UI does not inspect CONTENT payload fields. */
export function contentFrozenInputSummary(input:{assets:Array<{slot:string;asset:AssetVersion}>}):string[] {
 const opportunityAsset=input.assets.find(item=>item.slot==='opportunity')?.asset;
 const materialsAsset=input.assets.find(item=>item.slot==='materials')?.asset;
 if(!opportunityAsset||!materialsAsset)return [];
 const opportunity=data(opportunityAsset);
 return [`${arr(materialsAsset.payload).length} 份材料`,`${arr(opportunity.requiredQuestions).length} 个必答问题`,
  opportunity.webResearch===false?'不新增联网研究':'联网研究条件见原输入',
  `最多返工 ${typeof opportunity.maxRevisions==='number'?opportunity.maxRevisions:'未记录'} 次`,
  typeof opportunity.maxSeconds==='number'?`硬时长上限 ${opportunity.maxSeconds} 秒`:'无硬时长上限'];
}
const opportunity:AssetReader=asset=>{
 const value=data(asset),account=obj(value.account);
 return {title:'冻结内容目标与约束',sections:[
  section('原始目标',[field('主题标识',value.topicId),field('内容机会',value.opportunity),field('观众学习目标',value.readerGoal),field('形式',value.form)].join('\n\n')),
  section('目标观众',[field('账号',account.name),field('账号定位',account.positioning),field('已有观众',account.currentAudience)].join('\n\n')),
  section('必答问题',bullets(value.requiredQuestions)),
  section('硬约束与标准',str(value.standards)||'未保存审阅标准'),
  section('冻结运行条件',`联网研究：${value.webResearch===true?'开启':'关闭'}\n最大返工次数：${typeof value.maxRevisions==='number'?value.maxRevisions:'未记录'}\n硬时长上限：${typeof value.maxSeconds==='number'?`${value.maxSeconds} 秒`:'无'}\n原始输入／无前稿：${value.prior?'否':'是'}`),
 ]};
};
const material:AssetReader=asset=>{
  const value=data(asset);
  return {title:str(value.title)||'材料原文与来源',sections:[section('原文',str(value.text)||'未保存材料正文')]};
};

const coldRead: AssetReader = asset => {
  const read = data(asset);
  const locations = (value: unknown, empty: string) => {
    const items = arr(value).map(obj);
    return items.length ? items.map(item => `${str(item.segment) || '未定位段落'}：${str(item.why) || '未说明原因'}`).join('\n') : empty;
  };
  const retention = (value: unknown) => {
    const item = obj(value);
    return `${item.yes === true ? '愿意继续看' : item.yes === false ? '可能离开' : '未判断'}：${str(item.why) || '未说明原因'}`;
  };
  return { title: '模拟冷读者反馈', sections: [
    section('观众复述', str(read.retell) || '未填写'),
    section('观众理解的一句话', str(read.oneLineAnswerAsUnderstood) || '未填写'),
    section('读后仍有的问题', bullets(read.unansweredQuestions, '未报告未解问题')),
    section('跟丢的位置', locations(read.lostAt, '未报告跟丢位置')),
    section('感到无聊的位置', locations(read.boredAt, '未报告无聊位置')),
    section('观看意愿', `3 秒：${retention(read.keepWatchingAt3s)}\n30 秒：${retention(read.keepWatchingAt30s)}`),
    section('最有记忆点', str(read.mostMemorable) || '未填写'),
  ] };
};

const factCheck: AssetReader = asset => {
  const facts = data(asset), issues = arr(facts.issues).map(obj);
  return { title: '给定材料内的事实核查', sections: [
    section('核查摘要', str(facts.summary) || '未填写'),
    section('报告的问题', issues.length ? issues.map((issue, index) => [
      `${index + 1}. ${str(issue.segment) || '未定位段落'} · ${problemLabels[str(issue.problem)] || str(issue.problem) || '未分类'}`,
      field('主张', issue.claim), field('所见证据', issue.evidence), field('修改建议', issue.fix),
    ].join('\n')).join('\n\n') : '给定材料下未报告问题。'),
  ] };
};

const editorial: AssetReader = asset => {
  const review = data(asset), criteria = arr(review.criteria).map(obj), coverage = arr(review.questionCoverage).map(obj);
  return { title: '主编意见', sections: [
    section('主编判断', [field('结论', verdictLabels[str(review.verdict)] || review.verdict), field('建议路径', routeLabels[str(review.route)] || review.route),
      str(review.summary) || '未填写摘要'].join('\n\n')),
    section('必须修改', bullets(review.mustChange, '未列出必须修改项')),
    section('必答问题覆盖', coverage.length ? coverage.map(item => [
      `${str(item.question) || '未命名问题'} · ${resultLabels[str(item.result)] || str(item.result) || '未判断'}`,
      field('稿件中的回答', item.answerInDraft), field('尚缺', item.missing),
    ].join('\n')).join('\n\n') : '未列出问题覆盖'),
    section('C1–C8 标准', criteria.length ? criteria.map(item =>
      `${str(item.id) || '未标识标准'} · ${resultLabels[str(item.result)] || str(item.result) || '未判断'}：${str(item.reason) || '未说明原因'}`).join('\n') : '未列出标准评估'),
    section('程序检查', bullets(review.guardFailures, '未报告程序检查问题')),
  ] };
};

const frames: AssetReader = asset => {
  const frame = data(asset), specs = arr(frame.specs).map(obj);
  return { title: '制作方案', sections: [
    section('设计说明', str(frame.report) || '设计说明请查看原始记录'),
    section('程序构建检查', str(frame.build) || '构建检查请查看原始记录'),
    ...specs.map(spec => section(str(spec.file) || '文件', str(spec.content) || '无文本内容')),
  ] };
};

/** Reader keys pin schema revision; a future shape cannot reinterpret old assets. */
export const creationPresentationReaderIds = {
  materials:'creation/content-materials@1', material:'creation/content-material@1', research: 'creation/content-research@1', draft: 'creation/content-draft@1', reader: 'creation/content-reader@1',
  factCheck: 'creation/content-fact-check@1', review: 'creation/content-review@1',
} as const;

export const creationAssetReaders: Record<string, AssetReader> = {
  ...contentBusinessAssetReaders,
  'creation/content-opportunity@1':opportunity,
  'creation/content-materials@1':materials,
  'creation/content-material@1':material,
  'creation/content-draft@1': manuscript,
  'creation/content-piece-brief@1': manuscript,
  'creation/content-research@1': research,
  'creation/content-reader@1': coldRead,
  'creation/content-fact-check@1': factCheck,
  'creation/content-review@1': editorial,
  'creation/b3-frame-specs@1': frames,
};
