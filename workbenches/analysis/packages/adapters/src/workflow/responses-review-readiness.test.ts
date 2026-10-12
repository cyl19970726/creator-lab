import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { artifactPath, artifactRef } from "../core/artifacts.js";
import { fileDigest } from "./research-inputs.js";
import { ResponsesResearchRunner } from "./responses-research-runner.js";
import { boundArtifact, ResponsesEvidenceTools } from "./responses-tools.js";

const roots: string[] = [];
const originalRuntime = process.env.SELF_MEDIA_RUNTIME_DIR;
afterEach(() => {
  if (originalRuntime === undefined) delete process.env.SELF_MEDIA_RUNTIME_DIR;
  else process.env.SELF_MEDIA_RUNTIME_DIR = originalRuntime;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("gives an exact unread candidate offset and lets the same Reviewer session finish reading", async () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "responses-review-readiness-"));
  roots.push(runtime);
  process.env.SELF_MEDIA_RUNTIME_DIR = runtime;
  const creatorRunId = randomUUID();
  const reportRef = artifactRef(creatorRunId, "creator-analysis.json");
  const reportFile = artifactPath(reportRef);
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify({ report: "x".repeat(170_000) }));
  const candidateRef = { id: randomUUID(), revision: "1", sha256: "a".repeat(64) };
  const prior = { kind: "creator" as const, evidence: candidateRef, reportArtifactRef: reportRef,
    reportSha256: fileDigest(reportFile), report: { report: "x" }, relativeRoot: "test", outcome: {} };
  const directory = path.join(runtime, "review-attempt");
  fs.mkdirSync(directory, { recursive: true });
  const tools = new ResponsesEvidenceTools([boundArtifact(reportRef)], directory);
  const read = tools.tools().find(tool => tool.name === "read_evidence")!;
  const receipt = { schemaVersion: "research-review@1", kind: "creator", candidate: candidateRef,
    candidateReportSha256: prior.reportSha256, summary: "本轮没有发现需修订的问题", findings: [] };
  const runner = new ResponsesResearchRunner({} as never, {} as never) as unknown as {
    model: (...args: unknown[]) => Promise<unknown>;
    review: (...args: unknown[]) => Promise<{ artifact: unknown }>;
  };
  const model = vi.spyOn(runner, "model").mockImplementation(async (...args: unknown[]) => {
    const instructions = args[3] as string;
    const validate = args[4] as (value: unknown) => unknown;
    const extraTools = args[5] as Array<{ name: string; execute: () => Promise<unknown> }>;
    const feedback = args[6] as (error: unknown) => string | null;
    expect(instructions).toContain("RESPONSES_REVIEW_CANDIDATE_UNREAD");
    expect(instructions).toContain("check_review_evidence_readiness");
    await read.execute({ ref: reportRef, offset: 0, length: 32768 }, new AbortController().signal);
    await read.execute({ ref: reportRef, offset: 139000, length: 32768 }, new AbortController().signal);
    const readiness = await extraTools.find(tool => tool.name === "check_review_evidence_readiness")!.execute() as {
      ready: boolean; missingText: Array<{ nextOffset: number; totalCharacters: number }> };
    expect(readiness.ready).toBe(false);
    expect(readiness.missingText[0]).toMatchObject({ nextOffset: 32768, totalCharacters: 170013 });
    let error: unknown;
    try { await validate(receipt); } catch (caught) { error = caught; }
    expect(String(error)).toContain("offset=32768");
    expect(feedback(error)).toContain("offset=32768");
    while (!tools.fullyRead(reportRef)) {
      await read.execute({ ref: reportRef, offset: tools.readProgress(reportRef).nextOffset, length: 32768 },
        new AbortController().signal);
    }
    expect(await validate(receipt)).toEqual(receipt);
    return receipt;
  });
  const request = { input: { candidate: candidateRef, retryFeedback: "RESPONSES_REVIEW_CANDIDATE_UNREAD" },
    signal: new AbortController().signal };
  const result = await runner.review(request, {}, prior, candidateRef, tools, false);
  expect(result.artifact).toEqual(receipt);
  expect(model).toHaveBeenCalledOnce();
});

