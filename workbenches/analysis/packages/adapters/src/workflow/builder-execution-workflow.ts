import {
  runWorkflow, workflow, workflowFingerprint,
  type AgentDefinition, type AgentRunRequest, type AgentRunResult, type AgentRunner,
  type DecisionRunner, type PhaseContext, type RunStore,
} from "@signal-room/workflow";

export const builderLensSlots = ["contentRestoration", "directingLogic", "visualEditing"] as const;
export type BuilderLensSlot = typeof builderLensSlots[number];
export type BuilderLensMode = "serial" | "parallel" | "content-first-serial" | "content-first-parallel";

/** Keep this input safe to store: modes, immutable digests, and public revision labels only. */
export interface BuilderExecutionInput {
  frozenEvidenceHash: string;
  evidenceMode: string;
  lensMode: BuilderLensMode;
  configRevision?: string;
}

export type BuilderEvidenceInput = Omit<BuilderExecutionInput, "lensMode">;

export interface BuilderLensInput<Evidence, Input> {
  slot: BuilderLensSlot;
  evidence: Evidence;
  input: Input;
  /** Exact authored restoration and its receipt, never a program-generated fact summary. */
  contentRestorationHandoff?: BuilderLensResult<unknown, unknown>;
}

export interface BuilderLensResult<Value, Receipt> {
  slot: BuilderLensSlot;
  value: Value;
  receipt: Receipt;
  /** Domain-authored proposed challenges; access/structure checks do not certify their truth. */
  factChallenges?: readonly unknown[];
}

export interface BuilderLensSpec<Evidence, Input, Value, Receipt> {
  definition: AgentDefinition<BuilderLensInput<Evidence, Input>, BuilderLensResult<Value, Receipt>>;
  input: Input;
}

export interface BuilderEvidenceOptions<Evidence> {
  parentRequest: Pick<AgentRunRequest<unknown>, "runId" | "stepRunId" | "signal">;
  store: RunStore;
  revision: string;
  input: BuilderEvidenceInput;
  decisionRunner?: DecisionRunner;
  prepareEvidence: (context: PhaseContext) => Promise<Evidence>;
  /** Explicit replay only; callbacks and external receipts must be reconstructed by the caller. */
  resumeRunId?: string;
}

export interface BuilderExecutionOptions<Evidence, Input, Value, Receipt> {
  parentRequest: Pick<AgentRunRequest<unknown>, "runId" | "stepRunId" | "signal">;
  store: RunStore;
  revision: string;
  input: BuilderExecutionInput;
  decisionRunner?: DecisionRunner;
  /** Supply exactly one of a preparation callback or an already persisted evidence receipt. */
  prepareEvidence?: (context: PhaseContext) => Promise<Evidence>;
  evidenceReceipt?: Evidence;
  lenses: Record<BuilderLensSlot, BuilderLensSpec<Evidence, Input, Value, Receipt>>;
  writeLens: (
    slot: BuilderLensSlot,
    request: AgentRunRequest<BuilderLensInput<Evidence, Input>>,
    evidence: Evidence,
  ) => Promise<AgentRunResult<BuilderLensResult<Value, Receipt>>>;
  /** Explicit replay only; a lost in-flight model call has no automatic provider reconciliation. */
  resumeRunId?: string;
}

export interface BuilderExecutionOutput<Evidence, Value, Receipt> {
  evidence: Evidence;
  lenses: Record<BuilderLensSlot, BuilderLensResult<Value, Receipt>>;
}

function assertSafeInput(input: BuilderEvidenceInput): void {
  assertReceipt(input, "Builder execution input");
  if (!input.frozenEvidenceHash?.trim() || !input.evidenceMode?.trim()) {
    throw new Error("Builder execution requires a frozen evidence hash and evidence mode");
  }
  if ("lensMode" in input && !["serial", "parallel", "content-first-serial", "content-first-parallel"].includes(String(input.lensMode))) {
    throw new Error("Builder lens mode is invalid");
  }
}

