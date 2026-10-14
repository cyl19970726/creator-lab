import { createHash } from "node:crypto";
import type { SiwcImage, SiwcTool, SiwcVisualToolResult } from "@signal-room/workflow-agent-sdk";
import { ZodError } from "zod";
import { simpleReviewFindingSchema, type SimpleReviewFinding } from "../../../research/src/workflows/simple-review-contract.js";
import { ResponsesEvidenceTools } from "./responses-tools.js";

const MAX_FIELD_CHARACTERS = 8_000;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const stable = (value: unknown): string => value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(stable).join(",")}]`
    : `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;

export function reviewFindingHash(value: SimpleReviewFinding): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function toJsonValue(value: unknown): JsonValue {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("RESPONSES_REVIEW_COMPARISON_VALUE_NOT_JSON");
  return JSON.parse(encoded) as JsonValue;
}

function resolvePointer(root: unknown, pointer: string): { exists: boolean; value?: unknown } {
  if (pointer === "") return { exists: true, value: root };
  if (!pointer.startsWith("/")) return { exists: false };
  let current = root;
  for (const raw of pointer.slice(1).split("/")) {
    if (/~(?:[^01]|$)/u.test(raw)) return { exists: false };
    const token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(token)) return { exists: false };
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index >= current.length) return { exists: false };
      current = current[index];
    } else if (current !== null && typeof current === "object"
      && Object.prototype.hasOwnProperty.call(current, token)) {
      current = (current as Record<string, unknown>)[token];
    } else return { exists: false };
  }
  return { exists: true, value: current };
}

function assertFieldIsSpecific(value: unknown, label: string): void {
  if (value !== null && typeof value === "object" && stable(value).length > MAX_FIELD_CHARACTERS) {
    throw new Error(`RESPONSES_REVIEW_COMPARISON_POINTER_TOO_BROAD: ${label} exceeds ${MAX_FIELD_CHARACTERS} characters; use a more specific JSON Pointer`);
  }
}

async function readFully(ref: string, readTool: SiwcTool, tools: ResponsesEvidenceTools, signal: AbortSignal): Promise<string> {
  const initial = tools.readProgress(ref);
  let offset = 0;
  let total = initial.totalCharacters;
  let text = "";
  do {
    const result = await readTool.execute({ ref, offset, length: 32_768 }, signal) as {
      text?: unknown; nextOffset?: unknown; totalCharacters?: unknown;
    };
    if (typeof result.text !== "string" || typeof result.nextOffset !== "number"
      || typeof result.totalCharacters !== "number" || result.nextOffset <= offset && total > offset) {
      throw new Error(`RESPONSES_REVIEW_COMPARISON_TEXT_READ_FAILED: ${ref}`);
    }
    text += result.text;
    offset = result.nextOffset;
    total = result.totalCharacters;
  } while (offset < total);
  if (text.length !== total || !tools.fullyRead(ref)) throw new Error(`RESPONSES_REVIEW_COMPARISON_TEXT_NOT_FULLY_READ: ${ref}`);
  return text;
}

