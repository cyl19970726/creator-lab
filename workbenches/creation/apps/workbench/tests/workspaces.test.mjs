import http from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createWorkspaceStore } from "../src/workspace-store.mjs";
import { createCollaborationStore } from "../src/collaboration-store.mjs";
import { createServer } from "../server.mjs";
import { renderArtifact } from "../src/render.mjs";
const sha = (p) =>
  crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
function fixture() {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "token-workspaces-")),
  );
  const file = (id, name, text, topicId) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, text);
    return {
      id: id.repeat(24),
      name,
      ext: path.extname(name).slice(1),
      path: p,
      displayPath: name,
      topicId,
      revisionId: "r1",
      size: fs.statSync(p).size,
      coreStep: "report",
    };
  };
  const a = file(
    "a",
    "report.md",
    "# Account A\n![figure](figure.svg)\n[foreign](other.md)\n",
    "original",
  );
  const image = file(
    "c",
    "figure.svg",
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
    "original",
  );
  const b = file("b", "other.md", "private account B", "other");
  const media = file("d", "video.mp4", "0123456789", "original");
  const makeTopic = (id, assets) => ({
    id,
    title: id,
    artifacts: assets,
    reviews: [],
    metrics: [],
    currentReport: "r1",
    currentVideo: "r1",
    collaboration: {
      proxyAuthorization: { enabled: true, source: "historical permission" },
    },
    revisions: [
      {
        id: "r1",
        kind: "report",
        coreIds: { report: assets[0].id },
        artifactIds: assets.map((a) => a.id),
        decision: { label: "source accepted" },
      },
    ],
  });
  const c = {
    generatedAt: "now",
    index: { stale: false },
    topics: [makeTopic("original", [a, image, media]), makeTopic("other", [b])],
    docs: [],
    all: new Map([a, b, image, media].map((f) => [f.id, f])),
    aliases: { ["1".repeat(24)]: a.id },
    publication: { items: [{ topic_id: "original", status: "published" }] },
  };
  let config = {
    schemaVersion: 1,
    workspaces: [
      {
        id: "history-unassigned",
        name: "History",
        kind: "unassigned",
        topicIds: ["original"],
      },
      {
        id: "account-a",
        name: "Account A",
        kind: "account",
        account: {
          platform: "xiaohongshu",
          accountId: "a",
          verification: "pending",
        },
        topicIds: [],
        inventory: [],
      },
      {
        id: "account-b",
        name: "Account B",
        kind: "account",
        account: {
          platform: "douyin",
          accountId: "b",
          verification: "pending",
        },
        topicIds: ["other"],
      },
    ],
  };
  const allowedPath = (p) => {
    try {
      const real = fs.realpathSync(p);
      return real.startsWith(dir + path.sep) ? real : null;
    } catch {
      return null;
    }
  };
  const build = () =>
    createWorkspaceStore({
      catalog: () => c,
      manifest: () => config,
      filename: path.join(dir, "workspaces.sqlite"),
      storageDir: path.join(dir, "snapshots"),
      allowedPath,
    });
  let work = build();
  const store = createCollaborationStore({
    filename: path.join(dir, "events.sqlite"),
    catalog: (id) => work.catalog(id),
    scopeRequired: true,
    allowedPath,
  });
  return {
    dir,
    a,
    b,
    image,
    media,
    c,
    store,
    allowedPath,
    get work() {
      return work;
    },
    get config() {
      return config;
    },
    set config(v) {
      config = v;
    },
    restart() {
      work.close();
      work = build();
    },
    close() {
      store.close();
      work.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
const importInput = (f) => ({
  clientOperationId: crypto.randomUUID(),
  sourceWorkspaceId: "history-unassigned",
  sourceAssetId: f.a.id,
  sourceHash: sha(f.a.path),
  targetTitle: "My new explanation",
  companions: [{ assetId: f.image.id, hash: sha(f.image.path) }],
});
const opinion = (a, hash) => ({
  clientOperationId: crypto.randomUUID(),
  type: "feedback",
  actor: "user",
  assetId: a.id,
  expectedHash: hash,
  location: { kind: "file" },
  scope: { kind: "whole", label: "whole" },
  text: "Needs a clear example",
});
test("scope projects catalogs, aliases and links; malformed/stale ownership fails closed", () => {
  const f = fixture();
  try {
    const a = f.work.catalog("account-a"),
      h = f.work.catalog("history-unassigned");
    assert.equal(a.all.size, 0);
    assert.equal(a.topics.length, 0);
    assert.deepEqual(a.publication.items, []);
    assert.equal(h.all.get(f.a.id).id, f.a.id);
    assert.equal(h.aliases["1".repeat(24)], f.a.id);
    assert.throws(
      () => f.work.resolveAsset("account-a", f.a.id),
      (e) => e.code === "UNKNOWN_ASSET",
    );
    assert.throws(
      () => f.work.resolveAsset("account-b", "1".repeat(24)),
      (e) => e.code === "UNKNOWN_ASSET",
    );
    const rendered = renderArtifact(
      f.a,
      h,
      "/api/workspaces/history-unassigned",
    );
    assert.ok(
      rendered.html.includes(
        `/api/workspaces/history-unassigned/asset/${f.image.id}`,
      ),
    );
    assert.ok(rendered.html.includes('data-unavailable="true"'));
    f.config.workspaces[0].topicIds = [];
    f.config.workspaces[1].topicIds = ["original"];
    assert.throws(
      () => f.work.catalog("account-a"),
      (e) => e.code === "OWNERSHIP_CHANGE",
    );
    f.config.workspaces[0].topicIds = ["original"];
    f.config.workspaces[1].topicIds = [];
    f.c.index.stale = true;
    assert.throws(
      () => f.work.catalog("account-a"),
      (e) => e.code === "STALE_CATALOG",
    );
    f.config.schemaVersion = 99;
    assert.throws(
      () => f.work.summaries(),
      (e) => e.code === "WORKSPACE_CONFIG",
    );
  } finally {
    f.close();
  }
});
test("explicit import freezes source and companions, keeps original identities and does not inherit decisions", () => {
  const f = fixture();
  try {
    const originalOpinion = f.store.append(
      "original",
      opinion(f.a, sha(f.a.path)),
      "history-unassigned",
    ).event;
    const before = JSON.stringify(originalOpinion),
      oldId = f.a.id;
    const payload = importInput(f),
      r = f.work.importAsset("account-a", payload);
    assert.equal(r.replayed, false);
    assert.equal(f.work.importAsset("account-a", payload).replayed, true);
    assert.equal(f.work.inventory("account-a").imports.length, 1);
    const c = f.work.catalog("account-a"),
      t = c.topics[0],
      a = t.artifacts[0];
    assert.notEqual(a.id, oldId);
    assert.equal(a.provenance.sourceAssetId, oldId);
    assert.equal(sha(a.path), payload.sourceHash);
    assert.deepEqual(t.reviews, []);
    assert.equal(t.revisions[0].decision, undefined);
    assert.deepEqual(c.publication.items, []);
    const state = f.store.read(t.id, a.id, "account-a");
    assert.equal(state.events.length, 0);
    assert.equal(state.authorization.proxyMayAdvance, false);
    assert.equal(
      f.work.workspace("account-a").positioning.readers.status,
      "unknown",
    );
    assert.ok(
      renderArtifact(a, c, "/api/workspaces/account-a").html.includes(
        `/api/workspaces/account-a/asset/${t.artifacts[1].id}`,
      ),
    );
    fs.writeFileSync(f.a.path, "new source version");
    assert.equal(
      fs.readFileSync(a.path, "utf8").startsWith("# Account A"),
      true,
    );
    assert.equal(
      JSON.stringify(
        f.store.read("original", undefined, "history-unassigned").events[0],
      ),
      before,
    );
    assert.equal(f.a.id, oldId);
    f.restart();
    assert.equal(f.work.catalog("account-a").topics[0].artifacts[0].id, a.id);
    assert.equal(
      f.work.importAsset("account-a", payload).replayed,
      true,
      "retry returns original frozen operation after source update",
    );
    fs.writeFileSync(a.path, "tampered copy");
    assert.throws(
      () => f.work.resolveAsset("account-a", a.id),
      (e) => e.code === "SNAPSHOT_CHANGED",
    );
    assert.throws(
      () => f.store.append(t.id, opinion(a, sha(a.path)), "account-a"),
      (e) => e.code === "SNAPSHOT_CHANGED",
    );
  } finally {
    f.close();
  }
});
test("frozen report attachments keep their own import batch and target purpose is not copied from source", () => {
  const f = fixture();
  try {
    f.image.coreStep = "package";
    f.config.workspaces[1].positioning = {
      purpose: {
        value: "Help this account's beginners",
        status: "confirmed",
        sources: [{ label: "Target user decision" }],
      },
    };
    const first = f.work.importAsset("account-a", importInput(f)).import;
    fs.writeFileSync(
      f.image.path,
      '<svg xmlns="http://www.w3.org/2000/svg"><title>Changed figure</title></svg>',
    );
    const second = f.work.importAsset("account-a", importInput(f)).import;
    const c = f.work.catalog("account-a");
    const t = c.topics.find((t) => t.id === first.targetTopicId);
    assert.equal(t.collaboration.longTermGoal, "Help this account's beginners");
    assert.equal(t.artifacts[1].coreStep, "package");
    assert.equal(t.revisions[0].coreIds.package, first.assets[1].id);
    const rendered = renderArtifact(
      t.artifacts[0],
      c,
      "/api/workspaces/account-a",
    );
    assert.ok(rendered.html.includes(first.assets[1].id));
    assert.ok(
      !rendered.html.includes(second.assets[1].id),
      "a later import of the same source path cannot silently replace the old figure",
    );
    assert.equal(c.topics[0].revisions[0].decision, undefined);
  } finally {
    f.close();
  }
});

test("imports reject stale hashes, foreign targets, unsafe paths and implicit companions", () => {
  const f = fixture();
  try {
    assert.throws(
      () =>
        f.work.importAsset("account-a", {
          ...importInput(f),
          sourceHash: "0".repeat(64),
        }),
      (e) => e.code === "STALE_VERSION",
    );
    assert.throws(
      () =>
        f.work.importAsset("account-a", {
          ...importInput(f),
          targetTopicId: "original",
        }),
      (e) => e.code === "UNKNOWN_TOPIC",
    );
    assert.throws(
      () =>
        f.work.importAsset("account-a", {
          ...importInput(f),
          path: "/etc/hosts",
        }),
      (e) => e.code === "INVALID_FIELD",
    );
    assert.throws(
      () =>
        f.work.importAsset("account-a", {
          ...importInput(f),
          companions: [{ assetId: f.b.id, hash: sha(f.b.path) }],
        }),
      (e) => e.code === "UNKNOWN_ASSET",
    );
    fs.unlinkSync(f.a.path);
    fs.symlinkSync("/etc/hosts", f.a.path);
    assert.throws(
      () => f.work.importAsset("account-a", importInput(f)),
      (e) => e.code === "UNKNOWN_ASSET",
    );
    assert.equal(f.work.inventory("account-a").imports.length, 0);
  } finally {
    f.close();
  }
});
test("collaboration checks scope before replay and history, preserves same-account review", () => {
  const f = fixture();
  try {
    const p = opinion(f.a, sha(f.a.path)),
      event = f.store.append("original", p, "history-unassigned").event;
    assert.throws(
      () => f.store.append("original", p, "account-a"),
      (e) => e.code === "UNKNOWN_TOPIC",
    );
    assert.throws(
      () => f.store.read("original", f.a.id, "account-a"),
      (e) => e.code === "UNKNOWN_TOPIC",
    );
    assert.throws(
      () => f.store.read("original"),
      (e) => e.code === "WORKSPACE_REQUIRED",
    );
    assert.equal(
      f.store.append("original", p, "history-unassigned").event.id,
      event.id,
    );
    assert.equal(
      f.store.read("original", f.a.id, "history-unassigned").opinions.length,
      1,
    );
  } finally {
    f.close();
  }
});
test("manual candidates keep judgments and operation identity within one account across restart", () => {
  const f = fixture();
  try {
    const p = {
      clientOperationId: crypto.randomUUID(),
      title: "What can two machines run?",
      source: "manual RSS excerpt",
      url: "https://example.com/research",
      summary: "Candidate only",
      status: "consider",
      reason: "Relevant to readers",
      recommendedCarrier: "explainer",
    };
    const r = f.work.saveCandidate("account-a", p);
    assert.equal(f.work.saveCandidate("account-a", p).replayed, true);
    assert.equal(f.work.inventory("account-b").candidates.length, 0);
    assert.throws(
      () =>
        f.work.saveCandidate("account-b", {
          ...p,
          clientOperationId: crypto.randomUUID(),
          candidateId: r.candidate.id,
        }),
      (e) => e.code === "UNKNOWN_CANDIDATE",
    );
    const update = f.work.saveCandidate("account-a", {
      ...p,
      clientOperationId: crypto.randomUUID(),
      candidateId: r.candidate.id,
      status: "research",
      reason: "Evidence is now sufficient",
    });
    assert.equal(update.candidate.judgments.length, 2);
    assert.equal(
      f.work.catalog("account-a").topics.length,
      0,
      "recommendation does not launch research",
    );
    f.restart();
    assert.equal(
      f.work.inventory("account-a").candidates[0].status,
      "research",
    );
    assert.throws(
      () =>
        f.work.saveCandidate("account-a", {
          ...p,
          clientOperationId: crypto.randomUUID(),
          url: "file:///etc/hosts",
        }),
      (e) => e.code === "INVALID_URL",
    );
  } finally {
    f.close();
  }
});
test("HTTP scope is mandatory for raw IDs, aliases, Range, fingerprint, search and writes", async () => {
  const f = fixture();
  const server = createServer({
    index: { read: () => f.c, close() {} },
    workspaces: f.work,
    collaboration: f.store,
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const list = await (await fetch(base + "/api/workspaces")).json();
    assert.equal(list.workspaces.length, 3);
    assert.equal(list.workspaces[1].inventory, undefined);
    for (const route of [
      "catalog",
      "search?q=report",
      "asset/" + f.a.id,
      "artifact/" + f.a.id,
      "collaboration/original",
    ]) {
      assert.equal((await fetch(base + "/api/" + route)).status, 400);
    }
    for (const route of [
      "asset/" + f.a.id,
      "artifact/" + f.a.id,
      "asset/" + "1".repeat(24),
      "fingerprint/" + f.a.id,
      "collaboration/original",
    ]) {
      assert.equal(
        (await fetch(base + "/api/workspaces/account-a/" + route)).status,
        404,
      );
    }
    const navigationHeaders = {
      "sec-fetch-site": "same-site",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    };
    // Undici overwrites sec-fetch-mode; use raw HTTP to reproduce a real top-level navigation.
    const navigate = (url) =>
      new Promise((resolve, reject) => {
        http
          .get(url, { headers: navigationHeaders }, (res) => {
            res.resume();
            resolve(res.statusCode);
          })
          .on("error", reject);
      });
    assert.equal(await navigate(base + "/?workspace=account-a"), 200);
    assert.equal(await navigate(base + "/api/workspaces"), 403);
    const search = await (
      await fetch(base + "/api/workspaces/account-a/search?q=report")
    ).json();
    assert.deepEqual(search.items, []);
    assert.equal(
      (
        await fetch(base + "/api/workspaces/account-a/asset/" + f.media.id, {
          method: "HEAD",
          headers: { range: "bytes=1-3" },
        })
      ).status,
      404,
    );
    // HTTP uses the real filesystem root allowlist in addition to scope, so temporary fixture media cannot stream.
    assert.equal(
      (
        await fetch(
          base + "/api/workspaces/history-unassigned/asset/" + f.media.id,
          { headers: { range: "bytes=1-3" } },
        )
      ).status,
      404,
    );
    const p = opinion(f.a, sha(f.a.path));
    assert.equal(
      (
        await fetch(
          base + "/api/workspaces/account-a/collaboration/original/events",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(p),
          },
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(base + "/api/workspaces/account-a/candidates", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: "https://evil.example",
          },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + "/api/workspaces/account-a/candidates", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "{}",
        })
      ).status,
      415,
    );
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
