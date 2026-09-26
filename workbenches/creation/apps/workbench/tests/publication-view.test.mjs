import test from "node:test";
import assert from "node:assert/strict";
import { publicationView } from "../src/publication-view.mjs";
test("current release keeps its identity and URL even when history is last", () => {
  const current = {
    topic_id: "t",
    platform: "douyin",
    account_id: "a",
    video_version: "r2",
    video_sha256: "new",
    state_path: "new",
    status: "reviewing",
    url: null,
  };
  const old = {
    ...current,
    video_version: "r1",
    state_path: "old",
    status: "published",
    url: "https://example.org/old",
  };
  const catalog = {
    workspace: { channels: [{ accountId: "a" }] },
    publication: {
      items: [current, { ...current, account_id: "b", url: "wrong" }, old],
    },
    publicationReceipts: {
      new: {
        id: "receipt",
        data: {
          videoSha256: "new",
          updatedAt: "2026-09-11",
          platforms: [{ id: "douyin", accountId: "a", status: "reviewing" }],
        },
      },
    },
  };
  const rows = publicationView(catalog, { id: "t", currentVideo: "r2" });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].video_version, "r2");
  assert.equal(rows[0].url, null);
  assert.equal(rows[0].receiptId, "receipt");
  assert.equal(rows[1].url, "https://example.org/old");
  catalog.publicationReceipts.new.data.videoSha256 = "other";
  assert.equal(
    publicationView(catalog, { id: "t", currentVideo: "r2" })[0].receiptId,
    undefined,
  );
});
test("latest dated observation wins independent of register order", () => {
  const row = {
    topic_id: "t",
    platform: "douyin",
    account_id: "a",
    video_version: "r",
  };
  const catalog = {
    publication: {
      items: [
        { ...row, observedAt: "2026-09-12", status: "published" },
        { ...row, observedAt: "2026-09-11", status: "reviewing" },
      ],
    },
  };
  assert.equal(
    publicationView(catalog, { id: "t", currentVideo: "r" })[0].status,
    "published",
  );
});
