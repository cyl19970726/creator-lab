import {methodCapabilityAssetReader,type AssetReader} from '@signal-room/workflow-spaces';
import {creationAssetReaders} from './readers.js';

const opportunity:AssetReader=asset=>{
  const base=creationAssetReaders['creation/content-opportunity@1']!(asset);
  const payload=asset.payload as {account?:{referencePieces?:unknown}};
  const pieces=Array.isArray(payload?.account?.referencePieces)?payload.account.referencePieces:[];
  return {...base,sections:[...base.sections,{title:'已有作品参考',text:pieces.length?
    pieces.map((piece,index)=>{
      const item=piece&&typeof piece==='object'&&!Array.isArray(piece)?piece as Record<string,unknown>:{};
      const field=(key:string)=>typeof item[key]==='string'?item[key] as string:'';
      return `${index+1}. ${field('title')}\n结果：${field('result')}\n经验：${field('lesson')}`;
    }).join('\n\n'):'未提供'}]};
};

/** The live explanatory host and its publication check consume the same reader inventory. */
export const explanatoryMethodAssetReaders:Record<string,AssetReader>={
  ...creationAssetReaders,
  'creation/content-opportunity@1':opportunity,
  'workflow/method-capability@1':methodCapabilityAssetReader,
};
export const explanatoryMethodPresentationOptions={
  readerIds:Object.keys(explanatoryMethodAssetReaders),
  resultRoleIds:['final-draft','research','cold-read','fact-check','editorial-review'],
};
