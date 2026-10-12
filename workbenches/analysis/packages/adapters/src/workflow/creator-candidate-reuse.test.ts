import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArtifactRef, RunStore } from "@signal-room/workflow";
import type { CreatorArtifactStore, CreatorSynthesisWorkflowStartInput } from "../../../research/index.js";
import { artifactPath } from "../core/artifacts.js";
import { runArtifactDir } from "../core/config.js";
import { fileDigest, type PinnedResearchInput } from "./research-inputs.js";
import { materializeCreatorReuseCandidate, pinVerifiedCreatorReuseCandidate } from "./creator-candidate-reuse.js";

const creatorRunId = "ae713242-656f-48bf-8f2b-42aa16201e3d";
const otherCreator = "be713242-656f-48bf-8f2b-42aa16201e3d";
let runtime: string;

const source = (): CreatorSynthesisWorkflowStartInput => ({ creatorRunId, candidateMode: "reuse",
  reuseCandidateArtifactId: "candidate-1",
  portfolioArtifactRef: `/artifacts/${creatorRunId}/portfolio.json`,
  portfolioAnnotationsArtifactRef: `/artifacts/${creatorRunId}/annotations.json`,
  selectionArtifactRef: `/artifacts/${creatorRunId}/selection.json`,
  detailArtifactRef: `/artifacts/${creatorRunId}/detail.json`,
  reconstructionBatchArtifactRef: `/artifacts/${creatorRunId}/batch.json` });

