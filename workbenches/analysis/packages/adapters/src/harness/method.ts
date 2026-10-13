import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSON_SCHEMA_DIALECT, SchemaRegistry, publishStorageContract,
  type JsonValue, type SchemaDefinition, type SchemaRef, type StorageContractDraft } from "@signal-room/workflow-space-contracts";
import { snapshotSkill } from "@signal-room/workflow-skill-snapshot";
import { makeAgents } from "../../../../scripts/benchmark-post-workflow-run.js";
import { projectResponsesEvidenceToolManifest } from "../workflow/responses-tools.js";
import type { AgentDefinition } from "@signal-room/workflow";
import type { ProcessContractDraft, WorkflowNodeDefinition, WorkflowVersionDraft } from "@signal-room/workflow-spaces";

export type PostMethodRole = "source-check" | "builder" | "reviewer" | "repair";
export type PostMethodSchemaName = "post-input" | "frozen-evidence" | "source-check" | "candidate" |
  "review" | "revision-record" | "registered-version";

/** JSON Schemas are supplied by the host from the current analysis contracts. */
export type PostMethodSchemaDefinitions = Record<PostMethodSchemaName, Omit<SchemaDefinition, "dialect"> & {
  dialect?: typeof JSON_SCHEMA_DIALECT;
}>;

export interface PostMethodToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface PostMethodAgent {
  id: string;
  revision: string;
  model: string;
  reasoningEffort?: string;
  promptRevision?: string;
  skillsRevision?: string;
  permissionsRevision?: string;
}

export interface AnalysisPostMethodInput {
  /** Absolute analysis workbench root. Defaults to the owning workbench root. */
  projectRoot?: string;
  /** Use the exact definitions created by the active Responses production composition. */
  agents?: Record<PostMethodRole, PostMethodAgent | AgentDefinition<unknown, unknown>>;
  /** Exact provider-visible tool manifests for this deployment and role. */
  tools?: Record<PostMethodRole, readonly PostMethodToolDefinition[]>;
  /** Exact current contracts. These are returned for host schema registration. */
  schemas?: PostMethodSchemaDefinitions;
  /** Candidate version metadata; no registration or execution is performed here. */
  id: string;
  revision: string;
  changeReason: string;
  predecessorId?: string;
  /** In benchmark projection, registration is deliberately disabled. */
  registrationEnabled?: boolean;
}

export type CurrentAnalysisPostMethodInput = Omit<AnalysisPostMethodInput, "agents" | "tools" | "schemas">;

export interface AnalysisPostMethodProjection {
  version: WorkflowVersionDraft;
  entrypoint: "post";
  schemaDefinitions: ReturnType<SchemaRegistry["snapshot"]>;
  methodSnapshot: Array<{ path: string; sha256: string }>;
  skillSnapshot: { path: string; sha256: string };
  promptSnapshot: Record<PostMethodRole, { path: string; sha256: string; text: string }>;
}

const METHOD_FILES = [
  "prompts/responses-source-check-v1.md",
  "prompts/responses-post-builder-v1.md",
  "prompts/responses-reviewer-v1.md",
  "prompts/responses-post-repair-v1.md",
  "packages/research/src/workflows/agents.ts",
  "packages/research/src/workflows/contracts.ts",
  "packages/research/src/workflows/simple-review-contract.ts",
  "packages/research/src/workflows/simple-review.ts",
  "packages/research/src/video-analysis/contracts.ts",
  "scripts/benchmark-post-workflow-run.ts",
  "packages/adapters/src/workflow/research-workflow-composition.ts",
  "packages/adapters/src/workflow/responses-research-runner.ts",
  "packages/adapters/src/workflow/responses-tools.ts",
  "packages/adapters/src/workflow/review-finding-comparison.ts",
  "packages/adapters/src/workflow/evidence-window.ts",
  "packages/adapters/src/workflow/builder-lens-drafts.ts",
  "packages/adapters/src/workflow/reconstruction-patch.ts",
  "packages/adapters/src/harness/method.ts",
  "../../vendor/agent-workflow/packages/agent-sdk/src/responses.ts",
  "../../vendor/agent-workflow/packages/agent-sdk/src/auth.ts",
  "../../vendor/agent-workflow/packages/agent-sdk/package.json",
  "../../pnpm-lock.yaml",
] as const;

