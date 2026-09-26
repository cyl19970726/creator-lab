import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "./runtime.mjs";
import { digest } from "./core.mjs";
import { reconcileReceipt } from "./receipts.mjs";
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "publish-runtime-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const platforms = Object.fromEntries(
    ["douyin", "xiaohongshu", "channels"].map((p) => [
      p,
      {
        title: "两台Spark 怎么运行 DeepSeek V4 Flash",
        short_title: "两台Spark怎么运行模型",
        body: "机制图解",
        tags: ["AI算力"],
        account: { name: "Token经济猫", id: p + "-123" },
        ai: true,
      },
    ]),
  );
  const job = {
    id: "test",
    deliveryId: "content:test",
    source: path.join(dir, "job.json"),
    fingerprint: "fingerprint",
    videoHash: "a".repeat(64),
    platforms,
    meta: { duration: 304.533 },
  };
  const screenshot = path.join(dir, "frame.png");
  fs.writeFileSync(screenshot, "test fixture");
  const sha256 = digest(fs.readFileSync(screenshot));
  let clicks = 0,
    fail = false;
  const observed = {
    title: platforms.douyin.title,
    caption: "机制图解 #AI算力",
    checks: Object.fromEntries(
      [
        "upload",
        "cover",
        "ai",
        "visibility",
        "publication",
        "location",
        "titleAccepted",
      ].map((k) => [k, true]),
    ),
  };
  const driver = {
    account: async () => ({ verified: true }),
    prepare: async () => structuredClone(observed),
    audit: async () => structuredClone(observed),
    preview: async () => ({
      observed: structuredClone(observed),
      frames: [
        { time: 8, screenshot, sha256 },
        { time: 178, screenshot, sha256 },
      ],
      settings: { screenshot, sha256 },
    }),
    inspect: async () => ({ screenshot }),
    submit: async () => {
      clicks++;
      if (fail) throw Error("连接在提交后中断");
      return { screenshot };
    },
    verify: async () => ({ rows: [] }),
  };
  const opts = {
    driver,
    ledgerFile: path.join(dir, "ledger.json"),
    log: () => {},
  };
  const execute = (command, p = "douyin", review) =>
    run({}, [command, job.source, p, review], job, opts);
  async function ready(p = "douyin") {
    if (p === "channels") {
      observed.title = platforms.channels.short_title;
      observed.caption = platforms.channels.title + "\n\n机制图解 #AI算力";
    }
    await execute("prepare", p);
    await execute("preview", p);
    const review = path.join(dir, ".publish/test", p + "-review.json");
    const data = JSON.parse(fs.readFileSync(review));
    data.reviewer = "independent-test";
    data.notes = "fixture review";
    for (const k in data.checks) data.checks[k] = true;
    fs.writeFileSync(review, JSON.stringify(data));
    await execute("review", p, review);
  }
  return {
    job,
    driver,
    opts,
    execute,
    ready,
    clicks: () => clicks,
    setFail: () => {
      fail = true;
    },
    observed,
    screenshot,
  };
}
test("五步后提交一次，未知回执不能触发重发", async (t) => {
  const f = fixture(t);
  await f.ready();
  const r = await f.execute("submit");
  assert.equal(r.status, "submission-unconfirmed");
  await assert.rejects(f.execute("submit"), /禁止|重复/);
  assert.equal(f.clicks(), 1);
});
test("点击后断线保留提交中，改标题和任务名也不能再发", async (t) => {
  const f = fixture(t);
  await f.ready();
  f.setFail();
  await assert.rejects(f.execute("submit"), /中断/);
  f.job.id = "other";
  f.job.platforms.douyin.title = "改标题";
  f.job.fingerprint = "changed";
  await assert.rejects(f.execute("prepare"), /禁止|重复/);
  assert.equal(f.clicks(), 1);
});
test("预览后当前页面被修改，提交前发现且不点击", async (t) => {
  const f = fixture(t);
  await f.ready();
  f.observed.caption = "意外的旧稿";
  await assert.rejects(f.execute("submit"), /正文/);
  assert.equal(f.clicks(), 0);
});
test("仅完成上传不能直接发布，审核不绑定预览也拒绝", async (t) => {
  const f = fixture(t);
  await f.execute("prepare");
  await assert.rejects(f.execute("submit"), /预览/);
  assert.equal(f.clicks(), 0);
});
test("真实已提交记录在创建浏览器前拦截", async (t) => {
  const f = fixture(t);
  f.job.alreadyPublished = { douyin: { status: "reviewing" } };
  let browser = 0;
  await assert.rejects(
    run(
      { taskSpace: async () => browser++ },
      ["prepare", f.job.source, "douyin"],
      f.job,
      f.opts,
    ),
    /禁止重复/,
  );
  assert.equal(browser, 0);
});
test("同名旧作品不是新回执，只有完整行可确认审核中", (t) => {
  const f = fixture(t);
  const record = { attemptedAt: "2026-09-11T09:46:11Z" };
  const row =
    "两台Spark 怎么运行 DeepSeek V4 Flash 05:04 2026-09-11 17:46 审核中";
  assert.equal(
    reconcileReceipt({ rows: [row] }, f.job, "douyin", record).status,
    "reviewing",
  );
  assert.equal(
    reconcileReceipt(
      { rows: [row.replace("2026-09-11", "2026-09-09")] },
      f.job,
      "douyin",
      record,
    ).status,
    "submission-unconfirmed",
  );
  assert.equal(
    reconcileReceipt({ rows: [row, row] }, f.job, "douyin", record).status,
    "submission-unconfirmed",
  );
});

test("审核后截图被替换，提交前停止", async (t) => {
  const f = fixture(t);
  await f.ready();
  fs.writeFileSync(f.screenshot, "replaced");
  await assert.rejects(f.execute("submit"), /图片已被修改/);
  assert.equal(f.clicks(), 0);
});
test("发布时间不能充当视频时长", (t) => {
  const f = fixture(t);
  const r = reconcileReceipt(
    { rows: ["两台Spark 怎么运行 DeepSeek V4 Flash 2026-09-11 05:04 审核中"] },
    f.job,
    "douyin",
    { attemptedAt: "2026-09-10T21:04:00Z" },
  );
  assert.equal(r.status, "submission-unconfirmed");
});

test("定时准备保存规范日期，回执按预约时刻匹配并兼容旧raw记录", async (t) => {
  const f = fixture(t);
  f.job.publication = { mode: "scheduled", at: "2099-09-08T00:00:00+08:00" };
  const record = await f.execute("prepare");
  assert.equal(record.publication.date, "2099-09-08");
  const result = reconcileReceipt(
    {
      rows: [
        "两台Spark 怎么运行 DeepSeek V4 Flash 05:04 将于2099年09月08日 00:00 定时发布",
      ],
    },
    f.job,
    "douyin",
    { attemptedAt: "2099-09-07T09:00:00Z", publication: record.publication },
  );
  assert.equal(result.status, "scheduled");
  const legacy = reconcileReceipt(
    {
      rows: [
        "两台Spark 怎么运行 DeepSeek V4 Flash 05:04 将于2099年09月08日 00:00 定时发布",
      ],
    },
    f.job,
    "douyin",
    { attemptedAt: "2099-09-07T09:00:00Z", publication: f.job.publication },
  );
  assert.equal(legacy.status, "scheduled");
});
