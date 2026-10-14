import { describe, expect, it } from "vitest";
import type { StepRecord } from "@signal-room/workflow";
import type { HistoricalProcessResolverInput, ProcessContract } from "@signal-room/workflow-spaces";
import { analysisPostProcessResolvers } from "./process.js";

function step(id: string, key: string, kind: StepRecord["kind"], workflowId: string): StepRecord {
  return { id, runId: "native-root", key, kind, workflowId, workflowRevision: "v11",
    inputFingerprint: "input", configFingerprint: "config", state: "succeeded", validation: "valid" };
}
function input(workflowId: string, steps: StepRecord[], nodeIds: string[], observedNativeRun = false): HistoricalProcessResolverInput {
  const process = { revision: "method-v1", hash: "frozen-contract-hash", runInputs: {},
    nodes: nodeIds.map(id => ({ id, kind: id === "native-execution" ? "group" as const : "agent" as const })),
    edges: [], results: [] } as ProcessContract;
  const value = { run: { runId: "native-root", entrypoint: "post", workflowVersionId: "current-method" },
    workflow: { config: { observedNativeRun }, entrypoints: { post: { workflowId, process } } },
    steps, contexts: [], events: [] };
  return value as unknown as HistoricalProcessResolverInput;
}

describe("native post process projection", () => {
  it("maps only exact full-workflow phase and child-call keys to frozen current method nodes", async () => {
    const steps = [
      step("s1", "source-consistency", "phase", "post.analyze"),
      step("s2", "source-consistency:source-check", "workflow", "post.analyze"),
      step("s3", "candidate-build", "phase", "post.analyze"),
      step("s4", "candidate-build:build", "workflow", "post.analyze"),
      step("s5", "simple-review", "phase", "post.analyze"),
      step("s6", "simple-review:review:attempt:2", "map", "post.analyze"),
      step("s7", "simple-review:review:2", "workflow", "post.analyze"),
      step("s8", "candidate-revision:repair:1", "workflow", "post.analyze"),
      step("s9", "revision-artifacts", "phase", "post.analyze"),
      step("unknown", "candidate-build:maybe", "workflow", "post.analyze"),
      step("wrong-kind", "source-consistency", "agent", "post.analyze"),
      step("wrong-workflow", "reviewer", "agent", "post.review"),
    ];
    const resolved = await analysisPostProcessResolvers["post.analyze"](input("post.analyze", steps,
      ["source-check", "builder", "reviewer", "repair", "candidate-terminal"]));
    expect(resolved.contract).not.toHaveProperty("hash");
    expect(resolved.mappings.map(map => [map.stepRunId, map.annotation.nodeId])).toEqual([
      ["s1", "source-check"], ["s2", "source-check"], ["s3", "builder"], ["s4", "builder"],
      ["s5", "reviewer"], ["s6", "reviewer"], ["s7", "reviewer"], ["s8", "repair"],
      ["s9", "candidate-terminal"],
    ]);
    expect(resolved.mappings[5]?.evidence).toContain("key=simple-review:review:attempt:2");
    expect(resolved.mappings[5]?.annotation).not.toHaveProperty("round");
    expect(resolved.routes).toBeUndefined();
  });

  it("maps reviewer-only agent, validation and publication without inventing a build", async () => {
    const resolved = await analysisPostProcessResolvers["post.review"](input("post.review", [
      step("a", "reviewer", "agent", "post.review"), step("b", "review-check", "validation", "post.review"),
      step("c", "evaluation", "publish", "post.review"), step("d", "receipt", "publish", "post.review"),
      step("e", "builder", "agent", "post.review"),
    ], ["reviewer"]));
    expect(resolved.mappings.map(map => map.stepRunId)).toEqual(["a", "b", "c", "d"]);
    expect(resolved.mappings.every(map => map.annotation.nodeId === "reviewer")).toBe(true);
  });

  it("maps real child workflow keys and exact historical step-ID nodes, leaving unknowns unmapped", async () => {
    const childCases = [
      ["post.source-check", "check", "agent", "source-check"],
      ["post.build", "candidate-check", "validation", "builder"],
      ["post.repair", "revision-record", "publish", "repair"],
    ] as const;
    for (const [workflowId, key, kind, nodeId] of childCases) {
      const resolved = await analysisPostProcessResolvers[workflowId](input(workflowId,
        [step("known", key, kind, workflowId), step("unseen", "arbitrary", "task", workflowId)], [nodeId]));
      expect(resolved.mappings.map(map => map.stepRunId)).toEqual(["known"]);
    }
    const historical = await analysisPostProcessResolvers["post.review"](input("post.review",
      [step("historical-step-uuid", "legacy-key", "task", "post.review"),
        step("plain-id", "legacy-key", "task", "post.review"),
        step("other", "legacy-key", "task", "post.review")],
      ["step-historical-step-uuid", "historical-step-uuid", "plain-id"]));
    expect(historical.mappings).toMatchObject([{ stepRunId: "historical-step-uuid",
      annotation: { nodeId: "step-historical-step-uuid" } },
    { stepRunId: "plain-id", annotation: { nodeId: "plain-id" } }]);
    expect(historical.mappings[0]?.evidence).toContain("Exact frozen process node ID");
  });

  it("maps every real step of an observed native run into its frozen execution group", async () => {
    const resolved = await analysisPostProcessResolvers["post.review"](input("post.review", [
      step("first", "reviewer", "agent", "post.review"),
      step("later", "previously-unseen-publication", "publish", "post.review"),
      { ...step("other-run", "reviewer", "agent", "post.review"), runId: "another-run" },
    ], ["native-execution", "step-first"], true));
    expect(resolved.mappings.map(map => [map.stepRunId, map.annotation.nodeId])).toEqual([
      ["first", "native-execution"], ["later", "native-execution"],
    ]);
    expect(resolved.mappings.every(map => map.evidence.includes("Derived observed native execution group"))).toBe(true);
    expect(resolved.mappings.every(map => map.annotation.round === undefined)).toBe(true);
  });
});
