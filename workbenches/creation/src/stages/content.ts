import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { workflow, type ArtifactRef, type WorkflowDefinition, type WorkflowTerminal } from '@signal-room/workflow';
import { z } from 'zod';
import { check, dependency, isTerminal, listOf, objectSchema, oneOf, stageAgent, str, strList, type RoleSpec, type StageModel } from './runtime.js';

/** One content loop: understand the opportunity, decide, write, read cold, check facts, and edit. */
export const CONTENT_REVISION = 'content-v2';
export const contentStandardsPath = fileURLToPath(new URL('./standards/content.md', import.meta.url));

const accountSchema = z.object({
  name: z.string(), positioning: z.string(), currentAudience: z.string(),
  referencePieces: z.array(z.object({ title: z.string(), result: z.string(), lesson: z.string() }).strict()),
}).strict();
const materialSchema = z.object({ id: z.string().min(1), title: z.string().min(1), text: z.string().min(1) }).strict();
const segmentSchema = z.object({ time: z.string(), voiceover: z.string().min(1), onScreenText: z.string(), visual: z.string().min(1) });
const scriptSchema = z.object({
  title: z.string().min(1), coverText: z.string().min(1), estimatedSeconds: z.number().int().positive(),
  segments: z.array(segmentSchema).min(1), sourcesUsed: z.array(z.string()), changesFromPrevious: z.string(),
});
const beatSchema = z.object({ beat: z.string().min(1), says: z.string().min(1), evidence: z.array(z.string()), visualIdea: z.string().min(1) });
const decisionSchema = z.object({
  workingTitle: z.string().min(1), coreQuestion: z.string().min(1), oneLineAnswer: z.string().min(1),
  audience: z.string().min(1), audienceChange: z.string().min(1), hook: z.string().min(1),
  beats: z.array(beatSchema).min(1), accountAngle: z.string().min(1),
  form: z.string().min(1), notSaying: z.array(z.string()), biggestRisk: z.string().min(1),
  openQuestions: z.array(z.string()), alternativesConsidered: z.array(z.object({ answer: z.string(), whyNotChosen: z.string() })),
  changesFromPrevious: z.string(),
});
const draftSchema = z.object({ decision: decisionSchema, script: scriptSchema });
const noteSchema = z.object({
  id: z.string().min(1), title: z.string().min(1), url: z.string().min(1), publisher: z.string().min(1),
  date: z.string().min(1), keyPoints: z.array(z.string().min(1)).min(1), fillsGap: z.string().min(1), sourceKind: z.enum(['primary', 'secondary']),
});
const researchSchema = z.object({
  questions: z.array(z.object({ question: z.string().min(1), answer: z.string().min(1), materialRefs: z.array(z.string()), gap: z.string() })).min(1),
  notes: z.array(noteSchema), remainingGaps: z.array(z.string()),
});
const readerSchema = z.object({
  retell: z.string().min(1), oneLineAnswerAsUnderstood: z.string().min(1),
  unansweredQuestions: z.array(z.string().min(1)),
  lostAt: z.array(z.object({ segment: z.string(), why: z.string() })),
  boredAt: z.array(z.object({ segment: z.string(), why: z.string() })),
  keepWatchingAt3s: z.object({ yes: z.boolean(), why: z.string() }),
  keepWatchingAt30s: z.object({ yes: z.boolean(), why: z.string() }), mostMemorable: z.string(),
});
const factSchema = z.object({
  issues: z.array(z.object({ segment: z.string(), claim: z.string(), problem: z.enum(['wrong', 'overclaim', 'unsupported']), evidence: z.string(), fix: z.string() })),
  summary: z.string().min(1),
});
const reviewSchema = z.object({
  verdict: z.enum(['pass', 'revise', 'blocked']), route: z.enum(['pass', 'rewrite', 'research', 'reframe', 'blocked']),
  criteria: z.array(z.object({ id: z.string(), result: z.enum(['ok', 'weak', 'fail']), reason: z.string() })).min(1),
  questionCoverage: z.array(z.object({ question: z.string(), answerInDraft: z.string(), missing: z.string(), result: z.enum(['ok', 'weak', 'fail']) })),
  mustChange: z.array(z.string()), summary: z.string().min(1),
});
export type ContentDraft = z.infer<typeof draftSchema>;
export type ContentReview = z.infer<typeof reviewSchema> & { guardFailures?: string[] };
export type ContentResearch = z.infer<typeof researchSchema>;
type ColdRead = z.infer<typeof readerSchema>;
export type ContentFactCheck = z.infer<typeof factSchema>;
type FactCheck = ContentFactCheck;

