import assert from 'node:assert/strict';
import test from 'node:test';
import { defineAgent, MemoryRunStore, runWorkflow } from '@signal-room/workflow';
import { createResearchWorkflow } from './workflow.mjs';
import { sourceHash } from './contracts.mjs';

const names = ['planner', 'researcher', 'synthesizer', 'author', 'reader', 'fact'];
const agents = Object.fromEntries(names.map(name => [name, defineAgent({
  id: name, revision: '1', model: 'fake', reasoningEffort: 'medium',
  promptRevision: '1', skillsRevision: '1', permissionsRevision: '1',
})]));
const content = 'Frozen source says the chip moves data to memory.';
const input = { workspaceId: 'w', topicId: 't', title: 'Compute', goal: 'Explain movement',
  readers: ['curious reader'], asOf: '2026-09-22',
  sources: [{ id: 's1', title: 'Source', content, sha256: sourceHash(content) }] };
const doc = title => ({ title, document: `${title} with a causal explanation and source s1.` });
const finding = { id: 'f1', location: '#mechanism', issue: 'Explain this step.' };

function runner(options = {}) {
  const calls = [];
  let failed = false;
  return { calls, agentRunner: { async run({ definition, input: request }) {
    calls.push({ role: definition.id, task: request.task, input: structuredClone(request) });
    if (options.failOnce && definition.id === 'researcher' && !failed) { failed = true; throw new Error('temporary research failure'); }
    let value;
    if (definition.id === 'planner') value = { ...doc(request.task), problems: [{ id: 'p1', question: 'What moves?' }] };
    else if (definition.id === 'researcher') value = { ...doc('evidence'), sourceIds: ['s1'], facts: ['data moves'], inferences: [], unknowns: [] };
    else if (definition.id === 'synthesizer') value = { ...doc('synthesis'),
      gaps: options.gaps && request.round === 0 ? [{ problemId: 'p1', question: 'Which memory?' }] : [],
      findingResponses: (options.omitFindingResponse && request.round > 0 ? [] : (request.foundationReviews || []).flatMap(review => review.payload.findings.map(item => ({
        reviewId: review.identity.id, findingId: item.id, status: 'addressed', explanation: `Clarified ${item.issue}`,
      })))) };
    else if (definition.id === 'author') value = { ...doc(request.task),
      document: `${request.task}\n\n\`\`\`mermaid\nflowchart LR\n  chip --> memory\n\`\`\`` };
    else value = { ...doc('review'),
      ...(options.wrongTarget && request.task === 'fact-check-report'
        ? { target: { ...request.target, revision: request.target.revision.slice(0, -1) } } : {}),
      decision: options.stageContractGate && request.task === 'check-foundation'
        ? request.stageContract?.stage === 'A2-foundation'
          && request.stageContract.deferredToA3.some(item => item.includes('reader'))
          && request.stageContract.assess.some(item => item.includes('mechanisms')) ? 'pass' : 'revise'
        : options.foundationFindings && request.task === 'check-foundation'
        && (options.alwaysFoundationRevise || calls.filter(call => call.task === 'check-foundation').length === 1)
        ? options.foundationFindings.decision
        : options.foundationGap && request.task === 'check-foundation' && calls.filter(call => call.task === 'check-foundation').length === 1
        ? 'insufficient-evidence' : options.reviseOnce && request.task === 'read-report' && !calls.some(call => call.task === 'revise-report') ? 'revise' : 'pass',
      findings: options.stageContractGate && request.task === 'check-foundation'
        ? request.stageContract?.stage === 'A2-foundation' ? [] : [{ id: 'stage', location: 'p1', issue: 'Wrong stage contract.' }]
        : options.foundationFindings && request.task === 'check-foundation'
        && (options.alwaysFoundationRevise || calls.filter(call => call.task === 'check-foundation').length === 1)
        ? options.foundationFindings.findings
        : options.foundationGap && request.task === 'check-foundation' && calls.filter(call => call.task === 'check-foundation').length === 1
        ? [{ id: 'gap', location: 'p1', issue: 'Find the memory boundary.' }]
        : options.reviseOnce && request.task === 'read-report' && !calls.some(call => call.task === 'revise-report') ? [finding] : [] };
    return { output: value };
  } } };
}

