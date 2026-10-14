import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MemoryRunStore, runWorkflow, type AgentRunner, type DecisionRunner } from "@signal-room/workflow";
import { postDecisionShadow, type PostDecisionShadowInput } from "./post-decision-shadow.js";

const noAgent: AgentRunner = { run: async () => { throw new Error("Unexpected agent call"); } };
const bytes = Buffer.from("exact fixture image bytes");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const fixture: PostDecisionShadowInput = {
  caseId: "fixture-1", kind: "evidence_support", claim: "The visible frame shows a red cup.",
  sourceContext: "Still frame from a frozen post; no other frames provided.",
  evidenceRefs: [{ artifactId: "frozen-post-1", revision: "r1", sha256 }],
  images: [{ dataUrl: `data:image/png;base64,${bytes.toString("base64")}`, sha256, label: "frame 1" }],
};

describe("post decision shadow", () => {
  it("records a separate shadow route without publishing or mutating frozen evidence", async () => {
    const store = new MemoryRunStore();
    const before = structuredClone(fixture);
    let calls = 0;
    const decisionRunner: DecisionRunner = { provider: "openai", revision: "mock-v1", async run(request) {
      calls += 1;
      expect(request.definition.model).toBe("gpt-6-luna");
      expect(request.input.images?.[0]?.sha256).toBe(sha256);
      expect(request.input.evidenceRefs).toEqual(fixture.evidenceRefs);
      return { provider: "openai", model: "gpt-6-luna", answers: [{ type: "choice", name: "evidence_relation",
        choice: "supported", confidence: 0.8, probabilities: [
          { value: "supported", probability: 0.8 }, { value: "contradicted", probability: 0.1 },
          { value: "insufficient", probability: 0.1 }] }] };
    } };
    const first = await runWorkflow({ workflow: postDecisionShadow, input: fixture, store, agentRunner: noAgent, decisionRunner });
    expect(first.run.state).toBe("succeeded");
    expect(first.output?.route).toBe("shadow-review");
    expect(first.output?.verdict).toBe("supported");
    expect(fixture).toEqual(before);
    expect(await store.listArtifacts(first.run.id)).toEqual([]);
    const events = await store.listEvents(first.run.id);
    expect(events.map((event) => event.type)).toContain("decision.inference.completed");
    expect(events.filter((event) => event.type === "decision.recorded")).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(bytes.toString("base64"));
    await runWorkflow({ workflow: postDecisionShadow, input: fixture, store, agentRunner: noAgent,
      decisionRunner, resumeRunId: first.run.id });
    expect(calls).toBe(1);
  });

  it("keeps a refusal distinct from a negative judgment and stays shadow-only", async () => {
    const store = new MemoryRunStore();
    const decisionRunner: DecisionRunner = { provider: "openai", revision: "mock-v1", async run() {
      return { provider: "openai", model: "gpt-6-luna", answers: [{ type: "refusal", name: "evidence_relation" }] };
    } };
    const result = await runWorkflow({ workflow: postDecisionShadow, input: { ...fixture, kind: "cut_check",
      images: [...fixture.images, { ...fixture.images[0]!, label: "frame 2" }] },
      store, agentRunner: noAgent, decisionRunner });
    expect(result.output).toMatchObject({ verdict: "refused", route: "shadow-review" });
    expect(await store.listArtifacts(result.run.id)).toEqual([]);
  });
});
