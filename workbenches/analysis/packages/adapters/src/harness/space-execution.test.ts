import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { artifactPayloadSha256, workflowFingerprint } from "@signal-room/workflow";
import type { WorkflowSpaceService } from "@signal-room/workflow-spaces";
import type { PostgresWorkflowRunStore } from "@signal-room/workflow-postgres";
import type { BoundedPostExecutionReceipt } from "./execution.js";
import { bindSpaceExecution, syncSpaceExecution } from "./space-execution.js";

async function fixture(overrides: {
  inputFingerprint?: string;
  evidenceRevision?: string;
  evidenceSha256?: string;
  preparedMaterial?: unknown;
  nativeEvidencePayload?: unknown;
} = {}) {
  const calls: string[] = [];
  // The source's original serialization and PostgreSQL JSONB's key order differ.
  const evidencePayload = { b: "post-1", a: "source" };
  const preparedMaterial = overrides.preparedMaterial ?? { a: "source", b: "post-1" };
  const evidenceSha256 = await artifactPayloadSha256(evidencePayload);
  const actualInput = {
    creatorRunId: "creator-1",
    postExternalId: "post-1",
    evidence: { id: "evidence-1", revision: overrides.evidenceRevision ?? "r1", sha256: overrides.evidenceSha256 ?? evidenceSha256 },
    candidateMode: "rebuild",
    evaluationMode: "fresh",
  };
  const binding = {
    spaceId: "space-1", caseId: "case-1", workflowVersionId: "method-1",
    inputManifestId: "manifest-before", methodHash: "method-hash",
  };
  const receipt = {
    id: "receipt-1", input: { scopeKey: "release-1", kind: "full" },
    nativeWorkflowRunId: "native-root", nativeWorkflowInput: actualInput,
    frozenInputSha256: createHash("sha256").update(JSON.stringify(evidencePayload)).digest("hex"),
    spaceBinding: binding,
  } as BoundedPostExecutionReceipt;
  const postInputSchema = { namespace: "analysis/post-input", revision: "1", hash: "post-input-hash" };
  const version = { id: "method-1", hash: "method-hash", config: { model: "gpt-6-luna" },
    entrypoints: { post: { process: { runInputs: { postInput: postInputSchema } } } } };
  const service = {
    readWorkflowVersion: vi.fn(async () => { calls.push("readWorkflowVersion"); return version; }),
    readManifest: vi.fn(async () => { calls.push("readManifest"); return { id: "manifest-before", assets: { frozenEvidence: "frozen-asset", executionRequest: "request-asset" } }; }),
    readAsset: vi.fn(async () => { calls.push("readAsset"); return { id: "frozen-asset", payload: preparedMaterial }; }),
    registerSchemas: vi.fn(async () => { calls.push("registerSchemas"); return [{ namespace: "analysis/history", revision: "1", hash: "history-hash" }]; }),
    importAsset: vi.fn(async (_spaceId: string, input: { idempotencyKey: string; payload: unknown }) => {
      calls.push(`importAsset:${input.idempotencyKey}`);
      return { id: input.idempotencyKey.endsWith("native-wrapper") ? "native-wrapper-asset" : "post-input-asset" };
    }),
    freezeInputs: vi.fn(async (_spaceId: string, _caseId: string, assets: Record<string, string>) => {
      calls.push("freezeInputs"); return { id: "manifest-after", assets };
    }),
    bindExternalRun: vi.fn(async () => { calls.push("bindExternalRun"); }),
  };
  const store = {
    getRun: vi.fn(async () => { calls.push("getRun"); return { id: "native-root", inputFingerprint: overrides.inputFingerprint ?? workflowFingerprint(actualInput) }; }),
    getArtifact: vi.fn(async () => { calls.push("getArtifact"); return { id: "evidence-1", revision: "r1", sha256: evidenceSha256 }; }),
    getArtifactPayload: vi.fn(async () => { calls.push("getArtifactPayload"); return overrides.nativeEvidencePayload ?? evidencePayload; }),
  };
  return { service, store, receipt, actualInput, evidencePayload, preparedMaterial, calls,
    bind: () => bindSpaceExecution(service as unknown as WorkflowSpaceService,
      store as unknown as PostgresWorkflowRunStore, "space-1", "source-workspace-1", receipt) };
}

