import { projectCatalog } from "./project-model.mjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { stages, stageFor } from "./stages.mjs";
import { contentRoot, mediaRoot } from "./paths.mjs";
export const root = contentRoot;
export { mediaRoot };
let explicitMedia = new Set();
let explicitExternal = new Set();
const viewExt = new Set([
  ".md",
  ".json",
  ".txt",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".mp4",
  ".mp3",
  ".wav",
  ".srt",
  ".html",
]);
export const hash = (p) => {
  const h = crypto.createHash("sha256"),
    fd = fs.openSync(p, "r"),
    buffer = Buffer.alloc(1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0)
      h.update(buffer.subarray(0, n));
    return h.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
};
const hashCache = new Map();
function cachedHash(p) {
  const s = fs.statSync(p);
  const k = `${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  const c = hashCache.get(p);
  if (c?.key === k) return c.hash;
  const h = hash(p);
  hashCache.set(p, { key: k, hash: h });
  return h;
}
const inside = (p, dir) => p === dir || p.startsWith(dir + path.sep);
export function safePath(p, roots) {
  try {
    const real = fs.realpathSync(p);
    if (
      roots === undefined &&
      explicitExternal.has(real) &&
      path.resolve(p) === real
    )
      return real;
    return (roots || [root, mediaRoot]).some((r) =>
      inside(real, fs.realpathSync(r)),
    )
      ? real
      : null;
  } catch {
    return null;
  }
}
export function readJSON(p) {
  try {
    if (fs.statSync(p).size > 8e6) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
function walk(dir, area, maxDepth = 1) {
  const result = [];
  if (!fs.existsSync(dir)) return result;
  function run(d, level) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (
        e.name.startsWith(".") ||
        [
          "source-extracts",
          "node_modules",
          "assets",
          "voice",
          "audio",
          "out",
          "dist",
        ].includes(e.name)
      )
        continue;
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (
          level < maxDepth ||
          (area === "media" &&
            [...explicitMedia].some((uri) => uri.startsWith(p + path.sep)))
        )
          run(p, level + 1);
        continue;
      }
      if (
        !e.isFile() ||
        !viewExt.has(path.extname(p).toLowerCase()) ||
        !safePath(p)
      )
        continue;
      if (
        area === "media" &&
        !explicitMedia.has(p) &&
        !/\.mp4$|\.srt$|\.mp3$|cover|sample|timeline|caption|script|user-style/i.test(
          p,
        )
      )
        continue;
      result.push({
        path: p,
        area,
        name: path.relative(dir, p),
        size: fs.statSync(p).size,
        mtime: fs.statSync(p).mtime.toISOString(),
      });
    }
  }
  run(dir, 0);
  return result;
}
export function resolveInput(reviewPath, input) {
  const given = input.path || input.file;
  if (typeof given !== "string") return null;
  if (path.isAbsolute(given)) return safePath(given);
  for (const candidate of [
    path.resolve(path.dirname(reviewPath), given),
    path.resolve(path.dirname(path.dirname(reviewPath)), given),
    path.resolve(root, given),
  ]) {
    const p = safePath(candidate);
    if (p && fs.statSync(p).isFile()) return p;
  }
  return null;
}
export function reviewInfo(file) {
  const d = readJSON(file.path);
  if (!d || !(d.stage && (d.verdict || d.decision || d.result))) return null;
  const inputs = Array.isArray(d.inputs) ? d.inputs : [];
  const checks = inputs.map((i) => {
    const p = resolveInput(file.path, i);
    let state = "unverifiable";
    if (!p) state = "missing";
    else if (/^[a-f0-9]{64}$/i.test(i.sha256 || "")) {
      try {
        state = cachedHash(p) === i.sha256 ? "match" : "changed";
      } catch {
        state = "unverifiable";
      }
    }
    return {
      path: i.path || i.file,
      expected: i.sha256,
      state,
      artifactPath: p,
    };
  });
  const version = checks.some((x) => x.state === "changed")
    ? "stale"
    : checks.some((x) => x.state === "missing")
      ? "missing"
      : !checks.length || checks.some((x) => x.state === "unverifiable")
        ? "unverifiable"
        : "match";
  return {
    id: file.id,
    path: file.displayPath,
    stage: d.stage,
    decision: d.verdict || d.decision || d.result,
    reviewer: d.reviewer || d.reviewer_id || "未记录",
    author: d.author || d.author_id || "未记录",
    independence: d.independence || "仅显示记录身份，未验证独立执行",
    native: d.native_record || null,
    date: d.reviewed_at || d.date || null,
    version,
    inputs: checks,
    findings:
      d.findings ||
      (Array.isArray(d.questions)
        ? d.questions.map((q) => ({
            id: q.id,
            title: q.question,
            location: q.location,
            evidence: q.resolution_reason || q.remaining_limit || "",
            recheck: q.reader_recheck || q.status || "未记录",
          }))
        : []),
    limits: Array.isArray(d.remaining_limits || d.unchecked)
      ? d.remaining_limits || d.unchecked
      : d.remaining_limits || d.unchecked
        ? [d.remaining_limits || d.unchecked]
        : [],
    surfaces: d.surfaces_checked || d.surfaces || [],
    next: d.allowed_next_action || d.delivery_scope || "",
    mode:
      d.review_mode ||
      (/reader/i.test(file.name || "") ? "simulated_reader" : null),
  };
}
export function buildCatalog() {
  const manifest = readJSON(path.join(root, "data/workbench/topics.json"));
  explicitExternal = new Set();
  const externalBySource = new Map();
  for (const topic of manifest?.topics || []) {
    const files = [];
    for (const uri of topic.externalArtifacts || []) {
      if (
        typeof uri !== "string" ||
        !path.isAbsolute(uri) ||
        !viewExt.has(path.extname(uri).toLowerCase())
      )
        throw Error("外部资产必须逐文件登记绝对路径与可读类型");
      const p = path.resolve(uri);
      // Register exact canonical files, never a directory or a symlink escape.
      if (!fs.existsSync(p) || fs.realpathSync(p) !== p) continue;
      const stat = fs.statSync(p);
      if (!stat.isFile()) continue;
      explicitExternal.add(p);
      files.push({
        path: p,
        area: "media",
        name: path.basename(p),
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      });
    }
    externalBySource.set(topic.sourceTopics[0], files);
  }
  explicitMedia = new Set(
    manifest.topics
      .flatMap((t) =>
        t.revisions.flatMap((r) => [
          ...Object.values(r.cores || {}),
          ...(r.artifactUris || []),
        ]),
      )
      .filter((uri) => uri.startsWith("media://"))
      .map((uri) => path.resolve(mediaRoot, uri.slice(8))),
  );
  const all = new Map();
  const topics = [];
  const directories = (fs.existsSync(path.join(root, "research")) ? fs
    .readdirSync(path.join(root, "research"), { withFileTypes: true }) : [])
    .filter((x) => x.isDirectory() && x.name !== "workflows")
    .map((x) => x.name);
  for (const slug of directories) {
    const feedbackSlug = slug.startsWith("deepseek-v4-flash-v2")
      ? "deepseek-v4-flash-20260908"
      : slug === "deepseek-v4-flash"
        ? "ep01"
        : slug === "minimax-h3"
          ? "ep02"
          : slug;
    const episode = slug === "minimax-h3" ? "ep02-minimax-h3" : slug;
    const media =
      slug === "deepseek-v4-flash"
        ? "deepseek-v4-flash-roi"
        : slug === "minimax-h3"
          ? "minimax-h3-roi-v2"
          : slug;
    const topic = {
      id: slug,
      title: slug.startsWith("deepseek")
        ? "DeepSeek V4 Flash"
        : slug === "minimax-h3"
          ? "MiniMax H3"
          : slug,
      edition: slug.includes("-v2-") ? "反馈驱动 · 新版" : "历史研究",
      artifacts: [],
      reviews: [],
      stages: [],
      metrics: [],
      comments: null,
    };
    const files = [
      ...walk(path.join(root, "research", slug), "research"),
      ...walk(path.join(root, "episodes", episode), "video"),
      ...walk(path.join(root, "data/feedback", feedbackSlug), "feedback"),
      ...walk(path.join(mediaRoot, media), "media"),
      ...(externalBySource.get(slug) || []),
    ];
    for (const f of files) {
      f.displayPath = inside(f.path, root)
        ? path.relative(root, f.path)
        : f.path;
      f.id = crypto
        .createHash("sha256")
        .update(f.path)
        .digest("hex")
        .slice(0, 24);
      f.stage = stageFor(f.name, f.area);
      f.ext = path.extname(f.path).slice(1);
      all.set(f.id, f);
      topic.artifacts.push(f);
    }
    for (const f of files.filter((f) =>
      /(?:review|reader).*\.json$/i.test(f.name),
    )) {
      const review = reviewInfo(f);
      if (review) topic.reviews.push(review);
    }
    topic.reviews.sort(
      (a, b) =>
        (b.date || "").localeCompare(a.date || "") ||
        b.path.localeCompare(a.path, undefined, { numeric: true }),
    );
    for (const review of topic.reviews)
      for (const i of review.inputs)
        i.artifactId = files.find((f) => f.path === i.artifactPath)?.id || null;
    topic.stages = stages.map((s) => {
      const a = files.filter((f) => f.stage === s.id);
      const relevant = topic.reviews.filter((rv) => {
        if (s.id === "research-review") return rv.path.startsWith("research/");
        if (s.id === "report")
          return rv.stage === "final" && rv.path.startsWith("research/");
        if (s.id === "outline") return rv.stage === "outline";
        if (s.id === "mechanism" || s.id === "evidence")
          return /^foundation(?:-|$)/.test(rv.stage);
        if (s.id === "feedback" || s.id === "learning")
          return rv.stage === "learning";
        const m = {
          "video-evidence": "evidence",
          architecture: "architecture",
          opening: "hook",
          package: "package",
          sample: "sample",
          final: "final",
          publish: "release",
        };
        return rv.stage === m[s.id] && rv.path.startsWith("episodes/");
      });
      // Do not collapse existence, declared decisions, or hash integrity into a fabricated stage pass.
      return {
        ...s,
        artifactIds: a.map((x) => x.id),
        reviewIds: relevant.map((x) => x.id),
        availability: a.length ? "有产物" : "未发现产物",
      };
    });
    const c = files.find((x) => /comments-collected\.json$/.test(x.name));
    if (c) {
      const raw = readJSON(c.path);
      topic.comments = { artifactId: c.id, data: raw };
    }
    // Capture fields from actual existing screenshots' transcription only, never infer missing analytics.
    if (feedbackSlug === "deepseek-v4-flash-20260908") {
      const capture = files.find((x) => x.name === "intake.md");
      if (capture) {
        const text = fs.readFileSync(capture.path, "utf8");
        for (const [label, re] of [
          ["播放", /播放\s*([\d.]+万)/],
          ["完播率", /完播率\s*([\d.]+%)/],
          ["2秒跳出率", /2秒跳出率\s*([\d.]+%)/],
          ["评论", /评论\s*(\d+)/],
        ]) {
          const m = text.match(re);
          if (m)
            topic.metrics.push({
              label,
              value: m[1],
              sourceId: capture.id,
              context: "旧版用户截图 · 统计窗口未提供",
            });
        }
      }
    }
    topics.push(topic);
  }
  const docs = walk(path.join(root, "docs"), "docs", 3).filter(
    (f) => !f.name.startsWith("archive/") && !f.name.startsWith("pipeline/"),
  );
  // Only explicitly registered collaboration sources, never the whole trace/replay tree.
  for (const uri of new Set(
    (manifest?.topics || []).flatMap((t) => [
      ...(t.collaboration?.sources || []).map((s) => s.path),
      ...(t.collaboration?.artifactUris || []),
    ]),
  )) {
    if (typeof uri !== "string" || path.isAbsolute(uri))
      throw Error("协作来源必须是仓库相对路径");
    const file = safePath(path.resolve(root, uri), [root]);
    if (
      !file ||
      !fs.statSync(file).isFile() ||
      !viewExt.has(path.extname(file))
    )
      throw Error("协作来源不可读取：" + uri);
    if (docs.some((d) => d.path === file)) continue;
    docs.push({
      path: file,
      area: "docs",
      name: uri,
      size: fs.statSync(file).size,
      mtime: fs.statSync(file).mtime.toISOString(),
    });
  }
  for (const f of docs) {
    f.displayPath = path.relative(root, f.path);
    f.id = crypto
      .createHash("sha256")
      .update(f.path)
      .digest("hex")
      .slice(0, 24);
    f.stage = "docs";
    f.ext = path.extname(f.path).slice(1);
    all.set(f.id, f);
  }
  const index = readJSON(path.join(root, "data/post-publish/index.json"));
  topics.sort(
    (a, b) =>
      Number(b.id.includes("-v2-")) - Number(a.id.includes("-v2-")) ||
      a.id.localeCompare(b.id),
  );
  return projectCatalog(
    {
      generatedAt: new Date().toISOString(),
      topics,
      docs,
      publication: index || { items: [], error: "登记表不可读" },
      all,
    },
    root,
    mediaRoot,
  );
}
export function publicCatalog(c) {
  return {
    generatedAt: c.generatedAt,
    workspace: c.workspace || null,
    aliases: c.aliases || {},
    index: c.index || null,
    topics: c.topics.map((t) => ({
      ...t,
      artifacts: t.artifacts.map(({ path, sourcePath, ...a }) => a),
      reviews: t.reviews.map((rv) => ({
        ...rv,
        inputs: rv.inputs.map(({ artifactPath, ...i }) => i),
      })),
    })),
    docs: c.docs.map(({ path, ...d }) => d),
    publication: c.publication,
  };
}
