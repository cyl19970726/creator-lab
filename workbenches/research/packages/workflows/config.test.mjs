import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexSdkRunner } from '@signal-room/workflow-codex';
import { createResearchAgents, defaultProjectRoot, implementationRevision } from './config.mjs';

test('role configs pin explicit model, permissions and complete local methods', async () => {
  const agents = await createResearchAgents({ model: 'gpt-5.6-luna', reasoningEffort: 'medium' });
  assert.deepEqual(Object.keys(agents), ['planner', 'researcher', 'synthesizer', 'author', 'reader', 'fact']);
  for (const agent of Object.values(agents)) {
    assert.equal(agent.model, 'gpt-5.6-luna');
    assert.ok(agent.skillsRevision);
    assert.equal(agent.config.threadOptions.sandboxMode, 'read-only');
    assert.ok(agent.config.skills.length > 0);
    assert.ok(agent.config.skills.every(skill => skill.kind === 'skill_bundle'
      && skill.path && skill.content && skill.files.length > 0));
  }
  assert.ok((await implementationRevision()).length === 64);
});

test('real CodexSdkRunner stages frozen native research methods for an injected driver', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-runner-'));
  try {
    const sourceSkills = join(defaultProjectRoot, '.agents/skills');
    const frozenSource = join(root, '.agents/skills');
    await cp(sourceSkills, frozenSource, { recursive: true });
    const { planner } = await createResearchAgents({ projectRoot: root });
    await rm(join(root, '.agents'), { recursive: true, force: true });
    const observed = [];
    const factory = { create: () => ({
      startThread(options) {
        const cwd = options.workingDirectory;
        return { id: 'injected-thread', async runStreamed(prompt) {
          const method = await readFile(join(cwd, '.agents/skills/research-report-workflow/SKILL.md'), 'utf8');
          const contract = await readFile(join(cwd, '.agents/skills/research-report-workflow/references/contracts.md'), 'utf8');
          observed.push({ cwd, prompt, method, contract });
          return { events: (async function* () {
            yield { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: JSON.stringify({ ready: true }) } };
          })() };
        } };
      },
      resumeThread() { throw new Error('unexpected resume'); },
    }) };
    const runner = new CodexSdkRunner(factory, join(root, 'traces'), { cliBinary: 'missing-codex' });
    const result = await runner.run({ runId: 'run', stepRunId: 'step', attemptId: 'attempt',
      definition: planner, input: { task: 'brief' }, signal: new AbortController().signal,
      emit: async () => undefined });
    assert.deepEqual(result.output, { ready: true });
    assert.equal(result.metadata.skillLoad.loading, 'native_skill_packages');
    assert.equal(result.metadata.skillLoad.files.length, 0, 'references should stay inside native bundles');
    assert.equal(result.metadata.skillLoad.packages.length, 2);
    assert.match(observed[0].method, /深度研究报告路由/);
    assert.match(observed[0].contract, /产物与审核合同/);
    assert.match(observed[0].prompt, /Required native skill packages/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('all roles default to Luna medium and reject model drift', async () => {
  const agents = await createResearchAgents();
  assert.ok(Object.values(agents).every(agent => agent.model === 'gpt-5.6-luna' && agent.reasoningEffort === 'medium'));
  await assert.rejects(() => createResearchAgents({ model: 'gpt-5.6-sol' }), /pinned/);
  await assert.rejects(() => createResearchAgents({ reasoningEffort: 'high' }), /pinned/);
});
