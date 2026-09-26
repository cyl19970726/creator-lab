import { workflow } from '@signal-room/workflow';
import { inputCheck, documentCheck, planCheck, gapsCheck, reviewCheck, identity, dependency } from './contracts.mjs';
const diagramCheck = value => {
  const base = documentCheck(value);
  const diagram = base.valid && value.document.match(/```mermaid\s+([\s\S]+?)```/i)?.[1];
  return { valid: Boolean(diagram && /\b(flowchart|graph|sequenceDiagram)\b/.test(diagram)
    && /(-->|---|==>|->>)/.test(diagram)),
    details: { reason: 'research-diagram-required' } };
};
const foundationStageContract = Object.freeze({
  stage: 'A2-foundation',
  assess: [
    'Core answers address the brief with supported facts, mechanisms, conditions, and explicit limits.',
    'Dates and source claims reflect evidence actually checked by the researcher; unsupported absence claims remain qualified.',
    'Any diagram or formula already present must not misstate the mechanism or evidence.',
  ],
  deferredToA3: [
    'Author creates the representative Markdown and Mermaid diagram source; the host reader renders it. A separate model reader reviews only the exact public text and diagram source it receives.',
    'Author expands the full Markdown and Mermaid report. Independent model reader and fact roles review the exact public text and diagram source; host browser inspection checks the actual rendered view.',
  ],
  decisionRule: 'Do not require future A3 artifacts to pass A2. A disclosed noncore unknown can remain a limit when the brief allows a scoped answer. Missing evidence that blocks a core A2 answer remains insufficient-evidence.',
});

const terminal = value => value?.ok === false;
const deps = refs => refs.filter(Boolean).map(dependency);
const check = async (ctx, key, value, validator, producer) => ctx.validate(key, value, validator, { producerStepKey: producer });

async function publish(ctx, key, type, value, checked, refs = [], role = type, primary = false) {
  const ref = await ctx.publish(key, type, value, {
    schemaVersion: '1', validation: checked.valid ? 'valid' : 'invalid',
    review: 'pending', dependsOn: deps(refs),
  });
  await ctx.bindArtifact(ref, { role, title: value?.title || type, primary });
  return ref;
}

async function generate(ctx, key, role, agent, input, type, validator = documentCheck, refs = [], primary = false, enrich = value => value) {
  const value = enrich(await ctx.agent(key, agent, input));
  const checked = await check(ctx, `${key}-contract`, value, validator, key);
  const ref = await publish(ctx, `${key}-artifact`, type, value, checked, refs, type, primary);
  return { value, ref, checked };
}

async function review(ctx, key, agent, task, target, candidate, context, refs = []) {
  const raw = await ctx.agent(key, agent, { task, target: identity(target), candidate, ...context });
  // The submitted candidate is the authority for binding. Preserve any explicit
  // legacy assertion so a conflicting target is rejected by reviewCheck.
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) && !Object.hasOwn(raw, 'target')
    ? { ...raw, target: identity(target) } : raw;
  const checked = await check(ctx, `${key}-contract`, value, item => reviewCheck(item, identity(target)), key);
  const ref = await ctx.publish(`${key}-artifact`, 'research-review', value, {
    schemaVersion: '1', validation: checked.valid ? 'valid' : 'invalid',
    review: checked.valid ? (value.decision === 'pass' ? 'passed' : 'findings') : 'findings',
    dependsOn: deps([target, ...refs]),
  });
  await ctx.bindArtifact(ref, { role: `${key}-review`, title: value?.title || key });
  return { value, ref, checked };
}

function requireValid(ctx, result, reason) {
  return result.checked.valid ? null : ctx.needsReview({ reason, artifact: identity(result.ref), validation: result.checked.details });
}

function decisionFor(reviews) {
  if (reviews.some(item => item.value.decision === 'human-decision')) return 'human-decision';
  if (reviews.some(item => item.value.decision === 'insufficient-evidence')) return 'insufficient-evidence';
  if (reviews.some(item => item.value.decision === 'revise')) return 'revise';
  return 'pass';
}

function groupEvidenceQuestions(items) {
  const grouped = new Map();
  for (const item of items) {
    const questions = grouped.get(item.problemId) ?? [];
    if (!questions.some(previous => previous.id === item.id && previous.question === item.question)) {
      questions.push({ id: item.id, location: item.location, question: item.question, source: item.source });
    }
    grouped.set(item.problemId, questions);
  }
  return [...grouped].map(([problemId, questions]) => ({ problemId, questions }));
}