async function scenario(options = {}, workflowOptions = {}) {
  const fake = runner(options);
  const store = new MemoryRunStore();
  const definition = createResearchWorkflow({ agents, revision: 'test', ...workflowOptions });
  const result = await runWorkflow({ workflow: definition, input, store, agentRunner: fake.agentRunner });
  return { ...fake, store, definition, result };
}

test('A1/A2/A3 publishes exact editorial candidate and leaves acceptance to user', async () => {
  const run = await scenario();
  assert.equal(run.result.run.state, 'needs_review');
  assert.equal(run.result.output.details.reason, 'awaiting-human-acceptance');
  const artifacts = await run.store.listArtifacts(run.result.run.id);
  const report = artifacts.find(item => item.type === 'research-report');
  const reviews = artifacts.filter(item => item.type === 'research-review');
  const release = artifacts.find(item => item.type === 'research-release');
  assert.ok(report && release);
  assert.equal(report.review, 'pending');
  assert.equal(reviews.length, 4);
  assert.ok(reviews.every(item => item.review === 'passed'));
  assert.equal(release.payload.candidate.sha256, report.sha256);
  assert.deepEqual(reviews.filter(item => item.dependsOn.some(dep => dep.artifactId === report.id)).map(item => item.payload.target.sha256), [report.sha256, report.sha256]);
  assert.ok(run.calls.find(item => item.task === 'read-sample'));
  assert.ok(run.calls.find(item => item.task === 'write-report'));
  assert.ok(run.calls.find(item => item.task === 'read-sample').input.candidate.document);
  assert.equal(run.calls.find(item => item.task === 'read-sample').input.brief, undefined);
});

test('target-free model review is bound by host to the exact submitted candidate', async () => {
  const run = await scenario();
  assert.equal(run.result.run.state, 'needs_review');
  const artifacts = await run.store.listArtifacts(run.result.run.id);
  const sample = artifacts.find(item => item.type === 'research-sample');
  const report = artifacts.find(item => item.type === 'research-report');
  const reviews = artifacts.filter(item => item.type === 'research-review');
  for (const candidate of [sample, report]) {
    const bound = reviews.filter(item => item.dependsOn.some(dep => dep.artifactId === candidate.id));
    assert.ok(bound.length > 0);
    for (const item of bound) assert.deepEqual(item.payload.target,
      { id: candidate.id, revision: candidate.revision, sha256: candidate.sha256 });
  }
  assert.ok(run.calls.filter(item => ['reader', 'fact'].includes(item.role)).every(item => item.input.target));
});

test('foundation receives an A2 scope contract before A3 creates sample and reader review', async () => {
  const run = await scenario({ stageContractGate: true });
  assert.equal(run.result.run.state, 'needs_review');
  assert.equal(run.result.output.details.reason, 'awaiting-human-acceptance');
  const foundation = run.calls.findIndex(item => item.task === 'check-foundation');
  const sample = run.calls.findIndex(item => item.task === 'write-sample');
  const reader = run.calls.findIndex(item => item.task === 'read-sample');
  assert.ok(foundation >= 0 && sample > foundation && reader > sample);
  const contract = run.calls[foundation].input.stageContract;
  assert.equal(contract.stage, 'A2-foundation');
  assert.match(contract.decisionRule, /Do not require future A3 artifacts/);
  assert.ok(contract.deferredToA3.some(item => item.includes('diagram')));
});

test('bounded evidence gaps are researched before the representative sample', async () => {
  const run = await scenario({ gaps: true });
  assert.equal(run.result.run.state, 'needs_review');
  assert.equal(run.calls.filter(item => item.role === 'researcher').length, 2);
  const research2 = run.calls.findIndex(item => item.task === 'fill-evidence-gap');
  const sample = run.calls.findIndex(item => item.task === 'write-sample');
  assert.ok(research2 >= 0 && sample > research2);
});

test('independent foundation findings route a bounded evidence round before A3', async () => {
  const run = await scenario({ foundationGap: true });
  assert.equal(run.result.run.state, 'needs_review');
  assert.equal(run.calls.filter(item => item.task === 'fill-evidence-gap').length, 1);
  assert.ok(run.calls.findIndex(item => item.task === 'write-sample') > run.calls.findIndex(item => item.task === 'fill-evidence-gap'));
});

