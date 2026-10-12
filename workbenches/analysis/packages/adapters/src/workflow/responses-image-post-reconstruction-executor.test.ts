import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { AgentRunRequest } from "@signal-room/workflow";
import { artifactRef } from "../core/artifacts.js";
import { ResponsesImagePostReconstructionExecutor } from "./responses-image-post-reconstruction-executor.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/0XcAAAAASUVORK5CYII=", "base64");

it("reads every page as image pixels and writes only a source-bound image candidate", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "responses-image-post-")); roots.push(root);
  const previous = process.env.SELF_MEDIA_RUNTIME_DIR; process.env.SELF_MEDIA_RUNTIME_DIR = root;
  try {
    const creatorRunId = crypto.randomUUID();
    const runDir = path.join(root, "runs", creatorRunId); fs.mkdirSync(runDir, { recursive: true });
    const refs = ["detail.json", "page1.png", "page2.png"].map(name => artifactRef(creatorRunId, name));
    fs.writeFileSync(path.join(runDir, "detail.json"), JSON.stringify({ posts: [{ externalId: "p1", title: "真实标题" }] }));
    fs.writeFileSync(path.join(runDir, "page1.png"), png); fs.writeFileSync(path.join(runDir, "page2.png"), png);
    const writes: Array<{ name: string; value: unknown }> = [];
    const artifacts = { write: async (_run: string, name: string, value: unknown) => {
      writes.push({ name, value }); return artifactRef(creatorRunId, name);
    } };
    const calls: string[] = [];
    const executor = new ResponsesImagePostReconstructionExecutor(artifacts as never, {
      auth: { accessToken: async () => "fake" }, createModelRunner: options => ({ run: async () => {
        const tools = await options.tools!({} as never);
        await tools.find(tool => tool.name === "read_evidence")!.execute({ ref: refs[0]! }, new AbortController().signal);
        for (const ref of refs.slice(1)) {
          const result = await tools.find(tool => tool.name === "inspect_image")!.execute({ ref }, new AbortController().signal);
          expect(result).toMatchObject({ kind: "siwc_visual_tool_result", images: [{ base64: png.toString("base64") }] });
          calls.push(ref);
        }
        return { output: { schemaVersion: "image-post-reconstruction@1", creatorRunId, postExternalId: "p1",
          sourceUrl: "https://example.com/p1", generatedAt: new Date().toISOString(),
          inputs: { detailArtifactRef: refs[0], imageArtifactRefs: refs.slice(1) },
          contentRestoration: { summary: "内容", hook: "标题", architecture: ["开头", "方法"], knowledgeUnits: ["步骤"],
            proofModes: ["截图"], intendedAudienceAction: "复核" },
          visualSystem: { carouselLogic: "先后两页", consistency: "一致", pages: refs.slice(1).map(ref => ({
            imageArtifactRef: ref, role: "解释", readableText: [], composition: "单图", contribution: "说明" })) },
          claims: [{ statement: "作者声称有方法", factClass: "author_claim", confidence: "medium",
            evidenceRefs: [refs[1]], caveat: "未经外部核验" }], readableArticle: "连续可读内容", unknowns: ["外部效果未知"] } } as never;
      } })
    });
    const result = await executor.reconstruct({ runId: crypto.randomUUID(), creatorRunId, postExternalId: "p1",
      sourceUrl: "https://example.com/p1", detailArtifactRef: refs[0]!, imageArtifactRefs: refs.slice(1) });
    expect(result.state).toBe("built_unevaluated");
    expect(calls).toEqual(refs.slice(1));
    expect(writes.map(item => item.name)).toEqual([
      expect.stringMatching(/^image-post-responses\/p1\/.+\/trace\.json$/),
      "image-post-reconstruction-p1.json", "image-post-builder-validation-p1.json"]);
    expect(writes[0]?.value).toMatchObject({ schemaVersion: "image-post-responses-trace@1",
      events: [{ type: "responses.method" }] });
    const candidate = writes[1]?.value;
    const noPixels = new ResponsesImagePostReconstructionExecutor(artifacts as never, {
      auth: { accessToken: async () => "fake" }, createModelRunner: () => ({ run: async <Input, Output>(request: AgentRunRequest<Input>) => {
        void request;
        return { output: candidate as Output };
      } })
    });
    expect((await noPixels.reconstruct({ runId: crypto.randomUUID(), creatorRunId, postExternalId: "p1",
      sourceUrl: "https://example.com/p1", detailArtifactRef: refs[0]!, imageArtifactRefs: refs.slice(1) })).state).toBe("not_ready");
    const forged = new ResponsesImagePostReconstructionExecutor(artifacts as never, {
      auth: { accessToken: async () => "fake" }, createModelRunner: options => ({ run: async <Input, Output>(request: AgentRunRequest<Input>) => {
        void request;
        const tools = await options.tools!({} as never);
        await tools.find(tool => tool.name === "read_evidence")!.execute({ ref: refs[0]! }, new AbortController().signal);
        for (const ref of refs.slice(1)) await tools.find(tool => tool.name === "inspect_image")!.execute({ ref }, new AbortController().signal);
        return { output: { ...(candidate as object), claims: [{ statement: "伪造引证", factClass: "observed",
          confidence: "high", evidenceRefs: ["/artifacts/forged/no.png"], caveat: null }] } as Output };
      } })
    });
    expect((await forged.reconstruct({ runId: crypto.randomUUID(), creatorRunId, postExternalId: "p1",
      sourceUrl: "https://example.com/p1", detailArtifactRef: refs[0]!, imageArtifactRefs: refs.slice(1) })).state).toBe("not_ready");
  } finally { if (previous === undefined) delete process.env.SELF_MEDIA_RUNTIME_DIR; else process.env.SELF_MEDIA_RUNTIME_DIR = previous; }
});
