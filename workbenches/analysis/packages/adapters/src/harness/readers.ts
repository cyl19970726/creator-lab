import type {AssetReader, AssetReading} from '@signal-room/workflow-spaces';

const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const labels:Record<string,string>={contentRestoration:'内容还原',directingLogic:'编导逻辑',visualEditing:'视觉剪辑',finalSummary:'综合总结',body:'正文',summary:'总结',title:'标题',evidenceRefs:'证据引用',findings:'审阅发现',source:'原始来源',native:'原始运行身份',knownLimits:'已知边界'};
/** Lossless prose projection: every authored string remains verbatim, with JSON pointers. */
export function authoredSections(value:unknown,pointer='',title='正文'):AssetReading['sections']{
 if(typeof value==='string')return [{title,text:value,pointer}];
 if(value===null||typeof value!=='object')return [{title,text:JSON.stringify(value)??'未知',pointer}];
 return Object.entries(value).flatMap(([key,item])=>authoredSections(item,`${pointer}/${key.replace(/~/g,'~0').replace(/\//g,'~1')}`,labels[key]??(Array.isArray(value)?`${title} ${Number(key)+1}`:key)));
}
export const lapianReader:AssetReader=asset=>{
 const payload=record(asset.payload), report=record(payload.report);
 const lenses=record(report.builderLenses);
 const sections:AssetReading['sections']=[{title:'来源与状态',text:String(payload.description??'导入的历史证据；不表示新执行、质量通过或采用。'),pointer:'/description'}];
 if(Object.keys(lenses).length)for(const key of ['contentRestoration','directingLogic','visualEditing','finalSummary']){
  if(lenses[key]!==undefined)sections.push(...authoredSections(lenses[key],`/report/builderLenses/${key}`,labels[key]));
 }
 else sections.push(...authoredSections(payload.content??payload.nativePayload??payload,'/content','内容'));
 if(asset.source?.kind==='historical-artifact')sections.push({title:'专业原片与证据阅读',text:`[打开准确原生报告与原帧](http://127.0.0.1:5177/workflow-runs/${asset.source.runId}#artifact-${asset.source.artifactId})`});
 if(payload.native)sections.push(...authoredSections(payload.native,'/native','准确身份'));
 if(payload.readerHref)sections.push({title:'专业阅读入口',text:`[打开原片、原帧与字幕对照](${String(payload.readerHref)})`,pointer:'/readerHref'});
 return {title:String(payload.title??'拉片证据'),sections};
};
export const lapianReaders={'analysis.lapian':lapianReader};
