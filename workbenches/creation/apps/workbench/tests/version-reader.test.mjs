import { test } from "node:test";
import assert from "node:assert/strict";
import {
  changedSections,
  renderVersionMarkdown,
  relatedTextVersions,
} from "../src/version-reader.mjs";
test("saved parents follow exact asset and hash relationships without mixing unrelated files", () => {
  const current = { assetId: "new", hash: "now", text: "new body" };
  const localOld = { assetId: "new", hash: "local-old", text: "local old" };
  const parent = { assetId: "old", hash: "then", text: "old body" };
  const ancestor = { assetId: "first", hash: "start", text: "first body" };
  const versions = [
    ancestor,
    parent,
    localOld,
    current,
    { assetId: "unrelated", hash: "then", text: "same hash is not identity" },
    { assetId: "old", hash: "unrelated-version", text: "not the parent" },
  ];
  const revisions = [
    { assetId: "new", expectedHash: "now", parent },
    { assetId: "old", expectedHash: "then", parent: ancestor },
  ];
  assert.deepEqual(relatedTextVersions("new", "now", versions, revisions), [
    ancestor,
    parent,
    localOld,
    current,
  ]);
});
test("same-file saved history stays available and media identifiers never become old text", () => {
  const before = { assetId: "file", hash: "before", text: "saved text" };
  const current = { assetId: "file", hash: "now", text: "current text" };
  const media = { assetId: "movie", hash: "video-hash", text: null };
  assert.deepEqual(
    relatedTextVersions(
      "file",
      "now",
      [before, current, media],
      [
        { assetId: "file", expectedHash: "now", parent: before },
        { assetId: "file", expectedHash: "before", parent: media },
      ],
    ),
    [before, current],
  );
});
test("version summary identifies changed sections rather than implying a full rewrite", () => {
  const before =
    "# 报告\n\n## 7. 工作台\n旧状态\n\n## 8. 下一步\n继续研究\n\n## 9. 执行\n未开始";
  const after =
    "# 报告\n\n## 7. 工作台\n已有意见\n\n## 8. 下一步\n继续研究\n\n## 9. 执行\n试用完成";
  assert.deepEqual(changedSections(before, after), [
    { title: "7. 工作台", kind: "修改" },
    { title: "9. 执行", kind: "修改" },
  ]);
});
test("saved Markdown renders readable text without executing HTML or presenting current attachments as old snapshots", () => {
  const result = renderVersionMarkdown(
    "# 旧版\n\n解释**机制**。\n\n![图](figure.png)\n\n[依据](evidence.md)\n\n<script>alert(1)</script>",
    {
      file: { displayPath: "research/case/report.md" },
      assets: [
        { id: "image", displayPath: "research/case/figure.png" },
        { id: "evidence", displayPath: "research/case/evidence.md" },
      ],
      historical: true,
    },
  );
  assert.ok(result.html.includes("<strong>机制</strong>"));
  assert.ok(result.html.includes("未保存该图片的历史快照"));
  assert.ok(!result.html.includes("<img"));
  assert.ok(!result.html.includes("<script>"));
  assert.ok(result.html.includes('data-snapshot-asset="evidence"'));
});