describe("Space execution model-entry binding gate", () => {
  it("accepts JSONB key reordering, then freezes and binds the real native root", async () => {
    const f = await fixture();
    expect(JSON.stringify(f.evidencePayload)).not.toBe(JSON.stringify(f.preparedMaterial));
    expect(await artifactPayloadSha256(f.evidencePayload)).toBe(await artifactPayloadSha256(f.preparedMaterial));
    const result = await f.bind();
    expect(result).toEqual({ ...f.receipt.spaceBinding, runId: "native-root", inputManifestId: "manifest-after" });
    expect(f.calls).toEqual([
      "readWorkflowVersion", "getRun", "readManifest", "getArtifact", "getArtifactPayload", "readAsset", "registerSchemas",
      "importAsset:execution:receipt-1:native-wrapper", "importAsset:execution:receipt-1:native-input",
      "freezeInputs", "bindExternalRun",
    ]);
    expect(f.service.importAsset).toHaveBeenNthCalledWith(1, "space-1", expect.objectContaining({ payload: f.actualInput }));
    expect(f.service.importAsset).toHaveBeenNthCalledWith(2, "space-1", expect.objectContaining({ payload: f.actualInput }));
    expect(f.service.freezeInputs).toHaveBeenCalledWith("space-1", "case-1", {
      frozenEvidence: "frozen-asset", executionRequest: "request-asset",
      nativeRunInput: "native-wrapper-asset", postInput: "post-input-asset",
    });
    expect(f.service.bindExternalRun).toHaveBeenCalledWith("space-1", {
      sourceWorkspaceId: "source-workspace-1",
      runs: [{ runId: "native-root", workflowVersionId: "method-1", entrypoint: "post",
        inputManifestId: "manifest-after", effectiveConfig: { model: "gpt-6-luna" } }],
    });
    expect(f.service.readAsset).toHaveBeenCalledWith("space-1", "frozen-asset");
  });

  it("rejects a native input fingerprint mismatch before importing or binding", async () => {
    const f = await fixture({ inputFingerprint: workflowFingerprint({ different: true }) });
    await expect(f.bind()).rejects.toThrow("Native root input fingerprint mismatch");
    expect(f.store.getArtifact).not.toHaveBeenCalled();
    expect(f.service.importAsset).not.toHaveBeenCalled();
    expect(f.service.freezeInputs).not.toHaveBeenCalled();
    expect(f.service.bindExternalRun).not.toHaveBeenCalled();
  });

  it.each([
    { name: "revision", override: { evidenceRevision: "r2" } },
    { name: "sha256", override: { evidenceSha256: "0".repeat(64) } },
  ])("rejects a changed evidence $name before importing or binding", async ({ override }) => {
    const f = await fixture(override);
    await expect(f.bind()).rejects.toThrow("Launched evidence reference mismatch");
    expect(f.store.getArtifactPayload).not.toHaveBeenCalled();
    expect(f.service.importAsset).not.toHaveBeenCalled();
    expect(f.service.freezeInputs).not.toHaveBeenCalled();
    expect(f.service.bindExternalRun).not.toHaveBeenCalled();
  });

  it("rejects changed prepared values even when the native evidence reference is valid", async () => {
    const f = await fixture({ preparedMaterial: { a: "changed", b: "post-1" } });
    await expect(f.bind()).rejects.toThrow("Launched material differs from prepared input");
    expect(f.store.getArtifactPayload).toHaveBeenCalledWith("evidence-1");
    expect(f.service.readAsset).toHaveBeenCalledWith("space-1", "frozen-asset");
    expect(f.service.importAsset).not.toHaveBeenCalled();
    expect(f.service.freezeInputs).not.toHaveBeenCalled();
    expect(f.service.bindExternalRun).not.toHaveBeenCalled();
  });

  it("rejects changed native values against the original artifact hash", async () => {
    const f = await fixture({ nativeEvidencePayload: { a: "source", b: "changed" } });
    await expect(f.bind()).rejects.toThrow("Launched material differs from prepared input");
    expect(f.service.importAsset).not.toHaveBeenCalled();
    expect(f.service.freezeInputs).not.toHaveBeenCalled();
    expect(f.service.bindExternalRun).not.toHaveBeenCalled();
  });
});

