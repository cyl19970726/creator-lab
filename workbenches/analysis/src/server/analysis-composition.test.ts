import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import { createSignalRoomComposition, type SignalRoomComposition } from "./composition-root.js";

let composition: SignalRoomComposition | undefined;
let server: Server | undefined;
let directory: string | undefined;
const originalRuntime = process.env.SELF_MEDIA_RUNTIME_DIR;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await composition?.close();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  if (originalRuntime === undefined) delete process.env.SELF_MEDIA_RUNTIME_DIR;
  else process.env.SELF_MEDIA_RUNTIME_DIR = originalRuntime;
  delete process.env.SELF_MEDIA_READ_ONLY;
  server = undefined; composition = undefined; directory = undefined;
});

it("boots a fresh analysis workspace without the removed domains and keeps creator and post workflow entry points", async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "studio-analysis-"));
  process.env.SELF_MEDIA_RUNTIME_DIR = path.join(directory, "fresh-runtime");
  composition = createSignalRoomComposition();
  expect(Object.keys(composition.services).sort()).toEqual([
    "creatorDiscovery", "creatorResearch", "creatorResearchBatches", "evidence", "workflows"
  ]);
  server = composition.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  const base = `http://127.0.0.1:${address.port}`;

  expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ ok: true });
  const created = await fetch(`${base}/api/creator-runs`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profileUrl: "https://www.xiaohongshu.com/user/profile/example", adapter: "redfox" })
  });
  expect(created.status).toBe(202);
  const run = await created.json() as { id: string };
  expect((await fetch(`${base}/api/creator-runs/${run.id}`)).status).toBe(200);
  expect(await (await fetch(`${base}/api/creator-runs`)).json()).toMatchObject({ runs: [{ id: run.id }] });
  expect((await fetch(`${base}/api/v1/evidence`)).status).toBe(200);
  const invalidPost = await fetch(`${base}/api/creator-runs/${run.id}/workflows/post`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}"
  });
  expect(invalidPost.status).toBe(400);
  expect(await invalidPost.json()).toEqual({ error: "请指定研究样本 postExternalId" });
  for (const route of ["/api/comparison-projects", "/api/v1/comparisons", "/api/v1/knowledge",
    "/api/v1/research-concepts", "/api/v1/learning-loop/runs", "/api/v1/content-packages",
    "/api/v1/publications", "/api/v1/workspace-overview"]) {
    expect((await fetch(`${base}${route}`)).status, route).toBe(404);
    expect((await fetch(`${base}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, route).toBe(404);
  }
  expect(fs.readdirSync(process.env.SELF_MEDIA_RUNTIME_DIR).filter((file) => file.endsWith(".sqlite"))).toEqual(["self-media.sqlite"]);
});


it("allows reading an explicitly reused workspace while blocking mutations", async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "analysis-readonly-"));
  process.env.SELF_MEDIA_RUNTIME_DIR = directory;
  process.env.SELF_MEDIA_READ_ONLY = "true";
  composition = createSignalRoomComposition();
  server = composition.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server!.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  const base = `http://127.0.0.1:${address.port}`;
  expect((await fetch(`${base}/api/creator-runs`)).status).toBe(200);
  for (const route of ["/api/creator-runs", "/api/creator-runs/old/workflows/post",
    "/api/creator-runs/old/workflows/creator-analyze", "/api/workflow-runs/old/cancel"]) {
    expect((await fetch(`${base}${route}`, { method: "POST" })).status).toBe(405);
  }
  expect(composition.services.creatorResearch.list()).toEqual([]);
});