const PROMPT_BY_ROLE: Record<PostMethodRole, string> = {
  "source-check": "prompts/responses-source-check-v1.md",
  builder: "prompts/responses-post-builder-v1.md",
  reviewer: "prompts/responses-reviewer-v1.md",
  repair: "prompts/responses-post-repair-v1.md",
};

const AGENT_ID_BY_ROLE: Record<PostMethodRole, string> = {
  "source-check": "post-source-checker",
  builder: "post-builder",
  reviewer: "post-reviewer",
  repair: "post-repair",
};

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const stableJson = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

function workbenchRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
}

function roleAgent(value: PostMethodAgent | AgentDefinition<unknown, unknown>, role: PostMethodRole): PostMethodAgent {
  const agent = value as PostMethodAgent;
  if (agent.id !== AGENT_ID_BY_ROLE[role] || typeof agent.model !== "string" || !agent.model.trim()) {
    throw new Error(`POST_METHOD_AGENT_MISMATCH:${role}`);
  }
  return agent;
}

function actualAgents(): Record<PostMethodRole, PostMethodAgent> {
  const { agents } = makeAgents();
  const pick = (agent: AgentDefinition<unknown, unknown>): PostMethodAgent => ({ id: agent.id,
    revision: agent.revision, model: agent.model, reasoningEffort: agent.reasoningEffort,
    promptRevision: agent.promptRevision, skillsRevision: agent.skillsRevision,
    permissionsRevision: agent.permissionsRevision });
  return { "source-check": pick(agents.postSourceChecker), builder: pick(agents.postBuilder),
    reviewer: pick(agents.postReviewer), repair: pick(agents.postRepair) };
}

function sourceSchema(namespace: string, revision: string, schema: Record<string, unknown>): Omit<SchemaDefinition, "dialect"> {
  return { namespace, revision, schema: schema as JsonValue };
}