test('two evidence findings on one problem both reach the researcher and next synthesis', async () => {
  const findings = [
    { id: 'f1', location: 'p1', issue: 'Find the load boundary.' },
    { id: 'f2', location: 'p1', issue: 'Define KV cache residency.' },
  ];
  const run = await scenario({ foundationFindings: { decision: 'insufficient-evidence', findings } });
  assert.equal(run.result.run.state, 'needs_review');
  const followup = run.calls.find(item => item.task === 'fill-evidence-gap');
  assert.deepEqual(followup.input.gap.questions.map(item => item.id), ['f1', 'f2']);
  const secondSynthesis = run.calls.filter(item => item.task === 'synthesize')[1].input;
  assert.deepEqual(secondSynthesis.foundationReviews[0].payload.findings.map(item => item.id), ['f1', 'f2']);
  const synthesized = (await run.store.listArtifacts(run.result.run.id)).filter(item => item.type === 'research-synthesis')[1];
  assert.deepEqual(synthesized.payload.findingResponses.map(item => item.findingId), ['f1', 'f2']);
});

test('foundation revise uses existing evidence for a new synthesis and exact rereview', async () => {
  const findings = [
    { id: 'f1', location: 'p1', issue: 'Define load path.' },
    { id: 'f2', location: 'p1', issue: 'Keep KV cache scope explicit.' },
  ];
  const run = await scenario({ foundationFindings: { decision: 'revise', findings } });
  assert.equal(run.result.run.state, 'needs_review');
  assert.equal(run.calls.filter(item => item.role === 'researcher').length, 1);
  const syntheses = run.calls.filter(item => item.task === 'synthesize');
  assert.equal(syntheses.length, 2);
  assert.ok(syntheses[1].input.previousSynthesis.identity.sha256);
  assert.deepEqual(syntheses[1].input.foundationReviews[0].payload.findings.map(item => item.id), ['f1', 'f2']);
  assert.equal(run.calls.filter(item => item.task === 'check-foundation').length, 2);
  const artifacts = await run.store.listArtifacts(run.result.run.id);
  const reviewed = artifacts.filter(item => item.type === 'research-synthesis');
  assert.notEqual(reviewed[0].sha256, reviewed[1].sha256);
  assert.equal(artifacts.find(item => item.type === 'research-release').payload.status,
    'editorially-selected-awaiting-human-acceptance');
});

test('missing closure of a prior foundation finding blocks A3', async () => {
  const run = await scenario({ omitFindingResponse: true,
    foundationFindings: { decision: 'revise', findings: [{ id: 'f1', location: 'p1', issue: 'Define load path.' }] } });
  assert.equal(run.result.run.state, 'needs_review');
  assert.equal(run.result.output.details.reason, 'invalid-synthesis');
  assert.equal(run.calls.some(item => item.task === 'write-sample'), false);
});

test('repeated foundation corrections stop at the correction budget without research calls', async () => {
  const run = await scenario({ alwaysFoundationRevise: true,
    foundationFindings: { decision: 'revise', findings: [{ id: 'f1', location: 'p1', issue: 'Define load path.' }] } },
  { maxRevisions: 2 });
  assert.equal(run.result.run.state, 'needs_review');
  assert.equal(run.result.output.details.reason, 'foundation-correction-budget-exhausted');
  assert.equal(run.calls.filter(item => item.role === 'researcher').length, 1);
  assert.equal(run.calls.filter(item => item.task === 'synthesize').length, 3);
  assert.equal(run.calls.some(item => item.task === 'write-sample'), false);
});

test('revision findings require a fresh exact review', async () => {
  const run = await scenario({ reviseOnce: true });
  assert.equal(run.result.run.state, 'needs_review');
  assert.equal(run.calls.filter(item => item.task === 'read-report').length, 2);
  assert.equal(run.calls.filter(item => item.task === 'fact-check-report').length, 2);
  const artifacts = await run.store.listArtifacts(run.result.run.id);
  const reports = artifacts.filter(item => item.type === 'research-report');
  assert.equal(reports.length, 2);
  assert.notEqual(reports[0].sha256, reports[1].sha256);
  assert.equal(artifacts.find(item => item.type === 'research-release').payload.candidate.sha256, reports[1].sha256);
});

