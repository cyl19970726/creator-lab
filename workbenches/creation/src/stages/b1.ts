import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { workflow, type ArtifactRef, type WorkflowDefinition, type WorkflowTerminal } from '@signal-room/workflow';
import { z } from 'zod';
import {
  check, dependency, isTerminal, listOf, objectSchema, oneOf, stageAgent, str, strList,
  type RoleSpec, type StageModel,
} from './runtime.js';

/**
 * B1 · 定题. The stage decides which question this piece answers, for whom, and whether we can answer it well.
 * Its failure mode in past runs: starting from the research material and describing it, then drowning
 * the result in disclaimers. Each role below exists to catch one specific way B1 goes wrong.
 */
export const B1_REVISION = 'b1-v2';

export const b1StandardsPath = fileURLToPath(new URL('./standards/b1.md', import.meta.url));

const materialSchema = z.object({ id: z.string().min(1), title: z.string().min(1), text: z.string().min(1) }).strict();
export const b1InputSchema = z.object({
  topicId: z.string().min(1),
  opportunity: z.string().min(1),
  account: z.object({
    name: z.string().min(1),
    positioning: z.string().min(1),
    currentAudience: z.string().min(1),
    referencePieces: z.array(z.object({ title: z.string(), result: z.string(), lesson: z.string() }).strict()),
  }).strict(),
  form: z.string().min(1),
  materials: z.array(materialSchema).min(1),
  standards: z.string().min(1),
  webResearch: z.boolean(),
  maxRevisions: z.number().int().min(0).max(3),
  /** A later round after the human gate: reuse the earlier analysis and revise from the reviewer's notes. */
  prior: z.object({
    audienceQuestion: z.record(z.string(), z.unknown()),
    evidenceMap: z.record(z.string(), z.unknown()),
    researchNotes: z.record(z.string(), z.unknown()).nullable(),
    decision: z.record(z.string(), z.unknown()),
    humanReview: z.object({
      reviewer: z.string().min(1),
      verdict: z.enum(['accept', 'revise', 'reject']),
      notes: z.array(z.string().min(1)).min(1),
      researchRequest: z.string().optional(),
    }).strict(),
  }).strict().optional(),
}).strict();
export type B1Input = z.infer<typeof b1InputSchema>;
export type HumanReview = NonNullable<B1Input['prior']>['humanReview'];

const audienceSchema = z.object({
  questionInAudienceWords: z.string().min(1),
  variants: z.array(z.string()),
  currentIntuition: z.string().min(1),
  contradiction: z.string().min(1),
  desiredChange: z.string().min(1),
  demandSignals: z.array(z.object({ signal: z.string(), status: z.enum(['creator-judgment', 'observable', 'unverified']) })),
  premisesToCheck: z.array(z.string()),
});
const evidenceSchema = z.object({
  whatMaterialsActuallyAnswer: z.string().min(1),
  subQuestions: z.array(z.object({
    id: z.string(), question: z.string(), answerSketch: z.string(),
    support: z.enum(['direct', 'partial', 'none']), materialRefs: z.array(z.string()), note: z.string(),
  })).min(1),
  decisiveGaps: z.array(z.object({ gap: z.string(), whyDecisive: z.string(), whereToLook: z.string() })),
  verdict: z.enum(['sufficient', 'gaps-fillable', 'mismatch']),
});
const researchSchema = z.object({
  notes: z.array(z.object({
    id: z.string().min(1), title: z.string(), url: z.string(), publisher: z.string(), date: z.string(),
    keyPoints: z.array(z.string()).min(1), fillsGap: z.string(), sourceKind: z.enum(['primary', 'secondary']),
  })),
  remainingGaps: z.array(z.string()),
});
const decisionSchema = z.object({
  workingTitle: z.string().min(1),
  coreQuestion: z.string().min(1),
  oneLineAnswer: z.string().min(1),
  audience: z.string().min(1),
  audienceChange: z.string().min(1),
  hook: z.string().min(1),
  beats: z.array(z.object({ beat: z.string(), says: z.string(), evidence: z.array(z.string()), visualIdea: z.string() })).min(2).max(6),
  accountAngle: z.string().min(1),
  form: z.string().min(1),
  notSaying: z.array(z.string()).min(1),
  biggestRisk: z.string().min(1),
  openQuestions: z.array(z.string()),
  changesFromPrevious: z.string(),
});
const challengeSchema = z.object({
  verdict: z.enum(['pass', 'revise', 'blocked']),
  criteria: z.array(z.object({ id: z.string(), result: z.enum(['ok', 'weak', 'fail']), reason: z.string() })).min(1),
  mustChange: z.array(z.string()),
  niceToChange: z.array(z.string()),
  summary: z.string().min(1),
});
export type AudienceQuestion = z.infer<typeof audienceSchema>;
export type EvidenceMap = z.infer<typeof evidenceSchema>;
export type ResearchNotes = z.infer<typeof researchSchema>;
export type ContentDecision = z.infer<typeof decisionSchema>;
export type Challenge = z.infer<typeof challengeSchema>;

