import { describe, expect, test } from 'vitest';
import { scriptMarkdown, storyboardMarkdown } from '../src/stages/b3.js';

const segments = [
  { time: '0–18秒', voiceover: '只判答案，AI 的答对率\n就能涨？', onScreenText: '15.6% → 77.9%｜论文报告', visual: '数字占满竖屏' },
  { time: '18–30秒', voiceover: '谁在判卷？', onScreenText: '', visual: '判卷框' },
];

describe('B3 assembly-line files', () => {
  test('writes SCRIPT.md in the template format: numbered lines, duration hints, four-space voice lines', () => {
    const md = scriptMarkdown('只判答案', segments, 'placeholder');
    expect(md).toMatch(/^### Line 01 — 15\.6% → 77\.9% \(F01 · ~18s\)$/m);
    expect(md).toMatch(/^### Line 02 — 18–30秒 \(F02 · ~12s\)$/m);
    expect(md).toContain('\n    只判答案，AI 的答对率就能涨？\n');
    expect(md).toContain('占位');
  });

  test('marks the first beat as the cover beat so render can pick a cover frame', () => {
    expect(storyboardMarkdown('t', segments)).toMatch(/^cover_beat: 1$/m);
  });
});