it("routes unread frozen source and exact frame refs through bounded final correction", async () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "responses-post-review-readiness-"));
  roots.push(runtime);
  process.env.SELF_MEDIA_RUNTIME_DIR = runtime;
  const creatorRunId = randomUUID();
  const reportRef = artifactRef(creatorRunId, "reconstruction.json");
  const reportFile = artifactPath(reportRef);
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  const report = { builderLenses: { contentRestoration: { title: "实际报告主张" } } };
  fs.writeFileSync(reportFile, JSON.stringify(report));
  const candidateRef = { id: randomUUID(), revision: "1", sha256: "b".repeat(64) };
  const prior = { kind: "post" as const, evidence: candidateRef, reportArtifactRef: reportRef,
    reportSha256: fileDigest(reportFile), report, relativeRoot: "test", outcome: {} };
  const directory = path.join(runtime, "review-attempt");
  fs.mkdirSync(directory, { recursive: true });
  const put = (filename: string, contents: string | Buffer) => {
    const file = path.join(directory, filename);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    return file;
  };
  const tools = new ResponsesEvidenceTools([boundArtifact(reportRef)], directory);
  tools.addGenerated("post-source-input.json", put("post-source-input.json", JSON.stringify({ title: "冻结来源" })));
  tools.addGenerated("evidence/evidence-pack.json", put("evidence/evidence-pack.json", JSON.stringify({ cues: ["OPEN-0002"] })));
  tools.addGenerated("targeted-evidence/targeted-evidence.json", put("targeted-evidence/targeted-evidence.json",
    JSON.stringify({ frames: [{ id: "TARGET-0001" }] })));
  tools.addGenerated("OPEN-0002", put("evidence/OPEN-0002.jpg", Buffer.from("test image bytes")));
  tools.addGenerated("TARGET-0001", put("targeted-evidence/frames/TARGET-0001.jpg", Buffer.from("target image bytes")));
  const read = tools.tools().find(tool => tool.name === "read_evidence")!;
  const inspect = tools.tools().find(tool => tool.name === "inspect_image")!;
  const receipt = { schemaVersion: "research-review@1", kind: "post", candidate: candidateRef,
    candidateReportSha256: prior.reportSha256, summary: "来源和候选字段已核对", findings: [{ id: "F-1",
      location: "/builderLenses/contentRestoration/title", issue: "某个结论需要修订",
      evidenceRefs: ["OPEN-0002"], suggestedChange: "按该帧的实际内容修正", priority: "major", kind: "content" }] };
  const runner = new ResponsesResearchRunner({} as never, {} as never) as unknown as {
    model: (...args: unknown[]) => Promise<unknown>;
    review: (...args: unknown[]) => Promise<{ artifact: unknown }>;
  };
  const model = vi.spyOn(runner, "model").mockImplementation(async (...args: unknown[]) => {
    const instructions = args[3] as string;
    const validate = args[4] as (value: unknown) => unknown;
    const readinessTools = args[5] as Array<{ name: string; execute: () => Promise<unknown> }>;
    const feedback = args[6] as (error: unknown) => string | null;
    expect(instructions).toContain("post-source-input.json");
    expect(instructions).toContain("evidence/evidence-pack.json");
    expect(instructions).toContain("targeted-evidence/targeted-evidence.json");
    const readiness = readinessTools.find(tool => tool.name === "check_review_evidence_readiness")!;
    const first = await readiness.execute() as { ready: boolean; missingText: Array<{ ref: string; nextOffset: number }> };
    expect(first.ready).toBe(false);
    expect(first.missingText.map(item => item.ref)).toEqual(expect.arrayContaining([
      reportRef, "post-source-input.json", "evidence/evidence-pack.json", "targeted-evidence/targeted-evidence.json",
    ]));
    let error: unknown;
    try { validate(receipt); } catch (caught) { error = caught; }
    expect(String(error)).toContain("RESPONSES_REVIEW_CANDIDATE_UNREAD");
    expect(feedback(error)).toContain("post-source-input.json read_evidence offset=0");

    for (const ref of [reportRef, "post-source-input.json", "evidence/evidence-pack.json", "targeted-evidence/targeted-evidence.json"]) {
      while (!tools.fullyRead(ref)) await read.execute({ ref, offset: tools.readProgress(ref).nextOffset, length: 32768 }, new AbortController().signal);
    }
    await inspect.execute({ ref: "TARGET-0001" }, new AbortController().signal);
    error = undefined;
    try { validate(receipt); } catch (caught) { error = caught; }
    expect(String(error)).toContain("finding=F-1");
    expect(String(error)).toContain("ref=OPEN-0002");
    expect(feedback(error)).toContain("inspect_image");
    await inspect.execute({ ref: "OPEN-0002" }, new AbortController().signal);
    expect(await validate(receipt)).toEqual(receipt);
    return receipt;
  });
  const result = await runner.review({ input: { candidate: candidateRef }, signal: new AbortController().signal } as never,
    {} as never, prior as never, candidateRef, tools, true);
  expect(result.artifact).toEqual(receipt);
  expect(model).toHaveBeenCalledOnce();
});