const COMMON = '用中文输出。只依据提供的输入；不编造数据、热度、来源或厂商事实。只返回符合 schema 的 JSON。';

export const B1_ROLES = {
  audience: {
    id: 'b1-audience', title: '观众问题',
    guards: '防止从材料出发选题：先确定观众真正会问什么、他们现在怎么想。',
    prompt: `你是内容策划中的"观众代言人"。根据创作者的机会判断和账号现状，写出目标观众会用自己的话提出的核心问题，他们现在的直觉（常常是错的或不完整的），这个问题让人觉得矛盾的地方，以及看完后他们应该有什么变化。把"有人关心"的依据逐条标注：创作者判断 / 可观察信号 / 未验证。列出问题里需要拆开核实的前提（例如"弱""强"各指什么）。不要看研究材料来改写问题——问题属于观众。${COMMON}`,
    outputSchema: objectSchema({
      questionInAudienceWords: str, variants: strList, currentIntuition: str, contradiction: str, desiredChange: str,
      demandSignals: listOf(objectSchema({ signal: str, status: oneOf('creator-judgment', 'observable', 'unverified') })),
      premisesToCheck: strList,
    }),
  },
  evidence: {
    id: 'b1-evidence', title: '材料对答',
    guards: '防止"材料答非所问"：逐个子问题检查材料能不能回答，发现缺口。',
    prompt: `你是研究编辑。把观众的核心问题拆成 3–6 个必须回答的子问题，逐个检查提供的材料能否回答：direct / partial / none，并写出答案草图和引用的材料 id。先用一句话说清"这批材料真正回答的是什么问题"——它可能和观众的问题不同，要诚实指出。列出决定性缺口（不补就答不了核心问题的），并写明去哪里找（论文、官方文档、可验证的一手资料）。verdict：sufficient（够用）/ gaps-fillable（缺口可补）/ mismatch（材料与问题基本不相干）。${COMMON}`,
    outputSchema: objectSchema({
      whatMaterialsActuallyAnswer: str,
      subQuestions: listOf(objectSchema({ id: str, question: str, answerSketch: str, support: oneOf('direct', 'partial', 'none'), materialRefs: strList, note: str })),
      decisiveGaps: listOf(objectSchema({ gap: str, whyDecisive: str, whereToLook: str })),
      verdict: oneOf('sufficient', 'gaps-fillable', 'mismatch'),
    }),
  },
  research: {
    id: 'b1-research', title: '补材料', webSearch: true,
    guards: '防止为了迁就材料而偷换问题：缺口先补，补不上再缩小承诺。',
    prompt: `你是研究员，可以联网搜索。针对给出的决定性缺口，找一手或权威来源（论文、官方技术报告、官方博客/仓库），每条来源写清标题、URL、发布方、日期、能支持的要点（逐条、克制、可核对）以及它填补了哪个缺口。只写你在来源里实际读到的内容；读不到就不要写。补不上的缺口放进 remainingGaps。每条 note 的 id 用 "web-" 开头。${COMMON}`,
    outputSchema: objectSchema({
      notes: listOf(objectSchema({ id: str, title: str, url: str, publisher: str, date: str, keyPoints: strList, fillsGap: str, sourceKind: oneOf('primary', 'secondary') })),
      remainingGaps: strList,
    }),
  },
  planner: {
    id: 'b1-planner', title: '内容决定',
    guards: '把观众问题、材料和账号视角合成一个可执行的决定，交给 B2。',
    prompt: `你是这一篇的策划。写一页"内容决定"：工作标题、核心问题（观众的话）、一句话答案（让人"原来如此"，不是机制清单）、目标观众与看完后的变化、开头钩子（10 秒内说什么）、3–5 个节拍（每个节拍说什么、依据哪些材料 id、画面想法）、账号视角（技术之外，钱和算力花在哪、为什么）、载体与时长、明确不讲什么、最大风险、仍待确认的问题。严格遵守标准卡。严谨靠准确而不是免责：限定语只放在真正会误导的地方，最多两处。若收到 humanReview（创作者本人或其代理的审阅），它的优先级最高，逐条落实；若收到挑战意见，逐条回应 mustChange。在 changesFromPrevious 写清改了什么；首版写"首版"。${COMMON}`,
    outputSchema: objectSchema({
      workingTitle: str, coreQuestion: str, oneLineAnswer: str, audience: str, audienceChange: str, hook: str,
      beats: listOf(objectSchema({ beat: str, says: str, evidence: strList, visualIdea: str })),
      accountAngle: str, form: str, notSaying: strList, biggestRisk: str, openQuestions: strList, changesFromPrevious: str,
    }),
  },
  challenger: {
    id: 'b1-challenger', title: '挑战者',
    guards: '替用户先审一遍：按标准卡逐条判断，只提会改变结果的意见。',
    prompt: `你是独立挑战者，代表创作者本人审这份内容决定。逐条按标准卡（S1–S8）给 ok / weak / fail 和一句具体理由；任何 fail 则 verdict=revise；材料根本撑不住核心问题且无法补救时 verdict=blocked。mustChange 只写会改变结果的修改，每条要具体到"把什么改成什么"；不要要求增加免责声明或补充无关细节——那正是过去让稿子越改越密的原因。标准卡末尾若有用户审阅记录，它们的权重高于你的个人偏好。${COMMON}`,
    outputSchema: objectSchema({
      verdict: oneOf('pass', 'revise', 'blocked'),
      criteria: listOf(objectSchema({ id: str, result: oneOf('ok', 'weak', 'fail'), reason: str })),
      mustChange: strList, niceToChange: strList, summary: str,
    }),
  },
} satisfies Record<string, RoleSpec>;

