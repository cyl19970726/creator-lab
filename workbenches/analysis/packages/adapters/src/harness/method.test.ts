import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SchemaRegistry, publishStorageContract } from "@signal-room/workflow-space-contracts";
import { publishProcessContract } from "@signal-room/workflow-spaces";
import { buildAnalysisPostMethod, buildCurrentAnalysisPostMethod, type AnalysisPostMethodInput, type PostMethodSchemaName } from "./method.js";

const files = [
  "prompts/responses-source-check-v1.md", "prompts/responses-post-builder-v1.md",
  "prompts/responses-reviewer-v1.md", "prompts/responses-post-repair-v1.md",
  "packages/research/src/workflows/agents.ts", "packages/research/src/workflows/contracts.ts",
  "packages/research/src/workflows/simple-review-contract.ts", "packages/research/src/workflows/simple-review.ts",
  "packages/research/src/video-analysis/contracts.ts", "scripts/benchmark-post-workflow-run.ts",
  "packages/adapters/src/workflow/research-workflow-composition.ts",
  "packages/adapters/src/workflow/responses-research-runner.ts", "packages/adapters/src/workflow/responses-tools.ts",
  "packages/adapters/src/workflow/review-finding-comparison.ts", "packages/adapters/src/workflow/evidence-window.ts",
  "packages/adapters/src/workflow/builder-lens-drafts.ts", "packages/adapters/src/workflow/reconstruction-patch.ts",
  "packages/adapters/src/harness/method.ts",
  "../../vendor/agent-workflow/packages/agent-sdk/src/responses.ts",
  "../../vendor/agent-workflow/packages/agent-sdk/src/auth.ts",
  "../../vendor/agent-workflow/packages/agent-sdk/package.json", "../../pnpm-lock.yaml",
];
const roles = ["source-check", "builder", "reviewer", "repair"] as const;
const ids = { "source-check": "post-source-checker", builder: "post-builder", reviewer: "post-reviewer", repair: "post-repair" } as const;

function fixture(root: string, overrides: Partial<AnalysisPostMethodInput> = {}): AnalysisPostMethodInput {
  const skillDir = path.join(root, ".agents/skills/video-content-reconstruction");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, "SKILL.md"), "fixture skill\n");
  const schemas = Object.fromEntries(([
    "post-input", "frozen-evidence", "source-check", "candidate", "review", "revision-record", "registered-version",
  ] as PostMethodSchemaName[]).map((name) => [name, {
    namespace: `analysis/${name}`, revision: "fixture-v1", schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", additionalProperties: true,
    },
  }])) as unknown as NonNullable<AnalysisPostMethodInput["schemas"]>;
  return {
    projectRoot: root,
    id: "analysis-post-v13", revision: "v13", changeReason: "Fixture candidate",
    agents: Object.fromEntries(roles.map((role) => [role, { id: ids[role], revision: "v1",
      model: role === "reviewer" ? "gpt-6-luna" : "gpt-6-sol", reasoningEffort: "medium" }])) as AnalysisPostMethodInput["agents"],
    tools: Object.fromEntries(roles.map((role) => [role, [{ name: `${role}_read`, description: "Read bound material",
      parameters: { type: "object", additionalProperties: false } }]])) as unknown as NonNullable<AnalysisPostMethodInput["tools"]>,
    schemas,
    ...overrides,
  };
}

describe("analysis post method projection", () => {
  it("reads current prompt/code bytes and produces a valid shared process/storage draft", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "analysis-post-method-"));
    try {
      for (const [index, file] of files.entries()) {
        const target = path.resolve(root, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, `${file} source ${index}\n`);
      }
      const input = fixture(root);
      const projection = buildAnalysisPostMethod(input);
      const entry = projection.version.entrypoints.post!;
      const registry = new SchemaRegistry(projection.schemaDefinitions);
      const storage = publishStorageContract(registry, entry.storageContract);
      const process = await publishProcessContract(entry.process!, storage);
      expect(process.nodes.map((node) => node.id)).toEqual(["source-check", "builder", "reviewer", "repair", "candidate-terminal"]);
      expect(entry.nodeDefinitions?.reviewer?.instructions).toContain("responses-reviewer-v1.md source 2");
      expect(entry.nodeDefinitions?.reviewer?.model).toBe("gpt-6-luna");
      expect(entry.nodeDefinitions?.reviewer?.toolDefinitions?.[0]?.name).toBe("reviewer_read");
      expect(projection.promptSnapshot.reviewer.sha256).toHaveLength(64);
      expect((projection.version.config.methodSnapshotHash as string)).toHaveLength(64);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records the real bounded-repair caveat and rejects agents from another workflow", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "analysis-post-method-"));
    try {
      for (const [index, file] of files.entries()) {
        const target = path.resolve(root, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, `${file} source ${index}\n`);
      }
      const projection = buildAnalysisPostMethod(fixture(root, { registrationEnabled: false }));
      const config = projection.version.config as { workflowSemantics: Record<string, unknown> };
      expect(config.workflowSemantics).toMatchObject({ repairMaxTraversals: 1, secondReviewAfterRepair: false,
        repairedCandidateStatus: "revised-unverified", qualityAcceptedByHarness: false });
      expect(projection.version.entrypoints.post?.nodeDefinitions?.["candidate-terminal"]?.configuration)
        .toMatchObject({ registrationEnabled: false, selectsRepairedCandidateWhenPresent: true });
      const fixtureAgents = fixture(root).agents!;
      expect(() => buildAnalysisPostMethod(fixture(root, { agents: { ...fixtureAgents,
        reviewer: { ...fixtureAgents.reviewer, id: "creator-synthesis-reviewer" } } })))
        .toThrow("POST_METHOD_AGENT_MISMATCH:reviewer");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("offers a one-call factory using the production agent definitions and role tool catalog", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "analysis-post-current-method-"));
    try {
      for (const [index, file] of files.entries()) {
        const target = path.resolve(root, file);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, `${file} source ${index}\n`);
      }
      fixture(root);
      const schema = path.join(root, ".agents/skills/video-content-reconstruction/schemas/reconstruction.schema.json");
      mkdirSync(path.dirname(schema), { recursive: true });
      writeFileSync(schema, JSON.stringify({ type: "object", required: ["builderLenses"] }));
      const projection = buildCurrentAnalysisPostMethod({ projectRoot: root, id: "analysis-post-current-v1",
        revision: "current-v1", changeReason: "Current production projection" });
      const nodes = projection.version.entrypoints.post?.nodeDefinitions;
      expect(nodes?.builder?.model).toBe("gpt-6-luna");
      expect(nodes?.builder?.configuration?.roleToolCapabilities).toContainEqual(expect.objectContaining({ name: "validate_reconstruction_draft" }));
      expect(nodes?.builder?.configuration?.dynamicToolConditions).toMatchObject({
        capture_frame: expect.stringContaining("only when the bound source media is video"),
      });
      expect(nodes?.reviewer?.configuration?.roleToolCapabilities)
        .toContainEqual(expect.objectContaining({ name: "check_review_evidence_readiness" }));
      const registrationProjection = buildCurrentAnalysisPostMethod({ projectRoot: root, id: "analysis-post-register-v1",
        revision: "register-v1", changeReason: "Registration-enabled candidate", registrationEnabled: true });
      expect(registrationProjection.version.entrypoints.post?.process?.nodes.map((node) => node.id))
        .toContain("register-version");
      expect(registrationProjection.version.entrypoints.post?.process?.results[0]?.role).toBe("registered-version");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
