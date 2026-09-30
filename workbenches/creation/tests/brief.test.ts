import { describe, expect, test } from 'vitest';
import type { AudienceQuestion, ContentDecision } from '../src/stages/b1.js';
import type { EditorVerdict, Script } from '../src/stages/b2.js';
import { b2WriterContext, b3DesignerContext, b3InspectorContext, briefAfterB1, briefAfterB2 } from '../src/stages/brief.js';

const gate = (runId: string, notesForNext: string[] = []) => ({ runId, revision: 'v', acceptedAt: '2026-09-30T00:00:00Z', reviewer: 'proxy', notesForNext });
const input = {
  topicId: 't', opportunity: '大家好奇弱模型如何训出强模型', form: '竖屏',
  account: { name: 'Token 经济猫', positioning: 'p', currentAudience: '普通读者', referencePieces: [{ title: 'EP01', result: '完播 5.32%', lesson: '2:46 偏长' }] },
  materials: [{ id: 'kimi', title: 'Kimi', text: 'rollouts' }],
};
const audienceQuestion = { questionInAudienceWords: '老师没学生强，怎么教？', currentIntuition: '老师必须比学生强' } as AudienceQuestion;
const decision = {
  coreQuestion: 'q', oneLineAnswer: '老师只要会判卷', hook: '15.6% → 77.9%', markdown: '# md',
  beats: [{ beat: 'Kimi', says: 's', evidence: ['kimi'], visualIdea: '检查器看最终状态' }],
} as unknown as ContentDecision;

function b1Brief() {
  return briefAfterB1({
    input, audienceQuestion, decision, gate: gate('b1-run', ['开头用具体事实']),
    research: [{ id: 'web-r1', title: 'R1', url: 'https://x', publisher: 'DeepSeek', date: '2025', keyPoints: ['15.6→77.9'], fillsGap: 'g', sourceKind: 'primary' }],
    challenge: { verdict: 'pass', criteria: [{ id: 'S4', result: 'weak', reason: '钩子没有具体数字' }, { id: 'S1', result: 'ok', reason: '' }], mustChange: [], niceToChange: [], summary: 's' },
  });
}

describe('piece brief', () => {
  test('B1 acceptance keeps what B1 decided and what it left open for B2', () => {
    const brief = b1Brief();
    expect(brief.version).toBe(1);
    expect(brief.audienceQuestion).toMatchObject({ currentIntuition: '老师必须比学生强' });
    expect(brief.decision).not.toHaveProperty('markdown');
    expect(brief.materials.map(m => m.id)).toEqual(['kimi', 'web-r1']);
    expect(brief.notesForB2).toEqual([{ from: 'proxy', note: '开头用具体事实' }, { from: 'B1 挑战者', note: 'S4 偏弱：钩子没有具体数字' }]);
  });

  test('B2 acceptance adds the script and passes the editor notes on to production', () => {
    const script = { title: 't', coverText: 'c', estimatedSeconds: 90, segments: [], sourcesUsed: [], changesFromPrevious: '', markdown: '#' } as unknown as Script;
    const editor = { verdict: 'pass', summary: '制作时把"同一基础模型"简化成同一起点', criteria: [{ id: 'T8', result: 'weak', reason: '结尾重复' }], mustChange: [], rejectedSuggestions: [], secondsBudget: 90 } as EditorVerdict;
    const brief = briefAfterB2(b1Brief(), { script, editor, gate: gate('b2-run', ['字幕别挡图']) });
    expect(brief.version).toBe(2);
    expect(brief.sources.map(s => s.stage)).toEqual(['b1', 'b2']);
    expect(brief.script).not.toHaveProperty('markdown');
    expect(brief.notesForB3.map(n => n.note)).toEqual(['字幕别挡图', '制作时把"同一基础模型"简化成同一起点', 'T8 偏弱：结尾重复']);
  });

  test('each role gets its slice: writers get the audience question, B3 gets the core and its notes but no materials', () => {
    const brief = b1Brief();
    expect(b2WriterContext(brief)).toMatchObject({ audienceQuestion: { currentIntuition: '老师必须比学生强' }, account: { referencePieces: [{ lesson: '2:46 偏长' }] } });
    const designer = b3DesignerContext(brief);
    expect(designer.core).toMatchObject({ oneLineAnswer: '老师只要会判卷', hook: '15.6% → 77.9%', beats: [{ beat: 'Kimi', visualIdea: '检查器看最终状态' }] });
    expect(JSON.stringify(designer)).not.toContain('rollouts');
    expect(b3InspectorContext(brief).core).toEqual({ coreQuestion: 'q', oneLineAnswer: '老师只要会判卷', hook: '15.6% → 77.9%' });
  });
});