export interface Published<T> { value: T; ref: ArtifactRef }
/** B1 always ends at the human gate; this is the needs_review detail shape. */
export interface B1GateDetails {
  stage: 'B1';
  reason: 'awaiting-human-review' | 'not-converged' | 'blocked';
  decision: ArtifactRef;
  challenge: ArtifactRef;
  rounds: number;
}

export function b1Markdown(decision: ContentDecision): string {
  const beats = decision.beats.map((beat, index) =>
    `${index + 1}. **${beat.beat.replace(/^\d+[.、．]\s*/, "")}** — ${beat.says}\n   - 依据：${beat.evidence.join('、') || '无'}\n   - 画面：${beat.visualIdea}`).join('\n');
  return [
    `# ${decision.workingTitle}`, '',
    `**核心问题**：${decision.coreQuestion}`, '',
    `**一句话答案**：${decision.oneLineAnswer}`, '',
    `**观众**：${decision.audience}`, '', `**看完的变化**：${decision.audienceChange}`, '',
    `**开头钩子**：${decision.hook}`, '', '## 节拍', beats, '',
    `**账号视角**：${decision.accountAngle}`, '', `**载体**：${decision.form}`, '',
    '**不讲什么**', ...decision.notSaying.map(item => `- ${item}`), '',
    `**最大风险**：${decision.biggestRisk}`, '',
    '**待确认**', ...(decision.openQuestions.length ? decision.openQuestions.map(item => `- ${item}`) : ['- 无']), '',
    `**本版改动**：${decision.changesFromPrevious}`, '',
  ].join('\n');
}