export const contentInputSchema = z.object({
  topicId: z.string().min(1), opportunity: z.string().min(1), account: accountSchema, form: z.string().min(1),
  materials: z.array(materialSchema).min(1), standards: z.string().min(1), webResearch: z.boolean(),
  readerGoal: z.string().min(1), requiredQuestions: z.array(z.string().min(1)).min(1),
  maxRevisions: z.number().int().min(0).max(5), maxSeconds: z.number().int().positive().optional(),
  prior: z.object({ draft: draftSchema, humanReview: z.object({ reviewer: z.string().min(1), notes: z.array(z.string().min(1)).min(1) }).strict() }).strict().optional(),
}).strict().superRefine((input, ctx) => {
  const ids = new Set<string>();
  for (const [index, material] of input.materials.entries()) {
    if (ids.has(material.id)) ctx.addIssue({ code: 'custom', path: ['materials', index, 'id'], message: `Duplicate material id: ${material.id}` });
    ids.add(material.id);
  }
});
export type ContentInput = z.infer<typeof contentInputSchema>;

const common = '用中文输出。只返回符合 schema 的 JSON。';
const segmentJson = objectSchema({ time: str, voiceover: str, onScreenText: str, visual: str });
const decisionJson = objectSchema({
  workingTitle: str, coreQuestion: str, oneLineAnswer: str, audience: str, audienceChange: str, hook: str,
  beats: listOf(objectSchema({ beat: str, says: str, evidence: strList, visualIdea: str })), accountAngle: str,
  form: str, notSaying: strList, biggestRisk: str, openQuestions: strList,
  alternativesConsidered: listOf(objectSchema({ answer: str, whyNotChosen: str })), changesFromPrevious: str,
});
const draftJson = objectSchema({ decision: decisionJson, script: objectSchema({
  title: str, coverText: str, estimatedSeconds: { type: 'integer' }, segments: listOf(segmentJson),
  sourcesUsed: strList, changesFromPrevious: str,
}) });
export const CONTENT_ROLES = {
  researcher: {
    id: 'content-researcher', title: '研究编辑', guards: '从原机会和阅读目标理解内容，核对现有材料，并补决定性证据。', webSearch: true,
    prompt: `你是研究编辑。每一轮都重新看原始机会、readerGoal、requiredQuestions 和材料；不要把上一稿自拟的观众直觉当成用户要求。逐项回答必答问题，区分已有证据、仍缺的证据和目前不能回答的事。优先读取创作者点名案例的一手资料。仅当输入 webResearch=true 时才允许联网；否则只用提供的材料，不声称读到新网页。研究问题不限于证明最终能力，还包括观众希望看懂的过程、机制和经济含义。若上一轮主编要求 research/reframe，连同全文和审阅意见及程序核出的缺口重新界定问题；reframe 允许修正内容主线。新来源 notes 可为空，不要虚构。materialRefs 只填已有材料或 notes 的准确 id，不要拼上标题或 URL；新 note.id 与已有材料保持唯一。${common}`,
    outputSchema: objectSchema({ questions: listOf(objectSchema({ question: str, answer: str, materialRefs: strList, gap: str })), notes: listOf(objectSchema({
      id: str, title: str, url: str, publisher: str, date: str, keyPoints: strList, fillsGap: str, sourceKind: oneOf('primary', 'secondary'),
    })), remainingGaps: strList }),
  },
  author: {
    id: 'content-author', title: '作者', guards: '在同一稿里完成内容决定和完整表达。',
    prompt: `你是作者，交付同一版的 decision 和 script，不把选题与写稿拆成两个冻结阶段。以原始机会、readerGoal 和 requiredQuestions 为准选择最有价值、能被材料支撑的主线；研究编辑的缺口也要看。decision 的 coreQuestion/oneLineAnswer/hook/beats 与 script 必须一致；beats 数量由内容决定。script 包含标题、封面、各段口播、屏幕文字和画面意图，足以直接给制作。sourcesUsed 和 beats.evidence 只填材料的准确 id，不能拼上 URL 或标题。解释所必需的新概念首次出现就用目标读者听得懂的话交代；用具体过程说明前后如何改变，不用“调整”“优化”“更强信号”等术语代替因果解释。数字只保留对理解有用的部分，时间分配应让普通读者跟得上。逐个回答必答问题，解释机制而不堆术语。除非输入显式给 maxSeconds，否则不要套用固定时长；给了则必须遵守。收到主编意见时按 route 改稿；research/reframe 后允许重定主线。收到 humanReview 优先落实，但不得改写原机会。事实只用已提供材料或研究编辑实际核实的来源。${common}`,
    outputSchema: draftJson,
  },
  reader: {
    id: 'content-cold-reader', title: '冷读者', guards: '只依据观众可看到的完整稿描述自己的理解。',
    prompt: `你扮演输入 profile 描述的目标观众，只看到标题、封面字、口播、屏幕文字和画面描述。用自己的话复述学到了什么、在哪里跟丢或想划走、能否继续看、记住了什么；特别列出读完后仍想问、稿子没讲清的问题，若无则 unansweredQuestions 为空数组。不要读取作者意图、标准卡、研究材料或必答问题；不要给写作建议。${common}`,
    outputSchema: objectSchema({ retell: str, oneLineAnswerAsUnderstood: str, unansweredQuestions: strList,
      lostAt: listOf(objectSchema({ segment: str, why: str })), boredAt: listOf(objectSchema({ segment: str, why: str })),
      keepWatchingAt3s: objectSchema({ yes: { type: 'boolean' }, why: str }),
      keepWatchingAt30s: objectSchema({ yes: { type: 'boolean' }, why: str }), mostMemorable: str }),
  },
  checker: {
    id: 'content-fact-checker', title: '事实核查', guards: '核对每段事实和每个材料引用。',
    prompt: `你是事实核查。逐段检查口播、屏幕文字和内容决定中的事实性说法，只报告 wrong、overclaim、unsupported，给出所见材料和可执行改法。材料未覆盖的问题不能冒充已核实。没有问题则 issues 为空。${common}`,
    outputSchema: objectSchema({ issues: listOf(objectSchema({ segment: str, claim: str, problem: oneOf('wrong', 'overclaim', 'unsupported'), evidence: str, fix: str })), summary: str }),
  },
  editor: {
    id: 'content-editor', title: '主编', guards: '决定通过、改稿、补证或重定主线，并逐项验收学习目标。',
    prompt: `你是主编，按标准卡 C1–C8 逐项审完整 decision+script，不能漏项。逐项列出 requiredQuestions 的 questionCoverage，question 必须逐字复制对应的 requiredQuestions，不能改写；已完整解答时 missing 必须是空字符串，不要写“无/暂无/不适用”：answerInDraft 必须是真正在稿里教给观众的答案，missing 写欠缺解释；不能只因素材有答案就给 ok。结合冷读者 unansweredQuestions 检查他是否仍不懂正文承诺要解释的关键因果；能复述术语或一句结论，不代表理解了机制。分清必要解释缺口和主题范围之外的好奇，后者不应阻断。对照冷读者的 unansweredQuestions，看读完仍有哪些本题关键疑问；能复述几句不等于已理解。若 readerGoal 没达成或任何必答问题缺失/解释不足，不能 pass。事实核查有明显 issues、显式 maxSeconds 超标也不能 pass。route= rewrite（局部或全篇改稿）、research（缺证据）、reframe（内容问题/目标主线错）、blocked（本轮无法继续）。每个 mustChange 写可操作动作；优先解释观众真正想学会的内容，不要机械套用错误直觉、等长替换或固定时长。只有全稿达标且 mustChange 为空才 verdict=pass, route=pass；其余可 revise 并选择回退路径。${common}`,
    outputSchema: objectSchema({ verdict: oneOf('pass', 'revise', 'blocked'), route: oneOf('pass', 'rewrite', 'research', 'reframe', 'blocked'),
      criteria: listOf(objectSchema({ id: str, result: oneOf('ok', 'weak', 'fail'), reason: str })),
      questionCoverage: listOf(objectSchema({ question: str, answerInDraft: str, missing: str, result: oneOf('ok', 'weak', 'fail') })),
      mustChange: strList, summary: str }),
  },
} satisfies Record<string, RoleSpec>;

