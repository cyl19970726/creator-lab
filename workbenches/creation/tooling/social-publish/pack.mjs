import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const supported = ["douyin", "xiaohongshu", "channels"];
function asset(value, base, label) {
  if (!value?.path || !/^[a-f0-9]{64}$/i.test(value.sha256 || ""))
    throw Error(`${label} 缺少素材路径或 SHA-256`);
  const file = path.resolve(base, value.path);
  if (!fs.statSync(file).isFile()) throw Error(`${label} 不是文件`);
  const actual = sha(fs.readFileSync(file));
  if (actual !== value.sha256.toLowerCase())
    throw Error(`${label} 素材指纹不符`);
  return { ...value, path: file, sha256: actual };
}

// Import is local and returns data only. Receipt state is never inferred from package readiness.
export function importReleasePackage(
  packageFile,
  releaseFile = path.join(path.dirname(packageFile), "release.json"),
  { id } = {},
) {
  const source = path.resolve(packageFile),
    receiptSource = path.resolve(releaseFile);
  const pack = JSON.parse(fs.readFileSync(source)),
    release = JSON.parse(fs.readFileSync(receiptSource));
  if (
    pack.kind !== "release_copy_package" ||
    !Array.isArray(pack.platforms) ||
    !Array.isArray(release.platforms)
  )
    throw Error("不是支持的发布包/回执格式");
  if (typeof release.content !== "string" || !release.content.trim())
    throw Error("回执缺少稳定 content，不能用版本或 job id 代替内容身份");
  const assets = Object.fromEntries(
    Object.entries(pack.assets || {}).map(([key, value]) => [
      key,
      asset(value, path.dirname(source), key),
    ]),
  );
  if (!assets.video || !assets.cover) throw Error("发布包缺少 video/cover");
  if (release.videoSha256 !== assets.video.sha256)
    throw Error("回执视频版本与发布包不一致");
  const covers = { portrait: assets.cover };
  for (const [key, value] of Object.entries(pack.covers || {}))
    covers[key] = asset(value, path.dirname(source), `covers.${key}`);
  const platforms = {},
    alreadyPublished = {};
  for (const p of supported) {
    const copy = pack.platforms.find((c) => c.id === p),
      observed = release.platforms.find((c) => c.id === p);
    if (!copy || !observed?.accountId || !observed.accountName)
      throw Error(`${p} 缺少文案或真实回执账号`);
    if (
      copy.actualAccount?.id &&
      String(copy.actualAccount.id) !== String(observed.accountId)
    )
      throw Error(`${p} 文案与回执账号不一致`);
    if (
      observed.publishAttempt?.videoSha256 &&
      observed.publishAttempt.videoSha256 !== assets.video.sha256
    )
      throw Error(`${p} 提交尝试与素材版本不一致`);
    const original =
      observed.originality_declared ??
      observed.originalityDeclared ??
      (/原创审核/u.test(observed.receipt?.platformStatus || "") ? true : null);
    platforms[p] = {
      account: { id: String(observed.accountId), name: observed.accountName },
      title: copy.title,
      short_title: copy.shortTitle ?? undefined,
      body: copy.body,
      bodyIncludesTitle: copy.body?.startsWith(copy.title + "\n") || false,
      publishBody: copy.publishBody,
      tags: [...(copy.tags || [])],
      ai: copy.ai === true || Boolean(copy.aiDeclaration),
      original,
      aiDeclaration: copy.aiDeclaration ?? null,
      originalityDeclaration: copy.originalityDeclaration ?? null,
      declarationEvidence: {
        original,
        source: original === null ? "not-recorded" : "release-receipt",
        accountVerifiedAtImport: observed.accountVerified === true,
      },
      fieldEvidence: copy.fieldEvidence ?? null,
      coverVariant: copy.coverVariant || "portrait",
    };
    alreadyPublished[p] = {
      ...observed,
      accountId: String(observed.accountId),
      videoHash: assets.video.sha256,
      source: receiptSource,
    };
  }
  return {
    schemaVersion: 1,
    id: id || `${release.content.replace(/[^a-zA-Z0-9_-]/g, "-")}-import`,
    content: release.content,
    deliveryId: `content:${release.content}`,
    video: assets.video.path,
    cover: assets.cover.path,
    assets,
    covers,
    platforms,
    alreadyPublished,
    publication: { mode: "immediate" },
    authorization: release.authorization ?? pack.authorization,
    browser: {
      profileId: release.browser?.profileId ?? null,
      profileName: release.browser?.profileName ?? null,
    },
    sourceRelease: {
      package: source,
      receipt: receiptSource,
      version: release.version,
      packageHash: sha(fs.readFileSync(source)),
      receiptHash: sha(fs.readFileSync(receiptSource)),
      observedAt: release.updatedAt,
      currentReleaseDecision: release.currentReleaseDecision ?? null,
    },
  };
}