function currentSchemas(root: string): PostMethodSchemaDefinitions {
  void root;
  const object = (properties: Record<string, unknown>, required: string[]) => ({
    $schema: JSON_SCHEMA_DIALECT, type: "object", additionalProperties: false, properties, required,
  });
  const openObject = { $schema: JSON_SCHEMA_DIALECT, type: "object", additionalProperties: true,
    description: "Open declaration: current runtime Zod/host validator is not represented by this JSON Schema." };
  const artifactRef = object({ id: { type: "string" }, type: { type: "string" }, schemaVersion: { type: "string" },
    revision: { type: "string" }, sha256: { type: "string" }, uri: { type: "string" },
    producedBy: object({ workflowRunId: { type: "string" }, stepRunId: { type: "string" }, attemptId: { type: "string" } },
      ["workflowRunId", "stepRunId", "attemptId"]), dependsOn: { type: "array", items: { type: "object" } },
  }, ["id", "type", "schemaVersion", "revision", "sha256", "uri", "producedBy", "dependsOn"]);
  const candidateOutcome = { type: "object", required: ["state"], properties: { state: { enum: ["built_unevaluated",
    "evaluated_with_findings", "verified", "ready", "not_ready", "blocked"] } }, additionalProperties: true,
    description: "Partial declaration only; full state-specific Zod contract is in packages/research/src/video-analysis/contracts.ts." };
  return {
    "post-input": sourceSchema("creator-analysis/post-input", "post-input-v1", object({
      creatorRunId: { type: "string" }, postExternalId: { type: "string" },
      evidenceKind: { enum: ["video", "image_post"] }, evaluationMode: { enum: ["fresh", "repair_existing_invalid"] },
      candidateMode: { enum: ["rebuild", "reuse"] }, importedEvaluationArtifactRef: { type: "string" },
      evidence: artifactRef,
    }, ["creatorRunId", "postExternalId", "evidence"])),
    "frozen-evidence": sourceSchema("creator-analysis/frozen-evidence", "pinned-research-input-v1", {
      $schema: JSON_SCHEMA_DIALECT, type: "object", additionalProperties: true, required: ["kind", "source", "files", "methods"],
      properties: { kind: { const: "post" }, executor: { enum: ["codex", "responses"] }, source: { type: "object" },
        files: { type: "array", items: object({ ref: { type: "string", minLength: 1 }, sha256: { type: "string", pattern: "^[a-f0-9]{64}$" } }, ["ref", "sha256"]) },
        methods: { type: "array", items: object({ path: { type: "string" }, sha256: { type: "string" } }, ["path", "sha256"]) },
        skillPackages: { type: "array", items: { type: "object" } }, researchScope: { type: "object" },
        reuseCandidate: { type: "object" }, reuseEvaluation: { type: "object" } },
      description: "PinnedResearchInput shape; optional compatibility and reuse fields are open declarations.",
    }),
    "source-check": sourceSchema("creator-analysis/post-source-consistency", "post-source-consistency-v2-open", object({
      schemaVersion: { const: "post-source-consistency@2" }, inputSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      verdict: { enum: ["consistent", "conflict", "uncertain"] }, summary: { type: "string", minLength: 1 },
      comparisons: { type: "array", minItems: 1, items: object({ postClaim: { type: "string", minLength: 1 },
        bearing: { enum: ["identity", "claim_detail"] }, relation: { enum: ["supports", "contradicts", "insufficient"] },
        evidenceRefs: { type: "array", minItems: 1, items: { type: "string" } }, reason: { type: "string", minLength: 1 },
      }, ["postClaim", "bearing", "relation", "evidenceRefs", "reason"]) },
      provenance: object({ model: { type: "string", minLength: 1 }, reasoningEffort: { const: "medium" },
        methodSha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, threadId: { type: ["string", "null"] } },
      ["model", "reasoningEffort", "methodSha256", "threadId"]),
    }, ["schemaVersion", "inputSha256", "verdict", "summary", "comparisons", "provenance"])),
    candidate: sourceSchema("creator-analysis/post-candidate", "post-candidate-current", object({
      kind: { const: "post" }, evidence: artifactRef, outcome: candidateOutcome, reportArtifactRef: { type: "string" },
      reportSha256: { type: "string", pattern: "^[a-f0-9]{64}$" }, relativeRoot: { type: "string" },
    }, ["kind", "evidence", "outcome", "reportArtifactRef", "reportSha256", "relativeRoot"])),
    review: sourceSchema("creator-analysis/research-review", "research-review-v1", object({
      schemaVersion: { const: "research-review@1" }, kind: { const: "post" }, candidate: object({
        id: { type: "string", minLength: 1 }, revision: { type: "string", minLength: 1 },
        sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      }, ["id", "revision", "sha256"]), candidateReportSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      summary: { type: "string", minLength: 1 }, findings: { type: "array", items: object({
        id: { type: "string", minLength: 1 }, location: { type: "string", minLength: 1 },
        issue: { type: "string", minLength: 1 }, evidenceRefs: { type: "array", items: { type: "string", minLength: 1 } },
        suggestedChange: { type: "string", minLength: 1 }, priority: { enum: ["minor", "major"] },
        kind: { enum: ["content", "missing_evidence"] },
      }, ["id", "location", "issue", "evidenceRefs", "suggestedChange", "priority", "kind"]) },
      }, ["schemaVersion", "kind", "candidate", "candidateReportSha256", "summary", "findings"])),
    "revision-record": sourceSchema("creator-analysis/research-revision", "research-revision-v1", object({
      schemaVersion: { const: "research-revision@1" }, baseCandidate: artifactRef, review: artifactRef, candidate: artifactRef,
      dispositions: { type: "array", minItems: 1, items: object({ id: { type: "string", minLength: 1 },
        status: { enum: ["changed", "disputed", "missing_evidence"] }, reason: { type: "string", minLength: 1 } }, ["id", "status", "reason"]) },
      validation: object({ valid: { const: true } }, ["valid"]),
    }, ["schemaVersion", "baseCandidate", "review", "candidate", "dispositions", "validation"])),
    "registered-version": sourceSchema("creator-analysis/registered-version", "registered-version-open-v1", openObject),
  };
}

