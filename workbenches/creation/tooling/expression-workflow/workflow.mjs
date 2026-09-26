import { createHash } from "node:crypto";
import { workflow } from "@signal-room/workflow";

const DECISIONS = new Set(["pass", "revise", "insufficient-evidence", "human-decision"]);
const MATERIAL_STATUSES = new Set(["ready", "missing", "alternative"]);

const dependency = (ref) => ({ artifactId: ref.id, revision: ref.revision, sha256: ref.sha256 });
const publicRef = (ref) => ({ id: ref.id, revision: ref.revision, sha256: ref.sha256 });
const isString = (value) => typeof value === "string" && value.trim().length > 0;
const contentSha256 = (content) => createHash("sha256").update(content, "utf8").digest("hex");

function validateCandidate(value) {
  const valid = value && isString(value.title) && isString(value.document) && isString(value.publicDocument)
    && Array.isArray(value.visuals) && value.visuals.length > 0
    && value.visuals.every((item) => item && isString(item.id) && isString(item.content))
    && Array.isArray(value.materials)
    && value.materials.every((item) => item && isString(item.id) && isString(item.purpose)
      && typeof item.required === "boolean" && MATERIAL_STATUSES.has(item.status)
      && (item.status !== "alternative" || isString(item.alternative))
      && (item.alternative === undefined || typeof item.alternative === "string"));
  return { valid: Boolean(valid), details: valid ? undefined : {
    reason: "candidate-contract-invalid",
    required: ["title", "document", "publicDocument", "visuals[]", "materials[]"],
  } };
}

function readerCandidate(candidate) {
  return {
    title: candidate.title,
    document: candidate.publicDocument,
    visuals: candidate.visuals,
  };
}

function validateReaderReview(value, candidateSha256) {
  const valid = value && value.candidateSha256 === candidateSha256
    && Array.isArray(value.observations)
    && value.observations.every((item) => item && isString(item.id) && isString(item.location)
      && isString(item.observation) && ["blocking", "non_blocking"].includes(item.severity));
  return { valid: Boolean(valid), details: valid ? undefined : {
    reason: "reader-review-contract-or-binding-invalid",
    expectedCandidateSha256: candidateSha256,
    actualCandidateSha256: value?.candidateSha256,
  } };
}

function validateEditorReview(value, candidateSha256) {
  const valid = value && value.candidateSha256 === candidateSha256 && DECISIONS.has(value.decision)
    && Array.isArray(value.findings)
    && value.findings.every((item) => item && isString(item.id) && isString(item.location)
      && isString(item.issue)
      && (item.requiredChange === undefined || typeof item.requiredChange === "string")
      && (item.evidenceIds === undefined || (Array.isArray(item.evidenceIds)
        && item.evidenceIds.every(isString))));
  return { valid: Boolean(valid), details: valid ? undefined : {
    reason: "editor-review-contract-or-binding-invalid",
    expectedCandidateSha256: candidateSha256,
    actualCandidateSha256: value?.candidateSha256,
  } };
}

function validateInput(input) {
  const valid = input && isString(input.workspaceId) && isString(input.topicId)
    && isString(input.goal) && Array.isArray(input.readers) && input.readers.length > 0
    && input.readers.every(isString) && isString(input.positioning)
    && Array.isArray(input.research) && input.research.length > 0
    && input.research.every((item) => item && isString(item.id) && isString(item.path)
      && /^[a-f0-9]{64}$/i.test(item.sha256) && isString(item.content)
      && contentSha256(item.content) === item.sha256.toLowerCase());
  return { valid: Boolean(valid), details: valid ? undefined : { reason: "expression-input-invalid" } };
}

function briefOf(input) {
  return Object.freeze({
    workspaceId: input.workspaceId,
    topicId: input.topicId,
    goal: input.goal,
    readers: Object.freeze([...input.readers]),
    positioning: input.positioning,
  });
}

