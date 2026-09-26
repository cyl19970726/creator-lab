import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));
const state = fs.mkdtempSync(path.join(os.tmpdir(), "creation-empty-"));
process.env.CREATION_CONTENT_ROOT = packageRoot;
process.env.CREATION_STATE_ROOT = state;
process.env.CREATION_MEDIA_ROOT = path.join(state, "absent-media");
delete process.env.TOKEN_INDEX_PATH;
delete process.env.TOKEN_COLLABORATION_PATH;
const { createServer } = await import("../server.mjs");

test("empty creation starts without historical repo, media, channels or research service", async () => {
  const server = createServer();
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (route) => {
      const response = await fetch(base + route);
      assert.equal(response.status, 200, `${route}: ${await response.clone().text()}`);
      return response;
    };
    assert.match(await (await get("/")).text(), /创作工作台/);
    const spaces = await (await get("/api/workspaces")).json();
    assert.ok(spaces.workspaces.some(w => w.id === "creation"));
    const catalog = await (await get("/api/workspaces/creation/catalog")).json();
    assert.deepEqual(catalog.topics, []);
    const inventory = await (await get("/api/workspaces/creation/inventory")).json();
    assert.deepEqual(inventory.topics, []);
    assert.deepEqual(inventory.workspace.channels, []);
    assert.equal((await fetch(base + "/api/workspaces/creation/research/runs")).status, 404);
    for (const name of ["index.sqlite", "workspaces.sqlite", "collaboration.sqlite"])
      assert.ok(fs.existsSync(path.join(state, name)), name);
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(state, { recursive: true, force: true });
  }
});
