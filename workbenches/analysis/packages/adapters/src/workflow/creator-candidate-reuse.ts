import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ArtifactRef, RunStore } from "@signal-room/workflow";
import { creatorSynthesisSchema, type CreatorArtifactStore, type CreatorSynthesis,
  type CreatorSynthesisWorkflowStartInput } from "../../../research/index.js";
import { artifactPath } from "../core/artifacts.js";
import { runArtifactDir } from "../core/config.js";
import { fileDigest, type PinnedResearchInput } from "./research-inputs.js";

type PayloadStore = RunStore & { getArtifactPayload(id: string): Promise<unknown> };
type CandidatePayload = { kind: "creator"; evidence: ArtifactRef; report: unknown;
  reportArtifactRef: string; reportSha256: string; outcome?: { synthesisArtifactRef?: string | null } };
type ReuseIdentity = ArtifactRef;

const sourceKeys = ["portfolioArtifactRef", "portfolioAnnotationsArtifactRef", "selectionArtifactRef",
  "detailArtifactRef", "reconstructionBatchArtifactRef"] as const;

function fail(reason: string): never { throw new Error(`CREATOR_REUSE_${reason}`); }

function sourceRefs(source: CreatorSynthesisWorkflowStartInput): string[] {
  return sourceKeys.map((key) => source[key]).filter((ref): ref is string => typeof ref === "string" && ref.length > 0);
}

async function registered(store: PayloadStore, ref: ArtifactRef): Promise<ArtifactRef> {
  const actual = await store.getArtifact(ref.id);
  if (!actual || actual.revision !== ref.revision || actual.sha256 !== ref.sha256) fail("ARTIFACT_REVISION_CHANGED");
  return actual;
}

async function inspect(store: PayloadStore, pinned: PinnedResearchInput): Promise<{
  candidate: ArtifactRef; report: CreatorSynthesis; reportArtifactRef: string; reportSha256: string;
}> {
  if (pinned.kind !== "creator") fail("WRONG_KIND");
  const source = pinned.source as CreatorSynthesisWorkflowStartInput;
  if (source.candidateMode !== "reuse" || !source.reuseCandidateArtifactId) fail("CANDIDATE_ID_REQUIRED");
  const candidate = await store.getArtifact(source.reuseCandidateArtifactId);
  if (!candidate || candidate.type !== "creator-synthesis" || candidate.validation !== "valid") fail("CANDIDATE_NOT_VALID");
  const owner = await store.getRun(candidate.producedBy.workflowRunId);
  if (owner?.metadata?.creatorRunId !== source.creatorRunId) fail("WRONG_CREATOR");
  const payload = await store.getArtifactPayload(candidate.id) as CandidatePayload;
  if (payload?.kind !== "creator" || !payload.evidence?.id || typeof payload.reportArtifactRef !== "string"
    || !/^[a-f0-9]{64}$/u.test(payload.reportSha256)) fail("CANDIDATE_PAYLOAD_INVALID");
  const evidence = await registered(store, payload.evidence);
  if (evidence.type !== "creator-evidence") fail("EVIDENCE_TYPE_INVALID");
  if (!candidate.dependsOn.some((edge) => edge.artifactId === evidence.id
    && edge.revision === evidence.revision && edge.sha256 === evidence.sha256)) fail("CANDIDATE_EVIDENCE_BINDING_CHANGED");
  const evidenceOwner = await store.getRun(evidence.producedBy.workflowRunId);
  if (evidenceOwner?.metadata?.creatorRunId !== source.creatorRunId) fail("EVIDENCE_WRONG_CREATOR");
  const oldInput = await store.getArtifactPayload(evidence.id) as PinnedResearchInput;
  if (oldInput?.kind !== "creator" || oldInput.source?.creatorRunId !== source.creatorRunId || !Array.isArray(oldInput.files)) {
    fail("EVIDENCE_INVALID");
  }
  const oldSource = oldInput.source as CreatorSynthesisWorkflowStartInput;
  const oldHashes = new Map(oldInput.files.map((file) => [file.ref, file.sha256]));
  const newHashes = new Map(pinned.files.map((file) => [file.ref, file.sha256]));
  for (const key of sourceKeys) {
    const original = oldSource[key] ?? null;
    const current = source[key] ?? null;
    if (original !== current) fail(`SOURCE_REF_CHANGED_${key}`);
    if (typeof current === "string") {
      const oldHash = oldHashes.get(current), newHash = newHashes.get(current);
      if (!oldHash || !newHash || oldHash !== newHash) fail(`SOURCE_SHA_CHANGED_${key}`);
    }
  }
  const match = payload.reportArtifactRef.match(/^\/artifacts\/([0-9a-f-]{36})\/workflow-responses\/([^/]+)\/([^/]+)\/creator-analysis\.([a-f0-9]{12})\.json$/u);
  if (!match || match[1] !== source.creatorRunId || match[4] !== payload.reportSha256.slice(0, 12)) fail("REPORT_REFERENCE_INVALID");
  const reportFile = artifactPath(payload.reportArtifactRef);
  if (!fs.existsSync(reportFile) || fileDigest(reportFile) !== payload.reportSha256) fail("REPORT_SHA_CHANGED");
  const report = creatorSynthesisSchema.parse(JSON.parse(fs.readFileSync(reportFile, "utf8")));
  if (report.creatorRunId !== source.creatorRunId || !isDeepStrictEqual(report, payload.report)) fail("REPORT_PAYLOAD_MISMATCH");
  for (const key of sourceKeys) {
    if ((report.inputs[key] ?? null) !== (source[key] ?? null)) fail(`REPORT_SOURCE_CHANGED_${key}`);
  }
  if (payload.outcome?.synthesisArtifactRef !== payload.reportArtifactRef) fail("OUTCOME_REPORT_MISMATCH");
  return { candidate, report, reportArtifactRef: payload.reportArtifactRef, reportSha256: payload.reportSha256 };
}

