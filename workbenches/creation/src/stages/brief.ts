import { z } from 'zod';
import type { AudienceQuestion, B1Input, Challenge, ContentDecision, ResearchNotes } from './b1.js';
import type { EditorVerdict, FactCheck, Script } from './b2.js';

/**
 * 作品档案 (piece brief): the one hand-off object between stages.
 * It is written only when the creator's gate accepts a stage, gets a new version each time, and each
 * downstream role receives a declared slice of it. Before this, the hand-offs were assembled by hand in a
 * session and silently dropped the audience question, the reference-piece lessons, the one-line answer and
 * the editor's notes for production (see docs/workflows/stage-flow.html).
 */
export const BRIEF_SCHEMA_VERSION = 'brief-v1';

const note = z.object({ from: z.string().min(1), note: z.string().min(1) }).strict();
const material = z.object({ id: z.string().min(1), title: z.string().min(1), text: z.string().min(1) }).strict();
const source = z.object({
  stage: z.enum(['b1', 'b2', 'b3']), runId: z.string().min(1), revision: z.string().min(1),
  acceptedAt: z.string().min(1), reviewer: z.string().min(1),
}).strict();

export const briefSchema = z.object({
  schemaVersion: z.literal(BRIEF_SCHEMA_VERSION),
  topicId: z.string().min(1),
  version: z.number().int().positive(),
  sources: z.array(source).min(1),
  creator: z.object({
    opportunity: z.string().min(1),
    account: z.object({ name: z.string(), positioning: z.string(), currentAudience: z.string(), referencePieces: z.array(z.record(z.string(), z.string())) }).strict(),
    form: z.string().min(1),
  }).strict(),
  audienceQuestion: z.record(z.string(), z.unknown()),
  decision: z.record(z.string(), z.unknown()),
  materials: z.array(material).min(1),
  notesForB2: z.array(note),
  script: z.record(z.string(), z.unknown()).optional(),
  notesForB3: z.array(note),
}).strict();
export type PieceBrief = z.infer<typeof briefSchema>;
export type StageNote = z.infer<typeof note>;

export interface GateAcceptance { runId: string; revision: string; acceptedAt: string; reviewer: string; notesForNext: string[] }

export function researchToMaterials(notes: ResearchNotes['notes']): PieceBrief['materials'] {
  return notes.map(n => ({
    id: n.id, title: n.title,
    text: `来源：${n.publisher}，${n.date}，${n.url}\n要点：\n- ${n.keyPoints.join('\n- ')}`,
  }));
}

/** Reviewer items that passed but were marked weak (or failed) are unresolved; the next stage should see them. */
function openItems(from: string, criteria: Array<{ id: string; result: string; reason: string }>): StageNote[] {
  return criteria.filter(c => c.result !== 'ok').map(c => ({ from, note: `${c.id} ${c.result === 'weak' ? '偏弱' : '未通过'}：${c.reason}` }));
}

export function briefAfterB1(args: {
  input: Pick<B1Input, 'topicId' | 'opportunity' | 'account' | 'form' | 'materials'>;
  audienceQuestion: AudienceQuestion; decision: ContentDecision; research: ResearchNotes['notes']; challenge?: Challenge;
  previousVersion?: number; gate: GateAcceptance;
}): PieceBrief {
  const materials = [...args.input.materials];
  for (const m of researchToMaterials(args.research)) {
    if (!materials.some(existing => existing.id === m.id)) materials.push(m);
  }
  const { markdown: _markdown, ...decision } = args.decision as ContentDecision & { markdown?: string };
  return briefSchema.parse({
    schemaVersion: BRIEF_SCHEMA_VERSION, topicId: args.input.topicId, version: (args.previousVersion ?? 0) + 1,
    sources: [{ stage: 'b1', runId: args.gate.runId, revision: args.gate.revision, acceptedAt: args.gate.acceptedAt, reviewer: args.gate.reviewer }],
    creator: { opportunity: args.input.opportunity, account: args.input.account, form: args.input.form },
    audienceQuestion: args.audienceQuestion, decision, materials,
    notesForB2: [
      ...args.gate.notesForNext.map(n => ({ from: args.gate.reviewer, note: n })),
      ...(args.challenge ? openItems('B1 挑战者', args.challenge.criteria) : []),
    ],
    notesForB3: [],
  });
}

export function briefAfterB2(brief: PieceBrief, args: { script: Script; editor?: EditorVerdict; factCheck?: FactCheck; gate: GateAcceptance }): PieceBrief {
  const { markdown: _markdown, ...script } = args.script as Script & { markdown?: string };
  const editorNotes: StageNote[] = args.editor
    ? [{ from: 'B2 主编', note: args.editor.summary }, ...openItems('B2 主编', args.editor.criteria)]
    : [];
  const factNotes: StageNote[] = (args.factCheck?.issues ?? []).map(i => ({ from: 'B2 事实核查', note: `${i.segment}：${i.claim} → ${i.fix}` }));
  return briefSchema.parse({
    ...brief, version: brief.version + 1,
    sources: [...brief.sources.filter(s => s.stage === 'b1'), { stage: 'b2', runId: args.gate.runId, revision: args.gate.revision, acceptedAt: args.gate.acceptedAt, reviewer: args.gate.reviewer }],
    script, notesForB3: [...args.gate.notesForNext.map(n => ({ from: args.gate.reviewer, note: n })), ...editorNotes, ...factNotes],
  });
}

// ---------- per-role slices (the table at the bottom of stage-flow.html) ----------

export function b2WriterContext(brief: PieceBrief) {
  return {
    opportunity: brief.creator.opportunity, account: brief.creator.account, form: brief.creator.form,
    audienceQuestion: brief.audienceQuestion, decision: brief.decision, materials: brief.materials, notesForB2: brief.notesForB2,
  };
}

export function b2EditorContext(brief: PieceBrief) {
  return {
    opportunity: brief.creator.opportunity, account: brief.creator.account,
    audienceQuestion: brief.audienceQuestion, decision: brief.decision, notesForB2: brief.notesForB2,
  };
}

function core(brief: PieceBrief) {
  const d = brief.decision as Partial<ContentDecision>;
  return {
    coreQuestion: d.coreQuestion, oneLineAnswer: d.oneLineAnswer, hook: d.hook,
    beats: (d.beats ?? []).map(b => ({ beat: b.beat, visualIdea: b.visualIdea })),
  };
}

export function b3DesignerContext(brief: PieceBrief) {
  return { core: core(brief), account: { name: brief.creator.account.name, positioning: brief.creator.account.positioning }, notesForB3: brief.notesForB3 };
}

export function b3InspectorContext(brief: PieceBrief) {
  const { coreQuestion, oneLineAnswer, hook } = core(brief);
  return { core: { coreQuestion, oneLineAnswer, hook }, notesForB3: brief.notesForB3 };
}
