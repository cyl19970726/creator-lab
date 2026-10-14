import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { SimpleReviewFinding } from "../../../research/src/workflows/simple-review-contract.js";
import { createReviewFindingComparisonTool, reviewFindingHash } from "./review-finding-comparison.js";
import { ResponsesEvidenceTools } from "./responses-tools.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("returns pointer errors for correction without recording, then records the corrected finding and still fails closed on mutation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-finding-comparison-"));
  roots.push(root);
  const evidencePath = path.join(root, "support.json");
  const initialEvidence = JSON.stringify({ support: { text: "Frozen source supports this." } });
  fs.writeFileSync(evidencePath, initialEvidence);
  const evidenceRef = "support.json";
  const evidence = [{ ref: evidenceRef, path: evidencePath,
    sha256: createHash("sha256").update(initialEvidence).digest("hex") }];
  const evidenceTools = new ResponsesEvidenceTools(evidence, root);
  const readTool = evidenceTools.tools().find(tool => tool.name === "read_evidence")!;
  await readTool.execute({ ref: evidenceRef }, new AbortController().signal);
  const checkedFindingHashes = new Set<string>();
  const compare = createReviewFindingComparisonTool({ headline: "Candidate statement" }, evidenceTools, checkedFindingHashes);
  const invalid: SimpleReviewFinding = { id: "F-1", location: "/headline", issue: "The headline lacks support.",
    evidenceRefs: [`${evidenceRef}#/support/missing`], suggestedChange: "Recheck the source.", priority: "major", kind: "content" };

  const rejected = await compare.execute({ finding: invalid }, new AbortController().signal) as {
    comparisonRecorded: boolean; semanticVerdict: string; error: string; nextAction: string;
  };
  expect(rejected).toMatchObject({ comparisonRecorded: false, semanticVerdict: "not_evaluated",
    error: expect.stringContaining("RESPONSES_REVIEW_COMPARISON_POINTER_INVALID"),
    nextAction: expect.stringContaining("Correct the JSON Pointer") });
  expect(checkedFindingHashes).toEqual(new Set());
  expect(checkedFindingHashes.has(reviewFindingHash(invalid))).toBe(false);

  const corrected = { ...invalid, evidenceRefs: [`${evidenceRef}#/support/text`] };
  const accepted = await compare.execute({ finding: corrected }, new AbortController().signal) as {
    semanticVerdict: string; candidate: { value: unknown }; referencedValues: Array<{ value: unknown }>;
  };
  expect(accepted).toMatchObject({ semanticVerdict: "not_evaluated", candidate: { value: "Candidate statement" },
    referencedValues: [{ value: "Frozen source supports this." }] });
  expect(checkedFindingHashes).toEqual(new Set([reviewFindingHash(corrected)]));
  expect(checkedFindingHashes.has(reviewFindingHash(invalid))).toBe(false);

  fs.writeFileSync(evidencePath, JSON.stringify({ support: { text: "Changed after binding." } }));
  await expect(compare.execute({ finding: corrected }, new AbortController().signal)).rejects.toThrow("RESPONSES_EVIDENCE_MUTATED");
  expect(checkedFindingHashes).toEqual(new Set([reviewFindingHash(corrected)]));
});