function write(reference: string, value: unknown): void {
  const filename = artifactPath(reference);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function report(input: CreatorSynthesisWorkflowStartInput) {
  const claim = { statement: "Observed", factClass: "observed", confidence: "high",
    evidenceRefs: [input.portfolioArtifactRef], caveat: null };
  return { schemaVersion: "1.0.0", creatorRunId, generatedAt: "2026-10-10T00:00:00.000Z",
    inputs: { portfolioArtifactRef: input.portfolioArtifactRef,
      portfolioAnnotationsArtifactRef: input.portfolioAnnotationsArtifactRef,
      selectionArtifactRef: input.selectionArtifactRef, detailArtifactRef: input.detailArtifactRef,
      reconstructionBatchArtifactRef: input.reconstructionBatchArtifactRef },
    identity: { positioning: claim, audience: [claim], problemsAddressed: [claim], valueProvided: [claim],
      trustSources: [claim], lifecycleStage: claim, commercialPaths: [] },
    contentSystem: { topicClusters: [claim], formatClusters: [claim], visualLanguage: [claim],
      publishingRhythm: [], recurringStructure: [claim] },
    performance: { baseline: [claim], high: [claim], low: [claim], timing: [], confounds: ["unknown"] },
    postAnalyses: Array.from({ length: 21 }, (_, index) => ({ postExternalId: `post-${index + 1}`,
      tier: "base", tierRank: index + 1, title: null, evidenceStatus: "surface_only", contentRole: "sample",
      contentForm: ["video"], performanceInterpretation: "Observed", evidenceRefs: [input.portfolioArtifactRef], unknowns: [] })),
    boundaries: ["Only frozen evidence"] };
}

function reference(id: string, type: string): ArtifactRef {
  return { id, type, schemaVersion: "v1", revision: "1", sha256: `${id}-sha`, uri: `memory://${id}`,
    producedBy: { workflowRunId: `${id}-run`, stepRunId: `${id}-step`, attemptId: `${id}-attempt` },
    dependsOn: [], validation: "valid", review: "pending" };
}

function fixture(overrides: { owner?: string; unboundEvidence?: boolean; oldSource?: CreatorSynthesisWorkflowStartInput;
  oldFiles?: PinnedResearchInput["files"]; reportInput?: CreatorSynthesisWorkflowStartInput } = {}) {
  const current = source();
  for (const ref of [current.portfolioArtifactRef, current.portfolioAnnotationsArtifactRef,
    current.selectionArtifactRef, current.detailArtifactRef, current.reconstructionBatchArtifactRef]) write(ref, { ref });
  const files = [current.portfolioArtifactRef, current.portfolioAnnotationsArtifactRef,
    current.selectionArtifactRef, current.detailArtifactRef, current.reconstructionBatchArtifactRef]
    .map((ref) => ({ ref, sha256: fileDigest(artifactPath(ref)) }));
  const pinned: PinnedResearchInput = { kind: "creator", executor: "responses", source: current,
    files, methods: [] };
  const old: PinnedResearchInput = { ...pinned, source: overrides.oldSource ?? { ...current, candidateMode: undefined,
    reuseCandidateArtifactId: undefined }, files: overrides.oldFiles ?? files };
  const body = report(overrides.reportInput ?? current);
  const preliminary = `/artifacts/${creatorRunId}/workflow-responses/old-run/old-attempt/creator-analysis.json`;
  write(preliminary, body);
  const sha = fileDigest(artifactPath(preliminary));
  const reportRef = `/artifacts/${creatorRunId}/workflow-responses/old-run/old-attempt/creator-analysis.${sha.slice(0, 12)}.json`;
  write(reportRef, body);
  const evidence = reference("evidence-1", "creator-evidence");
  const candidate = reference("candidate-1", "creator-synthesis");
  candidate.dependsOn = overrides.unboundEvidence ? [] : [{ artifactId: evidence.id,
    revision: evidence.revision, sha256: evidence.sha256 }];
  const registered = new Map([[evidence.id, evidence], [candidate.id, candidate]]);
  const payloads = new Map<string, unknown>([[evidence.id, old], [candidate.id, { kind: "creator", evidence,
    report: body, reportArtifactRef: reportRef, reportSha256: sha,
    outcome: { state: "not_ready", synthesisArtifactRef: reportRef, gateArtifactRef: null } }]]);
  const store = { getArtifact: async (id: string) => registered.get(id),
    getArtifactPayload: async (id: string) => payloads.get(id),
    getRun: async (id: string) => ({ id, metadata: { creatorRunId: id === candidate.producedBy.workflowRunId
      ? overrides.owner ?? creatorRunId : creatorRunId } }) } as unknown as RunStore & { getArtifactPayload(id: string): Promise<unknown> };
  const dependencies: string[][] = [];
  const artifacts = { write: async (_runId: string, filename: string, value: unknown, deps: string[] = []) => {
    const bytes = `${JSON.stringify(value, null, 2)}\n`;
    const hash = createHash("sha256").update(bytes).digest("hex");
    const versioned = filename.replace(/\.json$/u, `.${hash.slice(0, 12)}.json`);
    const ref = `/artifacts/${creatorRunId}/${versioned}`;
    write(ref, value); dependencies.push(deps); return ref;
  }, read: async (ref: string) => JSON.parse(fs.readFileSync(artifactPath(ref), "utf8")) as unknown } as CreatorArtifactStore;
  return { pinned, store, artifacts, reportRef, body, dependencies, candidate };
}

beforeEach(() => { runtime = fs.mkdtempSync(path.join(os.tmpdir(), "creator-candidate-reuse-"));
  process.env.SELF_MEDIA_RUNTIME_DIR = runtime; });
afterEach(() => { fs.rmSync(runtime, { recursive: true, force: true }); delete process.env.SELF_MEDIA_RUNTIME_DIR; });

describe("explicit creator candidate reuse", () => {
  it("requires an explicit candidate ID", async () => {
    const f = fixture();
    (f.pinned.source as CreatorSynthesisWorkflowStartInput).reuseCandidateArtifactId = undefined;
    await expect(pinVerifiedCreatorReuseCandidate(f.store, f.pinned)).rejects.toThrow("CREATOR_REUSE_CANDIDATE_ID_REQUIRED");
  });
  it("rejects a candidate owned by another creator", async () => {
    const f = fixture({ owner: otherCreator });
    await expect(pinVerifiedCreatorReuseCandidate(f.store, f.pinned)).rejects.toThrow("CREATOR_REUSE_WRONG_CREATOR");
  });
  it("rejects a candidate whose registered dependency no longer binds its evidence", async () => {
    const f = fixture({ unboundEvidence: true });
    await expect(pinVerifiedCreatorReuseCandidate(f.store, f.pinned)).rejects.toThrow("CREATOR_REUSE_CANDIDATE_EVIDENCE_BINDING_CHANGED");
  });
  it("rejects the same source ref with a changed frozen SHA", async () => {
    const f = fixture({ oldFiles: [] });
    await expect(pinVerifiedCreatorReuseCandidate(f.store, f.pinned)).rejects.toThrow("CREATOR_REUSE_SOURCE_SHA_CHANGED_portfolioArtifactRef");
  });
  it("rejects candidate source and report input drift", async () => {
    const current = source();
    const drift = { ...current, detailArtifactRef: `/artifacts/${creatorRunId}/different-detail.json` };
    const f = fixture({ oldSource: drift });
    await expect(pinVerifiedCreatorReuseCandidate(f.store, f.pinned)).rejects.toThrow("CREATOR_REUSE_SOURCE_REF_CHANGED_detailArtifactRef");
    const g = fixture({ reportInput: drift });
    await expect(pinVerifiedCreatorReuseCandidate(g.store, g.pinned)).rejects.toThrow("CREATOR_REUSE_REPORT_SOURCE_CHANGED_detailArtifactRef");
  });
  it("preserves the report and registers a new asset with old candidate lineage", async () => {
    const f = fixture();
    const pinned = await pinVerifiedCreatorReuseCandidate(f.store, f.pinned);
    const directory = path.join(runArtifactDir(creatorRunId), "workflow-responses", "new-run", "new-attempt");
    const result = await materializeCreatorReuseCandidate(f.store, f.artifacts, pinned, directory);
    expect(result.report).toEqual(f.body);
    expect(result.reportArtifactRef).not.toBe(f.reportRef);
    expect(JSON.parse(fs.readFileSync(path.join(directory, "creator-analysis.json"), "utf8"))).toEqual(f.body);
    expect(result.reusedFrom.candidate).toMatchObject({ id: f.candidate.id, revision: f.candidate.revision, sha256: f.candidate.sha256 });
    expect(f.dependencies[0]).toContain(f.reportRef);
    expect(f.dependencies[0]).toContain((f.pinned.source as CreatorSynthesisWorkflowStartInput).detailArtifactRef);
    expect(fileDigest(artifactPath(f.reportRef))).toBe(result.reusedFrom.reportSha256);
  });
});