/** Reopens a finding's exact candidate field and bound supporting material side by side. */
export function createReviewFindingComparisonTool(report: unknown, tools: ResponsesEvidenceTools,
  checkedFindingHashes: Set<string>): SiwcTool {
  const available = new Set(tools.list());
  const toolset = tools.tools();
  const readTool = toolset.find(tool => tool.name === "read_evidence")!;
  const inspectTool = toolset.find(tool => tool.name === "inspect_image")!;
  return {
    name: "compare_review_finding",
    description: "Reopen the exact candidate field and each cited frozen reference for one complete finding. Returns exact JSON pointer values and actual ordered image pixels. It does not judge truth, edit the finding, or change artifacts.",
    parameters: { type: "object", additionalProperties: false, required: ["finding"], properties: {
      finding: { type: "object", additionalProperties: false, required: ["id", "location", "issue", "evidenceRefs", "suggestedChange", "priority", "kind"],
        properties: { id: { type: "string", minLength: 1 }, location: { type: "string", minLength: 1 },
          issue: { type: "string", minLength: 1 }, evidenceRefs: { type: "array", items: { type: "string", minLength: 1 } },
          suggestedChange: { type: "string", minLength: 1 }, priority: { type: "string", enum: ["minor", "major"] },
          kind: { type: "string", enum: ["content", "missing_evidence"] } } }
    } },
    execute: async (args, signal) => {
      try {
        const finding = simpleReviewFindingSchema.parse((args as { finding?: unknown })?.finding);
        const candidatePointer = resolvePointer(report, finding.location);
        if (!candidatePointer.exists) throw new Error(`RESPONSES_REVIEW_COMPARISON_CANDIDATE_POINTER_INVALID: ${finding.location}`);
        assertFieldIsSpecific(candidatePointer.value, `candidate ${finding.location}`);
        const imageEntries: Array<{ ref: string; image: SiwcImage }> = [];
        const references: Array<{ ref: string; readStatus: string }> = [];
        const referencedValues: Array<{ ref: string; pointer: string; value: JsonValue }> = [];

        for (const evidenceRef of finding.evidenceRefs) {
          const delimiter = evidenceRef.indexOf("#");
          const baseRef = delimiter < 0 ? evidenceRef : evidenceRef.slice(0, delimiter);
          if (!baseRef || !available.has(baseRef)) throw new Error(`RESPONSES_REVIEW_COMPARISON_REF_NOT_BOUND: ${evidenceRef}`);
          if (delimiter >= 0) {
            const pointer = evidenceRef.slice(delimiter + 1);
            const problem = tools.jsonPointerProblem(baseRef, pointer);
            if (problem) throw new Error(`RESPONSES_REVIEW_COMPARISON_POINTER_INVALID: ${evidenceRef} (${problem})`);
            const source = JSON.parse(await readFully(baseRef, readTool, tools, signal)) as unknown;
            const resolved = resolvePointer(source, pointer);
            if (!resolved.exists) throw new Error(`RESPONSES_REVIEW_COMPARISON_POINTER_INVALID: ${evidenceRef}`);
            assertFieldIsSpecific(resolved.value, `evidence ${evidenceRef}`);
            references.push({ ref: evidenceRef, readStatus: "fully_read_json_pointer" });
            referencedValues.push({ ref: baseRef, pointer, value: toJsonValue(resolved.value) });
            continue;
          }

          let visual: unknown;
          try { visual = await inspectTool.execute({ ref: baseRef }, signal); }
          catch (error) {
            if (error instanceof Error && error.message.startsWith("RESPONSES_NOT_IMAGE")) {
              throw new Error(`RESPONSES_REVIEW_COMPARISON_REF_TYPE_INVALID: ${baseRef} is not a bound image ref`);
            }
            throw error;
          }
          if (visual && typeof visual === "object" && "kind" in visual
            && visual.kind === "siwc_visual_tool_result" && "images" in visual) {
            const result = visual as SiwcVisualToolResult;
            if (!result.images.length) throw new Error(`RESPONSES_REVIEW_COMPARISON_IMAGE_EMPTY: ${baseRef}`);
            for (const image of result.images) imageEntries.push({ ref: baseRef, image });
            references.push({ ref: baseRef, readStatus: "pixels_reopened" });
            continue;
          }
          if (!tools.readRefs.has(baseRef) || !tools.fullyRead(baseRef)) {
            throw new Error(`RESPONSES_REVIEW_COMPARISON_TEXT_NOT_FULLY_READ: ${baseRef}`);
          }
          await readFully(baseRef, readTool, tools, signal);
          references.push({ ref: baseRef, readStatus: "fully_read_text; contents omitted" });
        }

        const findingHash = reviewFindingHash(finding);
        const value = { semanticVerdict: "not_evaluated", findingHash,
          candidate: { location: finding.location, value: toJsonValue(candidatePointer.value) }, references, referencedValues,
          imageIndexToRef: imageEntries.map(({ ref }, index) => ({ index, ref })) };
        if (!imageEntries.length) {
          checkedFindingHashes.add(findingHash);
          return value;
        }
        const visualResult = { kind: "siwc_visual_tool_result", value,
          images: imageEntries.map(({ image }) => image) } satisfies SiwcVisualToolResult;
        checkedFindingHashes.add(findingHash);
        return visualResult;
      } catch (error) {
        if (error instanceof ZodError) return { comparisonRecorded: false, semanticVerdict: "not_evaluated",
          error: `RESPONSES_REVIEW_COMPARISON_FINDING_INVALID: ${error.message}`,
          nextAction: "Pass one complete finding with the exact research-review@1 fields." };
        if (!(error instanceof Error)) throw error;
        const message = error.message;
        const recoverable = ["RESPONSES_REVIEW_COMPARISON_CANDIDATE_POINTER_INVALID",
          "RESPONSES_REVIEW_COMPARISON_POINTER_INVALID", "RESPONSES_REVIEW_COMPARISON_POINTER_TOO_BROAD",
          "RESPONSES_REVIEW_COMPARISON_REF_NOT_BOUND", "RESPONSES_REVIEW_COMPARISON_REF_TYPE_INVALID",
          "RESPONSES_REVIEW_COMPARISON_TEXT_NOT_FULLY_READ", "RESPONSES_REVIEW_COMPARISON_TEXT_INCOMPLETE",
          "RESPONSES_REVIEW_COMPARISON_FINDING_INVALID"].some(prefix => message.startsWith(`${prefix}:`));
        if (!recoverable) throw error;
        const nextAction = message.startsWith("RESPONSES_REVIEW_COMPARISON_CANDIDATE_POINTER_INVALID")
          ? "Choose a candidate.location JSON Pointer that resolves to the exact report field."
          : message.startsWith("RESPONSES_REVIEW_COMPARISON_POINTER_TOO_BROAD")
            ? "Use a more specific JSON Pointer for an object or array; long string leaf values are returned in full."
            : message.startsWith("RESPONSES_REVIEW_COMPARISON_TEXT_NOT_FULLY_READ")
              ? "Read the bound text ref from its next missing offset until fully read, then retry the same complete finding."
              : message.startsWith("RESPONSES_REVIEW_COMPARISON_REF_NOT_BOUND")
                ? `Choose an exact ref from the bound refs: ${JSON.stringify([...available])}.`
                : message.startsWith("RESPONSES_REVIEW_COMPARISON_REF_TYPE_INVALID")
                  ? "Use an exact bound image ref for pixels, or a bound text ref for text evidence."
                  : message.startsWith("RESPONSES_REVIEW_COMPARISON_FINDING_INVALID")
                    ? "Pass one complete finding with the exact research-review@1 fields."
                    : "Correct the JSON Pointer or choose another exact bound JSON ref, fully read it, and retry the same complete finding.";
        return { comparisonRecorded: false, semanticVerdict: "not_evaluated", error: message, nextAction };
      }
    }
  };
}