export interface ContentGateDetails {
  stage: 'CONTENT'; reason: 'awaiting-human-review' | 'not-converged' | 'blocked';
  draft: ArtifactRef; review: ArtifactRef; research: ArtifactRef; rounds: number; guardFailures: string[];
}
type Published<T> = { value: T; ref: ArtifactRef };
export function contentDraftMarkdown(draft: ContentDraft): string {
  const d = draft.decision;
  return [`# ${draft.script.title}`, '', `核心问题：${d.coreQuestion}`, `一句话答案：${d.oneLineAnswer}`, `观众看完应能：${d.audienceChange}`, '',
    `封面字：${draft.script.coverText} · 预计 ${draft.script.estimatedSeconds} 秒`, '',
    '| 时间 | 口播 | 屏幕文字 | 画面 |', '|---|---|---|---|',
    ...draft.script.segments.map(s => `| ${s.time} | ${s.voiceover} | ${s.onScreenText} | ${s.visual} |`), '',
    `来源：${draft.script.sourcesUsed.join('、') || '无'}`, `本版改动：${draft.script.changesFromPrevious}`, ''].join('\n');
}
function viewerView(draft: ContentDraft, profile: string) {
  const { title, coverText, segments } = draft.script;
  return { profile, title, coverText, segments: segments.map(({ time, voiceover, onScreenText, visual }) => ({ time, voiceover, onScreenText, visual })) };
}
function mergeResearch(previous: ContentResearch | undefined, current: ContentResearch): ContentResearch {
  const notes = (previous?.notes ?? []).map(n => ({ ...n, keyPoints: [...n.keyPoints] }));
  const aliases = new Map<string, string>();
  for (const note of current.notes) {
    const sameUrl = notes.find(n => n.url === note.url);
    if (sameUrl) {
      if (note.id !== sameUrl.id) aliases.set(note.id, sameUrl.id);
      sameUrl.keyPoints = [...new Set([...sameUrl.keyPoints, ...note.keyPoints])];
      sameUrl.fillsGap = [...new Set([sameUrl.fillsGap, note.fillsGap].filter(Boolean))].join('；');
      continue;
    }
    notes.push(note);
  }
  return { questions: current.questions.map(q => ({ ...q, materialRefs: q.materialRefs.map(id => aliases.get(id) ?? id) })),
    notes, remainingGaps: current.remainingGaps };
}
function sourceIdConflicts(input: ContentInput, research: ContentResearch): string[] {
  const seen = new Map(input.materials.map(m => [m.id, `input:${m.title}`]));
  const conflicts: string[] = [];
  for (const note of research.notes) {
    const previous = seen.get(note.id);
    if (previous && previous !== note.url) conflicts.push(`Source id ${note.id} identifies both ${previous} and ${note.url}`);
    else seen.set(note.id, note.url);
  }
  return conflicts;
}
function materialsFor(input: ContentInput, research: ContentResearch) {
  return [...input.materials, ...research.notes.map(n => ({ id: n.id, title: n.title,
    text: `来源：${n.publisher}，${n.date}，${n.url}\n要点：\n- ${n.keyPoints.join('\n- ')}` }))];
}
/** Shared by the running workflow and the creator gate; never infer acceptance from a model verdict alone. */
export function contentAcceptanceFailures(input: ContentInput, review: ContentReview, factCheck: ContentFactCheck,
  draft: ContentDraft, research?: ContentResearch): string[] {
  const failures: string[] = [];
  if (research) {
    failures.push(...sourceIdConflicts(input, research));
    const available = new Set([...input.materials.map(m => m.id), ...research.notes.map(n => n.id)]);
    const references = [
      ...draft.script.sourcesUsed.map(id => ({ id, location: 'script.sourcesUsed' })),
      ...draft.decision.beats.flatMap((beat, index) => beat.evidence.map(id => ({ id, location: `decision.beats[${index}].evidence` }))),
      ...research.questions.flatMap((question, index) => question.materialRefs.map(id => ({ id, location: `research.questions[${index}].materialRefs` }))),
    ];
    for (const { id, location } of references) if (!available.has(id)) failures.push(`Unknown source id ${id} in ${location}`);
  }
  if (review.verdict === 'pass' || review.route === 'pass') {
    if (review.verdict !== 'pass' || review.route !== 'pass') failures.push('verdict/route mismatch');
    const expected = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8'];
    for (const id of expected) if (review.criteria.filter(c => c.id === id).length !== 1) failures.push(`missing or duplicate criterion: ${id}`);
    if (review.criteria.some(c => c.result === 'fail')) failures.push('editor criteria contain fail');
    if (review.mustChange.length) failures.push('editor mustChange is not empty');
    for (const question of input.requiredQuestions) {
      const rows = review.questionCoverage.filter(c => c.question === question);
      if (rows.length !== 1 || rows[0].result !== 'ok' || !rows[0].answerInDraft.trim() || rows[0].missing.trim()) failures.push(`required question not answered: ${question}`);
    }
    if (factCheck.issues.length) failures.push('fact-check issues remain');
    if (input.maxSeconds !== undefined && draft.script.estimatedSeconds > input.maxSeconds) failures.push('hard time limit exceeded');
  }
  return failures;
}

