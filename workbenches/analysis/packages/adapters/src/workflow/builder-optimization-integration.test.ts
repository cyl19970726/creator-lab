import { expect, it, vi } from "vitest";
import type { AgentRunRequest, ArtifactRef } from "@signal-room/workflow";
import { ResponsesResearchRunner, builderPromptFileName, type BuilderOptimization } from "./responses-research-runner.js";
import { ResponsesEvidenceTools } from "./responses-tools.js";

const parentSignal = new AbortController().signal;
it("isolates content-first candidate instructions from the default and existing control modes", () => {
  for (const lensMode of ["single", "serial", "parallel", "content-first-mistyped"]) {
    expect(builderPromptFileName({ builderOptimization: { evidenceMode: "agent", lensMode } }))
      .toBe("responses-post-builder-v1.md");
  }
  expect(builderPromptFileName(undefined)).toBe("responses-post-builder-v1.md");
  for (const lensMode of ["content-first-serial", "content-first-parallel"]) {
    expect(builderPromptFileName({ builderOptimization: { evidenceMode: "agent", lensMode } }))
      .toBe("responses-post-builder-content-first-v1.md");
  }
  expect(builderPromptFileName({ builderPromptVariant: "content-first", builderLensSlot: "visualEditing" }))
    .toBe("responses-post-builder-content-first-v1.md");
});
const request = (config?: Record<string, unknown>): AgentRunRequest<unknown> => ({
  runId: "parent-run", stepRunId: "builder-step", attemptId: "builder-attempt", input: {}, signal: parentSignal,
  definition: { id: "post-builder", revision: "1", model: "fake", reasoningEffort: "low", promptRevision: "1",
    skillsRevision: "1", permissionsRevision: "1", config }, emit: vi.fn(async () => {}),
});

type Probe = { postBuilder: (...args: unknown[]) => Promise<unknown> };
function invoke(optimization: BuilderOptimization | undefined, definitionConfig?: Record<string, unknown>) {
  const prepareMedia = vi.fn(async () => { throw new Error("media preparation must not run"); });
  const createModelRunner = vi.fn(() => { throw new Error("model factory must not run"); });
  const runner = new ResponsesResearchRunner({} as never, {} as never,
    { builderOptimization: optimization, prepareMedia: prepareMedia as never, createModelRunner });
  const pinned = { source: new Proxy({}, { get() { throw new Error("source accessed before guard"); } }) };
  const tools = new ResponsesEvidenceTools([], "/unused");
  const run = (runner as unknown as Probe).postBuilder(request(definitionConfig), {} as ArtifactRef,
    pinned, undefined, {}, tools, "/unused", false);
  return { run, prepareMedia, createModelRunner };
}

it("fails before media or model access when a serial or parallel optimization is not pinned in the Agent definition", async () => {
  for (const lensMode of ["serial", "parallel", "content-first-serial", "content-first-parallel"] as const) {
    const test = invoke({ evidenceMode: "agent", lensMode });
    await expect(test.run).rejects.toThrow("RESPONSES_BUILDER_OPTIMIZATION_NOT_PINNED");
    expect(test.prepareMedia).not.toHaveBeenCalled();
    expect(test.createModelRunner).not.toHaveBeenCalled();
  }
  const mismatch = invoke({ evidenceMode: "agent", lensMode: "parallel" },
    { builderOptimization: { evidenceMode: "agent", lensMode: "serial" } });
  await expect(mismatch.run).rejects.toThrow("RESPONSES_BUILDER_OPTIMIZATION_NOT_PINNED");
});

it("fails before media or model access when Decisions mode has no DecisionRunner", async () => {
  const optimization = { evidenceMode: "decisions", lensMode: "single" } as const;
  const test = invoke(optimization, { builderOptimization: optimization });
  await expect(test.run).rejects.toThrow("RESPONSES_BUILDER_DECISION_RUNNER_REQUIRED");
  expect(test.prepareMedia).not.toHaveBeenCalled();
  expect(test.createModelRunner).not.toHaveBeenCalled();
});

it("rejects pinned experimental definitions and stray prompt variants when runner options are default or omitted", async () => {
  for (const optimization of [undefined, { evidenceMode: "agent", lensMode: "single" } as const]) {
    for (const lensMode of ["content-first-serial", "content-first-parallel", "parallel"] as const) {
      const test = invoke(optimization, { builderOptimization: { evidenceMode: "agent", lensMode } });
      await expect(test.run).rejects.toThrow("RESPONSES_BUILDER_OPTIMIZATION_NOT_PINNED");
      expect(test.prepareMedia).not.toHaveBeenCalled();
      expect(test.createModelRunner).not.toHaveBeenCalled();
    }
    const stray = invoke(optimization, { builderPromptVariant: "content-first" });
    await expect(stray.run).rejects.toThrow("RESPONSES_BUILDER_OPTIMIZATION_NOT_PINNED");
  }
});

it("keeps the default usable with no pin or an exactly matching explicit pin", async () => {
  for (const config of [undefined, { builderOptimization: { lensMode: "single", evidenceMode: "agent" } }]) {
    await expect(invoke(undefined, config).run).rejects.toThrow("source accessed before guard");
  }
});