/** Pin a deliberately selected candidate. Old methods may differ; its five input file identities may not. */
export async function pinVerifiedCreatorReuseCandidate(store: PayloadStore, pinned: PinnedResearchInput): Promise<PinnedResearchInput> {
  const verified = await inspect(store, pinned);
  const existing = pinned.files.find((file) => file.ref === verified.reportArtifactRef);
  if (existing && existing.sha256 !== verified.reportSha256) fail("REPORT_PIN_CONFLICT");
  return { ...pinned,
    files: existing ? pinned.files : [...pinned.files, { ref: verified.reportArtifactRef, sha256: verified.reportSha256 }],
    reuseCandidate: { artifactRef: verified.reportArtifactRef, sha256: verified.reportSha256,
      candidate: { id: verified.candidate.id, revision: verified.candidate.revision, sha256: verified.candidate.sha256 } } };
}

/** Create a new candidate asset without asking the model to rewrite the accepted Builder report. */
export async function materializeCreatorReuseCandidate(store: PayloadStore, artifacts: CreatorArtifactStore,
  pinned: PinnedResearchInput, directory: string): Promise<{
    report: CreatorSynthesis; reportArtifactRef: string; reportSha256: string; relativeRoot: string;
    reusedFrom: { candidate: ReuseIdentity; reportArtifactRef: string; reportSha256: string };
  }> {
  const verified = await inspect(store, pinned);
  const reuse = pinned.reuseCandidate;
  if (!reuse?.candidate || reuse.candidate.id !== verified.candidate.id
    || reuse.candidate.revision !== verified.candidate.revision || reuse.candidate.sha256 !== verified.candidate.sha256
    || reuse.artifactRef !== verified.reportArtifactRef || reuse.sha256 !== verified.reportSha256) fail("PIN_CHANGED");
  const source = pinned.source as CreatorSynthesisWorkflowStartInput;
  const actualRelativeRoot = path.relative(runArtifactDir(source.creatorRunId), directory).split(path.sep).join("/");
  if (!actualRelativeRoot.startsWith("workflow-responses/") || actualRelativeRoot.includes("..")) fail("OUTPUT_DIRECTORY_INVALID");
  fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(artifactPath(verified.reportArtifactRef), path.join(directory, "creator-analysis.json"));
  const reportArtifactRef = await artifacts.write(source.creatorRunId, `${actualRelativeRoot}/creator-analysis.json`, verified.report,
    [verified.reportArtifactRef, ...sourceRefs(source)]);
  const reportSha256 = fileDigest(artifactPath(reportArtifactRef));
  const copy = creatorSynthesisSchema.parse(await artifacts.read(reportArtifactRef));
  if (!isDeepStrictEqual(copy, verified.report)) fail("NEW_REPORT_CHANGED");
  const reusedFrom = { candidate: verified.candidate,
    reportArtifactRef: verified.reportArtifactRef, reportSha256: verified.reportSha256 };
  fs.writeFileSync(path.join(directory, "reuse-lineage.json"), `${JSON.stringify(reusedFrom, null, 2)}\n`, "utf8");
  return { report: verified.report, reportArtifactRef, reportSha256, relativeRoot: actualRelativeRoot, reusedFrom };
}
