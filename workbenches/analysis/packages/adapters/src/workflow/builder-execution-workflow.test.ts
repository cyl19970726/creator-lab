import { describe, expect, it, vi } from "vitest";
import { MemoryRunStore, defineAgent, type AgentRunResult, type DecisionRunner } from "@signal-room/workflow";
import {
  builderLensSlots, runBuilderEvidence, runBuilderExecution,
  type BuilderExecutionOptions, type BuilderLensInput, type BuilderLensResult, type BuilderLensSlot, type BuilderLensMode,
} from "./builder-execution-workflow.js";

type Evidence = { hash: string };
type LensInput = { promptRevision: string };
type LensResult = BuilderLensResult<string, { draftId: string }>;

async function fixture(signal = new AbortController().signal) {
  const store = new MemoryRunStore();
  const parent = await store.createRun({ workflowId: "parent", workflowRevision: "1", inputFingerprint: "parent-input",
    state: "running" });
  const step = await store.createStep({ runId: parent.id, key: "builder", kind: "agent", workflowId: "parent",
    workflowRevision: "1", inputFingerprint: "parent-input", configFingerprint: "parent-config", state: "running",
    validation: "pending" });
  return { store, parentRequest: { runId: parent.id, stepRunId: step.id, signal } };
}

function options(
  base: Awaited<ReturnType<typeof fixture>>,
  lensMode: BuilderLensMode,
  writeLens: BuilderExecutionOptions<Evidence, LensInput, string, { draftId: string }>["writeLens"],
): BuilderExecutionOptions<Evidence, LensInput, string, { draftId: string }> {
  const definition = (slot: BuilderLensSlot) => defineAgent<BuilderLensInput<Evidence, LensInput>, LensResult>({
    id: `post-builder-${slot}`, revision: "1", model: "fake", reasoningEffort: "low", promptRevision: "1",
    skillsRevision: "1", permissionsRevision: "1",
  });
  return {
    ...base, revision: "1", input: { frozenEvidenceHash: "sha256:abc", evidenceMode: "baseline", lensMode,
      configRevision: "1" }, evidenceReceipt: { hash: "sha256:abc" },
    lenses: {
      contentRestoration: { definition: definition("contentRestoration"), input: { promptRevision: "1" } },
      directingLogic: { definition: definition("directingLogic"), input: { promptRevision: "1" } },
      visualEditing: { definition: definition("visualEditing"), input: { promptRevision: "1" } },
    }, writeLens,
  };
}

const complete = async (slot: BuilderLensSlot): Promise<AgentRunResult<LensResult>> => ({
  output: { slot, value: slot, receipt: { draftId: `draft-${slot}` } }, validation: "valid",
});

