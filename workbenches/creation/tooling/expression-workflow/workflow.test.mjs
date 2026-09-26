import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { defineAgent, MemoryRunStore, runWorkflow } from "@signal-room/workflow";
import { createExpressionWorkflow } from "./workflow.mjs";

const role = (id) => defineAgent({
  id,
  revision: "1",
  model: "fake",
  reasoningEffort: "medium",
  promptRevision: "1",
  skillsRevision: "1",
  permissionsRevision: "1",
});

const agents = { author: role("author"), reader: role("reader"), editor: role("editor") };
const researchContent = "PRIVATE_RESEARCH_CONTENT";
const input = Object.freeze({
  workspaceId: "workspace-1",
  topicId: "topic-1",
  goal: "Explain the subject clearly",
  readers: Object.freeze(["curious non-specialist"]),
  positioning: "Evidence-led plain-language explanation",
  expectedAnswers: Object.freeze(["must never reach reader"]),
  priorFindings: Object.freeze(["must never reach reader either"]),
  research: Object.freeze([Object.freeze({
    id: "source-1",
    path: "research/source-1.md",
    sha256: createHash("sha256").update(researchContent, "utf8").digest("hex"),
    content: researchContent,
  })]),
});

const candidate = (label) => ({
  title: `Title ${label}`,
  document: `Private diagnostic ${label}: AUTHOR_EXPECTED_READER_ANSWER`,
  publicDocument: `Audience narration ${label}`,
  visuals: [{ id: `visual-${label}`, content: `Visual ${label}` }],
  materials: [{ id: `material-${label}`, purpose: "MATERIAL_PRIVATE_SECRET", status: "ready", required: true }],
});

const readerReview = (sha256, observations = []) => ({ candidateSha256: sha256, observations });
const editorReview = (sha256, decision = "pass", findings = []) => ({ candidateSha256: sha256, decision, findings });

function makeRunner(implementation = {}) {
  const calls = [];
  return {
    calls,
    runner: {
      async run({ definition, input: agentInput }) {
        calls.push({ agent: definition.id, input: structuredClone(agentInput) });
        const custom = implementation[`${definition.id}:${agentInput.task}`] ?? implementation[definition.id];
        if (custom) return { output: await custom(agentInput, calls) };
        if (definition.id === "author") return { output: candidate(agentInput.task) };
        if (definition.id === "reader") return { output: readerReview(agentInput.candidateRef.sha256) };
        return { output: editorReview(agentInput.candidateRef.sha256) };
      },
    },
  };
}

async function runScenario(implementation = {}, options = {}) {
  const fake = makeRunner(implementation);
  const store = new MemoryRunStore();
  const expression = createExpressionWorkflow({ agents, revision: options.revision ?? "test-1", maxRevisions: options.maxRevisions ?? 1 });
  const result = await runWorkflow({ workflow: expression, input, store, agentRunner: fake.runner });
  return { ...fake, store, expression, result };
}

test("retains an invalid author result and does not review missing content", async () => {
  const scenario = await runScenario({
    "author:core-draft": () => ({ title: "Readable shell", visuals: [], materials: [] }),
  });
  assert.equal(scenario.result.run.state, "needs_review");
  assert.equal(scenario.result.output.details.reason, "invalid-core-candidate");
  assert.deepEqual(scenario.calls.map((call) => call.agent), ["author"]);
  const artifacts = await scenario.store.listArtifacts(scenario.result.run.id);
  const invalidCandidate = artifacts.find((artifact) => artifact.type === "expression-core-candidate");
  assert.ok(invalidCandidate);
  assert.equal(invalidCandidate.validation, "invalid");
  assert.equal(invalidCandidate.review, "pending");
});

test("requires a nonempty public document before reader review", async () => {
  const scenario = await runScenario({
    "author:core-draft": () => ({ ...candidate("core-draft"), publicDocument: "  " }),
  });
  assert.equal(scenario.result.run.state, "needs_review");
  assert.equal(scenario.result.output.details.reason, "invalid-core-candidate");
  assert.deepEqual(scenario.result.output.details.validation.required,
    ["title", "document", "publicDocument", "visuals[]", "materials[]"]);
  assert.equal(scenario.calls.some((call) => call.agent === "reader"), false);
});

test("blocks a source whose declared SHA does not match its content", async () => {
  const fake = makeRunner();
  const store = new MemoryRunStore();
  const expression = createExpressionWorkflow({ agents, revision: "bad-source", maxRevisions: 1 });
  const badInput = structuredClone(input);
  badInput.research[0].sha256 = "f".repeat(64);
  const result = await runWorkflow({ workflow: expression, input: badInput, store, agentRunner: fake.runner });
  assert.equal(result.run.state, "blocked");
  assert.equal(result.output.details.reason, "expression-input-invalid");
  assert.equal(fake.calls.length, 0);
  assert.equal((await store.listArtifacts(result.run.id)).length, 0);
});

