import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectCatalog } from "../src/project-model.mjs";
import { createCatalogIndex } from "../src/catalog-index.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "token-input-reuse-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "data/workbench"), { recursive: true });
  const revisions = [
    {
      id: "v1",
      areas: [],
      cores: { goal: "research/shared/brief.md" },
      artifactUris: ["research/shared/sources.json"],
    },
    {
      id: "v2",
      areas: [],
      cores: { report: "research/shared/report-v2.md" },
    },
    { id: "video", cores: {}, state: "not-produced" },
  ];
  const build = () => {
    fs.writeFileSync(
      path.join(root, "data/workbench/topics.json"),
      JSON.stringify({
        schemaVersion: 1,
        topics: [
          {
            id: "topic",
            sourceTopics: ["shared"],
            currentReport: "v2",
            currentVideo: "video",
            revisions,
          },
        ],
      }),
    );
    return projectCatalog(
      {
        generatedAt: "2026-09-11",
        docs: [],
        topics: [
          {
            id: "shared",
            metrics: [],
            reviews: [],
            artifacts: ["brief.md", "sources.json", "report-v2.md"].map(
              (name) => ({
                id: name,
                name,
                path: path.join(root, "research/shared", name),
                area: "research",
              }),
            ),
          },
        ],
      },
      root,
      path.join(root, "media"),
    );
  };
  const original = build();
  const brief = original.topics[0].artifacts.find((a) => a.name === "brief.md");
  const evidence = original.topics[0].artifacts.find(
    (a) => a.name === "sources.json",
  );
  return { root, revisions, build, original, brief, evidence };
}

test("new revisions reuse existing inputs without changing identity or claiming new outputs", (t) => {
  const f = fixture(t);
  f.revisions[1].inputRefs = [
    {
      assetId: f.brief.id,
      sourceRevisionId: "v1",
      step: "goal",
      label: "沿用目标",
    },
    { assetId: f.evidence.id, sourceRevisionId: "v1", step: "evidence" },
  ];
  f.revisions[2].inputRefs = [{ assetId: f.brief.id, sourceRevisionId: "v1" }];
  const c = f.build();
  const topic = c.topics[0],
    rev = topic.revisions.find((r) => r.id === "v2");
  assert.deepEqual(rev.inputCoreIds, {
    goal: f.brief.id,
    evidence: f.evidence.id,
  });
  assert.equal(rev.inputRefs[0].uri, "research/shared/brief.md");
  assert.equal(rev.inputRefs[0].sourceRevisionId, "v1");
  assert.equal(rev.inputRefs[1].name, "sources.json");
  assert.equal(rev.artifactIds.length, 1);
  assert.equal(rev.coreIds.goal, undefined);
  assert.equal(topic.artifacts.length, 3);
  assert.deepEqual(c.all.get(f.brief.id), f.brief);
  assert.equal(c.aliases["brief.md"], f.brief.id);
  f.revisions.reverse();
  assert.deepEqual(
    f.build().topics[0].revisions.find((r) => r.id === "v2").inputRefs,
    rev.inputRefs,
  );
});

test("invalid input identity, source, step and ambiguous ownership remain errors", (t) => {
  const f = fixture(t),
    ref = { assetId: f.brief.id, sourceRevisionId: "v1", step: "goal" };
  for (const [refs, pattern] of [
    [[{ ...ref, assetId: "f".repeat(24) }], /未登记于本选题/],
    [[{ ...ref, sourceRevisionId: "wrong" }], /来源版本不符/],
    [[{ ...ref, step: "imaginary-step" }], /步骤无效/],
    [[ref, ref], /重复输入/],
    [
      [ref, { assetId: f.evidence.id, sourceRevisionId: "v1", step: "goal" }],
      /步骤入口重复/,
    ],
    [[{ ...ref, step: "report" }], /步骤入口重复/],
    [
      [
        {
          ...ref,
          assetId: f.original.topics[0].revisions[1].coreIds.report,
          sourceRevisionId: "v2",
        },
      ],
      /本版产出不能声明为沿用输入/,
    ],
    [{ assetId: f.brief.id }, /输入引用格式/],
  ]) {
    f.revisions[1].inputRefs = refs;
    assert.throws(f.build, pattern);
  }
  f.revisions[1].inputRefs = [ref];
  f.revisions[1].artifactUris = ["research/shared/brief.md"];
  assert.throws(f.build, /重复归属/);
});

test("input relationships survive refresh and persisted index recovery", (t) => {
  const f = fixture(t);
  f.revisions[1].inputRefs = [
    { assetId: f.brief.id, sourceRevisionId: "v1", step: "goal" },
  ];
  const filename = path.join(f.root, "index.sqlite");
  const index = createCatalogIndex({ filename, build: f.build, intervalMs: 0 });
  const original = index.read().topics[0].revisions[1].inputRefs;
  assert.equal(index.refresh(), true);
  assert.deepEqual(index.read().topics[0].revisions[1].inputRefs, original);
  index.close();
  const restored = createCatalogIndex({
    filename,
    build: () => {
      throw Error("simulate unavailable source");
    },
    intervalMs: 0,
  });
  assert.deepEqual(restored.read().topics[0].revisions[1].inputRefs, original);
  assert.equal(restored.read().all.get(f.brief.id).revisionId, "v1");
  restored.close();
});