function assertReceipt(value: unknown, label: string): void {
  if (value === undefined || value === null) throw new Error(`${label} is required`);
  // A persisted step must never silently discard functions or other non-JSON values.
  const seen = new Set<unknown>();
  const inspect = (item: unknown): void => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object" || seen.has(item)) throw new Error(`${label} must be JSON serializable`);
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item) inspect(child);
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
        throw new Error(`${label} must be a plain JSON value`);
      }
      for (const child of Object.values(item)) inspect(child);
    }
    seen.delete(item);
  };
  inspect(value);
}

async function prepare<Evidence>(context: PhaseContext, input: BuilderEvidenceInput,
  callback: (context: PhaseContext) => Promise<Evidence>): Promise<Evidence> {
  return context.task("prepare", async () => {
    const receipt = await callback(context);
    assertReceipt(receipt, "Builder evidence receipt");
    return receipt;
  }, input);
}

export async function runBuilderEvidence<Evidence>(options: BuilderEvidenceOptions<Evidence>): Promise<{ runId: string; evidence: Evidence }> {
  assertSafeInput(options.input);
  const definition = workflow<BuilderEvidenceInput, Evidence>("analysis.builder-evidence", { revision: options.revision },
    async (ctx, input) => {
      await ctx.task("execution-config", async () => input, input);
      return ctx.phase("evidence", { title: "Prepare Builder evidence", purpose: "Freeze evidence and record finite decisions" },
        (phase) => prepare(phase, input, options.prepareEvidence));
    });
  await assertResumeParent(options.store, options.resumeRunId, options.parentRequest);
  const result = await runWorkflow({ workflow: definition, input: options.input, store: options.store,
    agentRunner: noAgentRunner, decisionRunner: options.decisionRunner,
    signal: options.parentRequest.signal, resumeRunId: options.resumeRunId,
    parent: { runId: options.parentRequest.runId, stepRunId: options.parentRequest.stepRunId } });
  if (result.run.state !== "succeeded" || result.output === undefined) throw new Error("Builder evidence did not complete");
  return { runId: result.run.id, evidence: result.output };
}

const noAgentRunner: AgentRunner = {
  async run() { throw new Error("Builder evidence workflow does not run agents"); },
};

