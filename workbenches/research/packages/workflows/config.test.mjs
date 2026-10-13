import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResearchAgents, defaultProjectRoot, implementationRevision } from './config.mjs';
import { createResearchSiwcRunner } from './research-runner.mjs';

const model = 'gpt-6-luna';
const jsonOutput = value => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] });
function completed(value) {
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'test-response', output: [jsonOutput(value)] } })}\n\n`);
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
}

test('role configs pin gpt-6-luna, read-only host tools and complete frozen local methods', async () => {
  const agents = await createResearchAgents({ model, reasoningEffort: 'medium' });
  assert.deepEqual(Object.keys(agents), ['planner', 'researcher', 'synthesizer', 'author', 'reader', 'fact']);
  for (const agent of Object.values(agents)) {
    assert.equal(agent.model, model);
    assert.ok(agent.skillsRevision);
    assert.deepEqual(agent.config.toolNames, agent.id === 'research-reader' ? []
      : ['research-author', 'research-synthesizer'].includes(agent.id) ? ['read_frozen_source']
      : ['read_frozen_source', 'search_public_web', 'open_public_page']);
    assert.ok(agent.config.skills.length > 0);
    assert.ok(agent.config.skills.every(skill => skill.kind === 'skill_bundle'
      && skill.path && skill.content && skill.files.length > 0));
  }
  assert.equal((await implementationRevision()).length, 64);
  await assert.rejects(() => createResearchAgents({ model: 'gpt-6-sol' }), /pinned/);
  await assert.rejects(() => createResearchAgents({ reasoningEffort: 'low' }), /pinned/);
});

test('official Agents SDK runs frozen role instructions and emits durable SDK metadata without Codex processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-agent-sdk-'));
  try {
    await cp(join(defaultProjectRoot, '.agents/skills'), join(root, '.agents/skills'), { recursive: true });
    const { planner } = await createResearchAgents({ projectRoot: root });
    await rm(join(root, '.agents'), { recursive: true, force: true });
    const requestBodies = [];
    const fetch = async (_url, init) => {
      requestBodies.push(JSON.parse(String(init.body)));
      return completed({ title: 'Brief', document: 'A frozen-method result.', problems: [] });
    };
    const runner = createResearchSiwcRunner({ auth: { accessToken: async () => 'test-token' }, sdkOptions: { fetch } });
    const events = [];
    const result = await runner.run({ runId: 'run', stepRunId: 'step', attemptId: 'attempt', input: { task: 'brief' },
      definition: planner, signal: new AbortController().signal, emit: async (type, data) => events.push({ type, data }) });
    assert.deepEqual(result.output, { title: 'Brief', document: 'A frozen-method result.', problems: [] });
    assert.equal(requestBodies.length, 1, 'the SDK made one model request');
    assert.match(JSON.stringify(requestBodies[0]), /Frozen method package/);
    assert.match(JSON.stringify(requestBodies[0]), /research-report-workflow\/SKILL.md/);
    assert.ok(events.some(item => item.type === 'research.siwc.mapping' && item.data.runtime === 'openai-agents-sdk'));
    assert.ok(events.some(item => item.type === 'siwc.started' && item.data.sdkPackage === '@openai/agents'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
