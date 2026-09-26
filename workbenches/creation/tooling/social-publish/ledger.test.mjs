import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createLedger, withLedger } from "./ledger.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "delivery-ledger-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    file: path.join(dir, "ledger.json"),
    job: {
      id: "job-one",
      deliveryId: "content:one",
      videoHash: "a".repeat(64),
      fingerprint: "b".repeat(64),
      platforms: {
        douyin: { account: { id: "account-a", name: "A" } },
        xiaohongshu: { account: { id: "account-b", name: "A" } },
      },
    },
  };
}

test("imported submitted/reviewing receipts block prepare and submit across job files and restart", (t) => {
  const { file, job } = fixture(t);
  job.alreadyPublished = {
    douyin: {
      status: "reviewing",
      accountId: "account-a",
      receipt: { contentId: null },
    },
  };
  createLedger(file).syncJob(job);
  const another = {
    ...job,
    id: "renamed-job",
    fingerprint: "c".repeat(64),
    videoHash: "d".repeat(64),
    alreadyPublished: {},
  };
  const ledger = createLedger(file);
  assert.throws(() => ledger.assertCanPrepare(another, "douyin"), /禁止重复/);
  assert.throws(() => ledger.beginSubmit(another, "douyin"), /禁止重复/);
  assert.equal(ledger.get(another, "douyin").status, "reviewing");
});

test("changing deliveryId does not bypass same-video protection for the same channel account", (t) => {
  const { file, job } = fixture(t);
  const ledger = createLedger(file);
  ledger.savePrepared(job, "douyin");
  ledger.beginSubmit(job, "douyin");
  assert.throws(
    () =>
      ledger.assertCanPrepare(
        { ...job, deliveryId: "content:renamed", id: "renamed" },
        "douyin",
      ),
    /禁止重复/,
  );
  assert.throws(
    () =>
      ledger.assertCanPrepare(
        {
          ...job,
          deliveryId: "content:uppercase",
          videoHash: job.videoHash.toUpperCase(),
        },
        "douyin",
      ),
    /禁止重复/,
  );
  assert.doesNotThrow(() => ledger.assertCanPrepare(job, "xiaohongshu"));
  const differentAccount = structuredClone(job);
  differentAccount.platforms.douyin.account.id = "other";
  assert.doesNotThrow(() =>
    ledger.assertCanPrepare(differentAccount, "douyin"),
  );
});

test("beginSubmit requires the prepared fingerprint and persists before external work", (t) => {
  const { file, job } = fixture(t);
  const ledger = createLedger(file);
  assert.throws(() => ledger.beginSubmit(job, "douyin"), /准备/);
  ledger.savePrepared(job, "douyin", { previewProof: "local-preview.png" });
  assert.throws(
    () => ledger.beginSubmit({ ...job, fingerprint: "e".repeat(64) }, "douyin"),
    /准备|变化/,
  );
  const record = ledger.beginSubmit(job, "douyin", {
    proof: "final-review.png",
  });
  assert.equal(record.status, "submitting");
  assert.ok(record.attempt.id);
  assert.equal(
    createLedger(file).get(job, "douyin").attempt.id,
    record.attempt.id,
  );
  assert.throws(() => ledger.savePrepared(job, "douyin"), /禁止重复/);
});

test("exceptions after submitting keep uncertainty blocked and release only the process lock", async (t) => {
  const { file, job } = fixture(t);
  createLedger(file).savePrepared(job, "douyin");
  await assert.rejects(
    withLedger(
      job,
      "douyin",
      "submit",
      async ({ ledger }) => {
        ledger.beginSubmit(job, "douyin");
        throw Error("browser disconnected");
      },
      { file },
    ),
    /disconnected/,
  );
  assert.equal(fs.existsSync(file + ".lock"), false);
  assert.throws(
    () => createLedger(file).assertCanPrepare(job, "douyin"),
    /禁止重复/,
  );
});

test("only one process can begin an attempt; another job cannot submit concurrently", async (t) => {
  const { file, job } = fixture(t);
  createLedger(file).savePrepared(job, "douyin");
  const jobFile = path.join(path.dirname(file), "job.json");
  fs.writeFileSync(jobFile, JSON.stringify(job));
  const moduleUrl = new URL("./ledger.mjs", import.meta.url).href;
  const code = `import fs from 'node:fs';import {createLedger} from ${JSON.stringify(moduleUrl)};try{createLedger(process.argv[1]).beginSubmit(JSON.parse(fs.readFileSync(process.argv[2])),'douyin');process.stdout.write('begun')}catch(e){process.stdout.write('blocked')}`;
  const once = () =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        "--input-type=module",
        "-e",
        code,
        file,
        jobFile,
      ]);
      let out = "";
      child.stdout.on("data", (b) => (out += b));
      child.on("error", reject);
      child.on("exit", (c) =>
        c === 0 ? resolve(out) : reject(Error("child failed")),
      );
    });
  const results = await Promise.all([once(), once()]);
  assert.deepEqual(results.sort(), ["begun", "blocked"]);
});

test("observed failure after a click cannot reopen the delivery, and terminal receipt is durable", (t) => {
  const { file, job } = fixture(t);
  const ledger = createLedger(file);
  ledger.savePrepared(job, "douyin");
  ledger.beginSubmit(job, "douyin");
  ledger.recordResult(job, "douyin", "failed", {
    lastObserved: "页面网络错误",
  });
  assert.equal(ledger.get(job, "douyin").status, "submission-unconfirmed");
  assert.throws(() => ledger.savePrepared(job, "douyin"), /禁止重复/);
  ledger.recordResult(job, "douyin", "reviewing", {
    receipt: { contentId: "real-id" },
  });
  assert.equal(
    createLedger(file).get(job, "douyin").receipt.contentId,
    "real-id",
  );
  assert.throws(() => ledger.recordResult(job, "douyin", "ready"), /状态/);
});

test("receipt import rejects an account mismatch rather than moving publication to another identity", (t) => {
  const { file, job } = fixture(t);
  job.alreadyPublished = {
    douyin: { status: "submitted", account_id: "not-account-a" },
  };
  assert.throws(() => createLedger(file).syncJob(job), /账号/);
  assert.equal(fs.existsSync(file), false);
});

test("withLedger blocks imported delivery before calling any driver callback", async (t) => {
  const { file, job } = fixture(t);
  job.alreadyPublished = { douyin: { status: "submitted" } };
  let calls = 0;
  await assert.rejects(
    withLedger(
      job,
      "douyin",
      "prepare",
      () => {
        calls++;
      },
      { file },
    ),
    /禁止重复/,
  );
  assert.equal(calls, 0);
});