export async function runBuilderExecution<Evidence, Input, Value, Receipt>(
  options: BuilderExecutionOptions<Evidence, Input, Value, Receipt>,
): Promise<{ runId: string; output: BuilderExecutionOutput<Evidence, Value, Receipt> }> {
  assertSafeInput(options.input);
  if ((options.prepareEvidence === undefined) === (options.evidenceReceipt === undefined)) {
    throw new Error("Supply exactly one Builder evidence source");
  }
  if (options.evidenceReceipt !== undefined) assertReceipt(options.evidenceReceipt, "Builder evidence receipt");
  const lensConfigFingerprint = workflowFingerprint(Object.fromEntries(builderLensSlots.map((slot) => {
    const spec = options.lenses[slot];
    if (!spec?.definition || spec.input === undefined) throw new Error(`Missing Builder lens: ${slot}`);
    assertReceipt(spec.input, `Builder ${slot} input`);
    return [slot, { definition: spec.definition, input: spec.input }];
  })));
  const flowInput = { ...options.input, lensConfigFingerprint,
    evidenceReceiptFingerprint: options.evidenceReceipt === undefined ? undefined : workflowFingerprint(options.evidenceReceipt) };
  const definition = workflow<typeof flowInput, BuilderExecutionOutput<Evidence, Value, Receipt>>(
    "analysis.builder-lens-execution", { revision: options.revision }, async (ctx, input) => {
      await ctx.task("execution-config", async () => input, input);
      const evidence = options.prepareEvidence
        ? await ctx.phase("evidence", { title: "Prepare Builder evidence", purpose: "Freeze evidence and record finite decisions" },
          (phase) => prepare(phase, input, options.prepareEvidence!))
        : await ctx.task("use-evidence", async () => options.evidenceReceipt!,
          { frozenEvidenceHash: input.frozenEvidenceHash, evidenceReceiptFingerprint: input.evidenceReceiptFingerprint });
      const runLens = async (slot: BuilderLensSlot, contentRestorationHandoff?: BuilderLensResult<Value, Receipt>): Promise<BuilderLensResult<Value, Receipt>> => {
        const spec = options.lenses[slot];
        const result = await ctx.agent(`lens-${slot}`, spec.definition, { slot, evidence, input: spec.input,
          ...(contentRestorationHandoff ? { contentRestorationHandoff } : {}) });
        assertLensResult(slot, result);
        return result;
      };
      let lenses: Record<BuilderLensSlot, BuilderLensResult<Value, Receipt>>;
      if (input.lensMode === "content-first-serial" || input.lensMode === "content-first-parallel") {
        const contentRestoration = await runLens("contentRestoration");
        let interpretations: Pick<typeof lenses, "directingLogic" | "visualEditing">;
        if (input.lensMode === "content-first-parallel") {
          interpretations = await ctx.parallel("builder-interpretations", {
            directingLogic: () => runLens("directingLogic", contentRestoration),
            visualEditing: () => runLens("visualEditing", contentRestoration),
          }, { concurrency: 2 });
        } else {
          interpretations = { directingLogic: await runLens("directingLogic", contentRestoration),
            visualEditing: await runLens("visualEditing", contentRestoration) };
        }
        lenses = { contentRestoration, ...interpretations };
      } else if (input.lensMode === "serial") {
        lenses = {} as typeof lenses;
        for (const slot of builderLensSlots) lenses[slot] = await runLens(slot);
      } else {
        lenses = await ctx.parallel("builder-lenses", {
          contentRestoration: () => runLens("contentRestoration"),
          directingLogic: () => runLens("directingLogic"),
          visualEditing: () => runLens("visualEditing"),
        }, { concurrency: 3 });
      }
      return { evidence, lenses };
    });
  const agentRunner: AgentRunner = {
    async run<I, O>(request: AgentRunRequest<I>): Promise<AgentRunResult<O>> {
      const typed = request as AgentRunRequest<BuilderLensInput<Evidence, Input>>;
      const slot = typed.input?.slot;
      if (!builderLensSlots.includes(slot)) throw new Error("Builder lens request has an invalid slot");
      if (typed.definition.id !== options.lenses[slot].definition.id) {
        throw new Error(`Builder lens definition mismatch for ${slot}`);
      }
      const result = await options.writeLens(slot, typed, typed.input.evidence);
      assertLensResult(slot, result.output);
      if (result.validation !== "valid") throw new Error(`Builder lens ${slot} needs a valid receipt`);
      return result as AgentRunResult<O>;
    },
  };
  await assertResumeParent(options.store, options.resumeRunId, options.parentRequest);
  const result = await runWorkflow({ workflow: definition, input: flowInput, store: options.store, agentRunner,
    decisionRunner: options.decisionRunner, signal: options.parentRequest.signal,
    resumeRunId: options.resumeRunId,
    parent: { runId: options.parentRequest.runId, stepRunId: options.parentRequest.stepRunId } });
  if (result.run.state !== "succeeded" || !result.output) throw new Error("Builder lens execution did not complete");
  return { runId: result.run.id, output: result.output };
}

async function assertResumeParent(store: RunStore, resumeRunId: string | undefined,
  parentRequest: Pick<AgentRunRequest<unknown>, "runId" | "stepRunId">): Promise<void> {
  if (!resumeRunId) return;
  const prior = await store.getRun(resumeRunId);
  if (prior && (prior.parentRunId !== parentRequest.runId || prior.parentStepRunId !== parentRequest.stepRunId)) {
    throw new Error("Builder replay requires the exact parent run and step");
  }
}

function assertLensResult<Value, Receipt>(slot: BuilderLensSlot, value: unknown): asserts value is BuilderLensResult<Value, Receipt> {
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as { slot?: unknown }).slot !== slot
    || !Object.hasOwn(value, "value") || !Object.hasOwn(value, "receipt")) {
    throw new Error(`Builder lens ${slot} returned an incomplete or mismatched result`);
  }
  assertReceipt(value, `Builder ${slot} result`);
}
