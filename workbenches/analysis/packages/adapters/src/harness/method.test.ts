import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { SchemaRegistry, publishStorageContract } from "@signal-room/workflow-space-contracts";
import { PostgresBlobStore, WorkflowSpaceService, migrateWorkflowSpaces, projectExpectedAssets, publishProcessContract } from "@signal-room/workflow-spaces";
import { buildAnalysisPostMethod, buildCurrentAnalysisPostMethod, buildCurrentAnalysisPostReviewerMethod,
  type AnalysisPostMethodInput, type PostMethodSchemaName } from "./method.js";

const files = [
  "prompts/responses-source-check-v1.md", "prompts/responses-post-builder-v1.md",
  "prompts/responses-reviewer-v1.md", "prompts/responses-post-repair-v1.md",
  "packages/research/src/workflows/agents.ts", "packages/research/src/workflows/contracts.ts",
  "packages/research/src/workflows/simple-review-contract.ts", "packages/research/src/workflows/simple-review.ts",
  "packages/research/src/video-analysis/contracts.ts", "scripts/benchmark-post-workflow-run.ts", "scripts/benchmark-post-reviewer.ts",
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
const databaseUrl = process.env.WORKFLOW_TEST_DATABASE_URL;

function fixture(root: string, overrides: Partial<AnalysisPostMethodInput> = {}): AnalysisPostMethodInput {
  const skillDir = path.join(root, ".agents/skills/video-content-reconstruction");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(path.join(skillDir, "SKILL.md"), "fixture skill\n");
  const schemas = Object.fromEntries(([
    "post-input", "frozen-evidence", "post-report", "source-check", "candidate", "review", "revision-record", "registered-version",
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
  it("registers the real production full and reviewer-only factories", async () => {
    for (const projection of [
      buildCurrentAnalysisPostMethod({ id: "analysis-post-real-smoke", revision: "real-smoke-v1", changeReason: "Factory smoke test" }),
      buildCurrentAnalysisPostReviewerMethod({ id: "analysis-post-review-real-smoke", revision: "review-smoke-v1", changeReason: "Reviewer factory smoke test" }),
    ]) {
      const registry = new SchemaRegistry(projection.schemaDefinitions);
      const entry = projection.version.entrypoints.post!;
      const storage = publishStorageContract(registry, entry.storageContract);
      await publishProcessContract(entry.process!, storage);
      expect(projectExpectedAssets(entry, projection.presentation).gaps).toEqual([]);
    }
  });

  (databaseUrl ? it : it.skip)("publishes and registers both current projections in an isolated Space", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 8 });
    try {
      await migrateWorkflowSpaces(pool);
      const owner = new WorkflowSpaceService(pool, new PostgresBlobStore(pool),
        { id: `lapian-method-test-${randomUUID()}`, kind: "human" }, {
          readerIds: ["analysis.lapian"],
          resultRoleIds: ["report", "candidate", "review", "revision", "registered-version"],
        });
      const space = await owner.createSpace({ id: `lapian-method-test-${randomUUID()}`, purpose: "Current Lapian method publish integration" });
      const projections = [
        buildCurrentAnalysisPostMethod({ id: `lapian-full-${randomUUID()}`, revision: "test-v1", changeReason: "PostgreSQL publication integration" }),
        buildCurrentAnalysisPostReviewerMethod({ id: `lapian-review-${randomUUID()}`, revision: "test-v1", changeReason: "PostgreSQL reviewer publication integration" }),
      ];
      for (const projection of projections) {
        await owner.registerSchemas(space.id, projection.schemaDefinitions);
        const version = await owner.publishWorkflow(space.id, projection.version);
        const presentation = await owner.registerPresentation(space.id, projection.presentation);
        const binding = await owner.bindPresentation(space.id, { workflowVersionId: version.id, entrypoint: "post",
          presentationId: presentation.id, revision: presentation.revision });
        expect(binding.workflowVersionId).toBe(version.id);
        expect(presentation.hash).toMatch(/^[a-f0-9]{64}$/);
        expect(projectExpectedAssets(version.entrypoints.post!, presentation).gaps).toEqual([]);
      }
    } finally {
      await pool.end();
    }
  });

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
      expect(projectExpectedAssets(entry, projection.presentation).gaps).toEqual([]);
      expect(process.nodes.map((node) => node.id)).toEqual(["source-check", "builder", "reviewer", "repair", "candidate-terminal"]);
      expect(entry.nodeDefinitions?.reviewer?.instructions).toContain("responses-reviewer-v1.md source 2");
      expect(entry.nodeDefinitions?.reviewer?.model).toBe("gpt-6-luna");
      expect(entry.nodeDefinitions?.reviewer?.toolDefinitions?.[0]?.name).toBe("reviewer_read");
      expect(projection.presentation.stages?.map(({ id }) => id)).toContain("builder");
      expect(projection.presentation.assetViews.find(({ schema }) => schema.namespace === "analysis/post-report")?.label)
        .toContain("三视角");
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
      expect(projection.version.entrypoints.post?.process?.results).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "primary", outputPort: "report" }),
        expect.objectContaining({ role: "assessment", outputPort: "review" }),
      ]));
      expect(projection.version.entrypoints.post?.process?.dataBindings).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "report-to-reviewer", from: { node: "builder", port: "report" }, to: { node: "reviewer", port: "report" } }),
        expect.objectContaining({ id: "report-to-repair", from: { node: "builder", port: "report" }, to: { node: "repair", port: "report" } }),
      ]));
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
      writeFileSync(schema, JSON.stringify({ type: "object", required: ["builderLenses"], properties: {
        builderLenses: { type: "object", required: ["contentRestoration", "directingLogic", "visualEditing", "finalSummary"] },
      } }));
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
      const full = projection.version.entrypoints.post!;
      expect(full.codeRevision).toBe("v11");
      expect(projection.presentation.stages?.map((stage) => stage.label)).toContain("Builder 三视角主报告");
      const reportRef = projection.schemaDefinitions.find((definition) => definition.namespace === "creator-analysis/post-report");
      expect(reportRef?.schema).toMatchObject({ required: expect.arrayContaining(["builderLenses"]) });
      expect((reportRef?.schema as { properties: { builderLenses: { required: string[] } } }).properties.builderLenses.required)
        .toContain("finalSummary");
      const reviewOnly = buildCurrentAnalysisPostReviewerMethod({ projectRoot: root, id: "analysis-post-review-current-v1",
        revision: "review-v1", changeReason: "Current reviewer-only projection" });
      expect(reviewOnly.version.entrypoints.post?.workflowId).toBe("post.review");
      expect(reviewOnly.version.entrypoints.post?.codeRevision).toBe("v6");
      expect(reviewOnly.version.entrypoints.post?.process?.nodes.map(({ id }) => id)).toEqual(["reviewer"]);
      expect(reviewOnly.version.config.workflowSemantics).toMatchObject({ repairMaxTraversals: 0, registrationEnabled: false });
      expect(reviewOnly.presentation.stages).toEqual([expect.objectContaining({ id: "reviewer", label: "独立 Reviewer" })]);
      expect(reviewOnly.version.entrypoints.post?.process?.dataBindings).toHaveLength(2);
      expect(projectExpectedAssets(reviewOnly.version.entrypoints.post!, reviewOnly.presentation).gaps).toEqual([]);
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