async function publishCandidate(phase, key, kind, candidate, checked, dependsOn = []) {
  const ref = await phase.publish(key, `expression-${kind}-candidate`, candidate, {
    schemaVersion: "1",
    validation: checked.valid ? "valid" : "invalid",
    review: "pending",
    dependsOn,
  });
  await phase.bindArtifact(ref, { role: `${kind}-candidate`, title: candidate?.title || `Invalid ${kind} candidate`, primary: true });
  return ref;
}

async function publishReview(ctx, key, type, review, checked, candidateRef, otherDependencies = []) {
  return ctx.publish(key, type, review, {
    schemaVersion: "1",
    validation: checked.valid ? "valid" : "invalid",
    review: checked.valid ? (review.decision === "pass" ? "passed" : "findings") : "findings",
    dependsOn: [dependency(candidateRef), ...otherDependencies],
  });
}

function failureDetails(settled) {
  return Object.fromEntries(Object.entries(settled).map(([name, result]) => [name,
    result.status === "fulfilled"
      ? { status: "fulfilled", ref: result.value.ref, valid: result.value.checked.valid }
      : { status: "rejected", error: String(result.reason?.message ?? result.reason) }]));
}

export function createExpressionWorkflow({ agents, revision, maxRevisions = 1 }) {
  if (!agents?.author || !agents?.reader || !agents?.editor) {
    throw new Error("createExpressionWorkflow requires author, reader, and editor agents");
  }
  if (!isString(revision)) throw new Error("createExpressionWorkflow revision is required");
  if (!Number.isInteger(maxRevisions) || maxRevisions < 0) {
    throw new Error("maxRevisions must be a non-negative integer");
  }

  return workflow("expression.b2", { revision }, async (ctx, input) => {
    const inputCheck = await ctx.validate("input-contract", input, validateInput);
    if (!inputCheck.valid) return ctx.blocked(inputCheck.details);

    const brief = briefOf(input);
    const researchRef = await ctx.phase("freeze-research", {
      title: "Freeze expression research",
      purpose: "Publish the exact verified evidence package used by every candidate",
      order: 1,
      expectedArtifacts: [{ role: "research", title: "Frozen research", required: true }],
    }, async (phase) => {
      const ref = await phase.publish("research", "expression-frozen-research", input.research, {
        schemaVersion: "1",
        validation: "valid",
        review: "not_applicable",
      });
      await phase.bindArtifact(ref, { role: "research", title: "Frozen research", primary: true });
      return ref;
    });
    let coreCandidate;
    let coreRef;
    let coreDecisionRef;
    let priorCoreReviews = [];

    for (let round = 0; round <= maxRevisions; round++) {
      const core = await ctx.phase(`core-${round}`, {
        title: round === 0 ? "Draft the core expression" : `Repair the core expression (${round})`,
        purpose: "Create a readable core and arbitrate reader comprehension before expansion",
        order: 10 + round,
        expectedArtifacts: [
          { role: "core-candidate", title: "Core candidate", required: true },
          { role: "reader-review", title: "Reader first impression", required: true },
          { role: "editor-review", title: "Editorial first impression", required: true },
          { role: "editor-arbitration", title: "Core arbitration", required: true },
        ],
      }, async (phase) => {
        const task = round === 0 ? "core-draft" : "core-revise";
        const candidate = await phase.agent("author", agents.author, {
          task,
          brief,
          research: input.research,
          ...(round === 0 ? {} : {
            candidate: coreCandidate,
            candidateRef: publicRef(coreRef),
            reviews: priorCoreReviews.map(({ review, ref }) => ({ review, ref: publicRef(ref) })),
          }),
        });
        const checked = await phase.validate("candidate-contract", candidate, validateCandidate, { producerStepKey: "author" });
        const ref = await publishCandidate(phase, "candidate", "core", candidate, checked,
          coreRef
            ? [dependency(researchRef), dependency(coreRef), ...priorCoreReviews.map((item) => dependency(item.ref))]
            : [dependency(researchRef)]);
        if (!checked.valid) return phase.needsReview({ reason: "invalid-core-candidate", candidate: ref, validation: checked.details });

        const reviews = await phase.parallelSettled("first-impressions", {
          reader: async () => {
            const review = await phase.agent("reader", agents.reader, {
              task: "reader-review",
              readers: input.readers,
              candidate: readerCandidate(candidate),
              candidateRef: publicRef(ref),
            });
            const reviewCheck = await phase.validate("reader-contract", review,
              (value) => validateReaderReview(value, ref.sha256), { producerStepKey: "reader" });
            const reviewRef = await publishReview(phase, "reader-record", "expression-reader-review", review, reviewCheck, ref);
            return { review, ref: reviewRef, checked: reviewCheck };
          },
          editor: async () => {
            const review = await phase.agent("editor", agents.editor, {
              task: "core-review",
              brief,
              candidate,
              candidateRef: publicRef(ref),
              evidence: input.research,
            });
            const reviewCheck = await phase.validate("editor-contract", review,
              (value) => validateEditorReview(value, ref.sha256), { producerStepKey: "editor" });
            const reviewRef = await publishReview(phase, "editor-record", "expression-editor-review", review, reviewCheck, ref);
            return { review, ref: reviewRef, checked: reviewCheck };
          },
        }, { concurrency: 2 });

        for (const [name, result] of Object.entries(reviews)) {
          if (result.status === "fulfilled") {
            await phase.bindArtifact(result.value.ref, { role: `${name}-review`, title: `${name} first impression` });
          }
        }
        if (Object.values(reviews).some((result) => result.status === "rejected"
          || !result.value.checked.valid)) {
          return phase.needsReview({ reason: "core-review-incomplete", candidate: ref, reviews: failureDetails(reviews) });
        }

        const readerResult = reviews.reader.value;
        const editorResult = reviews.editor.value;
        const arbitration = await phase.agent("arbitrator", agents.editor, {
          task: "core-arbitration",
          brief,
          candidate,
          candidateRef: publicRef(ref),
          evidence: input.research,
          readerReview: readerResult.review,
          editorReview: editorResult.review,
        });
        const arbitrationCheck = await phase.validate("arbitration-contract", arbitration,
          (value) => validateEditorReview(value, ref.sha256), { producerStepKey: "arbitrator" });
        const arbitrationRef = await publishReview(phase, "arbitration-record", "expression-editor-arbitration",
          arbitration, arbitrationCheck, ref, [dependency(readerResult.ref), dependency(editorResult.ref)]);
        await phase.bindArtifact(arbitrationRef, { role: "editor-arbitration", title: "Core arbitration", primary: true });
        if (!arbitrationCheck.valid) {
          return phase.needsReview({ reason: "invalid-core-arbitration", candidate: ref, review: arbitrationRef });
        }
        return {
          candidate,
          ref,
          decision: arbitration.decision,
          arbitrationRef,
          reviews: [readerResult, editorResult, { review: arbitration, ref: arbitrationRef }],
        };
      });

      if (core.ok === false) return core;
      coreCandidate = core.candidate;
      coreRef = core.ref;
      coreDecisionRef = core.arbitrationRef;
      priorCoreReviews = core.reviews;
      const route = ctx.decide(`core-route-${round}`, core.decision);
      if (route === "pass") break;
      if (route !== "revise") {
        return ctx.needsReview({ reason: `core-${route}`, candidate: coreRef, review: coreDecisionRef });
      }
      if (round === maxRevisions) {
        return ctx.needsReview({ reason: "core-revision-budget-exhausted", candidate: coreRef, review: coreDecisionRef });
      }
    }

    let fullCandidate;
    let fullRef;
    let fullReviewRef;
    let priorFullReview;

    for (let round = 0; round <= maxRevisions; round++) {
      const full = await ctx.phase(`full-${round}`, {
        title: round === 0 ? "Expand the full expression" : `Repair the full expression (${round})`,
        purpose: "Produce and independently review the complete expression",
        order: 30 + round,
        expectedArtifacts: [
          { role: "full-candidate", title: "Full candidate", required: true },
          { role: "full-review", title: "Full editorial review", required: true },
        ],
      }, async (phase) => {
        const task = round === 0 ? "full-expand" : "full-revise";
        const candidate = await phase.agent("author", agents.author, {
          task,
          brief,
          research: input.research,
          candidate: round === 0 ? coreCandidate : fullCandidate,
          candidateRef: publicRef(round === 0 ? coreRef : fullRef),
          reviews: round === 0
            ? priorCoreReviews.map((item) => ({ review: item.review, ref: publicRef(item.ref) }))
            : [{ review: priorFullReview, ref: publicRef(fullReviewRef) }],
        });
        const checked = await phase.validate("candidate-contract", candidate, validateCandidate, { producerStepKey: "author" });
        const previousRef = round === 0 ? coreRef : fullRef;
        const reviewDependency = round === 0 ? coreDecisionRef : fullReviewRef;
        const ref = await publishCandidate(phase, "candidate", "full", candidate, checked,
          [dependency(researchRef), dependency(previousRef), dependency(reviewDependency)]);
        if (!checked.valid) return phase.needsReview({ reason: "invalid-full-candidate", candidate: ref, validation: checked.details });

        const review = await phase.agent("editor", agents.editor, {
          task: "full-review",
          brief,
          candidate,
          candidateRef: publicRef(ref),
          evidence: input.research,
        });
        const reviewCheck = await phase.validate("editor-contract", review,
          (value) => validateEditorReview(value, ref.sha256), { producerStepKey: "editor" });
        const reviewRef = await publishReview(phase, "editor-record", "expression-full-review", review, reviewCheck, ref);
        await phase.bindArtifact(reviewRef, { role: "full-review", title: "Full editorial review", primary: true });
        if (!reviewCheck.valid) return phase.needsReview({ reason: "invalid-full-review", candidate: ref, review: reviewRef });
        return { candidate, ref, review, reviewRef };
      });

      if (full.ok === false) return full;
      fullCandidate = full.candidate;
      fullRef = full.ref;
      priorFullReview = full.review;
      fullReviewRef = full.reviewRef;
      const route = ctx.decide(`full-route-${round}`, full.review.decision);
      if (route === "pass") break;
      if (route !== "revise") {
        return ctx.needsReview({ reason: `full-${route}`, candidate: fullRef, review: fullReviewRef });
      }
      if (round === maxRevisions) {
        return ctx.needsReview({ reason: "full-revision-budget-exhausted", candidate: fullRef, review: fullReviewRef });
      }
    }

    const completion = await ctx.phase("complete-b2", {
      title: "Complete expression B2",
      purpose: "Expose the reviewed package for explicit human acceptance",
      order: 50,
      expectedArtifacts: [{ role: "expression-package", title: "Expression package", required: true }],
    }, async (phase) => {
      const ref = await phase.publish("package", "expression-b2-package", {
        status: "awaiting-human-acceptance",
        candidate: publicRef(fullRef),
        review: publicRef(fullReviewRef),
      }, {
        schemaVersion: "1",
        validation: "valid",
        review: "passed",
        dependsOn: [dependency(fullRef), dependency(fullReviewRef)],
      });
      await phase.bindArtifact(ref, { role: "expression-package", title: fullCandidate.title, primary: true });
      return ref;
    });
    return ctx.needsReview({
      reason: "awaiting-human-acceptance",
      stage: "B2",
      package: completion,
      candidate: fullRef,
      review: fullReviewRef,
    });
  });
}