export function createB1Workflow(model: { worker: StageModel; judge: StageModel }): WorkflowDefinition<B1Input, WorkflowTerminal<never>> {
  const audience = stageAgent<unknown, AudienceQuestion>(B1_ROLES.audience, model.worker, B1_REVISION);
  const evidence = stageAgent<unknown, EvidenceMap>(B1_ROLES.evidence, model.worker, B1_REVISION);
  const research = stageAgent<unknown, ResearchNotes>(B1_ROLES.research, model.worker, B1_REVISION);
  const planner = stageAgent<unknown, ContentDecision>(B1_ROLES.planner, model.judge, B1_REVISION);
  const challenger = stageAgent<unknown, Challenge>(B1_ROLES.challenger, model.judge, B1_REVISION);

  return workflow<B1Input, WorkflowTerminal<never>>('creation.b1', { revision: B1_REVISION }, async (ctx, rawInput) => {
    const input = b1InputSchema.parse(rawInput);
    const context = { opportunity: input.opportunity, account: input.account, form: input.form };
    type Basis = typeof context & {
      standards: string; materials: B1Input['materials'];
      audienceQuestion: unknown; evidenceMap: unknown; researchNotes: unknown;
    };
    type Previous = { decision: Published<unknown>; challenge?: Published<Challenge>; humanReview?: Published<HumanReview> };

    const runResearch = (key: string, order: number, request: unknown, dependsOn: ArtifactRef[]) =>
      ctx.phase(key, {
        title: B1_ROLES.research.title, purpose: B1_ROLES.research.guards, order,
        expectedArtifacts: [{ role: 'research-notes', title: '补充材料', required: true }],
      }, async phase => {
        const value = await phase.agent('research', research, request);
        const checked = await phase.validate('check-research', value, v => check(researchSchema, v));
        if (!checked.valid) return phase.blocked({ reason: 'invalid-research-notes', details: checked.details });
        const ref = await phase.publish('research-notes', 'b1-research-notes', value, {
          validation: 'valid', review: 'not_applicable', dependsOn: dependsOn.map(dependency),
        });
        await phase.bindArtifact(ref, { role: 'research-notes', title: '补充材料', primary: true });
        return { value, ref };
      });

    /** Planner → challenger loop; ends at the human gate. `previous` carries a challenge or a human review. */
    const decideAndChallenge = async (basis: Basis, basisRefs: ArtifactRef[], start?: Previous) => {
      const draftDecision = (round: number, previous?: Previous) =>
        ctx.phase(`b1-decision-${round}`, {
          title: previous?.humanReview && round === 0 ? '内容决定（按审阅修订）' : round === 0 ? '内容决定 v1' : `内容决定 v${round + 1}（按挑战修订）`,
          purpose: B1_ROLES.planner.guards, order: 40 + round * 10,
          expectedArtifacts: [{ role: 'content-decision', title: '内容决定', required: true }],
        }, async phase => {
          const value = await phase.agent('plan', planner, previous ? {
            ...basis, previousDecision: previous.decision.value,
            ...(previous.humanReview ? { humanReview: previous.humanReview.value } : {}),
            ...(previous.challenge ? { challenge: previous.challenge.value } : {}),
          } : basis);
          const checked = await phase.validate('check-decision', value, v => check(decisionSchema, v));
          if (!checked.valid) return phase.blocked({ reason: 'invalid-content-decision', details: checked.details });
          const upstream = previous ? [previous.decision.ref, previous.challenge?.ref, previous.humanReview?.ref] : [];
          const ref = await phase.publish('content-decision', 'b1-content-decision', { ...value, markdown: b1Markdown(value) }, {
            validation: 'valid', review: 'pending',
            dependsOn: [...basisRefs, ...upstream.filter((r): r is ArtifactRef => !!r)].map(dependency),
          });
          await phase.bindArtifact(ref, { role: 'content-decision', title: '内容决定', primary: true });
          return { value, ref };
        });

      const first = await draftDecision(0, start);
      if (isTerminal(first)) return first;
      let decision: Published<ContentDecision> = first;
      for (let round = 0; ; round++) {
        const current = decision;
        const challengePhase = await ctx.phase(`b1-challenge-${round}`, {
          title: `挑战 v${round + 1}`, purpose: B1_ROLES.challenger.guards, order: 45 + round * 10,
          expectedArtifacts: [{ role: 'challenge', title: '挑战意见', required: true }],
        }, async phase => {
          const value = await phase.agent('challenge', challenger, {
            ...basis, decision: current.value, ...(start?.humanReview ? { humanReview: start.humanReview.value } : {}),
          });
          const checked = await phase.validate('check-challenge', value, v => check(challengeSchema, v));
          if (!checked.valid) return phase.blocked({ reason: 'invalid-challenge', details: checked.details });
          const ref = await phase.publish('challenge', 'b1-challenge', value, {
            validation: 'valid', review: 'not_applicable', dependsOn: [dependency(current.ref)],
          });
          await phase.bindArtifact(ref, { role: 'challenge', title: '挑战意见', primary: true });
          return { value, ref };
        });
        if (isTerminal(challengePhase)) return challengePhase;

        const verdict = challengePhase.value.verdict;
        ctx.decide(`challenge-route-${round}`, { verdict, round });
        if (verdict === 'pass' || verdict === 'blocked' || round >= input.maxRevisions) {
          const reason = verdict === 'pass' ? 'awaiting-human-review' : verdict === 'blocked' ? 'blocked' : 'not-converged';
          const details: B1GateDetails = { stage: 'B1', reason, decision: current.ref, challenge: challengePhase.ref, rounds: round + 1 };
          return ctx.needsReview(details);
        }
        const revised = await draftDecision(round + 1, { decision: current, challenge: challengePhase });
        if (isTerminal(revised)) return revised;
        decision = revised;
      }
    };

    if (input.prior) {
      const prior = input.prior;
      const imported = await ctx.phase('b1-human-review', {
        title: '你的审阅', purpose: '上一轮停在人的闸口；把审阅意见作为本轮最高优先级的输入', order: 5,
        expectedArtifacts: [{ role: 'human-review', title: '审阅意见', required: true }],
      }, async phase => {
        const decisionRef = await phase.publish('prior-decision', 'b1-content-decision', prior.decision, { validation: 'valid', review: 'findings' });
        const reviewRef = await phase.publish('human-review', 'b1-human-review', prior.humanReview, {
          validation: 'valid', review: 'not_applicable', dependsOn: [dependency(decisionRef)],
        });
        await phase.bindArtifact(decisionRef, { role: 'prior-decision', title: '被审的上一版' });
        await phase.bindArtifact(reviewRef, { role: 'human-review', title: '审阅意见', primary: true });
        return { decision: { value: prior.decision, ref: decisionRef }, review: { value: prior.humanReview, ref: reviewRef } };
      });
      let notes: unknown = prior.researchNotes;
      const refs: ArtifactRef[] = [imported.review.ref];
      if (prior.humanReview.researchRequest && input.webResearch) {
        const followup = await runResearch('b1-research-followup', 30, {
          gaps: [{ gap: prior.humanReview.researchRequest, whyDecisive: '审阅者指定', whereToLook: '一手论文、官方技术报告' }],
          coreQuestion: prior.audienceQuestion.questionInAudienceWords,
        }, [imported.review.ref]);
        if (isTerminal(followup)) return followup;
        notes = { earlier: prior.researchNotes, followup: followup.value };
        refs.push(followup.ref);
      }
      return decideAndChallenge({
        ...context, standards: input.standards, materials: input.materials,
        audienceQuestion: prior.audienceQuestion, evidenceMap: prior.evidenceMap, researchNotes: notes,
      }, refs, { decision: imported.decision, humanReview: imported.review });
    }

    const audiencePhase = await ctx.phase('b1-audience', {
      title: B1_ROLES.audience.title, purpose: B1_ROLES.audience.guards, order: 10,
      expectedArtifacts: [{ role: 'audience-question', title: '观众问题', required: true }],
    }, async phase => {
      const value = await phase.agent('audience', audience, context);
      const checked = await phase.validate('check-audience', value, v => check(audienceSchema, v));
      if (!checked.valid) return phase.blocked({ reason: 'invalid-audience-question', details: checked.details });
      const ref = await phase.publish('audience-question', 'b1-audience-question', value, { validation: 'valid', review: 'not_applicable' });
      await phase.bindArtifact(ref, { role: 'audience-question', title: '观众问题', primary: true });
      return { value, ref };
    });
    if (isTerminal(audiencePhase)) return audiencePhase;

    const evidencePhase = await ctx.phase('b1-evidence', {
      title: B1_ROLES.evidence.title, purpose: B1_ROLES.evidence.guards, order: 20,
      expectedArtifacts: [{ role: 'evidence-map', title: '材料对答', required: true }],
    }, async phase => {
      const value = await phase.agent('evidence', evidence, { audienceQuestion: audiencePhase.value, materials: input.materials });
      const checked = await phase.validate('check-evidence', value, v => check(evidenceSchema, v));
      if (!checked.valid) return phase.blocked({ reason: 'invalid-evidence-map', details: checked.details });
      const ref = await phase.publish('evidence-map', 'b1-evidence-map', value, {
        validation: 'valid', review: 'not_applicable', dependsOn: [dependency(audiencePhase.ref)],
      });
      await phase.bindArtifact(ref, { role: 'evidence-map', title: '材料对答', primary: true });
      return { value, ref };
    });
    if (isTerminal(evidencePhase)) return evidencePhase;

    let notes: Published<ResearchNotes> | undefined;
    const needsResearch = evidencePhase.value.verdict !== 'sufficient' && evidencePhase.value.decisiveGaps.length > 0;
    ctx.decide('research-route', { research: needsResearch && input.webResearch, verdict: evidencePhase.value.verdict });
    if (needsResearch && input.webResearch) {
      const researchPhase = await runResearch('b1-research', 30, {
        gaps: evidencePhase.value.decisiveGaps, coreQuestion: audiencePhase.value.questionInAudienceWords,
      }, [evidencePhase.ref]);
      if (isTerminal(researchPhase)) return researchPhase;
      notes = researchPhase;
    }

    return decideAndChallenge({
      ...context, standards: input.standards, materials: input.materials,
      audienceQuestion: audiencePhase.value, evidenceMap: evidencePhase.value, researchNotes: notes?.value ?? null,
    }, [audiencePhase.ref, evidencePhase.ref, ...(notes ? [notes.ref] : [])]);
  });
}

export function readB1Standards(): string {
  return readFileSync(b1StandardsPath, 'utf8');
}