describe("Builder execution workflow", () => {
  it.each(["content-first-serial", "content-first-parallel"] as const)("hands off the exact passing restoration before either interpretation in %s", async lensMode => {
    const base = await fixture();
    const started: BuilderLensSlot[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const run = runBuilderExecution(options(base, lensMode, async (slot, request) => {
      started.push(slot);
      if (slot === "contentRestoration") {
        expect(request.input.contentRestorationHandoff).toBeUndefined();
        await gate;
      } else {
        expect(request.input.contentRestorationHandoff).toEqual((await complete("contentRestoration")).output);
      }
      return complete(slot);
    }));
    await vi.waitFor(() => expect(started).toEqual(["contentRestoration"]));
    release();
    const result = await run;
    expect(started.sort()).toEqual([...builderLensSlots].sort());
    expect(result.output.lenses.visualEditing.value).toBe("visualEditing");
  });

  it("does not start interpretation branches after a failed restoration", async () => {
    const base = await fixture();
    const write = vi.fn(async (slot: BuilderLensSlot) => { throw new Error(`${slot}: invalid restoration`); });
    await expect(runBuilderExecution(options(base, "content-first-parallel", write))).rejects.toThrow("invalid restoration");
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]?.[0]).toBe("contentRestoration");
  });

  it("overlaps only the two interpretation writers with one shared restoration receipt", async () => {
    const base = await fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started: string[] = [];
    const run = runBuilderExecution(options(base, "content-first-parallel", async (slot, request) => {
      started.push(slot);
      if (slot !== "contentRestoration") {
        expect(request.input.contentRestorationHandoff?.receipt).toEqual({ draftId: "draft-contentRestoration" });
        await gate;
      }
      return complete(slot);
    }));
    await vi.waitFor(() => expect(started).toEqual([...builderLensSlots]));
    release();
    await run;
  });
  it("runs three isolated parallel agent steps with bounded overlap and child provenance", async () => {
    const base = await fixture();
    const started: BuilderLensSlot[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = runBuilderExecution(options(base, "parallel", async (slot, request) => {
      expect(request.input.slot).toBe(slot);
      started.push(slot);
      await gate;
      return complete(slot);
    }));
    await vi.waitFor(() => expect(started).toHaveLength(3));
    expect(new Set(started)).toEqual(new Set(builderLensSlots));
    release();
    const result = await run;
    expect(Object.keys(result.output.lenses).sort()).toEqual([...builderLensSlots].sort());
    expect(Object.entries(result.output.lenses).every(([slot, output]) => slot === output.slot)).toBe(true);
    const child = await base.store.getRun(result.runId);
    expect(child?.parentRunId).toBe(base.parentRequest.runId);
    expect(child?.parentStepRunId).toBe(base.parentRequest.stepRunId);
    const steps = await base.store.listSteps(result.runId);
    expect(steps.filter((step) => step.kind === "agent")).toHaveLength(3);
    expect(new Set(steps.filter((step) => step.kind === "agent").map((step) => step.id)).size).toBe(3);
    expect((await base.store.listEvents(result.runId)).filter((event) => event.type === "step.started").length).toBeGreaterThanOrEqual(7);
  });

  it("runs serial lenses in fixed order using the same definitions and input shape", async () => {
    const base = await fixture();
    const order: string[] = [];
    const result = await runBuilderExecution(options(base, "serial", async (slot) => {
      order.push(`start:${slot}`);
      await Promise.resolve();
      order.push(`end:${slot}`);
      return complete(slot);
    }));
    expect(order).toEqual(builderLensSlots.flatMap((slot) => [`start:${slot}`, `end:${slot}`]));
    expect(result.output.lenses.visualEditing.receipt.draftId).toBe("draft-visualEditing");
  });

  it("waits for remaining branches after a failure and leaves no partial merged output", async () => {
    const base = await fixture();
    const completed: BuilderLensSlot[] = [];
    let childId: string | undefined;
    await expect(runBuilderExecution(options(base, "parallel", async (slot, request) => {
      childId = request.runId;
      if (slot === "directingLogic") throw new Error("invalid directing receipt");
      await new Promise((resolve) => setTimeout(resolve, 15));
      completed.push(slot);
      return complete(slot);
    }))).rejects.toThrow(/directingLogic/);
    expect(completed.sort()).toEqual(["contentRestoration", "visualEditing"]);
    const child = await base.store.getRun(childId!);
    expect(child?.state).toBe("failed");
    expect(child?.output).toBeUndefined();
    const steps = await base.store.listSteps(childId!);
    expect(steps.filter((step) => step.kind === "agent" && step.state === "succeeded")).toHaveLength(2);
    expect(steps.filter((step) => step.kind === "agent" && step.state === "failed")).toHaveLength(1);
  });

  it("joins canceled branch callbacks before returning and marks the child canceled", async () => {
    const controller = new AbortController();
    const base = await fixture(controller.signal);
    let active = 0;
    let childId: string | undefined;
    const run = runBuilderExecution(options(base, "parallel", async (_slot, request) => {
      childId = request.runId;
      active++;
      try {
        await new Promise<void>((resolve) => {
          request.signal.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("model canceled");
      } finally { active--; }
    }));
    await vi.waitFor(() => expect(active).toBe(3));
    controller.abort();
    await expect(run).rejects.toThrow();
    expect(active).toBe(0);
    expect((await base.store.getRun(childId!))?.state).toBe("canceled");
  });

  it("fingerprints safe config, reuses completed steps on explicit replay, and rejects changed config", async () => {
    const base = await fixture();
    const writeLens = vi.fn(async (slot: BuilderLensSlot) => complete(slot));
    const config = options(base, "serial", writeLens);
    const first = await runBuilderExecution(config);
    const replay = await runBuilderExecution({ ...config, resumeRunId: first.runId });
    expect(replay.runId).toBe(first.runId);
    expect(writeLens).toHaveBeenCalledTimes(3);
    expect((await base.store.listEvents(first.runId)).some((event) => event.type === "step.reused")).toBe(true);
    await expect(runBuilderExecution({ ...config, resumeRunId: first.runId,
      input: { ...config.input, configRevision: "2" } })).rejects.toThrow(/fingerprint/);
    await expect(runBuilderExecution({ ...config, resumeRunId: first.runId,
      lenses: { ...config.lenses, visualEditing: { ...config.lenses.visualEditing,
        input: { promptRevision: "2" } } } })).rejects.toThrow(/fingerprint/);
  });

  it("records evidence preparation and a finite decision without starting any lens", async () => {
    const base = await fixture();
    const decisionRunner: DecisionRunner = { provider: "fake", revision: "1", async run() {
      return { provider: "fake", model: "fake", answers: [{ type: "predicate", name: "hasCuts", probability: 0.9 }] };
    } };
    const result = await runBuilderEvidence({ ...base, revision: "1",
      input: { frozenEvidenceHash: "sha256:abc", evidenceMode: "decisions" }, decisionRunner,
      prepareEvidence: async (ctx) => {
        const decision = await ctx.decision("cut-check", { id: "cut-check", revision: "1", provider: "fake",
          model: "fake", timeoutMs: 1000,
          questions: [{ type: "predicate", name: "hasCuts", instructions: "Identify cuts" }] }, { text: "evidence" });
        return { hash: `decision:${decision.answers.length}` };
      } });
    expect(result.evidence.hash).toBe("decision:1");
    const steps = await base.store.listSteps(result.runId);
    expect(steps.map((step) => step.kind)).toEqual(expect.arrayContaining(["phase", "task", "decision"]));
    expect(steps.some((step) => step.kind === "agent")).toBe(false);
  });
});
