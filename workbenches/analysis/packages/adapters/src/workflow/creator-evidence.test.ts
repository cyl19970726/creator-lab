import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { artifactPath, artifactRef } from "../core/artifacts.js";
import { bindCreatorEvidenceViews, creatorEvidenceReadiness } from "./creator-evidence.js";
import { ResponsesEvidenceTools } from "./responses-tools.js";

const roots: string[] = [];
const previousRuntime = process.env.SELF_MEDIA_RUNTIME_DIR;
afterEach(() => {
  if (previousRuntime === undefined) delete process.env.SELF_MEDIA_RUNTIME_DIR;
  else process.env.SELF_MEDIA_RUNTIME_DIR = previousRuntime;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "creator-evidence-"));
  roots.push(runtime);
  process.env.SELF_MEDIA_RUNTIME_DIR = runtime;
  const runId = randomUUID();
  const files: Array<{ ref: string; sha256: string }> = [];
  const write = (name: string, value: unknown) => {
    const ref = artifactRef(runId, name);
    const file = artifactPath(ref);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = Buffer.from(JSON.stringify(value));
    fs.writeFileSync(file, bytes);
    files.push({ ref, sha256: createHash("sha256").update(bytes).digest("hex") });
    return ref;
  };
  const lenses = { contentRestoration: { body: "完整内容", nested: [{ x: 1, y: [1, 2] }] },
    directingLogic: { beats: ["开场", "推进"] }, visualEditing: { cuts: [{ purpose: "证明" }] } };
  const reconstructionRef = write("reconstruction.json", { builderLenses: lenses,
    technicalPack: { frames: Array.from({ length: 100 }, (_, i) => `FRAME-${i}`) } });
  const reviewRef = write("review.json", { findings: [{ id: "F-1", issue: "信息遗漏" }],
    candidateReportSha256: files[0]!.sha256 });
  const evaluationRef = write("evaluation.json", { gates: [{ id: "source", pass: false }], hugeTrace: [1, 2, 3] });
  const item = { postExternalId: "P-1", tier: "high", state: "built_unevaluated", evaluationPolicy: "skip",
    failedGateIds: [], reconstructionArtifactRef: reconstructionRef, evaluationArtifactRef: evaluationRef,
    researchReview: { reviewStatus: "completed_with_findings", candidateStatus: "original_reviewed",
      reviewArtifactRef: reviewRef, candidateReportSha256: files[0]!.sha256 } };
  const batchRef = write("batch.json", { items: [item] });
  const corpusRef = write("corpus.json", { records: [{ externalId: "P-1", title: "标题" }] });
  const directory = path.join(runtime, "runs", runId, "workflow-responses", "attempt");
  fs.mkdirSync(directory, { recursive: true });
  const tools = new ResponsesEvidenceTools([], directory);
  const bind = () => bindCreatorEvidenceViews({ tools, directory,
    pinned: { kind: "creator", source: {} as never, files, methods: [] },
    sourceRefs: [{ name: "corpus", ref: corpusRef }], batchRef, batchItems: [item] });
  return { lenses, files, reviewRef, reconstructionRef, batchRef, corpusRef, directory, tools, bind };
}

it("binds exact Builder lenses and frozen review findings while keeping original report citations", async () => {
  const fixture = setup();
  const { requiredRefs, verifySources } = fixture.bind();
  const materialRef = requiredRefs.find(ref => ref.includes("material-"))!;
  const view = JSON.parse(fs.readFileSync(path.join(fixture.directory, materialRef), "utf8"));
  expect(view.builderLenses).toEqual(fixture.lenses);
  expect(view.source.reconstructionArtifactRef).toBe(fixture.reconstructionRef);
  expect(view.source.batchArtifactRef).toBe(fixture.batchRef);
  expect(view.reviewReceipt.value.findings).toEqual([{ id: "F-1", issue: "信息遗漏" }]);
  expect(view.batchBoundary.researchReview.candidateStatus).toBe("original_reviewed");
  expect(view.evaluationBoundaries[0].fields).toEqual([{ jsonPointer: "#/gates",
    value: [{ id: "source", pass: false }] }]);
  verifySources();
  fs.appendFileSync(path.join(fixture.directory, materialRef), " ");
  expect(verifySources).toThrow("RESPONSES_CREATOR_VIEW_CHANGED");
  fs.writeFileSync(path.join(fixture.directory, materialRef), JSON.stringify(view));
  fs.appendFileSync(artifactPath(fixture.reconstructionRef), " ");
  expect(verifySources).toThrow("RESPONSES_CREATOR_SOURCE_CHANGED");
});

it("pinpoints each unread view offset and only becomes ready after all pages", async () => {
  const fixture = setup();
  const { requiredRefs } = fixture.bind();
  const state = creatorEvidenceReadiness(fixture.tools, requiredRefs);
  expect(state.ready).toBe(false);
  expect(state.missingText.map(row => row.ref)).toEqual(requiredRefs);
  const read = fixture.tools.tools().find(tool => tool.name === "read_evidence")!;
  for (const ref of requiredRefs) {
    const page = await read.execute({ ref, offset: 0, length: 32768 }, new AbortController().signal);
    expect(page).toHaveProperty("ref", ref);
  }
  expect(creatorEvidenceReadiness(fixture.tools, requiredRefs)).toEqual({ ready: true, missingText: [] });
});

it("rejects an unpinned review rather than quietly attaching a later receipt", () => {
  const fixture = setup();
  fixture.files.splice(fixture.files.findIndex(file => file.ref === fixture.reviewRef), 1);
  expect(fixture.bind).toThrow("RESPONSES_CREATOR_SOURCE_NOT_PINNED");
});

it("rejects a batch item whose current reconstruction differs from the frozen batch", () => {
  const fixture = setup();
  const batch = JSON.parse(fs.readFileSync(artifactPath(fixture.batchRef), "utf8"));
  const tools = new ResponsesEvidenceTools([], fixture.directory);
  expect(() => bindCreatorEvidenceViews({ tools, directory: fixture.directory,
    pinned: { kind: "creator", source: {} as never, files: fixture.files, methods: [] },
    sourceRefs: [{ name: "corpus", ref: fixture.corpusRef }], batchRef: fixture.batchRef,
    batchItems: [{ ...batch.items[0], reconstructionArtifactRef: "/artifacts/other/reconstruction.json" }] }))
    .toThrow("RESPONSES_CREATOR_BATCH_SOURCE_CHANGED");
});
