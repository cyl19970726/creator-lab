import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { Server } from "node:http";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createSignalRoomComposition, type SignalRoomComposition } from "./composition-root.js";

let composition: SignalRoomComposition | undefined;
let server: Server | undefined;
let directory: string | undefined;
const originalRuntime = process.env.SELF_MEDIA_RUNTIME_DIR;
const originalStorage = process.env.SELF_MEDIA_STORAGE;
const originalDatabase = process.env.SELF_MEDIA_DATABASE_URL;
const testDatabase = process.env.ANALYSIS_TEST_DATABASE_URL;
let admin: Pool | undefined;
let schema: string | undefined;
beforeEach(async () => {
  delete process.env.SELF_MEDIA_STORAGE;
  if (!testDatabase) return;
  schema = `composition_test_${randomUUID().replaceAll("-", "")}`;
  admin = new Pool({ connectionString: testDatabase });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const isolated = new URL(testDatabase);
  isolated.searchParams.set("options", `-c search_path=${schema}`);
  process.env.SELF_MEDIA_DATABASE_URL = isolated.toString();
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  await composition?.close();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  if (originalRuntime === undefined) delete process.env.SELF_MEDIA_RUNTIME_DIR;
  else process.env.SELF_MEDIA_RUNTIME_DIR = originalRuntime;
  delete process.env.SELF_MEDIA_READ_ONLY;
  if (originalStorage === undefined) delete process.env.SELF_MEDIA_STORAGE;
  else process.env.SELF_MEDIA_STORAGE = originalStorage;
  if (admin && schema) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin?.end();
  if (originalDatabase === undefined) delete process.env.SELF_MEDIA_DATABASE_URL;
  else process.env.SELF_MEDIA_DATABASE_URL = originalDatabase;
  server = undefined; composition = undefined; directory = undefined; admin = undefined; schema = undefined;
});

it.skipIf(!testDatabase)("boots a fresh analysis workspace without the removed domains and keeps creator and post workflow entry points", async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "studio-analysis-"));
  process.env.SELF_MEDIA_RUNTIME_DIR = path.join(directory, "fresh-runtime");
  composition = await createSignalRoomComposition();
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
  const missingReuseCandidate = await fetch(`${base}/api/creator-runs/${run.id}/workflows/synthesis`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ candidateMode: "reuse" })
  });
  expect(missingReuseCandidate.status).toBe(400);
  expect(await missingReuseCandidate.json()).toEqual({ error: "reuseCandidateArtifactId 必须是已登记的候选 ID" });
  const strayReuseCandidate = await fetch(`${base}/api/creator-runs/${run.id}/workflows/synthesis`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reuseCandidateArtifactId: "candidate-1" })
  });
  expect(strayReuseCandidate.status).toBe(400);
  for (const route of ["/api/comparison-projects", "/api/v1/comparisons", "/api/v1/knowledge",
    "/api/v1/research-concepts", "/api/v1/learning-loop/runs", "/api/v1/content-packages",
    "/api/v1/publications", "/api/v1/workspace-overview"]) {
    expect((await fetch(`${base}${route}`)).status, route).toBe(404);
    expect((await fetch(`${base}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status, route).toBe(404);
  }
  const runtimeFiles = fs.existsSync(process.env.SELF_MEDIA_RUNTIME_DIR) ? fs.readdirSync(process.env.SELF_MEDIA_RUNTIME_DIR) : [];
  expect(runtimeFiles.filter((file) => file.endsWith(".sqlite"))).toEqual([]);
});


it.skipIf(!testDatabase)("allows reading an explicitly reused workspace while blocking mutations", async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "analysis-readonly-"));
  process.env.SELF_MEDIA_RUNTIME_DIR = directory;
  process.env.SELF_MEDIA_READ_ONLY = "true";
  composition = await createSignalRoomComposition();
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
  expect(await composition.services.creatorResearch.list()).toEqual([]);
});

it("rejects retired storage configuration instead of silently opening a legacy database", async () => {
  process.env.SELF_MEDIA_STORAGE = "sqlite";
  await expect(createSignalRoomComposition()).rejects.toThrow("SQLite execution backend has been retired");
});
it("requires PostgreSQL configuration without falling back to a local database", async () => {
  delete process.env.SELF_MEDIA_DATABASE_URL;
  await expect(createSignalRoomComposition()).rejects.toThrow("SELF_MEDIA_DATABASE_URL is required");
});
