import { publishPlan } from "./schedule.mjs";
import { importReleasePackage } from "./pack.mjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
export const platforms = ["douyin", "xiaohongshu", "channels"];
export function norm(s) {
  return String(s)
    .normalize("NFC")
    .replace(/[\s\u200b\ufeff]/gu, "");
}
export function digest(x) {
  return crypto.createHash("sha256").update(x).digest("hex");
}
export function stableJSON(value) {
  if (Array.isArray(value)) return "[" + value.map(stableJSON).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .filter((k) => value[k] !== undefined)
        .map((k) => JSON.stringify(k) + ":" + stableJSON(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function isSubmissionState(record) {
  return Boolean(
    record?.attempt ||
      record?.publishAttempt?.startedAt ||
      /^(?:submitting|submitted(?:_.*)?|published(?:_.*)?|scheduled(?:_.*)?|reviewing|publish_success(?:_.*)?|submission-unconfirmed|submission-confirmed)$/u.test(
        record?.status || "",
      ),
  );
}
function defaultProbe(file) {
  return JSON.parse(
    execFileSync(
      "ffprobe",
      ["-v", "error", "-show_format", "-show_streams", "-of", "json", file],
      { encoding: "utf8" },
    ),
  );
}
export function readJob(file, { probe = defaultProbe, releaseFile } = {}) {
  const absolute = path.resolve(file);
  let job = JSON.parse(fs.readFileSync(absolute));
  if (job.kind === "release_copy_package")
    job = importReleasePackage(absolute, releaseFile);
  if (!job.id || !/^[a-zA-Z0-9_-]+$/.test(job.id))
    throw Error("id 只能包含字母、数字、下划线或横线");
  const hashes = {};
  function resolveAsset(value, label) {
    const spec = typeof value === "string" ? { path: value } : value;
    if (!spec?.path) throw Error(`缺少 ${label}`);
    const filename = path.resolve(path.dirname(absolute), spec.path);
    if (!fs.statSync(filename).isFile()) throw Error(`缺少 ${label}`);
    const hash = digest(fs.readFileSync(filename));
    if (spec.sha256 && spec.sha256.toLowerCase() !== hash)
      throw Error(`${label} 素材指纹不符`);
    hashes[label] = hash;
    return { ...spec, path: filename, sha256: hash };
  }
  for (const f of ["video", "cover"]) job[f] = resolveAsset(job[f], f).path;
  job.assets = Object.fromEntries(
    Object.entries(job.assets || {}).map(([k, v]) => [
      k,
      resolveAsset(v, `assets.${k}`),
    ]),
  );
  job.covers = Object.fromEntries(
    Object.entries(job.covers || { portrait: job.cover }).map(([k, v]) => [
      k,
      resolveAsset(v, `covers.${k}`),
    ]),
  );
  job.validation = {
    warnings: [],
    platformTitleFeedbackRequired: ["xiaohongshu"],
  };
  for (const p of platforms) {
    publishPlan(job, p);
    const c = job.platforms?.[p];
    if (!c) throw Error(`缺少平台 ${p}`);
    if (!c.account?.id || !c.account?.name)
      throw Error(`${p} 必须指定账号名称和唯一 ID`);
    const title = p === "channels" ? c.short_title : c.title;
    const limit = { douyin: 30, channels: 16 }[p];
    if (!title || (limit && [...title].length > limit))
      throw Error(`${p} 标题超过 ${limit ?? "平台允许"} 字或为空`);
    if (p === "xiaohongshu")
      job.validation.warnings.push({
        platform: p,
        code: "title-counter-needs-platform-feedback",
        unicodeCharacters: [...title].length,
        message:
          "不以 Unicode 字符数推断小红书计数；填写后读取实际字段计数/错误，禁止自动截短。",
      });
    if (!c.title || !c.body || !Array.isArray(c.tags))
      throw Error(`${p} 文案不完整`);
    if (c.tags.some((t) => !t || /[\s#]/u.test(t)))
      throw Error(`${p} 标签不能含空格或 #`);
    if (c.ai !== true) throw Error(`${p} 必须声明 AI 生成内容`);
    if (c.coverVariant && !job.covers[c.coverVariant])
      throw Error(`${p} 封面比例引用不存在`);
    const caption =
      description(job, p) + "\n\n" + c.tags.map((t) => "#" + t).join(" ");
    if ([...caption].length > 1000)
      throw Error(`${p} 正文超出本脚本 1000 字保守上限`);
  }
  const media = probe(job.video);
  if (
    !media.streams.some((s) => s.codec_type === "video") ||
    !media.streams.some((s) => s.codec_type === "audio")
  )
    throw Error("视频缺少画面或音轨");
  const pic = probe(job.cover).streams[0];
  if (!pic?.width || !pic?.height) throw Error("封面无法解码");
  const coverDimensions = {};
  for (const [name, value] of Object.entries(job.covers)) {
    const picture =
      value.path === job.cover ? pic : probe(value.path).streams[0];
    if (!picture?.width || !picture?.height)
      throw Error(`封面 ${name} 无法解码`);
    coverDimensions[name] = [picture.width, picture.height];
  }
  job.meta = {
    duration: Number(media.format.duration),
    cover: [pic.width, pic.height],
    covers: coverDimensions,
  };
  job.videoHash = hashes.video;
  const content =
    typeof job.content === "object" ? job.content?.id : job.content;
  if (!job.deliveryId && content) job.deliveryId = `content:${content}`;
  if (!job.deliveryId) {
    // Legacy receipts remain readable and blocked. New publishing jobs need a stable content identity.
    if (!platforms.every((p) => isSubmissionState(job.alreadyPublished?.[p])))
      throw Error(
        "新任务必须提供稳定 deliveryId 或 content，不能用 job id/版本代替",
      );
    job.deliveryId = `legacy-video:${job.videoHash}`;
    job.validation.warnings.push({
      code: "legacy-content-identity",
      message: "历史回执缺少稳定内容ID，仅按原视频识别并阻止重发。",
    });
  }
  if (typeof job.deliveryId !== "string" || !job.deliveryId.trim())
    throw Error("deliveryId 不能为空");
  job.assetHashes = hashes;
  job.coverHashes = Object.fromEntries(
    Object.entries(job.covers).map(([k, v]) => [k, v.sha256]),
  );
  job.fingerprint = digest(
    stableJSON({
      deliveryId: job.deliveryId,
      assets: hashes,
      platforms: job.platforms,
      publication: job.publication,
      authorization: job.authorization,
      browser: job.browser
        ? {
            profileId: job.browser.profileId,
            profileName: job.browser.profileName,
          }
        : undefined,
      adapters: job.adapters,
    }),
  );
  job.source = absolute;
  return job;
}
export function description(job, p) {
  const c = job.platforms[p];
  return p === "channels" && !c.bodyIncludesTitle
    ? c.title + "\n\n" + c.body
    : c.body;
}
export function atomicJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
      flush: true,
    });
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}
export function assertCanPrepare(record) {
  if (isSubmissionState(record))
    throw Error("已有提交记录，禁止重复上传或发布；请先核对作品列表");
}
export function assertCanSubmit(record, fingerprint) {
  assertCanPrepare(record);
  if (record?.status !== "ready" || record?.fingerprint !== fingerprint)
    throw Error("尚未完成准备或素材/文案已变化");
}
export function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    const fd = fs.openSync(file, "wx");
    fs.writeFileSync(fd, String(process.pid));
    return () => {
      fs.closeSync(fd);
      fs.unlinkSync(file);
    };
  } catch {
    throw Error(
      `该任务正在运行或异常退出留下锁：${file}。确认无进程后再移除。`,
    );
  }
}
export function accountMatches(snapshot, account) {
  const texts = [...snapshot.matchAll(/text "(.*)"/g)].map((m) => m[1]);
  return (
    texts.some((t) => t === account.name) &&
    texts.some(
      (t) => t === account.id || t.split(/[：:]/u).at(-1).trim() === account.id,
    )
  );
}
