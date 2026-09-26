import { creatorDiscoveryResultSchema, creatorResearchEventSchema, creatorResearchRunSchema, creatorRunOperationSchema, creatorSummarySchema, type CreatorAcquisitionAdapter, type CreatorDiscoveryResult, type CreatorResearchEvent, type CreatorResearchRun, type CreatorRunOperation, type CreatorRunOperationAction, type CreatorSummary } from "../contracts/core";
import {
  creatorPortfolioAnalysisSchema, creatorSelectionSchema, creatorDetailCollectionSchema,
  deepMediaManifestSchema, videoReconstructionBatchSchema, creatorSynthesisGateSchema,
  creatorSynthesisSchema, type CreatorPortfolioAnalysis, type CreatorSelection,
  type CreatorDetailCollection, type DeepMediaManifest, type VideoReconstructionBatch,
  type CreatorSynthesis, type CreatorSynthesisGate
} from "../contracts/research";
import { creatorDossierSchema, type CreatorDossier } from "../contracts/core";
import { videoResearchSchema, type VideoResearch } from "../contracts/core";
import { z } from "zod";
import { creatorResearchPipelineSchema, type CreatorResearchPipeline } from "../contracts/core";
import {
  evidenceAccessProjectionSchema, evidenceCatalogPageSchema,
  type EvidenceAccessProjection, type EvidenceCatalogPage
} from "../contracts/core";

async function json<T>(response: Response, parse: (value: unknown) => T): Promise<T> {
  const value: unknown = await response.json();
  if (!response.ok) {
    const error = value && typeof value === "object" && "error" in value ? String(value.error) : "请求失败";
    throw new Error(error);
  }
  return parse(value);
}

export async function getEvidenceAccess(evidenceId: string): Promise<EvidenceAccessProjection> {
  return json(await fetch(`/api/v1/evidence/${encodeURIComponent(evidenceId)}`, { cache: "no-store" }),
    (value) => evidenceAccessProjectionSchema.parse(value));
}

export async function listEvidenceCatalog(input: { q?: string; classification?: string; offset?: number; limit?: number } = {}): Promise<EvidenceCatalogPage> {
  const query = new URLSearchParams();
  if (input.q) query.set("q", input.q);
  if (input.classification) query.set("classification", input.classification);
  if (input.offset) query.set("offset", String(input.offset));
  if (input.limit) query.set("limit", String(input.limit));
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return json(await fetch(`/api/v1/evidence${suffix}`, { cache: "no-store" }), (value) => evidenceCatalogPageSchema.parse(value));
}

export async function listCreators(): Promise<CreatorSummary[]> {
  return json(await fetch("/api/creators", { cache: "no-store" }), (value) => {
    const creators = value && typeof value === "object" && "creators" in value ? value.creators : [];
    return creatorSummarySchema.array().parse(creators);
  });
}

export async function listCreatorResearchRuns(): Promise<CreatorResearchRun[]> {
  return json(await fetch("/api/creator-runs", { cache: "no-store" }), (value) => {
    const runs = value && typeof value === "object" && "runs" in value ? value.runs : [];
    return creatorResearchRunSchema.array().parse(runs);
  });
}

export async function getCreatorResearchRun(id: string): Promise<CreatorResearchRun> {
  return json(await fetch(`/api/creator-runs/${encodeURIComponent(id)}`, { cache: "no-store" }),
    (value) => creatorResearchRunSchema.parse(value));
}

export async function listCreatorRunOperations(): Promise<CreatorRunOperation[]> {
  return json(await fetch("/api/creator-run-operations", { cache: "no-store" }), (value) => {
    const operations = value && typeof value === "object" && "operations" in value ? value.operations : [];
    return creatorRunOperationSchema.array().parse(operations);
  });
}

export async function runCreatorOperation(id: string, action: CreatorRunOperationAction): Promise<CreatorResearchRun> {
  const paths: Record<Exclude<CreatorRunOperationAction, "none">, string> = {
    resume: "resume",
    retry_failed_videos: "retry-failed-videos",
    continue_with_media_gaps: "continue-with-media-gaps",
    revalidate_synthesis: "revalidate-synthesis"
  };
  if (action === "none") throw new Error("当前任务没有可执行的恢复动作");
  return json(await fetch(`/api/creator-runs/${id}/${paths[action]}`, {
    method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: "{}"
  }), (value) => creatorResearchRunSchema.parse(value));
}