test("reader receives only public candidate context", async () => {
  const scenario = await runScenario();
  const readerCall = scenario.calls.find((call) => call.agent === "reader");
  assert.deepEqual(Object.keys(readerCall.input).sort(), ["candidate", "candidateRef", "readers", "task"]);
  assert.deepEqual(readerCall.input.candidate, {
    title: "Title core-draft",
    document: "Audience narration core-draft",
    visuals: [{ id: "visual-core-draft", content: "Visual core-draft" }],
  });
  assert.equal(JSON.stringify(readerCall.input).includes("AUTHOR_EXPECTED_READER_ANSWER"), false);
  assert.equal(JSON.stringify(readerCall.input).includes("MATERIAL_PRIVATE_SECRET"), false);
  assert.equal(JSON.stringify(readerCall.input).includes("PRIVATE_RESEARCH_CONTENT"), false);
  assert.equal(JSON.stringify(readerCall.input).includes("expectedAnswers"), false);
  assert.equal(JSON.stringify(readerCall.input).includes("priorFindings"), false);
  assert.equal(scenario.result.run.state, "needs_review");
  assert.equal(scenario.result.output.details.reason, "awaiting-human-acceptance");
});

test("editors receive the full private candidate while readers receive its public document", async () => {
  const scenario = await runScenario();
  const readerCall = scenario.calls.find((call) => call.agent === "reader");
  const editorCall = scenario.calls.find((call) => call.agent === "editor" && call.input.task === "core-review");
  assert.equal(readerCall.input.candidate.document, "Audience narration core-draft");
  assert.equal(JSON.stringify(readerCall.input.candidate).includes("AUTHOR_EXPECTED_READER_ANSWER"), false);
  assert.equal(JSON.stringify(readerCall.input.candidate).includes("MATERIAL_PRIVATE_SECRET"), false);
  assert.equal(editorCall.input.candidate.document.includes("AUTHOR_EXPECTED_READER_ANSWER"), true);
  assert.equal(editorCall.input.candidate.publicDocument, "Audience narration core-draft");
  assert.equal(editorCall.input.candidate.materials[0].purpose, "MATERIAL_PRIVATE_SECRET");
});

test("editors receive the frozen brief and full expansion receives actual core review content", async () => {
  const observation = {
    id: "reader-note-1",
    location: "opening",
    observation: "I understood the object and result.",
    severity: "non_blocking",
  };
  const scenario = await runScenario({
    "reader:reader-review": (agentInput) => readerReview(agentInput.candidateRef.sha256, [observation]),
  });
  const expectedBrief = {
    workspaceId: input.workspaceId,
    topicId: input.topicId,
    goal: input.goal,
    readers: [...input.readers],
    positioning: input.positioning,
  };
  const editorCalls = scenario.calls.filter((call) => call.agent === "editor");
  assert.deepEqual(editorCalls.map((call) => call.input.brief), editorCalls.map(() => expectedBrief));
  const fullExpand = scenario.calls.find((call) => call.agent === "author" && call.input.task === "full-expand");
  assert.equal(fullExpand.input.reviews.length, 3);
  assert.deepEqual(fullExpand.input.reviews[0].review.observations, [observation]);
  assert.equal(fullExpand.input.reviews[1].review.decision, "pass");
  assert.equal(fullExpand.input.reviews[2].review.decision, "pass");
  assert.ok(fullExpand.input.reviews.every((item) => item.ref.sha256));
});

test("rejects a review bound to the wrong candidate hash and keeps it readable", async () => {
  const scenario = await runScenario({
    "reader:reader-review": () => readerReview("b".repeat(64)),
  });
  assert.equal(scenario.result.run.state, "needs_review");
  assert.equal(scenario.result.output.details.reason, "core-review-incomplete");
  const artifacts = await scenario.store.listArtifacts(scenario.result.run.id);
  const badReview = artifacts.find((artifact) => artifact.type === "expression-reader-review");
  assert.ok(badReview);
  assert.equal(badReview.validation, "invalid");
  assert.equal(badReview.dependsOn.length, 1);
  const target = await scenario.store.getArtifact(badReview.dependsOn[0].artifactId);
  assert.equal(target.sha256, badReview.dependsOn[0].sha256);
});

test("honors the core revision budget and never expands a failed core", async () => {
  const scenario = await runScenario({
    "editor:core-arbitration": (agentInput) => editorReview(agentInput.candidateRef.sha256, "revise", [{
      id: "finding-1", location: "opening", issue: "Still unclear", requiredChange: "Clarify it",
    }]),
  }, { maxRevisions: 1 });
  assert.equal(scenario.result.output.details.reason, "core-revision-budget-exhausted");
  assert.equal(scenario.calls.filter((call) => call.agent === "author").length, 2);
  assert.equal(scenario.calls.some((call) => call.input.task === "full-expand"), false);
});

