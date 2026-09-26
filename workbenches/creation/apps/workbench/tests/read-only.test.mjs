import { test } from "node:test";
import http from "node:http";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "token-readonly-"));
process.env.TOKEN_REPO_ROOT = tmp;
process.env.TOKEN_MEDIA_ROOT = path.join(tmp, "media");
fs.mkdirSync(path.join(tmp, "research/topic"), { recursive: true });
fs.mkdirSync(path.join(tmp, "media"));
fs.mkdirSync(path.join(tmp, "docs"));
fs.mkdirSync(path.join(tmp, "data/workbench"), { recursive: true });
fs.writeFileSync(
  path.join(tmp, "data/workbench/topics.json"),
  JSON.stringify({
    schemaVersion: 1,
    topics: [
      {
        id: "topic",
        sourceTopics: ["topic"],
        currentReport: "r1",
        currentVideo: "new",
        revisions: [
          {
            id: "r1",
            kind: "report",
            sourceTopic: "topic",
            areas: ["research"],
            cores: { report: "research/topic/report.md" },
          },
          { id: "new", kind: "video", state: "not-produced", cores: {} },
        ],
      },
    ],
  }),
);
fs.writeFileSync(
  path.join(tmp, "data/workbench/workspaces.json"),
  JSON.stringify({
    schemaVersion: 1,
    workspaces: [
      {
        id: "history-unassigned",
        name: "History",
        kind: "unassigned",
        topicIds: ["topic"],
      },
    ],
  }),
);
const { safePath, reviewInfo, hash, buildCatalog } = await import(
  "../src/catalog.mjs"
);
const { renderArtifact } = await import("../src/render.mjs");
const { createServer } = await import("../server.mjs");
const report = path.join(tmp, "research/topic/report.md");
fs.writeFileSync(
  report,
  "# Report\n<script>alert(1)</script>\n![remote](https://example.com/a.png)",
);
const review = path.join(tmp, "research/topic/review-final.json");
const writeReview = (inputs) =>
  fs.writeFileSync(
    review,
    JSON.stringify({ stage: "final", verdict: "pass", inputs }),
  );
test("original verdict is preserved while changed and missing inputs invalidate version", () => {
  writeReview([{ path: "report.md", sha256: hash(report) }]);
  assert.equal(reviewInfo({ path: review }).version, "match");
  fs.appendFileSync(report, "\nchanged");
  assert.equal(reviewInfo({ path: review }).version, "stale");
  assert.equal(reviewInfo({ path: review }).decision, "pass");
  writeReview([{ path: "missing.md", sha256: "a".repeat(64) }]);
  assert.equal(reviewInfo({ path: review }).version, "missing");
  writeReview([]);
  assert.equal(reviewInfo({ path: review }).version, "unverifiable");
});
test("symlink escape rejected, raw HTML and remote images cannot execute", () => {
  fs.symlinkSync("/etc/hosts", path.join(tmp, "outside"));
  assert.equal(safePath(path.join(tmp, "outside")), null);
  const c = buildCatalog(),
    f = [...c.all.values()].find((f) => f.ext === "md");
  const r = renderArtifact(f, c);
  assert.ok(!r.html.includes("<script>"));
  assert.ok(!r.html.includes("<img"));
  assert.equal(
    c.topics[0].revisions.find((r) => r.id === "new").artifactIds.length,
    0,
  );
});
test("reader opinions are discovered with original scope and input validity", () => {
  const reader = path.join(tmp, "research/topic/reader-v1.json");
  fs.writeFileSync(
    reader,
    JSON.stringify({
      stage: "draft/recheck",
      verdict: "accepted_with_limits",
      date: "2026-09-08",
      inputs: [{ path: "report.md", sha256: hash(report) }],
      questions: [
        {
          id: "RQ1",
          question: "What changes?",
          location: "figure",
          status: "answered_pending_review",
          reader_recheck: "Understood; no technical sign-off",
        },
      ],
    }),
  );
  const c = buildCatalog();
  const rv = c.topics[0].reviews.find((r) => r.path.endsWith("reader-v1.json"));
  assert.equal(rv.mode, "simulated_reader");
  assert.equal(rv.version, "match");
  assert.equal(rv.findings[0].title, "What changes?");
  assert.equal(rv.findings[0].recheck, "Understood; no technical sign-off");
  assert.equal(rv.date, "2026-09-08");
});

test("explicit external files are readable without granting their directory or symlink targets", () => {
  const external = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "token-external-")),
  );
  const video = path.join(external, "selected.mp4");
  const other = path.join(external, "unselected.mp4");
  const manifestPath = path.join(tmp, "data/workbench/topics.json");
  const original = fs.readFileSync(manifestPath, "utf8");
  try {
    fs.writeFileSync(video, "0123456789");
    fs.writeFileSync(other, "private");
    const manifest = JSON.parse(original);
    manifest.topics[0].externalArtifacts = [video];
    manifest.topics[0].revisions[1].cores = { final: video };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const c = buildCatalog();
    const f = c.topics[0].artifacts.find((a) => a.path === video);
    assert.ok(f, "registered external asset is indexed");
    assert.equal(f.logicalUri, video);
    assert.equal(f.coreStep, "final");
    assert.equal(safePath(video), video);
    assert.equal(
      safePath(video, [tmp]),
      null,
      "explicit root constraint still applies",
    );
    assert.equal(safePath(other), null, "neighbor is not readable");
    const doc = path.join(tmp, "docs/external.md");
    fs.writeFileSync(doc, `[video](${video})`);
    const rendered = renderArtifact({ path: doc, ext: "md", size: 100 }, c);
    assert.ok(rendered.html.includes(`data-artifact="${f.id}"`));
    fs.unlinkSync(video);
    fs.symlinkSync(other, video);
    assert.equal(
      safePath(video),
      null,
      "replacement symlink cannot expand the allowlist",
    );
    fs.unlinkSync(video);
    fs.writeFileSync(video, "replacement");
    fs.writeFileSync(manifestPath, original);
    buildCatalog();
    assert.equal(safePath(video), null, "removing registration revokes access");
  } finally {
    fs.writeFileSync(manifestPath, original);
    fs.rmSync(external, { recursive: true, force: true });
  }
});

test("HTTP unrelated routes remain read-only and media byte ranges survive collaboration extension", async () => {
  fs.writeFileSync(path.join(tmp, "research/topic/test.mp4"), "0123456789");
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + s.address().port;
  try {
    assert.equal(
      (await fetch(base + "/api/catalog", { method: "POST" })).status,
      405,
    );
    assert.equal(
      (
        await fetch(base + "/api/catalog", {
          headers: { origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      await new Promise((resolve) =>
        http.get(
          base + "/api/catalog",
          { headers: { host: "evil.example" } },
          (r) => {
            r.resume();
            resolve(r.statusCode);
          },
        ),
      ),
      403,
    );
    assert.equal(
      (await fetch(base + "/api/asset/" + "a".repeat(24))).status,
      400,
    );
    const scope = base + "/api/workspaces/history-unassigned";
    const c = await (await fetch(scope + "/catalog")).json();
    const f = c.topics[0].artifacts.find((f) => f.ext === "mp4");
    const r = await fetch(scope + "/asset/" + f.id, {
      headers: { range: "bytes=2-5" },
    });
    assert.equal(r.status, 206);
    assert.equal(await r.text(), "2345");
    assert.equal(
      (
        await fetch(scope + "/asset/" + f.id, {
          headers: { range: "bytes=99-" },
        })
      ).status,
      416,
    );
  } finally {
    await new Promise((r) => s.close(r));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
