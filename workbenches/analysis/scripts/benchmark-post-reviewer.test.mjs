import { describe, expect, it } from "vitest";
import path from "node:path";
import { benchmarkRepairModel, compactSummary, markSummaryIncomplete, parseBenchmarkArgs, resolveCandidateFromReview,
  reviewReceiptForCandidate, summarizeReviewResults } from "./benchmark-post-reviewer.ts";

const storedRef = (id, type, revision = "rev-1", sha256 = "sha-1") => ({ id, type, revision, sha256 });

describe("post Reviewer benchmark arguments", () => {
  it("accepts an explicit historical candidate and dry-run repeat", () => {
    expect(parseBenchmarkArgs(["--candidate-artifact-id", "candidate-id", "--case", "baseline",
      "--repeat", "3", "--dry-run"])).toMatchObject({
      candidateArtifactId: "candidate-id", caseLabel: "baseline", repeat: 3, dryRun: true,
    });
  });

  it("accepts historical review/workflow selectors and resolves an override path", () => {
    expect(parseBenchmarkArgs(["--source-review-artifact-id", "review-id", "--report-path", "variant.json"]))
      .toMatchObject({ sourceReviewArtifactId: "review-id", reportPath: path.resolve("variant.json") });
    expect(parseBenchmarkArgs(["--source-workflow-run-id", "workflow-id", "--candidate-artifact-id", "candidate-id"]))
      .toMatchObject({ sourceWorkflowRunId: "workflow-id", repeat: 1 });
  });

  it("requires a candidate or one history selector and rejects unsafe case labels", () => {
    expect(() => parseBenchmarkArgs([])).toThrow("Specify a candidate");
    expect(() => parseBenchmarkArgs(["--candidate-artifact-id", "a", "--source-workflow-run-id", "b"]))
      .not.toThrow();
    expect(() => parseBenchmarkArgs(["--source-review-artifact-id", "a", "--source-workflow-run-id", "b"]))
      .toThrow("Specify a candidate or exactly one");
    expect(() => parseBenchmarkArgs(["--candidate-artifact-id", "a", "--case", "unsafe label"]))
      .toThrow("short safe label");
  });

  it("opts into one review followed by conditional repair without accepting repeated paid runs", () => {
    expect(parseBenchmarkArgs(["--candidate-artifact-id", "repaired-candidate", "--repair-on-findings", "--dry-run"]))
      .toMatchObject({ candidateArtifactId: "repaired-candidate", repairOnFindings: true, repeat: 1, dryRun: true });
    expect(() => parseBenchmarkArgs(["--candidate-artifact-id", "a", "--repair-on-findings", "--repeat", "2"]))
      .toThrow("--repeat 1");
  });

  it("fixes repair to gpt-6-luna and rejects a conflicting explicit Builder model", () => {
    expect(benchmarkRepairModel(true, "")).toBe("gpt-6-luna");
    expect(benchmarkRepairModel(true, "gpt-6-luna")).toBe("gpt-6-luna");
    expect(() => benchmarkRepairModel(true, "gpt-6-sol")).toThrow("requires SELF_MEDIA_BUILDER_MODEL=gpt-6-luna");
    expect(benchmarkRepairModel(false, "gpt-6-sol")).toBe("gpt-6-luna");
  });
});

describe("post Reviewer benchmark summary", () => {
  it("makes missing receipts and incomplete run state explicit with comparison metadata", () => {
    const candidate = { ref: { id: "candidate", revision: "1", sha256: "candidate-sha" },
      payload: { reportSha256: "report-sha", reportArtifactRef: "/artifacts/report.json", evidence: { id: "evidence" } } };
    expect(compactSummary("run-1", "needs_review", candidate, undefined, [], Date.now(), "case-a", 1,
      undefined, "prompt-sha", "medium")).toMatchObject({
      runState: "needs_review", completion: "incomplete-no-receipt", reviewStatus: "incomplete",
      currentPromptSha256: "prompt-sha", reasoningEffort: "medium",
    });
  });

  it("marks a failed repeat incomplete in the existing summary and preserves completed results", () => {
    expect(markSummaryIncomplete({ status: "incomplete", results: [{ reviewStatus: "completed_no_findings" }] },
      new Error("second repeat failed"))).toMatchObject({
      status: "incomplete", completion: "failed-or-threw", completedRepeats: 1,
      results: [{ reviewStatus: "completed_no_findings" }], error: "second repeat failed",
    });
  });

  it("retains the completed review and pending repair when repair throws", () => {
    const review = { workflowRunId: "fresh-review", runState: "succeeded", completion: "receipt-recorded",
      repairStatus: "pending", reviewStatus: "completed_with_findings" };
    expect(markSummaryIncomplete({ status: "incomplete", repairOnFindings: true, results: [review] },
      new Error("repair failed"))).toMatchObject({ status: "incomplete", completion: "failed-or-threw",
      results: [review], error: "repair failed" });
  });

  it("does not label a needs_review run without a receipt as completed", () => {
    expect(summarizeReviewResults({ caseLabel: "case-a" }, [{ runState: "needs_review", completion: "incomplete-no-receipt" }], 1))
      .toMatchObject({ status: "incomplete", completion: "review-incomplete", completedRepeats: 0 });
  });

  it("only completes the opt-in benchmark when a finding's repair completed", () => {
    const prepared = { repairOnFindings: true };
    const reviewed = { runState: "succeeded", completion: "receipt-recorded", repairStatus: "pending" };
    expect(summarizeReviewResults(prepared, [reviewed], 1)).toMatchObject({ status: "incomplete",
      completion: "review-or-repair-incomplete" });
    expect(summarizeReviewResults(prepared, [{ ...reviewed, repairStatus: "incomplete" }], 1).status)
      .toBe("incomplete");
    expect(summarizeReviewResults(prepared, [{ ...reviewed, repairStatus: "completed" }], 1)).toMatchObject({
      status: "completed", completion: "reviews-and-requested-repairs-recorded" });
    expect(summarizeReviewResults(prepared, [{ ...reviewed, repairStatus: "not_needed" }], 1).status)
      .toBe("completed");
  });
});