export function createResearchWorkflow({ agents, revision, maxResearchRounds = 2, maxRevisions = 2, concurrency = 2 }) {
  if (!agents || ['planner', 'researcher', 'synthesizer', 'author', 'reader', 'fact'].some(role => !agents[role]))
    throw new Error('Research agents planner, researcher, synthesizer, author, reader, fact are required');
  if (typeof revision !== 'string' || !revision.trim()) throw new Error('Research workflow revision is required');
  for (const [key, value] of Object.entries({ maxResearchRounds, maxRevisions, concurrency })) {
    if (!Number.isInteger(value) || value < (key === 'concurrency' ? 1 : 0)) throw new Error(`Invalid ${key}`);
  }
  return workflow('research.a1-a3', { revision }, async (ctx, input) => {
    const validInput = await ctx.validate('input-contract', input, inputCheck);
    if (!validInput.valid) return ctx.blocked(validInput.details);
    const common = { topic: { id: input.topicId, title: input.title, goal: input.goal, readers: input.readers, asOf: input.asOf }, sources: input.sources };
    const brief = await ctx.phase('a1-brief', {
      title: 'A1 · 研究任务书', purpose: '明确问题、读者、材料与成功判据', order: 1,
      expectedArtifacts: [{ role: 'research-brief', required: true }],
    }, async phase => {
      const prior = input.repair?.route === 'expression' && input.repair.prior.brief;
      if (prior) {
        await phase.bindArtifact(prior.identity, { role: 'research-brief', title: prior.payload.title, primary: true });
        return { value: prior.payload, ref: prior.identity, checked: { valid: true } };
      }
      return generate(phase, 'brief', 'planner', agents.planner,
        { task: 'brief', ...common, repair: input.repair }, 'research-brief', documentCheck, [], true);
    });
    if (terminal(brief)) return brief;
    const briefError = requireValid(ctx, brief, 'invalid-brief');
    if (briefError) return briefError;

    let plan;
    let evidence = [];
    let synthesis;
    if (input.repair?.route === 'expression') {
      const prior = input.repair.prior;
      synthesis = await ctx.phase('a2-reused-evidence', {
        title: 'A2 · 已核验证据', purpose: '复用与旧综合稿精确绑定的不可变证据', order: 2,
        expectedArtifacts: [{ role: 'research-synthesis', required: true }],
      }, async phase => {
        for (const item of prior.evidence) {
          await phase.bindArtifact(item.identity, { role: 'research-evidence', title: item.payload.title });
        }
        await phase.bindArtifact(prior.synthesis.identity,
          { role: 'research-synthesis', title: prior.synthesis.payload.title, primary: true });
        return { value: prior.synthesis.payload, ref: prior.synthesis.identity, checked: { valid: true } };
      });
      if (terminal(synthesis)) return synthesis;
      evidence = prior.evidence.map(item => ({ value: item.payload, ref: item.identity }));
    } else {
    plan = await ctx.phase('a2-plan', {
      title: 'A2 · 预研与路径', purpose: '从已确认目标形成可调整的分题计划', order: 2,
      expectedArtifacts: [{ role: 'research-plan', required: true }],
    }, async phase => generate(phase, 'plan', 'planner', agents.planner,
      { task: 'plan', brief: brief.value, ...common, repair: input.repair },
      'research-plan', planCheck, [brief.ref], true));
    if (terminal(plan)) return plan;
    const planError = requireValid(ctx, plan, 'invalid-plan');
    if (planError) return planError;

    let gaps = groupEvidenceQuestions(plan.value.problems.map(problem => ({ problemId: problem.id,
      id: `plan:${problem.id}`, location: problem.id, question: problem.question, source: 'plan' })));
    let researchRound = 0;
    let correctionRound = 0;
    const foundationHistory = [];
    for (let round = 0; round <= maxResearchRounds + maxRevisions; round++) {
      if (gaps.length) {
        const research = await ctx.phase(`a2-research-${researchRound}`, {
          title: researchRound ? `A2 · 定向补证 ${researchRound}` : 'A2 · 分题研究',
          purpose: '保留原始来源、事实、推断与未知', order: 10 + round,
          expectedArtifacts: [{ role: 'research-evidence', required: true }],
        }, async phase => {
          const results = await phase.mapSettled('problems', gaps, {
            concurrency, itemKey: item => item.problemId,
          }, async gap => {
            const result = await generate(phase, `problem-${gap.problemId}`, 'researcher', agents.researcher,
              { task: researchRound ? 'fill-evidence-gap' : 'research-problem', round: researchRound, gap, brief: brief.value,
                plan: plan.value, previousEvidence: evidence.map(item => item.value), ...common },
              'research-evidence', documentCheck, [brief.ref, plan.ref, ...evidence.map(item => item.ref)]);
            if (!result.checked.valid) return { ...result, problemId: gap.problemId, invalid: true };
            const note = { title: `研究笔记 · ${gap.problemId}`, document: result.value.document,
              problemId: gap.problemId, evidence: identity(result.ref),
              facts: result.value.facts || [], inferences: result.value.inferences || [], unknowns: result.value.unknowns || [] };
            const noteRef = await phase.publish(`note-${gap.problemId}`, 'research-note', note, {
              schemaVersion: '1', validation: 'valid', review: 'pending', dependsOn: deps([result.ref]),
            });
            return { ...result, problemId: gap.problemId, noteRef };
          });
          const completed = [];
          const failures = [];
          const invalid = [];
          for (let index = 0; index < results.length; index++) {
            const result = results[index];
            if (result.status === 'rejected') failures.push({ problemId: gaps[index].problemId, error: String(result.reason?.message || result.reason) });
            else {
              if (result.value.invalid) {
                invalid.push({ problemId: result.value.problemId, artifact: identity(result.value.ref) });
                continue;
              }
              completed.push(result.value);
              await phase.bindArtifact(result.value.ref, { role: 'research-evidence', title: result.value.value.title });
              await phase.bindArtifact(result.value.noteRef, { role: 'research-note', title: `研究笔记 · ${result.value.problemId}` });
            }
          }
          if (failures.length) throw new AggregateError(failures.map(item => new Error(`${item.problemId}: ${item.error}`)), 'Research branch failed');
          if (invalid.length) return phase.needsReview({ reason: 'invalid-research-evidence', invalid });
          return completed;
        });
        if (terminal(research)) return research;
        evidence = [...evidence, ...research];
        researchRound++;
      }
      const previousSynthesis = synthesis;
      synthesis = await ctx.phase(`a2-synthesis-${round}`, {
        title: 'A2 · 综合与缺口', purpose: '裁定证据范围并决定是否补证', order: 20 + round,
        expectedArtifacts: [{ role: 'research-synthesis', required: true }],
      }, async phase => {
        const result = await generate(phase, 'synthesis', 'synthesizer', agents.synthesizer,
          { task: 'synthesize', round, brief: brief.value, plan: plan.value,
            evidence: evidence.map(item => ({ problemId: item.problemId, ...item.value })),
            previousSynthesis: previousSynthesis && { identity: identity(previousSynthesis.ref), payload: previousSynthesis.value },
            foundationReviews: foundationHistory.map(item => ({ identity: identity(item.ref), payload: item.value })), ...common },
          'research-synthesis', value => gapsCheck(value, plan.value, foundationHistory),
          [brief.ref, plan.ref, previousSynthesis?.ref, ...foundationHistory.map(item => item.ref), ...evidence.map(item => item.ref)], true);
        return result;
      });
      if (terminal(synthesis)) return synthesis;
      const synthesisError = requireValid(ctx, synthesis, 'invalid-synthesis');
      if (synthesisError) return synthesisError;
      const foundation = await ctx.phase(`a2-foundation-review-${round}`, {
        title: 'A2 · 独立基础审核', purpose: '核对关键判断是否得到实际来源支持', order: 25 + round,
        expectedArtifacts: [{ role: 'foundation-review', required: true }],
      }, async phase => review(phase, 'foundation', agents.fact, 'check-foundation', synthesis.ref,
        synthesis.value, { stageContract: foundationStageContract, brief: brief.value, plan: plan.value,
          evidence: evidence.map(item => item.value), sources: input.sources },
        [brief.ref, ...evidence.map(item => item.ref)]));
      if (terminal(foundation)) return foundation;
      const foundationError = requireValid(ctx, foundation, 'invalid-foundation-review');
      if (foundationError) return foundationError;
      if (foundation.value.decision === 'human-decision')
        return ctx.needsReview({ reason: 'foundation-human-decision', synthesis: identity(synthesis.ref), review: identity(foundation.ref) });
      if (foundation.value.decision !== 'pass' && foundation.value.findings.length === 0)
        return ctx.needsReview({ reason: 'foundation-findings-missing', synthesis: identity(synthesis.ref), review: identity(foundation.ref) });
      foundationHistory.push(foundation);
      const reviewGaps = foundation.value.findings.map(item => ({ problemId: item.location,
        id: item.id, location: item.location, question: item.issue, source: `foundation:${foundation.ref.id}` }));
      if (reviewGaps.some(item => !plan.value.problems.some(problem => problem.id === item.problemId)))
        return ctx.needsReview({ reason: 'foundation-unroutable-findings', synthesis: identity(synthesis.ref), review: identity(foundation.ref) });
      const synthesisGaps = synthesis.value.gaps.map((item, index) => ({ problemId: item.problemId,
        id: `synthesis:${synthesis.ref.id}:${index}`, location: item.problemId, question: item.question, source: 'synthesis' }));
      const unresolved = synthesis.value.findingResponses.filter(item => item.status === 'unresolved');
      if (unresolved.length && synthesisGaps.length === 0)
        return ctx.needsReview({ reason: 'foundation-findings-unresolved', synthesis: identity(synthesis.ref),
          review: identity(foundation.ref), unresolved });
      const needsEvidence = synthesisGaps.length > 0 || foundation.value.decision === 'insufficient-evidence';
      gaps = needsEvidence ? groupEvidenceQuestions([...synthesisGaps, ...reviewGaps]) : [];
      const route = needsEvidence ? 'fill-gaps' : foundation.value.decision === 'revise' ? 'revise-synthesis' : 'write';
      ctx.decide(`research-route-${round}`, route);
      if (route === 'write') break;
      if (route === 'fill-gaps' && researchRound > maxResearchRounds)
        return ctx.needsReview({ reason: 'evidence-gap-budget-exhausted', synthesis: identity(synthesis.ref),
          review: identity(foundation.ref), gaps });
      if (route === 'revise-synthesis') {
        correctionRound++;
        if (correctionRound > maxRevisions)
          return ctx.needsReview({ reason: 'foundation-correction-budget-exhausted', synthesis: identity(synthesis.ref),
            review: identity(foundation.ref), findings: foundation.value.findings });
      }
    }
    if (!synthesis) return ctx.needsReview({ reason: 'no-synthesis', plan: identity(plan.ref) });
    }

    let sample;
    let sampleReview;
    for (let round = 0; round <= maxRevisions; round++) {
      const result = await ctx.phase(`a3-sample-${round}`, {
        title: 'A3 · 代表解释', purpose: '先验证关键解释和图解的可理解性', order: 30 + round,
        expectedArtifacts: [{ role: 'research-sample', required: true }, { role: 'sample-review', required: true }],
      }, async phase => {
        const candidate = await generate(phase, 'sample', 'author', agents.author,
          { task: round ? 'revise-sample' : 'write-sample', brief: brief.value, synthesis: synthesis.value,
            prior: sample && { identity: identity(sample.ref), payload: sample.value },
            review: sampleReview?.value, repair: input.repair },
          'research-sample', diagramCheck, [synthesis.ref, sample?.ref, sampleReview?.ref], true);
        if (!candidate.checked.valid) return phase.needsReview({ reason: 'invalid-sample', candidate: identity(candidate.ref) });
        const reader = await review(phase, 'sample-reader', agents.reader, 'read-sample', candidate.ref,
          { title: candidate.value.title, document: candidate.value.document }, { readers: input.readers });
        if (!reader.checked.valid) return phase.needsReview({ reason: 'invalid-sample-review', candidate: identity(candidate.ref) });
        return { candidate, reader };
      });
      if (terminal(result)) return result;
      sample = result.candidate;
      sampleReview = result.reader;
      const route = ctx.decide(`sample-route-${round}`, sampleReview.value.decision);
      if (route === 'pass') break;
      if (route !== 'revise' || round === maxRevisions)
        return ctx.needsReview({ reason: route === 'revise' ? 'sample-revision-budget-exhausted' : `sample-${route}`,
          candidate: identity(sample.ref), review: identity(sampleReview.ref) });
    }

    let report;
    let priorReviews = [];
    for (let round = 0; round <= maxRevisions; round++) {
      const result = await ctx.phase(`a3-report-${round}`, {
        title: round ? `A3 · 报告修订 ${round}` : 'A3 · 完整图文报告',
        purpose: '交付可读候选并以独立读者和事实审核复验', order: 40 + round,
        expectedArtifacts: [{ role: 'research-report', required: true }, { role: 'reader-review', required: true }, { role: 'fact-review', required: true }],
      }, async phase => {
        const candidate = await generate(phase, 'report', 'author', agents.author,
          { task: round ? 'revise-report' : 'write-report', brief: brief.value, plan: plan?.value ?? null,
            synthesis: synthesis.value, sample: sample.value,
            previous: report && { identity: identity(report.ref), payload: report.value },
            reviews: priorReviews.map(item => ({ identity: identity(item.ref), payload: item.value })),
            repair: input.repair },
          'research-report', diagramCheck,
          [brief.ref, plan?.ref, synthesis.ref, sample.ref, report?.ref,
            input.repair?.candidate.identity, ...priorReviews.map(item => item.ref)], true,
          value => {
            const previous = report?.ref ?? input.repair?.candidate.identity;
            return previous ? { ...value, previous: identity(previous) } : value;
          });
        if (!candidate.checked.valid) return phase.needsReview({ reason: 'invalid-report', candidate: identity(candidate.ref) });
        const results = await phase.parallelSettled('independent-reviews', {
          reader: () => review(phase, 'reader', agents.reader, 'read-report', candidate.ref,
            { title: candidate.value.title, document: candidate.value.document }, { readers: input.readers }),
          fact: () => review(phase, 'fact', agents.fact, 'fact-check-report', candidate.ref,
            candidate.value, { brief: brief.value, synthesis: synthesis.value, sources: input.sources }, [synthesis.ref]),
        }, { concurrency: 2 });
        const reviews = [];
        for (const [name, outcome] of Object.entries(results)) {
          if (outcome.status === 'rejected') throw outcome.reason;
          reviews.push(outcome.value);
          await phase.bindArtifact(outcome.value.ref, { role: `${name}-review`, title: outcome.value.value.title });
        }
        if (reviews.some(item => !item.checked.valid))
          return phase.needsReview({ reason: 'invalid-report-review', candidate: identity(candidate.ref), reviews: reviews.map(item => identity(item.ref)) });
        return { candidate, reviews };
      });
      if (terminal(result)) return result;
      report = result.candidate;
      priorReviews = result.reviews;
      const route = ctx.decide(`report-route-${round}`, decisionFor(priorReviews));
      if (route === 'pass') break;
      if (route !== 'revise' || round === maxRevisions)
        return ctx.needsReview({ reason: route === 'revise' ? 'report-revision-budget-exhausted' : `report-${route}`,
          candidate: identity(report.ref), reviews: priorReviews.map(item => identity(item.ref)) });
    }

    let change;
    if (input.repair) {
      change = await ctx.phase('a3-change', {
        title: 'A3 · 修订说明', purpose: '逐项说明反馈处理和版本差异', order: 55,
        expectedArtifacts: [{ role: 'research-change', required: true }],
      }, async phase => {
        const result = await generate(phase, 'change', 'author', agents.author,
          { task: 'describe-change', previous: input.repair.candidate,
            current: { identity: identity(report.ref), payload: report.value },
            feedback: input.repair.feedback, reviews: priorReviews.map(item => item.value) },
          'research-change', documentCheck,
          [input.repair.candidate.identity, report.ref, ...priorReviews.map(item => item.ref)], true);
        return result;
      });
      if (terminal(change)) return change;
      const changeError = requireValid(ctx, change, 'invalid-change');
      if (changeError) return changeError;
    }
    const release = await ctx.phase('a3-release', {
      title: 'A3 · 待选择交付稿', purpose: '保留已复验候选，等待用户选择具体版本', order: 60,
      expectedArtifacts: [{ role: 'research-release', required: true }],
    }, async phase => {
      const payload = { title: report.value.title, document: '独立读者与事实审核已通过。此版本等待用户选择，尚未表示用户接受。',
        candidate: identity(report.ref), reviews: priorReviews.map(item => identity(item.ref)),
        ...(change ? { change: identity(change.ref) } : {}), status: 'editorially-selected-awaiting-human-acceptance' };
      const ref = await phase.publish('release', 'research-release', payload, {
        schemaVersion: '1', validation: 'valid', review: 'passed',
        dependsOn: deps([report.ref, ...priorReviews.map(item => item.ref), change?.ref]),
      });
      await phase.bindArtifact(ref, { role: 'research-release', title: payload.title, primary: true });
      return ref;
    });
    if (terminal(release)) return release;
    return ctx.needsReview({ reason: 'awaiting-human-acceptance', candidate: identity(report.ref),
      release: identity(release), reviews: priorReviews.map(item => identity(item.ref)) });
  });
}
