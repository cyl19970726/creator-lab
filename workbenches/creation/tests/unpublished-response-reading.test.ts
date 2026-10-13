import {describe,it,expect} from 'vitest';
import {readContentDraftResponse} from '../src/spaces/readers.js';

describe('unpublished content response reading',()=>{
  it('reads the original decision and script while retaining an invalid source for inspection',()=>{
    const output={decision:{workingTitle:'原标题',coreQuestion:'原问题',oneLineAnswer:'原回答',audience:'原受众',audienceChange:'原变化',hook:'原开场',beats:[{beat:'一',says:'原主线',evidence:['unresolved-id'],visualIdea:'原画面'}],accountAngle:'原角度',form:'视频',notSaying:[],biggestRisk:'原风险',openQuestions:[],alternativesConsidered:[],changesFromPrevious:''},script:{title:'原标题',coverText:'原封面',estimatedSeconds:32,segments:[{time:'00:00–00:32',voiceover:'原口播',onScreenText:'原屏幕',visual:'原画面'}],sourcesUsed:['unresolved-id'],changesFromPrevious:''}};
    const before=JSON.stringify(output);const reading=readContentDraftResponse(output);
    expect(reading?.sections.find(s=>s.title==='内容目标')?.text).toContain('原主线');
    expect(reading?.sections.find(s=>s.title==='连续口播')?.text).toBe('原口播');
    expect(reading?.sections.find(s=>s.title==='逐段画面与节拍')?.text).toContain('原画面');
    expect(reading?.sections.find(s=>s.title==='来源标识')?.text).toContain('unresolved-id');
    expect(JSON.stringify(output)).toBe(before);
  });
  it('declines unknown or incomplete output rather than fabricating a manuscript',()=>{
    expect(readContentDraftResponse({text:'unknown response'})).toBeNull();
    expect(readContentDraftResponse({decision:{},script:{segments:[]}})).toBeNull();
  });
});
