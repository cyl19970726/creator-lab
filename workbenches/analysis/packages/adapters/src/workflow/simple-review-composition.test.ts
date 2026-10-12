import { MemoryRunStore, type AgentRunner } from "@signal-room/workflow";
import { describe, expect, it } from "vitest";
import type { CreatorArtifactStore, CreatorResearchRepository, ResearchWorkflowDefinitions,
  ResearchVersionRegistrationTransaction, ResearchWorkflowExecutor } from "../../../research/index.js";
import type { WorkflowDefinitionRegistry } from "./research-workflow-executor.js";
import { createProductionResearchWorkflow, type ResearchRunStore } from "./research-workflow-composition.js";

describe("Responses reviewer workflow composition", () => {
  it("selects current definitions while preserving their durable historical revisions", () => {
    const memory = new MemoryRunStore();
    const store = Object.assign(memory, { getArtifactPayload: async (id: string) => {
      const artifact = memory.artifacts.find((item) => item.id === id);
      return artifact?.payload;
    } }) as ResearchRunStore;
    let wired: { definitions: ResearchWorkflowDefinitions; registry: WorkflowDefinitionRegistry } | undefined;
    const executorFactory = (_store: ResearchRunStore, _runner: AgentRunner, definitions: ResearchWorkflowDefinitions,
      _freezer: unknown, registry: WorkflowDefinitionRegistry) => {
      wired = { definitions, registry };
      return {} as ResearchWorkflowExecutor;
    };
    const registrationTransaction: ResearchVersionRegistrationTransaction = { run: (_creatorRunId, operation) => operation() };
    const executor = createProductionResearchWorkflow(store, {} as CreatorArtifactStore, {} as CreatorResearchRepository,
      { runner: { run: async () => { throw new Error("Composition test does not execute agents"); } } as AgentRunner,
        registrationTransaction, executorFactory });
    expect(executor).toBeDefined();
    expect(wired?.definitions.post.revision).toBe("v11");
    expect(wired?.definitions.creatorSynthesis.revision).toBe("v8");
    expect(wired?.definitions.creatorAnalysis?.revision).toBe("v11");
    for (const [id, revisions] of Object.entries({ "post.analyze": ["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9", "v11"],
      "creator.synthesize": ["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8"],
      "creator.analyze": ["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9", "v11"],
      "post.build": ["v1", "v2", "v3"], "creator.build": ["v1", "v2"], "post.source-check": ["v2", "v3", "v4"],
      "post.review": ["v1", "v2", "v3", "v4"], "creator.review": ["v1", "v2", "v3", "v4"],
      "post.repair": ["v1", "v2", "v3", "v4"], "creator.repair": ["v1", "v2", "v3"] })) {
      for (const revision of revisions) expect(wired?.registry.resolve(id, revision), `${id}@${revision}`).toBeDefined();
    }
    expect(wired?.registry.resolve("post.analyze", "v11")).toBe(wired?.definitions.post);
    expect(wired?.registry.resolve("creator.synthesize", "v8")).toBe(wired?.definitions.creatorSynthesis);
  });
});