test('a technical failure remains resumable in the same run', async () => {
  const fake = runner({ failOnce: true });
  const store = new MemoryRunStore();
  const definition = createResearchWorkflow({ agents, revision: 'resume' });
  await assert.rejects(() => runWorkflow({ workflow: definition, input, store, agentRunner: fake.agentRunner }));
  const runs = await store.listRuns();
  const root = runs.find(item => !item.parentRunId);
  assert.equal(root.state, 'failed');
  const before = fake.calls.filter(item => item.task === 'brief').length;
  const resumed = await runWorkflow({ workflow: definition, input, store, agentRunner: fake.agentRunner, resumeRunId: root.id });
  assert.equal(resumed.run.state, 'needs_review');
  assert.equal(fake.calls.filter(item => item.task === 'brief').length, before);
});

test('repair creates a new report and change record tied to the old candidate', async () => {
  const store = new MemoryRunStore();
  const fake = runner();
  const definition = createResearchWorkflow({ agents, revision: 'repair' });
  const first = await runWorkflow({ workflow: definition, input, store, agentRunner: fake.agentRunner });
  const oldIdentity = first.output.details.candidate;
  const oldReport = (await store.listArtifacts(first.run.id)).find(item => item.id === oldIdentity.id);
  const oldArtifacts = await store.listArtifacts(first.run.id);
  const previous = type => {
    const artifact = oldArtifacts.find(item => item.type === type);
    return { identity: { id: artifact.id, revision: artifact.revision, sha256: artifact.sha256 }, payload: artifact.payload };
  };
  const repairedInput = { ...input, repair: {
    candidate: { identity: oldIdentity, payload: oldReport.payload },
    feedback: [{ id: 'feedback-1', body: 'Clarify why data moves.', location: '#mechanism' }],
    route: 'expression',
    prior: { brief: previous('research-brief'), synthesis: previous('research-synthesis'),
      evidence: [previous('research-evidence')] },
  } };
  const callsBefore = fake.calls.length;
  const second = await runWorkflow({ workflow: definition, input: repairedInput, store, agentRunner: fake.agentRunner });
  assert.equal(second.run.state, 'needs_review');
  const artifacts = await store.listArtifacts(second.run.id);
  const report = artifacts.find(item => item.type === 'research-report');
  const change = artifacts.find(item => item.type === 'research-change');
  assert.ok(change);
  assert.ok(report.dependsOn.some(dep => dep.artifactId === oldIdentity.id && dep.sha256 === oldIdentity.sha256));
  assert.ok(change.dependsOn.some(dep => dep.artifactId === oldIdentity.id));
  assert.equal(artifacts.find(item => item.type === 'research-release').payload.change.id, change.id);
  assert.equal(report.payload.previous.id, oldIdentity.id);
  assert.equal(fake.calls.slice(callsBefore).some(call => ['planner', 'researcher', 'synthesizer'].includes(call.role)), false);
  assert.equal(fake.calls.slice(callsBefore).filter(call => call.task === 'fact-check-report').length, 1);
});

test('rejects an unbound review and never publishes a release', async () => {
  const run = await scenario({ wrongTarget: true });
  assert.equal(run.result.run.state, 'needs_review');
  assert.equal(run.result.output.details.reason, 'invalid-report-review');
  const artifacts = await run.store.listArtifacts(run.result.run.id);
  assert.equal(artifacts.some(item => item.type === 'research-release'), false);
  assert.ok(artifacts.some(item => item.type === 'research-review' && item.validation === 'invalid'));
});

test('evidence gap cap stops before A3 without claiming a pass', async () => {
  const run = await scenario({ gaps: true }, { maxResearchRounds: 0 });
  assert.equal(run.result.run.state, 'needs_review');
  assert.equal(run.result.output.details.reason, 'evidence-gap-budget-exhausted');
  assert.equal(run.calls.some(item => item.task === 'write-sample'), false);
});