function defaultTools(): Record<PostMethodRole, readonly PostMethodToolDefinition[]> {
  const evidence = projectResponsesEvidenceToolManifest({ video: false });
  return {
    "source-check": evidence, builder: evidence, reviewer: evidence, repair: evidence,
  };
}

const ROLE_TOOL_CAPABILITIES: Record<PostMethodRole, Array<{ name: string; phase?: string; condition?: string }>> = {
  "source-check": [],
  builder: [
    { name: "capture_frame", condition: "bound source media is video" },
    { name: "check_probe_evidence_readiness", phase: "probe" }, { name: "read_builder_context", phase: "probe" },
    { name: "validate_probe_protocol", phase: "probe" }, { name: "revise_validated_draft", phase: "probe" },
    { name: "check_evidence_readiness", phase: "reconstruction" }, { name: "read_builder_context", phase: "reconstruction" },
    { name: "validate_reconstruction_draft", phase: "reconstruction" }, { name: "revise_validated_draft", phase: "reconstruction" },
    { name: "stage_builder_lens", phase: "reconstruction" }, { name: "revise_builder_lens", phase: "reconstruction" },
  ],
  reviewer: [{ name: "check_review_evidence_readiness" }, { name: "read_reviewer_context" },
    { name: "compare_review_finding" }, { name: "inspect_evidence_window", condition: "indexed frames exist" }],
  repair: [{ name: "check_evidence_readiness" }, { name: "read_repair_context" },
    { name: "validate_reconstruction_draft" }, { name: "validate_reconstruction_patch" }, { name: "revise_validated_draft" }],
};

/** One-call production projection. Agent settings come from the actual full-post
 * workflow constructor; prompts, contracts, skills and code are read from disk. */
export function buildCurrentAnalysisPostMethod(input: CurrentAnalysisPostMethodInput): AnalysisPostMethodProjection {
  const root = path.resolve(input.projectRoot ?? workbenchRoot());
  return buildAnalysisPostMethod({ ...input, projectRoot: root, agents: actualAgents(),
    tools: defaultTools(), schemas: currentSchemas(root) });
}

type ResolvedAnalysisPostMethodInput = AnalysisPostMethodInput & {
  agents: NonNullable<AnalysisPostMethodInput["agents"]>;
  tools: NonNullable<AnalysisPostMethodInput["tools"]>;
  schemas: NonNullable<AnalysisPostMethodInput["schemas"]>;
};

