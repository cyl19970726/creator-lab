import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { ResponsesResearchRunner } from "./responses-research-runner.js";

const { materialize } = vi.hoisted(() => ({ materialize: vi.fn() }));
vi.mock("./creator-candidate-reuse.js", () => ({ materializeCreatorReuseCandidate: materialize }));

it("reuses a verified creator Builder candidate without invoking the model", async () => {
  const creatorRunId = randomUUID();
  const frozen = { id: "frozen", revision: "1", sha256: "a".repeat(64) };
  const report = { builderBody: "unchanged" };
  const reusedFrom = { candidate: { id: "original", revision: "1", sha256: "b".repeat(64) },
    reportArtifactRef: `/artifacts/${creatorRunId}/original/creator-analysis.json`, reportSha256: "c".repeat(64) };
  const reportArtifactRef = `/artifacts/${creatorRunId}/workflow-responses/new/attempt/creator-analysis.json`;
  materialize.mockResolvedValue({ report, reportArtifactRef, reportSha256: reusedFrom.reportSha256,
    relativeRoot: "workflow-responses/new/attempt", reusedFrom });
  const pinned = { kind: "creator", executor: "responses", source: { creatorRunId }, files: [], methods: [],
    reuseCandidate: { artifactRef: reusedFrom.reportArtifactRef, sha256: reusedFrom.reportSha256,
      candidate: reusedFrom.candidate } };
  const store = { getArtifact: vi.fn(async () => frozen), getArtifactPayload: vi.fn(async () => pinned) };
  const events: Array<{ type: string; data: unknown }> = [];
  const createModelRunner = vi.fn(() => { throw new Error("CREATOR_REUSE_MUST_NOT_CALL_MODEL"); });
  const runner = new ResponsesResearchRunner(store as never, {} as never, { createModelRunner });
  const result = await runner.run({ runId: "new", stepRunId: "builder", attemptId: "attempt",
    input: { frozenInputs: frozen }, signal: new AbortController().signal,
    definition: { id: "creator-synthesis-builder", revision: "v8", model: "gpt-6-sol",
      reasoningEffort: "medium", promptRevision: "v1", skillsRevision: "none", permissionsRevision: "bound",
      config: {} }, emit: async (type, data) => { events.push({ type, data }); } });
  expect(result.output).toMatchObject({ artifact: { kind: "creator", evidence: frozen, report,
    reportArtifactRef, reusedFrom, outcome: { state: "not_ready", synthesisArtifactRef: reportArtifactRef,
      gateArtifactRef: null, failedGateIds: [], message: "candidate reused for independent review" } } });
  expect(materialize).toHaveBeenCalledOnce();
  expect(createModelRunner).not.toHaveBeenCalled();
  expect(events).toContainEqual({ type: "responses.candidate_reused", data: {
    sourceCandidate: reusedFrom.candidate, sourceArtifactRef: reusedFrom.reportArtifactRef,
    sourceSha256: reusedFrom.reportSha256, reportArtifactRef, reportSha256: reusedFrom.reportSha256 } });
});

it("records the definition's real revision in the method event", async () => {
  const events: Array<{ type: string; data: unknown }> = [];
  const runner = new ResponsesResearchRunner({} as never, {} as never, {
    createModelRunner: () => ({ run: async () => ({ output: { accepted: true } }) }) as never
  }) as unknown as { model: (...args: unknown[]) => Promise<unknown> };
  const request = { runId: "run", stepRunId: "step", attemptId: "attempt", input: {},
    signal: new AbortController().signal,
    definition: { id: "creator-synthesis-reviewer", revision: "review-v5", model: "gpt-6-sol",
      reasoningEffort: "medium", promptRevision: "v1", skillsRevision: "none", permissionsRevision: "bound",
      config: {} }, emit: async (type: string, data: unknown) => { events.push({ type, data }); } };
  const tools = { tools: () => [], list: () => [] };
  expect(await runner.model(request, "creator-reviewer", tools, "", (value: unknown) => value))
    .toEqual({ accepted: true });
  expect(events.find(event => event.type === "responses.method")?.data)
    .toMatchObject({ role: "creator-reviewer", methodRevision: "review-v5", model: "gpt-6-sol" });
});