export function createContentWorkflow(models: { worker: StageModel; judge: StageModel }): WorkflowDefinition<ContentInput, WorkflowTerminal<never>> {
  const author = stageAgent<unknown, ContentDraft>(CONTENT_ROLES.author, models.judge, CONTENT_REVISION);
  const reader = stageAgent<unknown, ColdRead>(CONTENT_ROLES.reader, models.worker, CONTENT_REVISION);
  const checker = stageAgent<unknown, FactCheck>(CONTENT_ROLES.checker, models.worker, CONTENT_REVISION);
  const editor = stageAgent<unknown, ContentReview>(CONTENT_ROLES.editor, models.judge, CONTENT_REVISION);
  return workflow<ContentInput, WorkflowTerminal<never>>('creation.content', { revision: CONTENT_REVISION }, async (ctx, raw) => {
    const input = contentInputSchema.parse(raw);
    const researcher = stageAgent<unknown, ContentResearch>(
      { ...CONTENT_ROLES.researcher, webSearch: input.webResearch }, models.worker, CONTENT_REVISION,
    );
    let research: Published<ContentResearch> | undefined;
    let draft: Published<ContentDraft> | undefined;
    let review: Published<ContentReview> | undefined;
    let route: ContentReview['route'] = 'research';
    const original = { opportunity: input.opportunity, readerGoal: input.readerGoal, requiredQuestions: input.requiredQuestions,
      account: input.account, form: input.form, standards: input.standards, ...(input.maxSeconds !== undefined ? { maxSeconds: input.maxSeconds } : {}),
      ...(input.prior ? { humanReview: input.prior.humanReview } : {}) };
    for (let round = 0; round <= input.maxRevisions; round++) {
      if (round === 0 || route === 'research' || route === 'reframe') {
        const previousResearch = research;
        const previousDraft = draft;
        const previousReview = review;
        const found = await ctx.phase(`content-research-${round}`, {
          title: `研究编辑 v${round + 1}`, purpose: CONTENT_ROLES.researcher.guards, order: round * 20 + 1,
          expectedArtifacts: [{ role: 'research', title: '材料对答', required: true }],
        }, async phase => {
          const value = await phase.agent('research', researcher, {
            ...original, webResearch: input.webResearch, materials: materialsFor(input, previousResearch?.value ?? { questions: [], notes: [], remainingGaps: [] }),
            ...(previousDraft ? { previousDraft: previousDraft.value, previousReview: previousReview?.value,
              guardFailures: previousReview?.value.guardFailures ?? [], route } : {}),
            ...(round === 0 && input.prior ? { previousDraft: input.prior.draft } : {}),
          });
          const valid = await phase.validate('check-research', value, v => check(researchSchema, v));
          if (!valid.valid) return phase.blocked({ reason: 'invalid-research', details: valid.details });
          const conflicts = sourceIdConflicts(input, { ...value, notes: [...(previousResearch?.value.notes ?? []), ...value.notes] });
          if (conflicts.length) return phase.blocked({ reason: 'source-id-conflict', details: conflicts });
          const combined = mergeResearch(previousResearch?.value, value);
          const ref = await phase.publish('research', 'content-research', combined, { validation: 'valid', review: 'not_applicable',
            dependsOn: [previousResearch?.ref, previousDraft?.ref, previousReview?.ref].filter((r): r is ArtifactRef => !!r).map(dependency) });
          await phase.bindArtifact(ref, { role: 'research', title: '材料对答', primary: true });
          return { value: combined, ref };
        });
        if (isTerminal(found)) return found;
        research = found;
      }
      const currentResearch = research!;
      const previousDraft = draft;
      const previousReview = review;
      const written = await ctx.phase(`content-draft-${round}`, {
        title: `内容与完整稿 v${round + 1}`, purpose: CONTENT_ROLES.author.guards, order: round * 20 + 3,
        expectedArtifacts: [{ role: 'draft', title: '内容决定与完整稿', required: true }],
      }, async phase => {
        const value = await phase.agent('write', author, { ...original,
          research: currentResearch.value, materials: materialsFor(input, currentResearch.value),
          ...(previousDraft ? { previousDraft: previousDraft.value, review: previousReview?.value,
            guardFailures: previousReview?.value.guardFailures ?? [], route } : {}),
          ...(round === 0 && input.prior ? { previousDraft: input.prior.draft } : {}),
        });
        const valid = await phase.validate('check-draft', value, v => check(draftSchema, v));
        if (!valid.valid) return phase.blocked({ reason: 'invalid-draft', details: valid.details });
        const ref = await phase.publish('draft', 'content-draft', { ...value, markdown: contentDraftMarkdown(value) }, {
          validation: 'valid', review: 'pending', dependsOn: [dependency(currentResearch.ref), ...(previousDraft ? [dependency(previousDraft.ref)] : []), ...(previousReview ? [dependency(previousReview.ref)] : [])],
        });
        await phase.bindArtifact(ref, { role: 'draft', title: '内容决定与完整稿', primary: true });
        return { value, ref };
      });
      if (isTerminal(written)) return written;
      draft = written;
      const currentDraft = draft;
      const checked = await ctx.phase(`content-check-${round}`, {
        title: `冷读与事实核查 v${round + 1}`, purpose: '独立审阅同一版完整稿', order: round * 20 + 5,
        expectedArtifacts: [{ role: 'reader', title: '冷读体验', required: true }, { role: 'checker', title: '事实核查', required: true }],
      }, async phase => {
        const both = await phase.parallel('reviewers', {
          reader: () => phase.agent('cold-read', reader, viewerView(currentDraft.value, input.account.currentAudience)),
          checker: () => phase.agent('fact-check', checker, { draft: currentDraft.value, materials: materialsFor(input, currentResearch.value) }),
        }, { concurrency: 2 });
        const cold = both.reader as ColdRead;
        const facts = both.checker as FactCheck;
        const cv = await phase.validate('check-reader', cold, v => check(readerSchema, v));
        const fv = await phase.validate('check-facts', facts, v => check(factSchema, v));
        if (!cv.valid || !fv.valid) return phase.blocked({ reason: 'invalid-reviewers', details: [cv, fv] });
        const coldRef = await phase.publish('reader', 'content-reader', cold, { validation: 'valid', review: 'not_applicable', dependsOn: [dependency(currentDraft.ref)] });
        const factRef = await phase.publish('checker', 'content-fact-check', facts, { validation: 'valid', review: 'not_applicable', dependsOn: [dependency(currentDraft.ref), dependency(currentResearch.ref)] });
        await phase.bindArtifact(coldRef, { role: 'reader', title: '冷读体验', primary: true });
        await phase.bindArtifact(factRef, { role: 'checker', title: '事实核查' });
        return { reader: { value: cold, ref: coldRef }, checker: { value: facts, ref: factRef } };
      });
      if (isTerminal(checked)) return checked;
      const edited = await ctx.phase(`content-editor-${round}`, {
        title: `主编 v${round + 1}`, purpose: CONTENT_ROLES.editor.guards, order: round * 20 + 7,
        expectedArtifacts: [{ role: 'review', title: '主编意见', required: true }],
      }, async phase => {
        const value = await phase.agent('edit', editor, { ...original, draft: currentDraft.value, research: currentResearch.value,
          coldRead: checked.reader.value, factCheck: checked.checker.value });
        const valid = await phase.validate('check-editor', value, v => check(reviewSchema, v));
        if (!valid.valid) return phase.blocked({ reason: 'invalid-editor', details: valid.details });
        const guardFailures = contentAcceptanceFailures(input, value, checked.checker.value, currentDraft.value, currentResearch.value);
        const recorded: ContentReview = { ...value, guardFailures };
        const ref = await phase.publish('review', 'content-review', recorded, { validation: 'valid', review: 'not_applicable',
          dependsOn: [dependency(currentDraft.ref), dependency(currentResearch.ref), dependency(checked.reader.ref), dependency(checked.checker.ref)] });
        await phase.bindArtifact(ref, { role: 'review', title: '主编意见', primary: true });
        return { value: recorded, ref };
      });
      if (isTerminal(edited)) return edited;
      review = edited;
      const failures = edited.value.guardFailures ?? [];
      ctx.decide(`content-route-${round}`, { route: edited.value.route, verdict: edited.value.verdict, failures, round });
      const details = (reason: ContentGateDetails['reason']): ContentGateDetails => ({ stage: 'CONTENT', reason,
        draft: currentDraft.ref, review: edited.ref, research: currentResearch.ref, rounds: round + 1, guardFailures: failures });
      if (edited.value.verdict === 'pass' && edited.value.route === 'pass' && failures.length === 0) return ctx.needsReview(details('awaiting-human-review'));
      if (edited.value.verdict === 'blocked' || edited.value.route === 'blocked') return ctx.needsReview(details('blocked'));
      if (round >= input.maxRevisions) return ctx.needsReview(details('not-converged'));
      route = failures.length && edited.value.route === 'pass' ? 'rewrite' : edited.value.route;
    }
    throw new Error('Unreachable content loop');
  });
}
export function readContentStandards(): string { return readFileSync(contentStandardsPath, 'utf8'); }
