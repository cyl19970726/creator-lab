import {describe,it,expect} from 'vitest';
import {authoredSections,lapianReader} from './readers.js';
import type {AssetVersion} from '@signal-room/workflow-spaces';
describe('lapian authored reader',()=>{
 it('retains exact paragraphs and summary without deriving prose',()=>{
  const body='第一段。\n\n不确定的第二段。';
  const reading=lapianReader({payload:{report:{builderLenses:{contentRestoration:{blocks:[{body}]},finalSummary:{body:'原始总结'}}}}} as AssetVersion);
  expect(reading.sections.find(s=>s.pointer==='/report/builderLenses/contentRestoration/blocks/0/body')?.text).toBe(body);
  expect(reading.sections.find(s=>s.pointer==='/report/builderLenses/finalSummary/body')?.text).toBe('原始总结');
 });
 it('preserves zero and unknown separately',()=>expect(authoredSections({likes:0,shares:null}).map(s=>s.text)).toEqual(['0','null']));
});
