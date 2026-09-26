import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { importReleasePackage } from "./pack.mjs";
import { readJob, digest, description } from "./core.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-package-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const makeAsset = (name, data) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, data);
    return { path: name, sha256: digest(data) };
  };
  const title = "两台Spark 怎么运行 DeepSeek V4 Flash";
  const pack = {
    kind: "release_copy_package",
    assets: {
      video: makeAsset("video.mp4", "local video fixture"),
      cover: makeAsset("cover.png", "portrait fixture"),
      subtitles: makeAsset("captions.srt", "字幕"),
    },
    covers: { landscape: makeAsset("wide.png", "landscape fixture") },
    platforms: ["douyin", "xiaohongshu", "channels"].map((id) => ({
      id,
      title,
      shortTitle: id === "channels" ? "两台Spark怎么运行模型" : null,
      body: id === "channels" ? title + "\n\n模型如何运行。" : "模型如何运行。",
      tags: ["DeepSeek"],
      aiDeclaration: { visibleCopy: "AI合成配音。", uiLabelVerified: false },
      originalityDeclaration: {
        recommendation: "依当前平台和作品依据判断",
        uiLabelVerified: false,
      },
    })),
  };
  const release = {
    browser: {
      profileId: "Profile 3",
      profileName: "Token经济猫",
      taskSpaceId: 37,
    },
    content: "deepseek-runtime-explainer",
    version: "r2",
    videoSha256: pack.assets.video.sha256,
    platforms: pack.platforms.map((c, i) => ({
      id: c.id,
      accountId: `real-account-${i}`,
      accountName: "Token经济猫",
      accountVerified: true,
      status: c.id === "channels" ? "submitted" : "reviewing",
      receipt: {
        platformStatus: c.id === "channels" ? "原创审核中" : "审核中",
      },
    })),
  };
  const packageFile = path.join(dir, "package.json"),
    releaseFile = path.join(dir, "release.json");
  const save = () => {
    fs.writeFileSync(packageFile, JSON.stringify(pack));
    fs.writeFileSync(releaseFile, JSON.stringify(release));
  };
  save();
  return { dir, title, pack, release, packageFile, releaseFile, save };
}
const probe = (file) =>
  file.endsWith(".mp4")
    ? {
        streams: [{ codec_type: "video" }, { codec_type: "audio" }],
        format: { duration: "304.533333" },
      }
    : { streams: [{ width: 1080, height: 1440 }] };

test("package and receipt become one standard job without inventing current login or originality", (t) => {
  const f = fixture(t),
    job = importReleasePackage(f.packageFile, f.releaseFile);
  assert.equal(job.deliveryId, "content:deepseek-runtime-explainer");
  assert.deepEqual(job.browser, {
    profileId: "Profile 3",
    profileName: "Token经济猫",
  });
  assert.equal(job.platforms.xiaohongshu.account.id, "real-account-1");
  assert.equal(job.platforms.xiaohongshu.title, f.title);
  assert.equal(job.platforms.channels.original, true);
  assert.equal(job.platforms.xiaohongshu.original, null);
  assert.equal(job.platforms.xiaohongshu.aiDeclaration.uiLabelVerified, false);
  assert.equal(job.alreadyPublished.xiaohongshu.status, "reviewing");
  assert.equal(description(job, "channels"), f.pack.platforms[2].body);
  assert.equal(job.covers.landscape.sha256, f.pack.covers.landscape.sha256);
});

test("content identity stays the same when job id or release version changes", (t) => {
  const f = fixture(t),
    one = importReleasePackage(f.packageFile, f.releaseFile, { id: "one" });
  f.release.version = "r3";
  f.save();
  const two = importReleasePackage(f.packageFile, f.releaseFile, { id: "two" });
  assert.notEqual(one.id, two.id);
  assert.equal(one.deliveryId, two.deliveryId);
});

test("missing account, receipt video mismatch, or changed source bytes refuse import", (t) => {
  const f = fixture(t);
  f.release.platforms[0].accountId = "";
  f.save();
  assert.throws(
    () => importReleasePackage(f.packageFile, f.releaseFile),
    /账号/,
  );
  f.release.platforms[0].accountId = "real-account-0";
  f.release.videoSha256 = "f".repeat(64);
  f.save();
  assert.throws(
    () => importReleasePackage(f.packageFile, f.releaseFile),
    /版本/,
  );
  f.release.videoSha256 = f.pack.assets.video.sha256;
  f.save();
  fs.writeFileSync(path.join(f.dir, "wide.png"), "replaced");
  assert.throws(
    () => importReleasePackage(f.packageFile, f.releaseFile),
    /指纹/,
  );
});

test("30-code-point XHS title remains intact and requires actual platform feedback", (t) => {
  const f = fixture(t),
    job = readJob(f.packageFile, { probe });
  assert.equal([...f.title].length, 30);
  assert.equal(job.platforms.xiaohongshu.title, f.title);
  assert.deepEqual(job.validation.platformTitleFeedbackRequired, [
    "xiaohongshu",
  ]);
  assert.ok(
    job.validation.warnings.some(
      (x) => x.code === "title-counter-needs-platform-feedback",
    ),
  );
});

test("a changed secondary cover invalidates preparation fingerprint even when video is identical", (t) => {
  const f = fixture(t);
  const raw = importReleasePackage(f.packageFile, f.releaseFile);
  const jobFile = path.join(f.dir, "job.json");
  fs.writeFileSync(jobFile, JSON.stringify(raw));
  const before = readJob(jobFile, { probe });
  fs.writeFileSync(raw.covers.landscape.path, "new layout");
  raw.covers.landscape.sha256 = digest("new layout");
  fs.writeFileSync(jobFile, JSON.stringify(raw));
  const after = readJob(jobFile, { probe });
  assert.equal(before.videoHash, after.videoHash);
  assert.notEqual(before.fingerprint, after.fingerprint);
});

test("renaming the job does not change its fingerprint; changing a declaration does", (t) => {
  const f = fixture(t),
    raw = importReleasePackage(f.packageFile, f.releaseFile),
    file = path.join(f.dir, "job.json");
  fs.writeFileSync(file, JSON.stringify(raw));
  const before = readJob(file, { probe });
  raw.id = "new-job-id";
  fs.writeFileSync(file, JSON.stringify(raw));
  const renamed = readJob(file, { probe });
  assert.equal(before.fingerprint, renamed.fingerprint);
  raw.platforms.douyin.original = true;
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.notEqual(before.fingerprint, readJob(file, { probe }).fingerprint);
});

test("new hand-written jobs need a content identity and cannot use their job id as delivery identity", (t) => {
  const f = fixture(t),
    raw = importReleasePackage(f.packageFile, f.releaseFile),
    file = path.join(f.dir, "job.json");
  delete raw.deliveryId;
  delete raw.content;
  delete raw.alreadyPublished;
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.throws(() => readJob(file, { probe }), /deliveryId|content/);
});

test("browser profile or adapter changes invalidate the prepared package, but old taskSpace is not inherited", (t) => {
  const f = fixture(t),
    raw = importReleasePackage(f.packageFile, f.releaseFile),
    file = path.join(f.dir, "job.json");
  fs.writeFileSync(file, JSON.stringify(raw));
  const before = readJob(file, { probe });
  raw.browser.profileId = "Profile 4";
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.notEqual(before.fingerprint, readJob(file, { probe }).fingerprint);
  raw.browser.profileId = "Profile 3";
  raw.adapters = { douyin: { title: "#new-title" } };
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.notEqual(before.fingerprint, readJob(file, { probe }).fingerprint);
});
