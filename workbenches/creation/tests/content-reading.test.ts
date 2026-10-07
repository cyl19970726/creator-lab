import { describe, expect, it } from 'vitest';
import type { AssetVersion } from '@signal-room/workflow-spaces';
import { assetReading, fragmentAnchor } from '../../../vendor/agent-workflow/packages/spaces/workbench-render.js';
import { creationAssetReaders,contentFrozenInputSummary } from '../src/spaces/readers.js';
const hash='a'.repeat(64);
function asset(namespace:string,payload:unknown):AssetVersion {
  return {id:'fixture-parent-v1',assetId:'fixture-parent',spaceId:'fixture-space',version:1,schema:{namespace,revision:'1',hash},payload:payload as AssetVersion['payload'],payloadHash:hash,source:{kind:'import',actorId:'fixture',description:'Fixture'},dependencies:[],attachments:[],initialState:'imported',createdAt:'2026-10-05'};
}
describe('CONTENT source fragments',()=>{
  it('reads frozen original goals and every question without inventing a duration cap',()=>{
    const input=asset('creation/content-opportunity',{topicId:'fixture',opportunity:'原机会',readerGoal:'原始学习目标',form:'口播',requiredQuestions:['问题一','问题二','问题三','问题四','问题五'],standards:'保持事实边界',account:{name:'账号',positioning:'定位',currentAudience:'普通观众',referencePieces:[]},webResearch:false,maxRevisions:2});
    const reading=creationAssetReaders['creation/content-opportunity@1']!(input);
    const text=reading.sections.map(section=>section.text).join('\n');
    for(const item of ['原始学习目标','问题一','问题二','问题三','问题四','问题五','保持事实边界','硬时长上限：无','原始输入／无前稿：是'])expect(text).toContain(item);
    const materials=asset('creation/content-materials',Array.from({length:11},(_,index)=>({id:`source-${index}`,title:'来源',text:'原文'})));
    expect(contentFrozenInputSummary({assets:[{slot:'opportunity',asset:input},{slot:'materials',asset:materials}]})).toEqual(['11 份材料','5 个必答问题','不新增联网研究','最多返工 2 次','无硬时长上限']);
  });
  it('reads materials as normal text at exact-parent index anchors',()=>{
    const input=asset('creation/content-materials',[{id:'source-1',title:'第一份来源',text:'第一段\n\n第二段 <script>bad</script>'},{id:'source-2',title:'第二份来源',text:'下一份材料'}]);
    const reading=assetReading(input,{readers:creationAssetReaders});
    expect(reading.title).toBe('材料原文与来源');expect(reading.body).toContain('id="fragment-0"');expect(reading.body).toContain('id="fragment-1"');
    expect(reading.body).toContain('<p>第一段</p>');expect(reading.body).toContain('&lt;script&gt;');expect(reading.body).not.toContain('<dt>id</dt>');expect(reading.body).not.toContain('<script>');
    expect(fragmentAnchor('/notes/0')).toBe('fragment-notes-0');expect(fragmentAnchor('/0')).toBe('fragment-0');expect(fragmentAnchor('/notes-0')).not.toBe(fragmentAnchor('/notes/0'));
  });
  it('keeps each added research source at its own note anchor and evidence beside the conclusion',()=>{
    const input=asset('creation/content-research',{questions:[{question:'事实是什么',answer:'范围有限',materialRefs:['source-1'],gap:'尚缺更多证据'}],notes:[{title:'新增来源',url:'javascript:alert(1)',publisher:'发布机构',date:'2026-10-05',sourceKind:'primary',keyPoints:['原文要点'],fillsGap:'补足背景'}],remainingGaps:[]});
    const reading=assetReading(input,{readers:creationAssetReaders,sources:[{ref:'source-1',label:'第一份来源',resolved:true,assetVersionId:'materials-v1',pointer:'/0',excerpt:'准确材料原文'}]});
    expect(reading.body).toContain('id="fragment-notes-0"');expect(reading.body).toContain('发布机构');expect(reading.body).toContain('pointer=%2F0#fragment-0');expect(reading.body).toContain('准确材料原文');expect(reading.body).not.toContain('href="javascript:');
    expect(reading.body.indexOf('本结论的依据')).toBeLessThan(reading.body.indexOf('新增来源'));
  });
  it('places each manuscript beat evidence beside its claim and resolves the script source list',()=>{
    const input=asset('creation/content-draft',{decision:{beats:[{beat:'开场',says:'第一条主张',evidence:['source-1'],visualIdea:'第一画面'},{beat:'解释',says:'第二条主张',evidence:['note-1'],visualIdea:'第二画面'}]},script:{title:'测试稿',segments:[{time:'0–3',voiceover:'连续口播原文',visual:'画面构想',onScreenText:'屏幕文案'}],sourcesUsed:['source-1','note-1']}});
    const sections=creationAssetReaders['creation/content-draft@1']!(input).sections;
    expect(sections.filter(section=>section.view==='body').map(section=>section.title)).toEqual(['内容目标','连续口播']);
    expect(sections.filter(section=>section.view==='visual').map(section=>section.title)).toEqual(['逐段画面与节拍','封面与形式']);
    expect(sections.filter(section=>section.view==='evidence').map(section=>section.title)).toEqual(['叙事节拍与依据','叙事节拍与依据 · 2','来源标识','作者自述的改动']);
    expect(sections.every(section=>['body','visual','evidence'].includes(section.view!))).toBe(true);
    expect(sections.find(section=>section.title==='来源标识')!.sourceRefs).toEqual(['source-1','note-1']);
    const beats=sections.filter(section=>section.title.startsWith('叙事节拍与依据'));
    expect(beats.map(section=>section.sourceRefs)).toEqual([['source-1'],['note-1']]);
    const html=assetReading(input,{readers:creationAssetReaders,sources:[{ref:'source-1',label:'材料来源',resolved:true,assetVersionId:'materials-v1',pointer:'/0',excerpt:'材料证据'},{ref:'note-1',label:'研究来源',resolved:true,assetVersionId:'research-v1',pointer:'/notes/0',excerpt:'研究证据'}]}).body;
    expect(html).toContain('连续口播原文');expect(html).toContain('屏幕文案');expect(html).toContain('pointer=%2F0#fragment-0');expect(html).toContain('pointer=%2Fnotes%2F0#fragment-notes-0');
    expect(html.indexOf('材料证据')).toBeLessThan(html.indexOf('第二条主张'));
  });

});
