import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readJob,
  accountMatches,
  assertCanPrepare,
  assertCanSubmit,
  atomicJSON,
  acquireLock,
  norm,
} from "./core.mjs";
import { run } from "./runtime.mjs";
const source = new URL("./h3-published.json", import.meta.url);
const config = JSON.parse(fs.readFileSync(source));
function changed(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-test-"));
  const value = structuredClone(config);
  fn(value);
  const file = path.join(dir, "job.json");
  fs.writeFileSync(file, JSON.stringify(value));
  try {
    return readJob(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
test("视频号不能静默截断长标题", () =>
  assert.throws(
    () =>
      changed(
        (j) => (j.platforms.channels.short_title = j.platforms.channels.title),
      ),
    /16/,
  ));
test("任一平台漏 AI 声明都拒绝", () => {
  for (const p of Object.keys(config.platforms))
    assert.throws(() => changed((j) => (j.platforms[p].ai = false)), /AI/);
});
test("同名账号不够，必须唯一 ID 匹配", () => {
  assert.equal(
    accountMatches('text "hhh"\ntext "抖音号：2149348380"', {
      name: "hhh",
      id: "2149348380",
    }),
    true,
  );
  assert.equal(
    accountMatches('text "hhh"\ntext "73995666719"', {
      name: "hhh",
      id: "2149348380",
    }),
    false,
  );
  assert.equal(
    accountMatches('text "Token经济猫"\ntext "2149348380"', {
      name: "hhh",
      id: "2149348380",
    }),
    false,
  );
  assert.equal(
    accountMatches('text "hhh"\ntext "小红书账号: 991850755"', {
      name: "hhh",
      id: "991850755",
    }),
    true,
  );
});
test("不确定的提交结果也不可自动重试", () => {
  for (const status of [
    "submitting",
    "submitted",
    "submitted_reviewing",
    "publish_success_list_verified",
    "published_originality_reviewing",
  ])
    assert.throws(() => assertCanPrepare({ status }), /禁止重复/);
});
test("准备后换文案或视频，不能沿用发布许可状态", () => {
  assertCanSubmit({ status: "ready", fingerprint: "abc" }, "abc");
  assert.throws(() =>
    assertCanSubmit({ status: "ready", fingerprint: "abc" }, "def"),
  );
  assert.throws(() =>
    assertCanSubmit({ status: "submitting", fingerprint: "abc" }, "abc"),
  );
});
test("锁阻止同时运行，释放后可继续", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-lock-"));
  const f = path.join(dir, "lock");
  const release = acquireLock(f);
  assert.throws(() => acquireLock(f));
  release();
  acquireLock(f)();
  fs.rmSync(dir, { recursive: true });
});
test("已发布 H3 的 prepare 不执行上传或点击", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-guard-"));
  const j = { ...config, source: path.join(dir, "job.json") };
  let writes = 0;
  const h = {
    listTaskSpaces: async () => [],
    useOrCreateTaskSpace: async () => ({ id: 99 }),
    cliLog: () => {},
    snapshotText: async () => "",
    captureScreenshot: async () => {
      throw Error("no browser");
    },
    click: async () => writes++,
    cdp: async () => writes++,
  };
  try {
    await assert.rejects(
      run(h, ["prepare", j.source, "douyin"], j),
      /禁止重复/,
    );
    assert.equal(writes, 0);
    const state = JSON.parse(
      fs.readFileSync(path.join(dir, ".publish", j.id, "state.json")),
    );
    assert.equal(state.platforms.douyin.status, "submitted_reviewing");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("状态文件用原子替换，保留中文", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-state-"));
  const f = path.join(dir, "s.json");
  atomicJSON(f, { title: "回本？" });
  assert.equal(JSON.parse(fs.readFileSync(f)).title, "回本？");
  assert.equal(fs.existsSync(f + ".tmp"), false);
  fs.rmSync(dir, { recursive: true });
});

import {
  publishPlan,
  assertFuture,
  configurePublication,
  auditPublication,
  verifyScheduledEvidence,
} from "./schedule.mjs";
test("两小时后的时间固定为含时区的绝对时间，跨日正确", () => {
  const p = publishPlan(
    { publication: { mode: "scheduled", at: "2026-09-08T00:00:00+08:00" } },
    "douyin",
  );
  assert.equal(p.at, "2026-09-07T16:00:00.000Z");
  assert.equal(p.local, "2026-09-08 00:00");
  assert.deepEqual(
    p,
    publishPlan(
      { publication: { mode: "scheduled", at: "2026-09-07T16:00:00Z" } },
      "channels",
    ),
  );
});
test("拒绝无时区和过去的定时，不自动改成立即", () => {
  assert.throws(
    () =>
      publishPlan(
        { publication: { mode: "scheduled", at: "2026-09-08 00:00" } },
        "douyin",
      ),
    /ISO/,
  );
  assert.throws(
    () =>
      assertFuture(
        { mode: "scheduled", at: "2026-09-07T16:00:00Z" },
        Date.parse("2026-09-07T16:00:00Z"),
      ),
    /已过/,
  );
  assert.throws(
    () =>
      publishPlan({ publication: { mode: "immediate", at: "x" } }, "douyin"),
    /不能/,
  );
});
test("预约记录也禁止重复提交", () =>
  assert.throws(() => assertCanPrepare({ status: "scheduled" }), /禁止重复/));
test("实际选中模式和字段回读都必须一致", async () => {
  const plan = publishPlan(
    { publication: { mode: "scheduled", at: "2099-09-08T00:00:00+08:00" } },
    "douyin",
  );
  const recipe = {
    publication: {
      scheduled: {
        select: { text: "定时发布" },
        selected: "#scheduled",
        fields: [
          { selector: "#date", format: "date" },
          { selector: "#time", format: "time" },
        ],
      },
    },
  };
  const values = {};
  let selected = false;
  const d = {
    click: async () => {
      selected = true;
    },
    one: async (s) => s.selector,
    call: async () => selected,
    fill: async (s, v) => {
      values[s.selector] = v;
    },
    read: async (s) => values[s.selector],
  };
  await configurePublication(d, recipe, plan);
  assert.equal(values["#date"], "2099-09-08");
  assert.equal(values["#time"], "00:00");
  values["#time"] = "01:00";
  await assert.rejects(auditPublication(d, recipe, plan), /回读不一致/);
  values["#time"] = "00:00";
  selected = false;
  await assert.rejects(auditPublication(d, recipe, plan), /未选中/);
  await assert.rejects(configurePublication(d, {}, plan), /尚未校准/);
});
test("仅作品标题不等于定时成功，必须有对应时间和状态", () => {
  const plan = { mode: "scheduled", date: "2026-09-08", time: "00:00" };
  assert.throws(() => verifyScheduledEvidence(plan, "MiniMax H3"), /不能认定/);
  assert.throws(
    () => verifyScheduledEvidence(plan, "定时 2026-09-08 01:00"),
    /不能认定/,
  );
  verifyScheduledEvidence(plan, "MiniMax H3 定时发布 2026/09/08 00:00");
});

import { assertPlatformWindow } from "./schedule.mjs";
test("尊重抖音两小时最低提前量，不擅自顺延", () => {
  const now = Date.parse("2026-09-07T14:45:00Z"),
    recipe = {
      schedulingLimits: { minLeadMinutes: 120, maxLeadMinutes: 20160 },
    };
  assert.throws(
    () =>
      assertPlatformWindow(
        { mode: "scheduled", at: "2026-09-07T16:00:00Z" },
        recipe,
        now,
      ),
    /提前量/,
  );
  assertPlatformWindow(
    { mode: "scheduled", at: "2026-09-07T18:00:00Z" },
    recipe,
    now,
  );
});
