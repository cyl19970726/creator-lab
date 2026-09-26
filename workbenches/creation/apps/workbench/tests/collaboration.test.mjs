import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { createCollaborationStore } from "../src/collaboration-store.mjs";
import { createWorkspaceStore } from "../src/workspace-store.mjs";
import { createServer } from "../server.mjs";

const id = (n) => String(n).repeat(24);
function fixture() {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "token-collaboration-")),
  );
  const a = {
    id: id(1),
    name: "report.md",
    ext: "md",
    path: path.join(dir, "report.md"),
    revisionId: "r1",
    coreStep: "report",
  };
  const b = {
    id: id(2),
    name: "new.md",
    ext: "md",
    path: path.join(dir, "new.md"),
    revisionId: "r2",
    coreStep: "report",
  };
  const video = {
    id: id(3),
    name: "video.mp4",
    ext: "mp4",
    path: path.join(dir, "video.mp4"),
    revisionId: "v1",
    coreStep: "final",
  };
  const other = {
    id: id(4),
    name: "other.md",
    ext: "md",
    path: path.join(dir, "other.md"),
  };
  fs.writeFileSync(a.path, "# Report\nMoE routes a subset.\n");
  fs.writeFileSync(
    b.path,
    "# Report\nAll weights reside; a subset computes.\n",
  );
  fs.writeFileSync(video.path, "real media bytes");
  fs.writeFileSync(other.path, "other topic");
  const topic = {
    id: "topic",
    direction: "Explain model + software + hardware",
    currentReport: "r1",
    currentVideo: "v1",
    artifacts: [a, b, video],
    collaboration: {
      goal: "Readers understand",
      proxyAuthorization: {
        enabled: true,
        source: "User explicitly delegated review in this task",
      },
    },
  };
  const c = {
    topics: [topic, { id: "other", artifacts: [other] }],
    docs: [],
    all: new Map([a, b, video, other].map((a) => [a.id, a])),
    aliases: {},
  };
  const filename = path.join(dir, "durable/events.sqlite");
  const create = () =>
    createCollaborationStore({
      filename,
      catalog: () => c,
      allowedPath: (p) => {
        try {
          const real = fs.realpathSync(p);
          return real.startsWith(dir + path.sep) ? real : null;
        } catch {
          return null;
        }
      },
    });
  let store = create();
  return {
    dir,
    a,
    b,
    video,
    other,
    c,
    topic,
    get store() {
      return store;
    },
    restart() {
      store.close();
      store = create();
    },
    close() {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
function payload(f, overrides = {}) {
  return {
    clientOperationId: crypto.randomUUID(),
    type: "feedback",
    actor: "proxy",
    assetId: f.a.id,
    expectedHash: f.store
      .read("topic", f.a.id)
      .assets.find((a) => a.id === f.a.id).hash,
    location: { kind: "quote", quote: "MoE routes a subset." },
    text: "Explain what stays resident",
    scope: { kind: "partial", label: "MoE residency explanation" },
    stepId: "A3",
    ...overrides,
  };
}

test("operation retries return original result while separate opinions survive restart", () => {
  const f = fixture();
  try {
    const p = payload(f),
      first = f.store.append("topic", p);
    fs.appendFileSync(f.a.path, "Changed after the accepted write.\n");
    const retry = f.store.append("topic", p);
    assert.deepEqual(
      retry,
      { event: first.event, replayed: true },
      "lost response retries remain idempotent even after content changes",
    );
    assert.throws(
      () => f.store.append("topic", { ...p, text: "different" }),
      (e) => e.code === "OPERATION_CONFLICT",
    );
    f.store.append(
      "topic",
      payload(f, {
        text: "Another separate opinion",
        location: { kind: "file" },
      }),
    );
    f.restart();
    const restored = f.store.read("topic");
    assert.equal(restored.opinions.length, 2);
    assert.equal(restored.opinions[0].stale, true);
    assert.equal(restored.versions[0].text, "# Report\nMoE routes a subset.\n");
  } finally {
    f.close();
  }
});

test("exact version scoped proxy acceptance can proceed without impersonating user", () => {
  const f = fixture();
  try {
    const accept = payload(f, {
      type: "decision",
      verdict: "accept",
      advance: true,
      text: "Accept this explanation only",
    });
    f.store.append("topic", accept);
    let d = f.store.read("topic").decisions[0];
    assert.equal(d.canProceed, true);
    assert.equal(d.userConfirmed, false);
    assert.equal(d.scope.kind, "partial");
    assert.match(d.authorizationSource, /delegated/);
    fs.appendFileSync(f.a.path, "new meaning\n");
    assert.throws(
      () =>
        f.store.append("topic", {
          ...accept,
          clientOperationId: crypto.randomUUID(),
        }),
      (e) => e.code === "STALE_VERSION",
    );
    d = f.store.read("topic").decisions[0];
    assert.equal(d.canProceed, false);
    assert.equal(d.stale, true);
    f.topic.collaboration.proxyAuthorization.enabled = false;
    assert.throws(
      () =>
        f.store.append(
          "topic",
          payload(f, {
            type: "decision",
            verdict: "accept",
            advance: true,
            location: { kind: "file" },
          }),
        ),
      (e) => e.code === "NO_ADVANCE_AUTHORITY",
    );
    assert.throws(
      () =>
        f.store.append(
          "topic",
          payload(f, {
            type: "decision",
            actor: "technical",
            verdict: "accept",
            advance: true,
            location: { kind: "file" },
          }),
        ),
      (e) => e.code === "NO_ADVANCE_AUTHORITY",
    );
  } finally {
    f.close();
  }
});

test("revision registers true parent, feedback treatment, text comparison and downstream recheck", () => {
  const f = fixture();
  try {
    const p = payload(f),
      opinion = f.store.append("topic", p).event;
    const videoHash = f.store
      .read("topic", f.video.id)
      .assets.find((a) => a.id === f.video.id).hash;
    f.store.append(
      "topic",
      payload(f, {
        type: "decision",
        assetId: f.video.id,
        expectedHash: videoHash,
        location: { kind: "file" },
        scope: { kind: "whole", label: "Video" },
        verdict: "accept",
        advance: true,
      }),
    );
    f.store.append("topic", {
      ...p,
      clientOperationId: crypto.randomUUID(),
      type: "response",
      feedbackId: opinion.id,
      status: "open",
      actor: "agent",
      text: "I will revise the explanation",
    });
    const newHash = f.store
      .read("topic", f.b.id)
      .assets.find((a) => a.id === f.b.id).hash;
    const revision = f.store.append(
      "topic",
      payload(f, {
        type: "revision",
        actor: "agent",
        assetId: f.b.id,
        expectedHash: newHash,
        location: { kind: "quote", quote: "All weights reside" },
        parent: { assetId: f.a.id, hash: p.expectedHash },
        feedbackIds: [opinion.id],
        impactAssetIds: [f.video.id],
        text: "Residency and per-token activation separated",
      }),
    );
    let state = f.store.read("topic");
    assert.equal(state.opinions[0].status, "addressed");
    assert.equal(state.opinions[0].revisionIds[0], revision.event.id);
    assert.equal(state.decisions[0].affected, true);
    assert.equal(state.decisions[0].canProceed, false);
    assert.equal(
      state.versions.find((v) => v.assetId === f.b.id).text,
      fs.readFileSync(f.b.path, "utf8"),
    );
    assert.equal(
      state.versions.find((v) => v.assetId === f.video.id).text,
      null,
      "media contents are never copied",
    );
    f.store.append("topic", {
      ...p,
      clientOperationId: crypto.randomUUID(),
      type: "response",
      actor: "proxy",
      feedbackId: opinion.id,
      status: "resolved",
      text: "New explanation now distinguishes residency",
    });
    f.restart();
    state = f.store.read("topic");
    assert.equal(state.opinions[0].status, "resolved");
    assert.equal(state.revisions[0].parent.hash, p.expectedHash);
    assert.equal(state.decisions[0].stale, true);
  } finally {
    f.close();
  }
});

test("same-file changes retain original snapshot and reject imaginary parent or quote", () => {
  const f = fixture();
  try {
    const p = payload(f),
      opinion = f.store.append("topic", p).event;
    fs.writeFileSync(f.a.path, "New explanation with real changed text");
    const revise = payload(f, {
      type: "revision",
      location: { kind: "file" },
      parent: { assetId: f.a.id, hash: p.expectedHash },
      feedbackIds: [opinion.id],
      impactAssetIds: [],
      text: "Updated same file",
    });
    f.store.append("topic", revise);
    const state = f.store.read("topic");
    assert.equal(state.versions.filter((v) => v.assetId === f.a.id).length, 2);
    assert.equal(state.opinions[0].stale, true);
    assert.throws(
      () =>
        f.store.append("topic", {
          ...revise,
          clientOperationId: crypto.randomUUID(),
          parent: { assetId: f.a.id, hash: "a".repeat(64) },
        }),
      (e) => e.code === "STALE_VERSION",
    );
    assert.throws(
      () =>
        f.store.append(
          "topic",
          payload(f, { location: { kind: "quote", quote: "not present" } }),
        ),
      (e) => e.code === "UNVERIFIED_LOCATION",
    );
    assert.throws(
      () => f.store.append("topic", payload(f, { assetId: f.other.id })),
      (e) => e.code === "UNKNOWN_ASSET",
    );
    assert.throws(
      () => f.store.append("topic", payload(f, { assetId: "/etc/hosts" })),
      (e) => e.code === "INVALID_ASSET",
    );
    assert.throws(
      () => f.store.append("topic", payload(f, { filePath: "/etc/hosts" })),
      (e) => e.code === "INVALID_FIELD",
    );
    fs.unlinkSync(f.a.path);
    fs.symlinkSync("/etc/hosts", f.a.path);
    assert.throws(
      () =>
        f.store.append("topic", {
          ...p,
          clientOperationId: crypto.randomUUID(),
        }),
      (e) => e.code === "UNKNOWN_ASSET",
    );
  } finally {
    f.close();
  }
});

test("HTTP permits only bounded same-origin collaboration writes, retains other read-only routes", async () => {
  const f = fixture();
  const server = createServer({
    index: { read: () => f.c, close() {} },
    collaboration: f.store,
    workspaces: createWorkspaceStore({
      catalog: () => f.c,
      filename: path.join(f.dir, "workspaces.sqlite"),
      manifest: () => ({
        schemaVersion: 1,
        workspaces: [
          {
            id: "history-unassigned",
            name: "History",
            kind: "unassigned",
            topicIds: ["topic", "other"],
          },
        ],
      }),
    }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`,
    endpoint = `${base}/api/workspaces/history-unassigned/collaboration/topic/events`;
  const request = (body, headers = {}) =>
    fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  try {
    const p = payload(f);
    assert.equal((await request(p)).status, 201);
    assert.equal((await request(p)).status, 200);
    assert.equal(
      (
        await (
          await fetch(
            `${base}/api/workspaces/history-unassigned/collaboration/topic?assetId=${f.a.id}`,
          )
        ).json()
      ).opinions.length,
      1,
    );
    assert.equal(
      (await request(p, { origin: "https://evil.example" })).status,
      403,
    );
    assert.equal(
      (await request(p, { "sec-fetch-site": "cross-site" })).status,
      403,
    );
    assert.equal(
      (await request(p, { "content-type": "text/plain" })).status,
      415,
    );
    assert.equal((await request("{")).status, 400);
    assert.equal((await request(" ".repeat(65537))).status, 413);
    const chunkedStatus = await new Promise((resolve, reject) => {
      const req = http.request(
        endpoint,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: base,
            "transfer-encoding": "chunked",
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on("error", reject);
      req.write(" ".repeat(40000));
      req.end(" ".repeat(40000));
    });
    assert.equal(
      chunkedStatus,
      413,
      "chunked requests have the same size boundary",
    );
    assert.equal(
      (await request(p, { origin: base.replace("http:", "https:") })).status,
      403,
    );
    for (const route of [
      "/api/catalog",
      `/api/asset/${f.a.id}`,
      "/api/collaboration/topic",
    ])
      assert.equal((await fetch(base + route, { method: "POST" })).status, 405);
    assert.equal((await fetch(endpoint, { method: "DELETE" })).status, 405);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

test("media time anchors and user return preserve honest scope", () => {
  const f = fixture();
  try {
    const videoHash = f.store
      .read("topic", f.video.id)
      .assets.find((a) => a.id === f.video.id).hash;
    const base = payload(f, {
      assetId: f.video.id,
      expectedHash: videoHash,
      location: { kind: "time", seconds: 12.5, label: "视频 00:12" },
    });
    const opinion = f.store.append("topic", base).event;
    assert.equal(opinion.location.seconds, 12.5);
    for (const seconds of [-1, "12", null])
      assert.throws(
        () =>
          f.store.append("topic", {
            ...base,
            clientOperationId: crypto.randomUUID(),
            location: { kind: "time", seconds },
          }),
        (e) => e.code === "INVALID_LOCATION",
      );
    assert.throws(
      () =>
        f.store.append(
          "topic",
          payload(f, { location: { kind: "time", seconds: 0 } }),
        ),
      (e) => e.code === "INVALID_LOCATION",
    );
    f.store.append(
      "topic",
      payload(f, { type: "decision", verdict: "accept", advance: true }),
    );
    f.store.append(
      "topic",
      payload(f, {
        type: "decision",
        actor: "user",
        verdict: "return",
        advance: false,
        text: "This part is still unclear",
      }),
    );
    const decisions = f.store.read("topic").decisions;
    assert.equal(
      decisions[0].canProceed,
      false,
      "later user return overrides proxy acceptance of same scope",
    );
    assert.equal(
      decisions[1].userConfirmed,
      false,
      "a return is not acceptance",
    );
    f.store.append(
      "topic",
      payload(f, {
        type: "decision",
        verdict: "accept",
        advance: true,
        scope: { kind: "whole", label: "Whole report" },
      }),
    );
    f.store.append(
      "topic",
      payload(f, {
        type: "decision",
        actor: "user",
        verdict: "return",
        advance: false,
        scope: { kind: "partial", label: "Another specific figure" },
      }),
    );
    assert.equal(
      f.store.read("topic").decisions.at(-2).canProceed,
      false,
      "return of a subset invalidates a whole-asset acceptance",
    );
    const sameHash = f.store
      .read("topic", f.a.id)
      .assets.find((a) => a.id === f.a.id).hash;
    fs.copyFileSync(f.a.path, f.b.path);
    assert.throws(
      () =>
        f.store.append(
          "topic",
          payload(f, {
            type: "revision",
            assetId: f.b.id,
            expectedHash: sameHash,
            location: { kind: "file" },
            parent: { assetId: f.a.id, hash: sameHash },
            feedbackIds: [],
            impactAssetIds: [],
          }),
        ),
      (e) => e.code === "UNCHANGED_VERSION",
    );
  } finally {
    f.close();
  }
});
