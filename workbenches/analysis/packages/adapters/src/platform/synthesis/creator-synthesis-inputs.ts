import fs from "node:fs";
import { artifactPath } from "../../core/artifacts.js";
import {
  videoReconstructionBatchSchema,
  type CreatorArtifactStore,
  type CreatorSynthesisRequest
} from "../../../../research/index.js";
import { resolveReportSource } from "../artifacts/report-source-revision.js";

const builtStates = new Set(["built_unevaluated", "evaluated_with_findings", "verified", "ready"]);

/** Apply verified report-source corrections before synthesis and invalidate every evaluator bound to the old bytes. */
export async function prepareCreatorSynthesisBatch(
  artifacts: CreatorArtifactStore,
  request: CreatorSynthesisRequest
): Promise<string> {
  const originalBatch = videoReconstructionBatchSchema.parse(await artifacts.read(request.reconstructionBatchArtifactRef));
  const revisionDependencies: string[] = [];
  const revisedPostIds: string[] = [];
  const effectiveItems: typeof originalBatch.items = [];

  for (const item of originalBatch.items) {
    if (!item.reconstructionArtifactRef) {
      effectiveItems.push(item);
      continue;
    }
    const resolved = resolveReportSource(artifactPath(item.reconstructionArtifactRef));
    if (!resolved.revision || !resolved.revisedSha256 || !resolved.manifestPath) {
      effectiveItems.push(item);
      continue;
    }
    const revisedValue = JSON.parse(resolved.text) as unknown;
    const revisionManifestRef = await artifacts.write(request.creatorRunId,
      `creator-synthesis-source-revision-${item.postExternalId}.json`,
      JSON.parse(fs.readFileSync(resolved.manifestPath, "utf8")) as unknown,
      [item.reconstructionArtifactRef]);
    const revisedRef = await artifacts.write(request.creatorRunId,
      `creator-synthesis-source-${item.postExternalId}.json`, revisedValue,
      [item.reconstructionArtifactRef, revisionManifestRef]);
    revisionDependencies.push(revisionManifestRef, revisedRef);
    revisedPostIds.push(item.postExternalId);
    effectiveItems.push({
      ...item,
      state: "built_unevaluated",
      reconstructionArtifactRef: revisedRef,
      evaluationArtifactRef: null,
      gateReportArtifactRef: null,
      threeLensEvaluationArtifactRef: null,
      threeLensGateReportArtifactRef: null,
      failedGateIds: [],
      researchReview: null,
      message: `综合输入采用已核对源修订；既有独立评估未绑定该 revision。${resolved.revision}`
    });
  }

  const effectiveBatch = videoReconstructionBatchSchema.parse({
    ...originalBatch,
    generatedAt: originalBatch.generatedAt,
    builtPosts: effectiveItems.filter((item) => builtStates.has(item.state)).length,
    verifiedPosts: effectiveItems.filter((item) => ["verified", "ready"].includes(item.state)).length,
    readyPosts: effectiveItems.filter((item) => ["verified", "ready"].includes(item.state)).length,
    limitations: [...originalBatch.limitations,
      ...(revisedPostIds.length ? [`综合输入绑定 ${revisedPostIds.length} 份报告源修订；其既有单帖评估不沿用。`] : [])],
    items: effectiveItems
  });
  if (revisedPostIds.length === 0) return request.reconstructionBatchArtifactRef;
  return await artifacts.write(request.creatorRunId, "creator-synthesis-input-batch.json", effectiveBatch,
    [request.reconstructionBatchArtifactRef, ...revisionDependencies]);
}
