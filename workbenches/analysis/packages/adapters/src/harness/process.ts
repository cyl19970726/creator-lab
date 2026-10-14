import type { HistoricalProcessResolver, HistoricalProcessResolverInput, HistoricalProcessResolution,
  ProcessContractDraft } from "@signal-room/workflow-spaces";
import type { StepRecord } from "@signal-room/workflow";

type NativeWorkflowId = "post.analyze" | "post.source-check" | "post.build" | "post.review" | "post.repair";
const RESOLVER_VERSION = "analysis-native-ledger-steps-v1";

function processContract(input: HistoricalProcessResolverInput): ProcessContractDraft {
  const contract = input.workflow.entrypoints[input.run.entrypoint]?.process;
  if (!contract) throw new Error("Frozen analysis method has no process contract");
  const draft = structuredClone(contract);
  delete (draft as Partial<typeof contract>).hash;
  return draft;
}

function mappedNode(workflowId: NativeWorkflowId, step: StepRecord): string | undefined {
  const { key, kind } = step;
  if (workflowId === "post.analyze") {
    if ((key === "source-consistency" && kind === "phase") ||
      (key === "source-consistency:source-check" && kind === "workflow")) return "source-check";
    if ((key === "candidate-build" && kind === "phase") ||
      (key === "candidate-build:build" && kind === "workflow")) return "builder";
    if ((key === "simple-review" && kind === "phase") ||
      (/^simple-review:review:attempt:[12]$/.test(key) && kind === "map") ||
      (/^simple-review:review:[12]$/.test(key) && kind === "workflow")) return "reviewer";
    if ((key === "candidate-revision" && kind === "phase") ||
      (key === "candidate-revision:repair:attempt:1" && kind === "map") ||
      (key === "candidate-revision:repair:1" && kind === "workflow")) return "repair";
    if (key === "revision-artifacts" && kind === "phase") return "candidate-terminal";
    return undefined;
  }
  if (workflowId === "post.source-check") {
    return (key === "check" && kind === "agent") || (key === "result" && kind === "publish")
      ? "source-check" : undefined;
  }
  if (workflowId === "post.build") {
    return (key === "builder" && kind === "agent") || (key === "candidate-check" && kind === "validation") ||
      (key === "candidate" && kind === "publish") ? "builder" : undefined;
  }
  if (workflowId === "post.review") {
    return (key === "reviewer" && kind === "agent") || (key === "review-check" && kind === "validation") ||
      ((key === "evaluation" || key === "receipt") && kind === "publish") ? "reviewer" : undefined;
  }
  return (key === "repair" && kind === "agent") || (key === "candidate-check" && kind === "validation") ||
    ((key === "candidate" || key === "revision-record") && kind === "publish") ? "repair" : undefined;
}

function resolveNativeProcess(workflowId: NativeWorkflowId, input: HistoricalProcessResolverInput): HistoricalProcessResolution {
  const contract = processContract(input);
  const nodeIds = new Set(contract.nodes.map(node => node.id));
  const observedGroup = input.workflow.config?.observedNativeRun === true
    && contract.nodes.some(node => node.id === "native-execution" && node.kind === "group");
  const mappings = input.steps.flatMap(step => {
    if (step.runId !== input.run.runId || step.workflowId !== workflowId) return [];
    const exactNode = nodeIds.has(`step-${step.id}`) ? `step-${step.id}`
      : nodeIds.has(step.id) ? step.id : undefined;
    const nodeId = observedGroup ? "native-execution" : exactNode ?? mappedNode(workflowId, step);
    if (!nodeId || !nodeIds.has(nodeId)) return [];
    return [{ stepRunId: step.id, annotation: { nodeId },
      evidence: observedGroup
        ? `Derived observed native execution group from ${workflowId} ledger step key=${step.key}; kind=${step.kind}; stepRunId=${step.id}`
        : exactNode
        ? `Exact frozen process node ID matches native ledger step ID ${step.id}; key=${step.key}; kind=${step.kind}`
        : `Derived from native ${workflowId} ledger step key=${step.key}; kind=${step.kind}; stepRunId=${step.id}` }];
  });
  return { resolverVersion: RESOLVER_VERSION, contract, mappings };
}

/** Register only workflow IDs actually emitted by the post analysis runtime. */
export const analysisPostProcessResolvers: Record<NativeWorkflowId, HistoricalProcessResolver> = {
  "post.analyze": input => resolveNativeProcess("post.analyze", input),
  "post.source-check": input => resolveNativeProcess("post.source-check", input),
  "post.build": input => resolveNativeProcess("post.build", input),
  "post.review": input => resolveNativeProcess("post.review", input),
  "post.repair": input => resolveNativeProcess("post.repair", input),
};