function nodeDefinition(input: ResolvedAnalysisPostMethodInput, role: PostMethodRole,
  prompt: { path: string; sha256: string; text: string }, skill: { path: string; sha256: string }): WorkflowNodeDefinition {
  const agent = roleAgent(input.agents[role], role);
  const tools = input.tools[role];
  if (!Array.isArray(tools) || !tools.length || new Set(tools.map((tool) => tool.name)).size !== tools.length) {
    throw new Error(`POST_METHOD_TOOL_MANIFEST_INVALID:${role}`);
  }
  for (const tool of tools) {
    if (!tool.name || !tool.description || !tool.parameters || typeof tool.parameters !== "object") {
      throw new Error(`POST_METHOD_TOOL_DEFINITION_INCOMPLETE:${role}`);
    }
  }
  return {
    purpose: {
      "source-check": "核对原帖身份与冻结来源材料是否一致；不一致或证据不足时阻断后续构建。",
      builder: "依据精确冻结的视频、字幕、图像与证据材料，形成完整单帖三视角分析候选。",
      reviewer: "独立核查候选与冻结原始材料，提交绑定准确候选的结构化 findings。",
      repair: "依据 reviewer findings 对已绑定候选作一次有界定向修订，并保留修订处置记录。",
    }[role],
    instructions: prompt.text,
    model: agent.model,
    tools: tools.map((tool) => tool.name),
    toolDefinitions: tools.map((tool) => ({ name: tool.name, description: tool.description,
      parameters: structuredClone(tool.parameters), ...(tool.outputSchema ? { outputSchema: structuredClone(tool.outputSchema) } : {}) })),
    skills: [{ name: "video-content-reconstruction", sourceRef: skill.path, revision: skill.sha256 }],
    executor: { family: "agent-sdk", adapter: "SIWC Responses" },
    configuration: {
      promptPath: prompt.path, promptSha256: prompt.sha256,
      agentId: agent.id, agentRevision: agent.revision, reasoningEffort: agent.reasoningEffort ?? "medium",
      promptRevision: agent.promptRevision ?? null, skillsRevision: agent.skillsRevision ?? null,
      permissionsRevision: agent.permissionsRevision ?? null,
      dynamicToolConditions: {
        capture_frame: "available only when the bound source media is video; omitted for image media",
        inspect_evidence_window: "available only when the frozen candidate has an indexed frame timeline",
        builderPhaseTools: "the phase-one and phase-two tools are exposed in separate model calls; names may recur across phases",
        evidenceTools: "read_evidence/inspect_image/inspect_images operate only on the exact bound refs for that run",
      },
      roleToolCapabilities: ROLE_TOOL_CAPABILITIES[role],
      stopBoundaries: {
        "source-check": "only verdict=consistent routes onward; conflict and uncertain end without a candidate",
        builder: "technical failure or needs-review produces no candidate, so reviewer and terminal are not reached",
        reviewer: "technical failure or needs-review produces no review receipt, so neither repair nor terminal is reached",
        repair: "technical failure or needs-review produces no revised candidate, so terminal is not reached",
      },
      outputFormat: "json", toolManifestSha256: sha256(stableJson({ boundEvidenceTools: tools,
        roleCapabilities: ROLE_TOOL_CAPABILITIES[role] })),
    },
  };
}

/**
 * Project the current single-post analysis implementation into the shared Space
 * method contract. This reads the current prompts and implementation files;
 * it never executes an Agent, publishes a version, or claims historical runs
 * used this current definition.
 */