describe("post Reviewer conditional repair binding", () => {
  const candidate = storedRef("repaired-candidate", "post-candidate", "rev-final", "sha-final");
  const receipt = { schemaVersion: "research-review@1", kind: "post", candidate,
    candidateReportSha256: "report-final", summary: "The slider relation needs a correction.",
    findings: [{ id: "finding-1", location: "/builderLenses/contentRestoration/blocks/0",
      issue: "Mismatch", evidenceRefs: ["TARGET-0001"], suggestedChange: "Correct the stated relation",
      priority: "major", kind: "content" }] };

  it("allows a review of the selected final post.repair candidate", () => {
    expect(reviewReceiptForCandidate("succeeded", { ok: true, receipt }, candidate, "report-final"))
      .toMatchObject({ candidate: { id: "repaired-candidate" }, findings: [{ id: "finding-1" }] });
  });

  it("does not repair a failed review or one with no findings", () => {
    expect(reviewReceiptForCandidate("needs_review", { ok: true, receipt }, candidate, "report-final"))
      .toBeUndefined();
    expect(reviewReceiptForCandidate("succeeded", { ok: true,
      receipt: { ...receipt, findings: [] } }, candidate, "report-final")?.findings).toEqual([]);
  });

  it("rejects a review bound to a different candidate version or report bytes", () => {
    expect(() => reviewReceiptForCandidate("succeeded", { ok: true, receipt }, candidate, "different-report"))
      .toThrow("does not bind");
    expect(() => reviewReceiptForCandidate("succeeded", { ok: true, receipt },
      { ...candidate, sha256: "different-candidate" }, "report-final")).toThrow("does not bind");
  });
});

describe("post Reviewer historical review binding", () => {
  it("rejects a source artifact that is not a post-review", async () => {
    const store = { getArtifact: async () => storedRef("review", "creator-review") };
    await expect(resolveCandidateFromReview(store, "review")).rejects.toThrow("not post-review");
  });

  it("requires the embedded candidate revision and SHA to match storage", async () => {
    const store = {
      getArtifact: async (id) => id === "review" ? storedRef("review", "post-review") : storedRef("candidate", "post-candidate"),
      getArtifactPayload: async () => ({ candidate: { id: "candidate", revision: "stale-revision", sha256: "sha-1" } }),
    };
    await expect(resolveCandidateFromReview(store, "review")).rejects.toThrow("review candidate artifact binding");
  });

  it("checks the candidate evidence revision and SHA before reading its payload", async () => {
    const candidate = storedRef("candidate", "post-candidate");
    const store = {
      getArtifact: async (id) => id === "review" ? storedRef("review", "post-review")
        : id === "candidate" ? candidate : storedRef("evidence", "post-evidence", "actual-revision", "actual-sha"),
      getArtifactPayload: async (id) => id === "review"
        ? { candidate: { id: candidate.id, revision: candidate.revision, sha256: candidate.sha256 } }
        : { kind: "post", evidence: { id: "evidence", revision: "stale-revision", sha256: "stale-sha" },
          reportArtifactRef: "/artifacts/report.json", reportSha256: "report-sha", relativeRoot: "run", outcome: {} },
    };
    await expect(resolveCandidateFromReview(store, "review")).rejects.toThrow("candidate evidence artifact binding");
  });
});