describe("external run input-producer boundary", () => {
  function fixture(changedReference = false) {
    const root = { id: "native-root", workflowId: "post.analyze", workflowRevision: "v11", state: "running" };
    const producer = { id: "input-producer", workflowId: "research.input", workflowRevision: "1", state: "succeeded" };
    const unrelated = { id: "unrelated-run", workflowId: "research.input", workflowRevision: "1", state: "succeeded" };
    const evidence = { id: "evidence-1", revision: "1", sha256: "a".repeat(64), producedBy: { workflowRunId: producer.id } };
    const receipt = {
      id: "receipt-1", nativeWorkflowRunId: root.id,
      nativeWorkflowInput: { evidence: { id: evidence.id, revision: evidence.revision,
        sha256: changedReference ? "b".repeat(64) : evidence.sha256 } },
      startedAt: "2026-10-14T03:12:00.000Z",
      spaceBinding: { spaceId: "space-1", caseId: "case-1", workflowVersionId: "method-1", inputManifestId: "manifest-1" },
    } as BoundedPostExecutionReceipt;
    const store = {
      listRuns: vi.fn(async () => [root, producer, unrelated]),
      listArtifacts: vi.fn(async () => []),
      getArtifact: vi.fn(async () => evidence),
      listSteps: vi.fn(async () => []),
      listEvents: vi.fn(async () => []),
    };
    const service = {
      readRun: vi.fn(async (_spaceId: string, runId: string) => {
        if (runId !== root.id) throw new Error("not found");
        return { runId: root.id, executionMode: "external-host", workflowVersionId: "method-1",
          entrypoint: "post", inputManifestId: "manifest-1", effectiveConfig: {} };
      }),
      readWorkflowVersion: vi.fn(async () => { throw new Error("not found"); }),
      publishWorkflow: vi.fn(async (_spaceId: string, draft: { id: string; config: Record<string, unknown> }) => draft),
      registerSchemas: vi.fn(async () => [{ namespace: "analysis/history", revision: "1", hash: "history-hash" }]),
      registerPresentation: vi.fn(async () => undefined),
      bindPresentation: vi.fn(async () => undefined),
      syncExternalRuns: vi.fn(async (spaceId: string, input: unknown) => { void spaceId; void input; }),
      publishExternalArtifact: vi.fn(async () => undefined),
    };
    return { service, store, receipt,
      sync: () => syncSpaceExecution(service as unknown as WorkflowSpaceService,
        store as unknown as PostgresWorkflowRunStore, "space-1", "source-workspace-1", receipt) };
  }

  it("links only the exact input artifact producer as supporting the bound root", async () => {
    const f = fixture();
    const result = await f.sync();
    expect(result.runs).toEqual(["native-root", "input-producer"]);
    expect(f.service.syncExternalRuns).toHaveBeenCalledOnce();
    expect(f.service.syncExternalRuns).toHaveBeenCalledWith("space-1", {
      sourceWorkspaceId: "source-workspace-1",
      runs: [
        expect.objectContaining({ runId: "native-root" }),
        expect.objectContaining({ runId: "input-producer", supportingOf: "native-root" }),
      ],
    });
    const bindings = (f.service.syncExternalRuns.mock.calls[0]![1] as { runs: Array<Record<string, unknown>> }).runs;
    expect(bindings[0]).not.toHaveProperty("supportingOf");
    expect(bindings.some(row => row.runId === "unrelated-run")).toBe(false);
  });

  it("rejects a changed input artifact identity before external sync", async () => {
    const f = fixture(true);
    await expect(f.sync()).rejects.toThrow("Native input artifact reference changed");
    expect(f.service.syncExternalRuns).not.toHaveBeenCalled();
    expect(f.service.publishWorkflow).not.toHaveBeenCalled();
  });
});
