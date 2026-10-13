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
  tools.addGenerated("targeted-evidence/ocr-evidence.json", put("targeted-evidence/ocr-evidence.json",
    JSON.stringify({ lines: "unread later OCR entries ".repeat(3_000) })));
  const openingPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/0XcAAAAASUVORK5CYII=", "base64");
  tools.addGenerated("evidence/opening-contact.jpg", put("evidence/opening-contact.png", openingPng));
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
    const comparison = (readinessTools as Array<{ name: string; execute: (args: unknown, signal: AbortSignal) => Promise<unknown> }>)
      .find(tool => tool.name === "compare_review_finding")!;
    const feedback = args[6] as (error: unknown) => string | null;
    expect(instructions).toContain("Call read_reviewer_context with {} once");
    expect(instructions).toContain("post-source-input.json");
    const context = readinessTools.find(tool => tool.name === "read_reviewer_context")!;
    expect(context).toBeDefined();
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
    await read.execute({ ref: "targeted-evidence/ocr-evidence.json", length: 32768 }, new AbortController().signal);
    expect(() => validate(receipt)).toThrow("targeted-evidence/ocr-evidence.json read_evidence offset=32768");
    const beforeBatch = await readiness.execute() as { ready: boolean; missingImages: string[] };
    expect(beforeBatch.missingImages).toContain("inspect_image evidence/opening-contact.jpg; test onset claims against the opening sequence");
    const batch = await context.execute() as { kind: string; value: {
      text: Array<{ ref: string }>; imageRefs: Array<{ ref: string }>;
      readiness: { ready: boolean; missingText: unknown[]; missingImages: string[] } } };
    expect(batch.kind).toBe("siwc_visual_tool_result");
    expect(batch.value.text.map(item => item.ref)).toEqual(expect.arrayContaining([
      reportRef, "post-source-input.json", "evidence/evidence-pack.json",
      "targeted-evidence/targeted-evidence.json", "targeted-evidence/ocr-evidence.json"]));
    expect(batch.value.imageRefs.map(item => item.ref)).toContain("evidence/opening-contact.jpg");
    expect(batch.value.readiness).toMatchObject({ ready: true, missingText: [], missingImages: [] });
    error = undefined;
    try { validate(receipt); } catch (caught) { error = caught; }
    expect(String(error)).toContain("finding=F-1");
    expect(String(error)).toContain("ref=OPEN-0002");
    expect(feedback(error)).toContain("inspect_image");
    await inspect.execute({ ref: "OPEN-0002" }, new AbortController().signal);
    await comparison.execute({ finding: receipt.findings[0] }, new AbortController().signal);
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
  const report = { builderLenses: { contentRestoration: { title: "候选主张" } },
    wideContainer: { body: "x".repeat(8_001) }, longBody: "y".repeat(9_001) };
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
    ["evidence/evidence-pack.json", "evidence/evidence-pack.json", { cues: [{ details: "冻结证据文字" }] }],
    ["targeted-evidence/targeted-evidence.json", "targeted-evidence/targeted-evidence.json", { frames: [] }],
  ];
  for (const [ref, filename, value] of generatedTextRefs) tools.addGenerated(ref, put(filename, value));
  const image = path.join(directory, "OPEN-0002.jpg");
  fs.writeFileSync(image, "image bytes");
  tools.addGenerated("OPEN-0002", image);
  const targetImage = path.join(directory, "TARGET-0001.jpg");
  fs.writeFileSync(targetImage, "target image bytes");
  tools.addGenerated("TARGET-0001", targetImage);
  const read = tools.tools().find(tool => tool.name === "read_evidence")!;
  const inspect = tools.tools().find(tool => tool.name === "inspect_image")!;
  for (const ref of [reportRef, "post-source-input.json", "evidence/evidence-pack.json", "targeted-evidence/targeted-evidence.json"]) {
    await read.execute({ ref }, new AbortController().signal);
  }
  await inspect.execute({ ref: "OPEN-0002" }, new AbortController().signal);
  await inspect.execute({ ref: "TARGET-0001" }, new AbortController().signal);
  const runner = new ResponsesResearchRunner({} as never, {} as never) as unknown as {
    model: (...args: unknown[]) => Promise<unknown>;
    review: (...args: unknown[]) => Promise<unknown>;
  };
  vi.spyOn(runner, "model").mockImplementation(async (...args: unknown[]) => {
    const validate = args[4] as (value: unknown) => unknown;
    const comparison = (args[5] as Array<{ name: string; execute: (args: unknown, signal: AbortSignal) => Promise<unknown> }>)
      .find(tool => tool.name === "compare_review_finding")!;
    const feedback = args[6] as (error: unknown) => string | null;
    const unbound = { schemaVersion: "research-review@1", kind: "post", candidate: candidateRef,
      candidateReportSha256: prior.reportSha256, summary: "存在真实问题", findings: [{ id: "F-2",
        location: "/builderLenses/contentRestoration/title", issue: "操作细节缺少证据", evidenceRefs: ["source-video.mp4"],
        suggestedChange: "检查具体帧", priority: "major", kind: "content" }] };
    let error: unknown;
    try { validate(unbound); } catch (caught) { error = caught; }
    expect(String(error)).toContain("ref=source-video.mp4");
    expect(String(error)).toContain("not bound");
    expect(feedback(error)).toContain("Never remove a finding just to bypass this technical check");
    expect(feedback(error)).toContain("withdraw a finding if the issue cannot be verified");
    expect(feedback(error)).toContain("candidate already contains the correction");
    const badPointer = { ...unbound, findings: [{ ...unbound.findings[0]!, location: "/builderLenses/noSuchField", evidenceRefs: ["OPEN-0002"] }] };
    error = undefined;
    try { validate(badPointer); } catch (caught) { error = caught; }
    expect(String(error)).toContain("location=/builderLenses/noSuchField");
    expect(feedback(error)).toContain("exact refs listed in Bound evidence refs");
    const invalidCandidate = await comparison.execute({ finding: badPointer.findings[0] }, new AbortController().signal) as {
      comparisonRecorded: boolean; semanticVerdict: string; error: string; nextAction: string;
    };
    expect(invalidCandidate).toMatchObject({ comparisonRecorded: false, semanticVerdict: "not_evaluated",
      error: expect.stringContaining("RESPONSES_REVIEW_COMPARISON_CANDIDATE_POINTER_INVALID"),
      nextAction: expect.stringContaining("candidate.location") });
    const tooBroad = await comparison.execute({ finding: { ...badPointer.findings[0]!, location: "/wideContainer", evidenceRefs: [] } },
      new AbortController().signal) as { comparisonRecorded: boolean; error: string; nextAction: string };
    expect(tooBroad).toMatchObject({ comparisonRecorded: false,
      error: expect.stringContaining("RESPONSES_REVIEW_COMPARISON_POINTER_TOO_BROAD"),
      nextAction: expect.stringContaining("more specific JSON Pointer") });
    const longBody = await comparison.execute({ finding: { ...badPointer.findings[0]!, location: "/longBody", evidenceRefs: [] } },
      new AbortController().signal) as { candidate: { value: string } };
    expect(longBody.candidate.value).toBe("y".repeat(9_001));
    const corrected = { schemaVersion: "research-review@1", kind: "post", candidate: candidateRef,
      candidateReportSha256: prior.reportSha256, summary: "保留有证据支撑的问题", findings: [{ ...unbound.findings[0]!,
        location: "/builderLenses/contentRestoration/title",
        evidenceRefs: ["evidence/evidence-pack.json#/cues/0/details", "TARGET-0001", "OPEN-0002"] }] };
    error = undefined;
    try { validate(corrected); } catch (caught) { error = caught; }
    expect(String(error)).toContain("RESPONSES_REVIEW_COMPARISON_REQUIRED");
    expect(feedback(error)).toContain("compare_review_finding");
    const invalidEvidencePointer = await comparison.execute({ finding: { ...corrected.findings[0]!,
      evidenceRefs: ["evidence/evidence-pack.json#/cues/1/missing"] } }, new AbortController().signal) as {
      comparisonRecorded: boolean; semanticVerdict: string; error: string; nextAction: string;
    };
    expect(invalidEvidencePointer).toMatchObject({ comparisonRecorded: false, semanticVerdict: "not_evaluated",
      error: expect.stringContaining("RESPONSES_REVIEW_COMPARISON_POINTER_INVALID"),
      nextAction: expect.stringContaining("Correct the JSON Pointer") });
    const compared = await comparison.execute({ finding: corrected.findings[0] }, new AbortController().signal) as {
      kind: string; value: { semanticVerdict: string; candidate: { location: string; value: unknown };
        referencedValues: Array<{ value: unknown }>; imageIndexToRef: Array<{ index: number; ref: string }> };
      images: Array<{ base64: string }>;
    };
    expect(compared).toMatchObject({ kind: "siwc_visual_tool_result", value: {
      semanticVerdict: "not_evaluated",
      candidate: { location: "/builderLenses/contentRestoration/title", value: "候选主张" },
      referencedValues: [{ ref: "evidence/evidence-pack.json", pointer: "/cues/0/details", value: "冻结证据文字" }],
      imageIndexToRef: [{ index: 0, ref: "TARGET-0001" }, { index: 1, ref: "OPEN-0002" }],
    }, images: [{ base64: "dGFyZ2V0IGltYWdlIGJ5dGVz" }, { base64: "aW1hZ2UgYnl0ZXM=" }] });
    expect(await validate(corrected)).toEqual(corrected);
    const edited = { ...corrected, findings: [{ ...corrected.findings[0]!, issue: "修改后的问题" }] };
    expect(() => validate(edited)).toThrow("RESPONSES_REVIEW_COMPARISON_REQUIRED");
    const noFindings = { ...corrected, summary: "复核后没有需修订的问题", findings: [] };
    expect(validate(noFindings)).toEqual(noFindings);
    return corrected;
  });
  await runner.review({ input: { candidate: candidateRef }, signal: new AbortController().signal } as never,
    {} as never, prior as never, candidateRef, tools, true);
});