it("rejects unbound evidence refs and locations that do not point into the candidate", async () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "responses-post-review-invalid-refs-"));
  roots.push(runtime);
  process.env.SELF_MEDIA_RUNTIME_DIR = runtime;
  const creatorRunId = randomUUID();
  const reportRef = artifactRef(creatorRunId, "reconstruction.json");
  const reportFile = artifactPath(reportRef);
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  const report = { builderLenses: { contentRestoration: { title: "候选主张" } } };
  fs.writeFileSync(reportFile, JSON.stringify(report));
  const candidateRef = { id: randomUUID(), revision: "1", sha256: "c".repeat(64) };
  const prior = { kind: "post" as const, evidence: candidateRef, reportArtifactRef: reportRef,
    reportSha256: fileDigest(reportFile), report, relativeRoot: "test", outcome: {} };
  const directory = path.join(runtime, "review-attempt");
  fs.mkdirSync(directory, { recursive: true });
  const put = (name: string, value: unknown) => {
    const file = path.join(directory, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
    return file;
  };
  const tools = new ResponsesEvidenceTools([boundArtifact(reportRef)], directory);
  const generatedTextRefs: Array<[string, string, unknown]> = [
    ["post-source-input.json", "post-source-input.json", { title: "source" }],
    ["evidence/evidence-pack.json", "evidence/evidence-pack.json", { cues: [] }],
    ["targeted-evidence/targeted-evidence.json", "targeted-evidence/targeted-evidence.json", { frames: [] }],
  ];
  for (const [ref, filename, value] of generatedTextRefs) tools.addGenerated(ref, put(filename, value));
  const image = path.join(directory, "OPEN-0002.jpg");
  fs.writeFileSync(image, "image bytes");
  tools.addGenerated("OPEN-0002", image);
  const read = tools.tools().find(tool => tool.name === "read_evidence")!;
  const inspect = tools.tools().find(tool => tool.name === "inspect_image")!;
  for (const ref of [reportRef, "post-source-input.json", "evidence/evidence-pack.json", "targeted-evidence/targeted-evidence.json"]) {
    await read.execute({ ref }, new AbortController().signal);
  }
  await inspect.execute({ ref: "OPEN-0002" }, new AbortController().signal);
  const runner = new ResponsesResearchRunner({} as never, {} as never) as unknown as {
    model: (...args: unknown[]) => Promise<unknown>;
    review: (...args: unknown[]) => Promise<unknown>;
  };
  vi.spyOn(runner, "model").mockImplementation(async (...args: unknown[]) => {
    const validate = args[4] as (value: unknown) => unknown;
    const feedback = args[6] as (error: unknown) => string | null;
    const unbound = { schemaVersion: "research-review@1", kind: "post", candidate: candidateRef,
      candidateReportSha256: prior.reportSha256, summary: "存在真实问题", findings: [{ id: "F-2",
        location: "/builderLenses/contentRestoration/title", issue: "操作细节缺少证据", evidenceRefs: ["source-video.mp4"],
        suggestedChange: "检查具体帧", priority: "major", kind: "content" }] };
    let error: unknown;
    try { validate(unbound); } catch (caught) { error = caught; }
    expect(String(error)).toContain("ref=source-video.mp4");
    expect(String(error)).toContain("not bound");
    expect(feedback(error)).toContain("do not delete a real finding");
    const badPointer = { ...unbound, findings: [{ ...unbound.findings[0]!, location: "/builderLenses/noSuchField", evidenceRefs: ["OPEN-0002"] }] };
    error = undefined;
    try { validate(badPointer); } catch (caught) { error = caught; }
    expect(String(error)).toContain("location=/builderLenses/noSuchField");
    expect(feedback(error)).toContain("exact refs listed in Bound evidence refs");
    const corrected = { schemaVersion: "research-review@1", kind: "post", candidate: candidateRef,
      candidateReportSha256: prior.reportSha256, summary: "保留有证据支撑的问题", findings: [{ ...unbound.findings[0]!,
        location: "/builderLenses/contentRestoration/title", evidenceRefs: ["OPEN-0002"] }] };
    expect(await validate(corrected)).toEqual(corrected);
    return corrected;
  });
  await runner.review({ input: { candidate: candidateRef }, signal: new AbortController().signal } as never,
    {} as never, prior as never, candidateRef, tools, true);
});
