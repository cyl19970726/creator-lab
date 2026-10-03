import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { runWorkflow, workflow } from '@signal-room/workflow';
import { SQLiteWorkflowRunStore } from '@signal-room/workflow-sqlite';
import { B1_ROLES, B1_REVISION, type Challenge } from '../src/stages/b1.js';
import { B2_ROLES, B2_REVISION, type EditorVerdict } from '../src/stages/b2.js';
import { CONTENT_ROLES, CONTENT_REVISION, type ContentReview } from '../src/stages/content.js';
import { createStageRunner, stageAgent } from '../src/stages/runtime.js';

/**
 * Reviewer calibration: does the stage's internal reviewer judge like the human did?
 * Each case is a frozen asset the human already reviewed, with the human's verdict and the criteria the
 * human said failed. The reviewer runs on every case; agreement is the evidence for (or against)
 * letting the agent replace the human gate at that stage.
 *   pnpm stage:eval-reviewer <content|b1|b2> <casesDir>
 * A case file: { id, note, expected: { verdict, failing: ["S9", ...] }, reviewInput: {...} }
 */
const { positionals, values } = parseArgs({ allowPositionals: true, options: { model: { type: 'string', default: 'gpt-6-sol' } } });
const [stage, casesDir] = positionals;
if (!['content', 'b1', 'b2'].includes(stage ?? '') || !casesDir) throw new Error('Usage: eval-reviewer.ts <content|b1|b2> <casesDir>');

interface Case { id: string; note: string; expected: { verdict: string; failing: string[] }; reviewInput: Record<string, unknown> }
const cases: Case[] = readdirSync(casesDir).filter(f => f.endsWith('.json')).sort()
  .map(f => JSON.parse(readFileSync(path.join(casesDir, f), 'utf8')) as Case);
if (!cases.length) throw new Error(`No case files in ${casesDir}`);

const role = stage === 'content' ? CONTENT_ROLES.editor : stage === 'b1' ? B1_ROLES.challenger : B2_ROLES.editor;
const revision = stage === 'content' ? CONTENT_REVISION : stage === 'b1' ? B1_REVISION : B2_REVISION;
const reviewer = stageAgent<unknown, Challenge | EditorVerdict | ContentReview>(role, { model: values.model!, reasoningEffort: 'high' }, revision);
const calibration = workflow<Case[], Array<{ id: string; verdict: string; failing: string[] }>>(`creation.${stage}-reviewer-eval`, { revision: role.id + '-' + revision }, async (ctx, all) => {
  const settled = await ctx.mapSettled('cases', all, { concurrency: 3, itemKey: c => c.id }, async c => {
    const out = await ctx.agent(`review:${c.id}`, reviewer, c.reviewInput);
    await ctx.publish(`review-result:${c.id}`, `${stage}-reviewer-eval-result`, { id: c.id, review: out }, { validation: 'valid', review: 'not_applicable' });
    return { id: c.id, verdict: out.verdict, failing: out.criteria.filter(x => x.result === 'fail').map(x => x.id) };
  });
  return settled.map((r, i) => r.status === 'fulfilled' ? r.value : { id: all[i].id, verdict: 'error', failing: [] });
});

const root = path.resolve('.local/stages/eval');
mkdirSync(path.join(root, 'traces'), { recursive: true });
const store = new SQLiteWorkflowRunStore(new DatabaseSync(path.join(root, 'ledger.sqlite')));
const { run, output } = await runWorkflow({
  workflow: calibration, input: cases, store,
  agentRunner: createStageRunner({ traceRoot: path.join(root, 'traces') }),
  metadata: { stage: `${stage}-reviewer-eval` },
});
if (!output) throw new Error(`Calibration run ${run.id} ended ${run.state}: ${run.error ?? ''}`);

const rows = cases.map(c => {
  const got = output.find(o => o.id === c.id)!;
  const verdictAgrees = got.verdict === c.expected.verdict;
  const missed = c.expected.failing.filter(id => !got.failing.includes(id));
  const extra = got.failing.filter(id => !c.expected.failing.includes(id));
  return { id: c.id, note: c.note, expected: c.expected, got, verdictAgrees, missed, extra };
});
const agree = rows.filter(r => r.verdictAgrees).length;
const md = [
  `# ${role.title}校准 · ${stage.toUpperCase()} · run ${run.id.slice(0, 8)}`, '',
  `结论一致：**${agree} / ${rows.length}**`, '',
  '这是模型审阅输出；不包含 content 主流程的程序校验，也不代替真人验收。案例必须同时含真人认可的正例和反例，才可讨论完整校准。', '',
  '| 案例 | 预期判断（来源见案例说明） | 它的判断 | 一致 | 它漏掉的不通过项 | 它多判的不通过项 |', '|---|---|---|---|---|---|',
  ...rows.map(r => `| ${r.id}：${r.note} | ${r.expected.verdict}（${r.expected.failing.join('、') || '无'}） | ${r.got.verdict}（${r.got.failing.join('、') || '无'}） | ${r.verdictAgrees ? '是' : '**否**'} | ${r.missed.join('、') || '—'} | ${r.extra.join('、') || '—'} |`),
  '',
].join('\n');
writeFileSync(path.join(casesDir, `calibration-${run.id.slice(0, 8)}.md`), md);
console.log(md);