test("full review is bound to the new full candidate rather than inherited from core", async () => {
  const scenario = await runScenario();
  const coreReview = scenario.calls.find((call) => call.agent === "editor" && call.input.task === "core-review");
  const fullReview = scenario.calls.find((call) => call.agent === "editor" && call.input.task === "full-review");
  assert.ok(coreReview);
  assert.ok(fullReview);
  assert.notEqual(fullReview.input.candidateRef.sha256, coreReview.input.candidateRef.sha256);
  const artifacts = await scenario.store.listArtifacts(scenario.result.run.id);
  const fullReviewArtifact = artifacts.find((artifact) => artifact.type === "expression-full-review");
  assert.equal(fullReviewArtifact.dependsOn[0].sha256, fullReview.input.candidateRef.sha256);
  const fullCandidateArtifact = artifacts.find((artifact) => artifact.type === "expression-full-candidate");
  const researchArtifact = artifacts.find((artifact) => artifact.type === "expression-frozen-research");
  assert.ok(fullCandidateArtifact.dependsOn.some((item) => item.artifactId === researchArtifact.id
    && item.sha256 === researchArtifact.sha256));
});

test("replay makes no additional agent calls", async () => {
  const scenario = await runScenario();
  const count = scenario.calls.length;
  const replay = await runWorkflow({
    workflow: scenario.expression,
    input,
    store: scenario.store,
    agentRunner: scenario.runner,
    resumeRunId: scenario.result.run.id,
  });
  assert.equal(replay.run.state, "needs_review");
  assert.equal(replay.output.details.reason, "awaiting-human-acceptance");
  assert.equal(scenario.calls.length, count);
});

test("a technical branch failure retains the other parallel review", async () => {
  const scenario = await runScenario({
    "editor:core-review": () => { throw new Error("editor unavailable"); },
  });
  assert.equal(scenario.result.run.state, "needs_review");
  assert.equal(scenario.result.output.details.reason, "core-review-incomplete");
  assert.equal(scenario.result.output.details.reviews.editor.status, "rejected");
  assert.equal(scenario.result.output.details.reviews.reader.status, "fulfilled");
  const artifacts = await scenario.store.listArtifacts(scenario.result.run.id);
  assert.ok(artifacts.some((artifact) => artifact.type === "expression-reader-review"));
});

test("resume retries only the failed technical review branch", async () => {
  let editorAttempts = 0;
  const fake = makeRunner({
    "editor:core-review": (agentInput) => {
      editorAttempts++;
      if (editorAttempts === 1) throw new Error("temporary editor failure");
      return editorReview(agentInput.candidateRef.sha256);
    },
  });
  const store = new MemoryRunStore();
  const expression = createExpressionWorkflow({ agents, revision: "technical-resume", maxRevisions: 1 });
  const first = await runWorkflow({ workflow: expression, input, store, agentRunner: fake.runner });
  assert.equal(first.run.state, "needs_review");
  assert.equal(first.output.details.reason, "core-review-incomplete");
  assert.equal(fake.calls.filter((call) => call.agent === "reader").length, 1);
  assert.equal(fake.calls.filter((call) => call.agent === "editor" && call.input.task === "core-review").length, 1);

  const resumed = await runWorkflow({
    workflow: expression,
    input,
    store,
    agentRunner: fake.runner,
    resumeRunId: first.run.id,
  });
  assert.equal(resumed.run.state, "needs_review");
  assert.equal(resumed.output.details.reason, "awaiting-human-acceptance");
  assert.equal(fake.calls.filter((call) => call.agent === "reader").length, 1);
  assert.equal(fake.calls.filter((call) => call.agent === "editor" && call.input.task === "core-review").length, 2);
  assert.equal(fake.calls.filter((call) => call.input.task === "core-draft").length, 1);
  const artifacts = await store.listArtifacts(first.run.id);
  assert.equal(artifacts.filter((artifact) => artifact.type === "expression-reader-review").length, 1);
  assert.equal(artifacts.filter((artifact) => artifact.type === "expression-editor-review").length, 1);
});


test("core repair handoff contains only serializable review payloads and refs", async () => {
  const result = await runScenario({
    "editor:core-arbitration": ({ candidateRef }) => editorReview(candidateRef.sha256, "revise"),
  });
  const repair = result.calls.find(call => call.input.task === "core-revise");
  assert.ok(repair);
  for (const item of repair.input.reviews) {
    assert.deepEqual(Object.keys(item).sort(), ["ref", "review"]);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(repair.input)), repair.input);
});
