import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createIntegrationStore } from "../src/integration-store.mjs";

function fixture(filename = ":memory:") {
  const definitions = [
    {
      id: "token-economics",
      name: "Token 经济猫",
      kind: "account",
      aliases: ["token-xiaohongshu", "token-douyin", "token-channels"],
      channels: ["xiaohongshu", "douyin", "channels"].map((platform) => ({
        platform,
        verification: "pending",
      })),
      positioning: {
        purpose: { value: "seed", status: "confirmed", sources: [] },
      },
    },
  ];
  const topic = {
    id: "deepseek-v4-flash",
    title: "DeepSeek",
    direction: "讲清运行链路",
    artifacts: [],
    collaboration: { currentTask: "审阅成片", recent: "已完成 r2" },
  };
  const workspaceStore = {
    canonicalWorkspaceId: (id) =>
      id.startsWith("token-") && id !== "token-economics"
        ? "token-economics"
        : id,
    family: () => [
      "token-economics",
      "token-xiaohongshu",
      "token-douyin",
      "token-channels",
    ],
    workspace: () => definitions[0],
    catalog: () => ({ workspace: definitions[0], topics: [topic] }),
  };
  return createIntegrationStore({ filename, workspaceStore });
}
const positioning = {
  purpose: { value: "可信算力内容", status: "confirmed", sources: [] },
  readers: { value: "非专业读者", status: "confirmed", sources: [] },
  promise: { value: "从真实问题讲清运行", status: "proposed", sources: [] },
};
const fields = {
  currentCommitment: "交付本期说明",
  currentStageGoal: "资产审阅",
  currentTask: "核对 r2",
  currentActor: "用户",
  recent: "三平台已提交",
  result: "回执已登记",
  next: "收集反馈",
  unresolved: "公开状态待复核",
};

test("legacy channel aliases share identity, stale guard and operation replay", () => {
  const store = fixture();
  const input = {
    clientOperationId: "identity-op-01",
    actorType: "user",
    expectedRevision: 0,
    positioning,
  };
  assert.equal(
    store.identity("token-douyin").canonicalWorkspaceId,
    "token-economics",
  );
  assert.equal(
    store.saveIdentity("token-xiaohongshu", input).identity.positioningRevision,
    1,
  );
  assert.equal(store.saveIdentity("token-channels", input).replayed, true);
  assert.throws(
    () =>
      store.saveIdentity("token-economics", {
        ...input,
        clientOperationId: "identity-op-02",
      }),
    (e) =>
      e.code === "STALE_POSITIONING" &&
      e.details.current.positioningRevision === 1,
  );
  store.close();
});

test("summary seeds existing collaboration, persists all frontend fields and fuses catalog", () => {
  const store = fixture(),
    seed = store.summary("token-economics", "deepseek-v4-flash");
  assert.equal(seed.fields.currentTask, "审阅成片");
  assert.equal(seed.fields.currentCommitment, "讲清运行链路");
  const saved = store.saveSummary("token-douyin", "deepseek-v4-flash", {
    clientOperationId: "summary-op-01",
    actorType: "proxy",
    expectedRevision: 0,
    fields,
  });
  assert.deepEqual(saved.summary.fields, fields);
  const catalog = store.catalog("token-economics");
  assert.equal(catalog.workspace.positioning.purpose.value, "seed");
  assert.equal(
    catalog.topics[0].collaboration.currentCommitment,
    fields.currentCommitment,
  );
  assert.equal(catalog.topics[0].collaboration.summaryRevision, 1);
  store.close();
});

test("non-user sources may preserve an existing confirmation but cannot create one", () => {
  const store = fixture();
  assert.throws(
    () =>
      store.saveIdentity("token-economics", {
        clientOperationId: "proxy-confirm-01",
        actorType: "proxy",
        expectedRevision: 0,
        positioning,
      }),
    (e) => e.code === "CONFIRMATION_REQUIRES_USER",
  );
  const proposed = {
    purpose: { value: "seed", status: "confirmed", sources: [] },
    readers: { value: "非专业读者", status: "proposed", sources: [] },
    promise: { value: "解释真实运行", status: "proposed", sources: [] },
  };
  assert.equal(
    store.saveIdentity("token-economics", {
      clientOperationId: "proxy-propose-01",
      actorType: "proxy",
      expectedRevision: 0,
      positioning: proposed,
    }).identity.positioning.readers.status,
    "proposed",
  );
  store.close();
});

test("positioning and content versions survive restart without overwriting history", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "identity-persist-")),
    file = path.join(dir, "state.sqlite");
  let store = fixture(file);
  try {
    store.saveIdentity("token-economics", {
      clientOperationId: "persist-identity-1",
      actorType: "user",
      expectedRevision: 0,
      positioning,
    });
    store.saveSummary("token-economics", "deepseek-v4-flash", {
      clientOperationId: "persist-summary-1",
      actorType: "proxy",
      expectedRevision: 0,
      fields,
    });
    store.close();
    store = fixture(file);
    assert.equal(store.identity("token-douyin").positioningRevision, 1);
    const next = { ...fields, currentTask: "重新核对证据" };
    store.saveSummary("token-economics", "deepseek-v4-flash", {
      clientOperationId: "persist-summary-2",
      actorType: "agent",
      expectedRevision: 1,
      fields: next,
    });
    const result = store.summary("token-economics", "deepseek-v4-flash");
    assert.equal(result.history.length, 2);
    assert.equal(result.history[1].fields.currentTask, fields.currentTask);
    assert.equal(result.fields.currentTask, next.currentTask);
    assert.throws(
      () =>
        store.saveSummary("token-economics", "deepseek-v4-flash", {
          clientOperationId: "persist-summary-stale",
          actorType: "agent",
          expectedRevision: 1,
          fields,
        }),
      (e) => e.code === "STALE_SUMMARY",
    );
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the same operation ID remains independent across identities", () => {
  const store = fixture();
  try {
    const input = {
      clientOperationId: "shared-operation-id",
      actorType: "user",
      expectedRevision: 0,
      positioning,
    };
    assert.equal(
      store.saveIdentity("token-economics", input).identity.positioningRevision,
      1,
    );
    assert.equal(
      store.saveIdentity("hhh", input).identity.positioningRevision,
      1,
    );
    assert.equal(store.saveIdentity("hhh", input).replayed, true);
  } finally {
    store.close();
  }
});
