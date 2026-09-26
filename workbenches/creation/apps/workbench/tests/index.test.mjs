import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCatalogIndex } from "../src/catalog-index.mjs";
import { projectCatalog } from "../src/project-model.mjs";
test("SQLite commits complete snapshots, retains last good on failure, persists and rebuilds", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "token-index-")),
    filename = path.join(dir, "test.sqlite");
  let calls = 0,
    bad = false;
  const build = () => {
    calls++;
    if (bad) throw Error("broken manifest");
    return {
      generatedAt: "2026-09-08",
      topics: [],
      docs: [],
      all: new Map([
        [
          "a",
          { id: "a", name: "report.md", topicId: "topic", revisionId: "v3" },
        ],
      ]),
    };
  };
  const index = createCatalogIndex({ filename, build, intervalMs: 0 });
  assert.equal(index.read().all.size, 1);
  index.read();
  index.read();
  assert.equal(calls, 1, "reads must not scan filesystem");
  assert.equal(index.search("report")[0].id, "a");
  bad = true;
  assert.equal(index.refresh(), false);
  assert.equal(index.read().all.size, 1);
  assert.equal(index.read().index.stale, true);
  index.close();
  const restored = createCatalogIndex({ filename, build, intervalMs: 0 });
  assert.equal(restored.read().all.size, 1);
  restored.close();
  bad = false;
  fs.rmSync(filename);
  const rebuilt = createCatalogIndex({ filename, build, intervalMs: 0 });
  assert.equal(rebuilt.read().all.size, 1);
  rebuilt.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
test("one topic groups versions, stable core IDs survive relocation, user rejection does not overwrite technical pass", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "token-model-"));
  try {
    const run = (base, reportPath) => {
      fs.mkdirSync(path.join(base, "data/workbench"), { recursive: true });
      fs.writeFileSync(
        path.join(base, "data/workbench/topics.json"),
        JSON.stringify({
          schemaVersion: 1,
          topics: [
            {
              id: "topic",
              sourceTopics: ["r3", "v2"],
              currentReport: "r3",
              currentVideo: "new",
              revisions: [
                {
                  id: "r3",
                  kind: "report",
                  sourceTopic: "r3",
                  areas: ["research"],
                  cores: { report: reportPath },
                },
                {
                  id: "v2",
                  kind: "video",
                  sourceTopic: "v2",
                  areas: ["video"],
                  state: "rejected-direction",
                  cores: {},
                },
                { id: "new", kind: "video", state: "not-produced", cores: {} },
              ],
            },
          ],
        }),
      );
      const report = {
          id: "old-r",
          path: path.join(base, reportPath),
          area: "research",
          name: "report.md",
        },
        video = {
          id: "old-v",
          path: path.join(base, "episodes/old/final.json"),
          area: "video",
          name: "final.json",
        };
      return projectCatalog(
        {
          topics: [
            { id: "r3", artifacts: [report], reviews: [], metrics: [] },
            {
              id: "v2",
              artifacts: [video],
              reviews: [{ id: "old-v", decision: "pass", inputs: [] }],
              metrics: [],
            },
          ],
          docs: [],
          all: new Map(),
        },
        base,
        path.join(base, "media"),
      );
    };
    const a = run(path.join(tmp, "first"), "research/r3/report.md"),
      b = run(path.join(tmp, "second"), "renamed/report.md");
    assert.equal(a.topics.length, 1);
    assert.equal(
      a.topics[0].revisions[0].coreIds.report,
      b.topics[0].revisions[0].coreIds.report,
    );
    assert.equal(a.topics[0].reviews[0].decision, "pass");
    assert.equal(a.topics[0].revisions[1].state, "rejected-direction");
    assert.equal(a.topics[0].revisions[2].artifactIds.length, 0);
    assert.equal(a.aliases["old-r"], a.topics[0].revisions[0].coreIds.report);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("missing manifest is a refresh failure, never a successful empty/legacy projection", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "token-missing-manifest-"));
  let missing = false;
  const build = () => {
    if (missing)
      return projectCatalog(
        { topics: [], docs: [], all: new Map() },
        tmp,
        path.join(tmp, "media"),
      );
    return {
      generatedAt: "before",
      topics: [{ id: "known" }],
      docs: [],
      all: new Map(),
    };
  };
  const index = createCatalogIndex({
    filename: ":memory:",
    build,
    intervalMs: 0,
  });
  missing = true;
  assert.equal(index.refresh(), false);
  assert.equal(index.read().topics[0].id, "known");
  assert.match(index.read().index.error, /清单缺失/);
  assert.equal(index.read().index.stale, true);
  index.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("explicit video membership wins shared report directory and ambiguous ownership fails", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "token-explicit-"));
  try {
    fs.mkdirSync(path.join(tmp, "data/workbench"), { recursive: true });
    const revisions = [
      {
        id: "report",
        sourceTopic: "shared",
        areas: ["research"],
        cores: { report: "research/shared/report.md" },
      },
      {
        id: "video",
        sourceTopic: "shared",
        areas: [],
        cores: {
          architecture: "research/shared/video.md",
          sample: "media://missing.mp4",
        },
        artifactUris: ["research/shared/review.json"],
      },
    ];
    const run = () => {
      fs.writeFileSync(
        path.join(tmp, "data/workbench/topics.json"),
        JSON.stringify({
          schemaVersion: 1,
          topics: [
            {
              id: "topic",
              sourceTopics: ["shared"],
              currentReport: "report",
              currentVideo: "video",
              revisions,
            },
          ],
        }),
      );
      return projectCatalog(
        {
          docs: [],
          topics: [
            {
              id: "shared",
              metrics: [],
              reviews: [],
              artifacts: ["report.md", "video.md", "review.json"].map(
                (name) => ({
                  id: name,
                  path: path.join(tmp, "research/shared", name),
                  area: "research",
                }),
              ),
            },
          ],
        },
        tmp,
        path.join(tmp, "media"),
      );
    };
    const t = run().topics[0];
    assert.equal(
      t.artifacts.find((a) => a.logicalUri.endsWith("video.md")).revisionId,
      "video",
    );
    assert.equal(
      t.artifacts.find((a) => a.logicalUri.endsWith("report.md")).revisionId,
      "report",
    );
    assert.equal(
      t.artifacts.find((a) => a.logicalUri.endsWith("review.json")).revisionId,
      "video",
    );
    assert.equal(t.revisions[1].coreIds.sample, undefined);
    assert.equal(t.revisions[1].missingCores[0].step, "sample");
    revisions[0].artifactUris = ["research/shared/video.md"];
    assert.throws(run, /重复归属/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
