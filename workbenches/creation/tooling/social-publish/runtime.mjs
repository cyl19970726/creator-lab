import fs from "node:fs";
import path from "node:path";
import {
  atomicJSON,
  assertCanPrepare,
  assertCanSubmit,
  acquireLock,
  platforms,
  digest,
} from "./core.mjs";
import { createLedger } from "./ledger.mjs";
import { createBrowserDriver, assertAudit } from "./browser.mjs";
import { reconcileReceipt } from "./receipts.mjs";
import { publishPlan } from "./schedule.mjs";
export { makeDOM } from "./dom.mjs";

export async function run(api, args, job, options = {}) {
  const [command, , platform, reviewFile] = args;
  if (
    ![
      "probe",
      "prepare",
      "preview",
      "review",
      "inspect",
      "submit",
      "verify",
      "resume",
      "finish",
      "status",
    ].includes(command)
  )
    throw Error("未知命令");
  const directory = path.join(path.dirname(job.source), ".publish", job.id);
  const stateFile = path.join(directory, "state.json");
  const unlock = acquireLock(path.join(directory, "run.lock"));
  const state = fs.existsSync(stateFile)
    ? JSON.parse(fs.readFileSync(stateFile))
    : { id: job.id, platforms: structuredClone(job.alreadyPublished || {}) };
  const save = () => atomicJSON(stateFile, state);
  const log = options.log || console.log;
  let driver;
  try {
    // This check precedes all browser APIs, including TaskSpace creation.
    if (["prepare", "submit"].includes(command) && !job.videoHash)
      assertCanPrepare(state.platforms[platform]);
    const ledger = options.ledger || createLedger(options.ledgerFile);
    ledger.syncJob(job);
    if (["prepare", "submit"].includes(command))
      assertCanPrepare(state.platforms[platform]);
    if (command === "status") {
      const value = {
        stateFile,
        platforms: Object.fromEntries(
          platforms.map((p) => [p, ledger.get(job, p)]),
        ),
      };
      log(value);
      return value;
    }
    if (command === "resume") {
      if (!state.space) throw Error("没有可恢复的空间");
      await api.takeOverTaskSpace(state.space);
      return;
    }
    if (!["probe", "finish"].includes(command) && !platforms.includes(platform))
      throw Error("需要指定平台");
    const record = (state.platforms[platform] ||= {});
    const checkpoint = () => {
      state.platforms[platform] = record;
      save();
    };
    if (command === "prepare") ledger.assertCanPrepare(job, platform);
    if (command === "submit") {
      ledger.assertCanPrepare(job, platform);
      assertCanSubmit(record, job.fingerprint);
      validateReview(record, job);
    }
    if (command === "review") {
      const review = JSON.parse(fs.readFileSync(reviewFile));
      if (
        review.fingerprint !== job.fingerprint ||
        review.previewHash !== record.previewHash
      )
        throw Error("审核未绑定当前发布包和预览");
      if (
        !review.reviewer ||
        !review.notes?.trim() ||
        !["cover", "layout", "subtitles", "settings"].every(
          (k) => review.checks?.[k] === true,
        )
      )
        throw Error("需要实际核对封面、布局、字幕和设置并记录意见");
      record.review = { ...review, at: new Date().toISOString() };
      checkpoint();
      log(record.review);
      return record.review;
    }
    driver =
      options.driver ||
      (await createBrowserDriver(api, job, state, save, directory));
    if (command === "finish") {
      await driver.finish();
      state.finished = true;
      save();
      return;
    }
    if (command === "probe") {
      const results = {};
      for (const p of platforms) results[p] = await driver.account(p);
      log(results);
      return results;
    }
    if (command === "inspect") {
      const result = await driver.inspect(platform);
      log(result);
      return result;
    }
    if (command === "prepare") {
      record.accountEvidence = await driver.account(platform);
      checkpoint();
      const observed = await driver.prepare(platform, record, checkpoint);
      assertAudit(observed, job, platform);
      record.status = "ready";
      record.fingerprint = job.fingerprint;
      record.observed = observed;
      record.publication = publishPlan(job, platform);
      delete record.review;
      delete record.preview;
      delete record.previewHash;
      checkpoint();
      ledger.savePrepared(job, platform, { fingerprint: job.fingerprint });
      log({ platform, status: "ready", next: "preview", stateFile });
      return record;
    }
    if (command === "preview") {
      assertCanSubmit(record, job.fingerprint);
      record.preview = await driver.preview(platform);
      assertAudit(record.preview.observed, job, platform);
      record.previewHash = digest(JSON.stringify(record.preview));
      delete record.review;
      checkpoint();
      const template = {
        reviewer: "",
        fingerprint: job.fingerprint,
        previewHash: record.previewHash,
        checks: {
          cover: false,
          layout: false,
          subtitles: false,
          settings: false,
        },
        notes: "",
      };
      atomicJSON(path.join(directory, platform + "-review.json"), template);
      log({
        platform,
        preview: record.preview,
        reviewFile: path.join(directory, platform + "-review.json"),
      });
      return record.preview;
    }
    if (command === "verify") {
      const result = reconcileReceipt(
        await driver.verify(platform),
        job,
        platform,
        record,
      );
      // An inconclusive read must not erase an already confirmed historic receipt.
      if (result.status !== "submission-unconfirmed") {
        record.status = result.status;
        record.receipt = result;
        ledger.recordResult(job, platform, result.status, result);
      } else record.lastReconciliation = result;
      checkpoint();
      log(result);
      return result;
    }
    if (command === "submit") {
      await driver.account(platform);
      const observed = await driver.audit(platform);
      assertAudit(observed, job, platform);
      if (
        digest(JSON.stringify(observed)) !==
        digest(JSON.stringify(record.preview.observed))
      )
        throw Error("页面内容或设置已变化，重新预览");
      const attemptedAt = new Date().toISOString();
      ledger.beginSubmit(job, platform, {
        fingerprint: job.fingerprint,
        attemptedAt,
        previewHash: record.previewHash,
      });
      record.status = "submitting";
      record.attemptedAt = attemptedAt;
      checkpoint();
      record.afterClick = await driver.submit(platform);
      checkpoint();
      const result = reconcileReceipt(
        await driver.verify(platform),
        job,
        platform,
        record,
      );
      record.status = result.status;
      record.receipt = result;
      checkpoint();
      ledger.recordResult(job, platform, result.status, result);
      log(result);
      return result;
    }
  } catch (error) {
    state.lastError = {
      command,
      platform,
      message: error.message,
      at: new Date().toISOString(),
    };
    save();
    // User-control errors are hard stops: do not take another screenshot or click.
    if (
      driver &&
      platform &&
      !/user|用户|control|inactive|unassigned|not assigned/i.test(error.message)
    ) {
      try {
        state.lastError.evidence = await driver.inspect(platform);
        save();
      } catch {}
    }
    throw error;
  } finally {
    save();
    unlock();
  }
}
export function validateReview(record, job) {
  const review = record.review,
    preview = record.preview;
  if (
    !preview ||
    !review ||
    review.fingerprint !== job.fingerprint ||
    review.previewHash !== record.previewHash ||
    record.previewHash !== digest(JSON.stringify(preview))
  )
    throw Error("尚未完成当前版本的预览核对");
  if (
    !review.reviewer ||
    !review.notes?.trim() ||
    !["cover", "layout", "subtitles", "settings"].every(
      (k) => review.checks?.[k] === true,
    )
  )
    throw Error("实际审核记录不完整");
  if (
    !Array.isArray(preview.frames) ||
    !preview.frames.length ||
    !preview.settings
  )
    throw Error("缺少视频新帧或设置预览证据");
  for (const frame of [...preview.frames, preview.settings]) {
    if (
      !frame.screenshot ||
      !/^[a-f0-9]{64}$/i.test(frame.sha256 || "") ||
      !fs.existsSync(frame.screenshot)
    )
      throw Error("预览证据文件或指纹缺失");
    if (digest(fs.readFileSync(frame.screenshot)) !== frame.sha256)
      throw Error("预览图片已被修改，重新核对");
  }
}