export function buildAnalysisPostMethod(input: AnalysisPostMethodInput): AnalysisPostMethodProjection {
  const root = path.resolve(input.projectRoot ?? workbenchRoot());
  const resolved: ResolvedAnalysisPostMethodInput = { ...input, agents: input.agents ?? actualAgents(),
    tools: input.tools ?? defaultTools(), schemas: input.schemas ?? currentSchemas(root) };
  const promptSnapshot = Object.fromEntries(Object.entries(PROMPT_BY_ROLE).map(([role, relative]) => {
    const text = fs.readFileSync(path.join(root, relative), "utf8");
    return [role, { path: relative, sha256: sha256(text), text }];
  })) as AnalysisPostMethodProjection["promptSnapshot"];
  const methodSnapshot = METHOD_FILES.map((relative) => ({ path: relative,
    sha256: sha256(fs.readFileSync(path.resolve(root, relative))) }));
  const skillPath = ".agents/skills/video-content-reconstruction";
  const skillSnapshot = { path: skillPath, sha256: snapshotSkill(path.join(root, skillPath)).sha256 };

  const schemaRegistry = new SchemaRegistry();
  const schemaRefs = {} as Record<PostMethodSchemaName, SchemaRef>;
  for (const name of Object.keys(resolved.schemas) as PostMethodSchemaName[]) {
    const supplied = resolved.schemas[name];
    const frozen = schemaRegistry.registerSchema({ ...structuredClone(supplied),
      dialect: supplied.dialect ?? JSON_SCHEMA_DIALECT });
    schemaRefs[name] = { namespace: frozen.namespace, revision: frozen.revision, hash: frozen.hash };
  }

  const versionId = input.id;
  const schemas = schemaRefs;
  const storageContract: StorageContractDraft = {
    workflowVersion: versionId,
    nodes: {
      sourceCheck: { actorKinds: ["agent"], inputs: { input: { schema: schemas["post-input"], states: ["frozen"] },
        evidence: { schema: schemas["frozen-evidence"], states: ["frozen"] } },
        outputs: { receipt: { schema: schemas["source-check"], requiredInputs: ["input", "evidence"], appendVersions: false, initialState: "validated" } },
        actions: ["readBoundInput", "readBoundInputProjection", "appendOutputVersion"] },
      builder: { actorKinds: ["agent"], inputs: { input: { schema: schemas["post-input"], states: ["frozen"] },
        evidence: { schema: schemas["frozen-evidence"], states: ["frozen"] },
        sourceCheck: { schema: schemas["source-check"], states: ["validated"] } },
        outputs: { candidate: { schema: schemas.candidate, requiredInputs: ["input", "evidence", "sourceCheck"], appendVersions: false, initialState: "draft" } },
        actions: ["readBoundInput", "readBoundInputProjection", "appendOutputVersion"] },
      reviewer: { actorKinds: ["agent"], inputs: { candidate: { schema: schemas.candidate, states: ["draft"] },
        evidence: { schema: schemas["frozen-evidence"], states: ["frozen"] } },
        outputs: { review: { schema: schemas.review, requiredInputs: ["candidate", "evidence"], appendVersions: false, initialState: "recorded" } },
        actions: ["readBoundInput", "readBoundInputProjection", "appendOutputVersion"] },
      repair: { actorKinds: ["agent"], inputs: { candidate: { schema: schemas.candidate, states: ["draft"] },
        evidence: { schema: schemas["frozen-evidence"], states: ["frozen"] },
        review: { schema: schemas.review, states: ["recorded"] } },
        outputs: { candidate: { schema: schemas.candidate, requiredInputs: ["candidate", "evidence", "review"], appendVersions: true, initialState: "revised-unverified" },
          revision: { schema: schemas["revision-record"], requiredInputs: ["candidate", "review"], appendVersions: false, initialState: "recorded" } },
        actions: ["readBoundInput", "readBoundInputProjection", "appendOutputVersion"] },
      ...(resolved.registrationEnabled ? { registerVersion: { actorKinds: ["program"], inputs: { candidate: { schema: schemas.candidate, states: ["draft", "revised-unverified"] },
        review: { schema: schemas.review, states: ["recorded"] } },
        outputs: { registration: { schema: schemas["registered-version"], requiredInputs: ["candidate", "review"], appendVersions: false, initialState: "registered" } },
        actions: ["readBoundInput", "appendOutputVersion"] } } : { candidateTerminal: { actorKinds: ["program"],
        inputs: { candidate: { schema: schemas.candidate, states: ["draft", "revised-unverified"] } },
        outputs: { candidate: { schema: schemas.candidate, requiredInputs: ["candidate"], appendVersions: false, initialState: "selected" } },
        actions: ["readBoundInput", "appendOutputVersion"] } }),
    },
    stateRules: [],
  };
  publishStorageContract(schemaRegistry, storageContract);
  const process: ProcessContractDraft = {
    revision: input.revision,
    runInputs: { postInput: schemas["post-input"], frozenEvidence: schemas["frozen-evidence"] },
    nodes: [
      { id: "source-check", kind: "agent" as const, storageNodeId: "sourceCheck", phase: "source-check",
        inputs: { input: { slot: "input", min: 1, max: 1 }, evidence: { slot: "evidence", min: 1, max: 1 } },
        outputs: { receipt: { slot: "receipt", min: 1, max: 1 } } },
      { id: "builder", kind: "agent" as const, storageNodeId: "builder", phase: "builder",
        inputs: { input: { slot: "input", min: 1, max: 1 }, evidence: { slot: "evidence", min: 1, max: 1 }, sourceCheck: { slot: "sourceCheck", min: 1, max: 1 } },
        outputs: { candidate: { slot: "candidate", min: 1, max: 1 } } },
      { id: "reviewer", kind: "agent" as const, storageNodeId: "reviewer", phase: "reviewer",
        inputs: { candidate: { slot: "candidate", min: 1, max: 1 }, evidence: { slot: "evidence", min: 1, max: 1 } },
        outputs: { review: { slot: "review", min: 1, max: 1 } } },
      { id: "repair", kind: "agent" as const, storageNodeId: "repair", phase: "repair",
        inputs: { candidate: { slot: "candidate", min: 1, max: 1 }, evidence: { slot: "evidence", min: 1, max: 1 }, review: { slot: "review", min: 1, max: 1 } },
        outputs: { candidate: { slot: "candidate", min: 1, max: 1 }, revision: { slot: "revision", min: 1, max: 1 } } },
      ...(resolved.registrationEnabled ? [{ id: "register-version", kind: "program" as const, storageNodeId: "registerVersion", phase: "register-version",
        inputs: { candidate: { slot: "candidate", min: 1, max: 1 }, review: { slot: "review", min: 1, max: 1 } },
        outputs: { registration: { slot: "registration", min: 1, max: 1 } } }] : [{ id: "candidate-terminal", kind: "program" as const,
        storageNodeId: "candidateTerminal", phase: "candidate-terminal", inputs: { candidate: { slot: "candidate", min: 1, max: 1 } },
        outputs: { candidate: { slot: "candidate", min: 1, max: 1 } } }]),
    ],
    edges: [
      { id: "source-consistent", from: "source-check", to: "builder", kind: "condition" as const, route: "consistent" },
      { id: "build-to-review", from: "builder", to: "reviewer", kind: "sequence" as const },
      { id: resolved.registrationEnabled ? "review-clear-to-register" : "review-clear-to-candidate", from: "reviewer",
        to: resolved.registrationEnabled ? "register-version" : "candidate-terminal", kind: "condition" as const, route: "no-findings" },
      { id: "review-findings-to-repair", from: "reviewer", to: "repair", kind: "condition" as const, route: "findings" },
      { id: resolved.registrationEnabled ? "repair-to-register" : "repair-to-candidate", from: "repair",
        to: resolved.registrationEnabled ? "register-version" : "candidate-terminal", kind: "sequence" as const },
    ],
    dataBindings: [
      { id: "input-to-source-check", from: { runInput: "postInput" }, to: { node: "source-check", port: "input" }, selection: "frozen-input" as const },
      { id: "evidence-to-source-check", from: { runInput: "frozenEvidence" }, to: { node: "source-check", port: "evidence" }, selection: "frozen-input" as const },
      { id: "input-to-builder", from: { runInput: "postInput" }, to: { node: "builder", port: "input" }, selection: "frozen-input" as const },
      { id: "evidence-to-builder", from: { runInput: "frozenEvidence" }, to: { node: "builder", port: "evidence" }, selection: "frozen-input" as const },
      { id: "source-check-to-builder", from: { node: "source-check", port: "receipt" }, to: { node: "builder", port: "sourceCheck" }, selection: "latest-successful-in-this-run" as const },
      { id: "candidate-to-reviewer", from: { node: "builder", port: "candidate" }, to: { node: "reviewer", port: "candidate" }, selection: "latest-successful-in-this-run" as const },
      { id: "evidence-to-reviewer", from: { runInput: "frozenEvidence" }, to: { node: "reviewer", port: "evidence" }, selection: "frozen-input" as const },
      { id: "candidate-to-repair", from: { node: "builder", port: "candidate" }, to: { node: "repair", port: "candidate" }, selection: "latest-successful-in-this-run" as const },
      { id: "evidence-to-repair", from: { runInput: "frozenEvidence" }, to: { node: "repair", port: "evidence" }, selection: "frozen-input" as const },
      { id: "review-to-repair", from: { node: "reviewer", port: "review" }, to: { node: "repair", port: "review" }, selection: "latest-successful-in-this-run" as const },
      ...(resolved.registrationEnabled ? [
        { id: "review-to-register", from: { node: "reviewer", port: "review" } as const, to: { node: "register-version", port: "review" } as const, selection: "latest-successful-in-this-run" as const },
        { id: "candidate-to-register", from: { node: "builder", port: "candidate" } as const, to: { node: "register-version", port: "candidate" } as const, selection: "latest-successful-in-this-run" as const, when: "initial-round" as const },
        { id: "repaired-candidate-to-register", from: { node: "repair", port: "candidate" } as const, to: { node: "register-version", port: "candidate" } as const, selection: "latest-successful-in-this-run" as const, when: "later-rounds" as const },
      ] : [
        { id: "candidate-to-terminal", from: { node: "builder", port: "candidate" } as const, to: { node: "candidate-terminal", port: "candidate" } as const, selection: "latest-successful-in-this-run" as const, when: "initial-round" as const },
        { id: "repaired-candidate-to-terminal", from: { node: "repair", port: "candidate" } as const, to: { node: "candidate-terminal", port: "candidate" } as const, selection: "latest-successful-in-this-run" as const, when: "later-rounds" as const },
      ]),
    ],
    results: resolved.registrationEnabled ? [{ role: "registered-version", nodeId: "register-version", outputPort: "registration" }]
      : [{ role: "candidate", nodeId: "candidate-terminal", outputPort: "candidate" }],
  };
  const nodes: Record<string, WorkflowNodeDefinition> = Object.fromEntries((Object.keys(PROMPT_BY_ROLE) as PostMethodRole[]).map((role) => [
    role, nodeDefinition(resolved, role, promptSnapshot[role], skillSnapshot),
  ]));
  if (resolved.registrationEnabled) nodes["register-version"] = {
    purpose: "将经过来源检查、候选构建与独立复核的精确候选登记为业务版本；基准运行默认关闭登记。",
    tools: [], executor: { family: "program", adapter: "analysis post version registrar" },
    configuration: { enabled: resolved.registrationEnabled ?? false, benchmarkDefault: false,
      repairedCandidateReviewState: "revised-unverified", secondReviewAfterRepair: false,
      qualityAcceptance: false },
  };
  else nodes["candidate-terminal"] = { purpose: "将当前分支的候选作为方法运行结果暴露；此终态不执行业务版本登记。",
    tools: [], executor: { family: "program", adapter: "candidate result selector" },
    configuration: { registrationEnabled: false, selectsRepairedCandidateWhenPresent: true } };
  const methodSnapshotHash = sha256(stableJson(methodSnapshot));
  const version: WorkflowVersionDraft = {
    id: resolved.id, revision: resolved.revision,
    ...(resolved.predecessorId ? { predecessorId: resolved.predecessorId } : {}),
    changeReason: resolved.changeReason,
    config: { domain: "creator-analysis.single-post", suite: "post.analyze@v11", workflowId: "post.analyze",
      methodSnapshot, methodSnapshotHash, skillPackages: [skillSnapshot],
      prompts: Object.fromEntries(Object.entries(promptSnapshot).map(([role, prompt]) =>
        [role, { path: prompt.path, sha256: prompt.sha256 }])),
      modelByRole: Object.fromEntries((Object.keys(PROMPT_BY_ROLE) as PostMethodRole[]).map((role) => [role, {
        agentId: roleAgent(resolved.agents[role], role).id, model: roleAgent(resolved.agents[role], role).model,
        reasoningEffort: roleAgent(resolved.agents[role], role).reasoningEffort ?? "medium" }])),
      workflowSemantics: { sourceCheckBeforeBuilder: true, independentReview: true, repairMaxTraversals: 1,
        secondReviewAfterRepair: false, repairedCandidateStatus: "revised-unverified", registrationEnabled: resolved.registrationEnabled ?? false,
        qualityAcceptedByHarness: false, schemaDeclarationsAreNotRuntimeCapabilityProof: true,
        stopBoundaries: { sourceCheckConflictOrUncertain: true, builderFailureOrNeedsReview: true,
          reviewerFailureOrNeedsReview: true, repairFailureOrNeedsReview: true } } },
    entrypoints: { post: { workflowId: "post.analyze", codeRevision: resolved.revision,
      storageContract, process, nodeDefinitions: nodes } },
  };
  return { version, entrypoint: "post", schemaDefinitions: schemaRegistry.snapshot(), methodSnapshot, skillSnapshot, promptSnapshot };
}