export async function createCreatorResearchRun(
  profileUrl: string,
  adapter: CreatorAcquisitionAdapter = "ego-browser"
): Promise<CreatorResearchRun> {
  return json(await fetch("/api/creator-runs", {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileUrl, adapter })
  }), (value) => creatorResearchRunSchema.parse(value));
}

export async function discoverAiCreators(): Promise<CreatorDiscoveryResult> {
  return json(await fetch("/api/creator-discovery/redfox", {
    method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: "{}"
  }), (value) => creatorDiscoveryResultSchema.parse(value));
}

export async function resumeCreatorResearchRun(id: string): Promise<CreatorResearchRun> {
  return json(await fetch(`/api/creator-runs/${id}/resume`, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  }), (value) => creatorResearchRunSchema.parse(value));
}

export async function evaluateCreatorVideos(id: string, postExternalIds: string[]): Promise<CreatorResearchRun> {
  return json(await fetch(`/api/creator-runs/${id}/evaluate-videos`, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ postExternalIds })
  }), (value) => creatorResearchRunSchema.parse(value));
}

export async function listCreatorResearchEvents(id: string, after = 0): Promise<CreatorResearchEvent[]> {
  return json(await fetch(`/api/creator-runs/${id}/events?after=${after}`, { cache: "no-store" }), (value) => {
    const events = value && typeof value === "object" && "events" in value ? value.events : [];
    return creatorResearchEventSchema.array().parse(events);
  });
}

export type CreatorResearchPortfolio = {
  run: CreatorResearchRun;
  pipeline: CreatorResearchPipeline;
  analysis: CreatorPortfolioAnalysis | null;
  selection: CreatorSelection | null;
  details: CreatorDetailCollection | null;
  mediaManifest: DeepMediaManifest | null;
  reconstructionBatch: VideoReconstructionBatch | null;
  synthesis: CreatorSynthesis | null;
  synthesisGate: CreatorSynthesisGate | null;
};

export async function getCreatorResearchPortfolio(id: string): Promise<CreatorResearchPortfolio> {
  return json(await fetch(`/api/creator-runs/${id}/portfolio`, { cache: "no-store" }), (value) => {
    if (!value || typeof value !== "object" || !("run" in value)) throw new Error("博主 Portfolio 结构无效");
    const candidate = value as Record<string, unknown>;
    return {
      run: creatorResearchRunSchema.parse(candidate.run),
      pipeline: creatorResearchPipelineSchema.parse(candidate.pipeline),
      analysis: candidate.analysis === null ? null : creatorPortfolioAnalysisSchema.parse(candidate.analysis),
      selection: candidate.selection === null ? null : creatorSelectionSchema.parse(candidate.selection),
      details: candidate.details === null ? null : creatorDetailCollectionSchema.parse(candidate.details),
      mediaManifest: candidate.mediaManifest === null ? null : deepMediaManifestSchema.parse(candidate.mediaManifest),
      reconstructionBatch: candidate.reconstructionBatch === null ? null : videoReconstructionBatchSchema.parse(candidate.reconstructionBatch),
      synthesis: candidate.synthesis === null ? null : creatorSynthesisSchema.parse(candidate.synthesis),
      synthesisGate: candidate.synthesisGate === null ? null : creatorSynthesisGateSchema.parse(candidate.synthesisGate)
    };
  });
}

export async function getCreatorDossier(id: string): Promise<CreatorDossier> {
  return json(await fetch(`/api/v1/creators/${encodeURIComponent(id)}`, { cache: "no-store" }),
    (value) => creatorDossierSchema.parse(value));
}

export async function getVideoResearch(creatorId: string, videoId: string, runId?: string): Promise<VideoResearch> {
  const query = runId ? `?run=${encodeURIComponent(runId)}` : "";
  return json(await fetch(`/api/v1/creators/${encodeURIComponent(creatorId)}/videos/${encodeURIComponent(videoId)}${query}`, { cache: "no-store" }),
    (value) => videoResearchSchema.parse(value));
}

const latestVideoResearchItemSchema = z.object({
  creatorId: z.string(), creatorName: z.string(), videoId: z.string(), title: z.string(), runId: z.string(), href: z.string()
});
export type LatestVideoResearchItem = z.infer<typeof latestVideoResearchItemSchema>;

export async function listLatestVideoResearch(): Promise<LatestVideoResearchItem[]> {
  return json(await fetch("/api/v1/video-research/latest", { cache: "no-store" }), (value) => {
    const items = value && typeof value === "object" && "items" in value ? value.items : [];
    return latestVideoResearchItemSchema.array().parse(items);
  });
}