it("requires JSON evidence pointers to resolve in a fully read frozen JSON ref", async () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "responses-review-json-pointers-"));
  roots.push(runtime);
  process.env.SELF_MEDIA_RUNTIME_DIR = runtime;
  const creatorRunId = randomUUID();
  const reportRef = artifactRef(creatorRunId, "creator-analysis.json");
  const report = { claim: "candidate claim" };
  const reportFile = artifactPath(reportRef);
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, JSON.stringify(report));
  const candidateRef = { id: randomUUID(), revision: "1", sha256: "d".repeat(64) };
  const prior = { kind: "creator" as const, evidence: candidateRef, reportArtifactRef: reportRef,
    reportSha256: fileDigest(reportFile), report, relativeRoot: "test", outcome: {} };
  const directory = path.join(runtime, "review-attempt");
  fs.mkdirSync(directory, { recursive: true });
  const put = (name: string, contents: string | Buffer) => {
    const file = path.join(directory, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
    return file;
  };
  const jsonRef = "support.json";
  const jsonFile = put(jsonRef, JSON.stringify({ cues: [{ text: "supporting text" }], "a/b~c": "escaped key" }));
  const noteRef = "support.txt";
  const noteFile = put(noteRef, "plain note");
  const imageRef = "support-image";
  const imageFile = put("support.png", Buffer.from("image bytes"));
  const tools = new ResponsesEvidenceTools([boundArtifact(reportRef),
    { ref: jsonRef, path: jsonFile, sha256: fileDigest(jsonFile) },
    { ref: noteRef, path: noteFile, sha256: fileDigest(noteFile) },
    { ref: imageRef, path: imageFile, sha256: fileDigest(imageFile) }], directory);
  const read = tools.tools().find(tool => tool.name === "read_evidence")!;
  const inspect = tools.tools().find(tool => tool.name === "inspect_image")!;
  await read.execute({ ref: reportRef }, new AbortController().signal);
  await read.execute({ ref: jsonRef, offset: 0, length: 10 }, new AbortController().signal);
  await read.execute({ ref: noteRef }, new AbortController().signal);
  await inspect.execute({ ref: imageRef }, new AbortController().signal);

  const runner = new ResponsesResearchRunner({} as never, {} as never) as unknown as {
    model: (...args: unknown[]) => Promise<unknown>;
    review: (...args: unknown[]) => Promise<unknown>;
  };
  vi.spyOn(runner, "model").mockImplementation(async (...args: unknown[]) => {
    const validate = args[4] as (value: unknown) => unknown;
    const base = { schemaVersion: "research-review@1", kind: "creator", candidate: candidateRef,
      candidateReportSha256: prior.reportSha256, summary: "核对引用范围", findings: [{ id: "F-JSON",
        location: "/claim", issue: "结论需要核对", evidenceRefs: ["support.json#/cues/0/text"],
        suggestedChange: "按冻结材料修订", priority: "major", kind: "content" }] };
    const attempt = (evidenceRef: string) => {
      const value = { ...base, findings: [{ ...base.findings[0]!, evidenceRefs: [evidenceRef] }] };
      let error: unknown;
      try { validate(value); } catch (caught) { error = caught; }
      return String(error);
    };
    expect(attempt("support.json#/cues/0/text")).toContain("has not been fully read");
    while (!tools.fullyRead(jsonRef)) {
      await read.execute({ ref: jsonRef, offset: tools.readProgress(jsonRef).nextOffset }, new AbortController().signal);
    }
    expect(attempt("support.json#/missing")).toContain("does not resolve");
    expect(attempt("support.json#/cues/0~2text")).toContain("does not resolve");
    expect(attempt("support.txt#/anything")).toContain("require a bound JSON ref");
    expect(attempt("support-image#/anything")).toContain("require a bound JSON ref");
    expect(attempt("support.json#/a~1b~0c")).toBe("undefined");
    const valid = { ...base, findings: [{ ...base.findings[0]!, evidenceRefs: ["support.json#/a~1b~0c"] }] };
    expect(validate(valid)).toEqual(valid);
    return valid;
  });
  const result = await runner.review({ input: { candidate: candidateRef }, signal: new AbortController().signal } as never,
    {} as never, prior as never, candidateRef, tools, false);
  expect(result).toBeDefined();
});
