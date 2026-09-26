import { stateRoot } from "./paths.mjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { root, safePath, hash } from "./catalog.mjs";
import { CollaborationError } from "./collaboration-store.mjs";

const idPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const assetPattern = /^[a-f0-9]{24}$/;
const shaPattern = /^[a-f0-9]{64}$/;
const fail = (status, code, message) => {
  throw new CollaborationError(status, code, message);
};
const digest = (value) =>
  crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
const canonical = (value) =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
const cleanText = (value, name, max = 1000, optional = false) => {
  if (optional && value === undefined) return "";
  if (
    typeof value !== "string" ||
    (!optional && !value.trim()) ||
    value.length > max
  )
    fail(400, "INVALID_INPUT", `${name}缺失或过长`);
  return value.trim();
};
const unknownProfile = () =>
  Object.fromEntries(
    ["purpose", "readers", "promise"].map((key) => [
      key,
      { value: "", status: "unknown", sources: [] },
    ]),
  );

// Workspace ownership is separate from asset identity. Existing topic/event IDs are never rewritten.
export function createWorkspaceStore({
  catalog,
  manifest = () =>
    JSON.parse(
      fs.readFileSync(
        path.join(root, "data/workbench/workspaces.json"),
        "utf8",
      ),
    ),
  filename = path.join(stateRoot, "workspaces.sqlite"),
  storageDir = path.join(stateRoot, "imports"),
  allowedPath = safePath,
} = {}) {
  if (filename !== ":memory:")
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS topic_ownership(topic_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS topics(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS imports(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, topic_id TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operations(workspace_id TEXT NOT NULL, operation_id TEXT NOT NULL, request TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(workspace_id,operation_id));`);
  if (filename !== ":memory:") fs.chmodSync(filename, 0o600);
  function definitions() {
    let data;
    try {
      data = manifest();
    } catch {
      fail(503, "WORKSPACE_CONFIG", "工作区清单不可读，未回退到全局资料");
    }
    if (
      ![1, 2].includes(data?.schemaVersion) ||
      !Array.isArray(data.workspaces)
    )
      fail(503, "WORKSPACE_CONFIG", "工作区清单格式不正确");
    const ids = new Set(),
      accounts = new Set(),
      topics = new Set();
    for (const w of data.workspaces) {
      if (
        !idPattern.test(w.id || "") ||
        ids.has(w.id) ||
        !w.name ||
        !["account", "unassigned"].includes(w.kind) ||
        !Array.isArray(w.topicIds)
      )
        fail(503, "WORKSPACE_CONFIG", "工作区身份或选题范围不正确");
      ids.add(w.id);
      if (w.kind === "account") {
        const channels = w.channels || (w.account ? [w.account] : []);
        if (
          channels.some(
            (account) =>
              !account.platform ||
              !["historical-not-rechecked", "pending"].includes(
                account.verification,
              ),
          )
        )
          fail(503, "WORKSPACE_CONFIG", "账号来源和验证状态必须明确");
        for (const account of channels)
          if (account.accountId) {
            const key = account.platform + ":" + account.accountId;
            if (accounts.has(key))
              fail(503, "WORKSPACE_CONFIG", "一个平台账号只能有一个工作区");
            accounts.add(key);
          }
      }
      for (const t of w.topicIds) {
        if (!idPattern.test(t) || topics.has(t))
          fail(503, "WORKSPACE_CONFIG", "选题重复归属或身份无效");
        topics.add(t);
      }
      for (const entry of Object.values(w.positioning || {}))
        if (
          !entry ||
          !["confirmed", "proposed", "unknown"].includes(entry.status) ||
          typeof entry.value !== "string" ||
          !Array.isArray(entry.sources)
        )
          fail(503, "WORKSPACE_CONFIG", "账号定位须记录状态和来源");
    }
    if (
      !data.workspaces.some(
        (w) => w.id === "history-unassigned" && w.kind === "unassigned",
      ) ||
      data.workspaces.filter((w) => w.kind === "unassigned").length !== 1
    )
      fail(503, "WORKSPACE_CONFIG", "必须保留唯一的历史待归属工作区");
    return data.workspaces;
  }
  function aliasMap() {
    const map = {};
    for (const w of definitions())
      for (const alias of w.aliases || []) {
        if (!idPattern.test(alias) || map[alias])
          fail(503, "WORKSPACE_CONFIG", "工作区别名无效或重复");
        map[alias] = w.id;
      }
    return map;
  }
  function canonicalWorkspaceId(id) {
    return aliasMap()[id] || id;
  }
  function family(id) {
    const target = canonicalWorkspaceId(id);
    return [
      target,
      ...Object.entries(aliasMap())
        .filter(([, v]) => v === target)
        .map(([k]) => k),
    ];
  }
  function workspace(id) {
    const target = canonicalWorkspaceId(id);
    const found = definitions().find((w) => w.id === target);
    if (!found) fail(404, "UNKNOWN_WORKSPACE", "请先选择有效工作区");
    return {
      ...found,
      canonicalWorkspaceId: target,
      requestedWorkspaceId: id,
      positioning: { ...unknownProfile(), ...found.positioning },
    };
  }
  function ownedTopics(c, defs) {
    const declared = new Map(
      defs.flatMap((w) => w.topicIds.map((id) => [id, w.id])),
    );
    const owner = new Map();
    for (const t of c.topics) {
      const target = canonicalWorkspaceId(
        declared.get(t.id) || "history-unassigned",
      );
      const previous = db
        .prepare("SELECT workspace_id FROM topic_ownership WHERE topic_id=?")
        .get(t.id);
      if (previous && previous.workspace_id !== target)
        fail(
          503,
          "OWNERSHIP_CHANGE",
          "现有选题归属发生变化；请显式导入，不能自动迁移意见或接受记录",
        );
      if (!previous)
        db.prepare("INSERT INTO topic_ownership VALUES(?,?)").run(t.id, target);
      owner.set(t.id, canonicalWorkspaceId(target));
    }
    return owner;
  }
  const records = (table, id) => {
    const ids = family(id),
      placeholders = ids.map(() => "?").join(",");
    return db
      .prepare(
        `SELECT workspace_id,payload FROM ${table} WHERE workspace_id IN (${placeholders}) ORDER BY rowid`,
      )
      .all(...ids)
      .map((r) => ({
        ...JSON.parse(r.payload),
        storedWorkspaceId: r.workspace_id,
        canonicalWorkspaceId: canonicalWorkspaceId(r.workspace_id),
      }));
  };
  function importedRecord(record, c) {
    const source = c.all.get(record.sourceAssetId);
    const sourceTopic = c.topics.find((t) => t.id === source?.topicId);
    const sourceRevision = sourceTopic?.revisions?.find(
      (r) => r.id === source?.revisionId,
    );
    const sourceLabel =
      sourceRevision?.assetLabels?.[source?.logicalUri || source?.displayPath];
    const target = db
      .prepare("SELECT payload FROM topics WHERE id=? AND workspace_id=?")
      .get(record.targetTopicId, record.workspaceId);
    const targetTitle = target ? JSON.parse(target.payload).title : null;
    return {
      ...record,
      title: record.displayTitle || sourceLabel || targetTitle || record.title,
      assets: record.assets.map((a) => ({
        ...a,
        coreStep:
          a.coreStep || c.all.get(a.provenance?.sourceAssetId)?.coreStep,
      })),
    };
  }
  function scopedCatalog(id) {
    id = canonicalWorkspaceId(id);
    const defs = definitions(),
      w = workspace(id),
      c = catalog();
    // A failed source rebuild may contain revoked registrations. It remains available to the
    // internal index, but cannot grant API access from an outdated ownership projection.
    if (c.index?.stale)
      fail(503, "STALE_CATALOG", "资料索引更新失败，暂停读取；修复清单后刷新");
    const owners = ownedTopics(c, defs);
    const topics = c.topics
      .filter((t) => owners.get(t.id) === id)
      .map((t) => ({ ...t, workspaceId: id }));
    for (const t of records("topics", id)) {
      if (c.topics.some((original) => original.id === t.id))
        fail(503, "TOPIC_COLLISION", "本地选题身份与历史记录冲突");
      topics.push({
        ...t,
        artifacts: [],
        revisions: [],
        reviews: [],
        metrics: [],
        comments: null,
        stages: [],
        workspaceId: id,
        collaboration: {
          ...t.collaboration,
          longTermGoal:
            w.positioning.purpose.value || "本账号的长期目的尚未确认",
          accountReaders: w.positioning.readers,
        },
      });
    }
    for (const saved of records("imports", id)) {
      const record = importedRecord(saved, c);
      const t = topics.find((t) => t.id === record.targetTopicId);
      if (!t) fail(503, "IMPORT_TOPIC_MISSING", "导入所属选题不存在");
      // Do not mutate original catalog arrays.
      t.artifacts = [...t.artifacts, ...record.assets];
      const revision = {
        id: record.id,
        label: "导入材料 · " + record.title,
        kind: record.kind,
        state: "candidate",
        artifactIds: record.assets.map((a) => a.id),
        coreIds: {},
        missingCores: [],
        inputRefs: [],
        inputCoreIds: {},
        previewIds: {},
        contextNotice:
          "本区冻结副本；未继承来源账号的审核、接受或发布。修改须另建本区版本。",
      };
      for (const a of record.assets)
        if (a.coreStep && !revision.coreIds[a.coreStep])
          revision.coreIds[a.coreStep] = a.id;
      t.revisions = [...t.revisions, revision];
      t[record.kind === "video" ? "currentVideo" : "currentReport"] = record.id;
    }
    // Project guidance belongs to historical context until explicitly imported, not to every account.
    const allowedDocs = new Set(
      topics.flatMap((t) => [
        ...(t.collaboration?.artifactUris || []),
        ...(t.collaboration?.sources || []).map((s) => s.path),
      ]),
    );
    const docs =
      id === "history-unassigned"
        ? c.docs
        : c.docs.filter(
            (a) =>
              allowedDocs.has(a.displayPath) || allowedDocs.has(a.logicalUri),
          );
    const all = new Map(
      [...docs, ...topics.flatMap((t) => t.artifacts)].map((a) => [a.id, a]),
    );
    const aliases = Object.fromEntries(
      Object.entries(c.aliases || {}).filter(([, target]) => all.has(target)),
    );
    const scoped = { ...c, topics, docs, all, aliases, workspace: w };
    const channelIds = new Set(
      (w.channels || (w.account ? [w.account] : [])).map((c) => c.accountId),
    );
    scoped.publication = {
      ...c.publication,
      items: (c.publication?.items || []).filter(
        (i) =>
          topics.some((t) => t.id === (i.topicId || i.topic_id)) &&
          (w.kind === "unassigned" || channelIds.has(i.account_id)),
      ),
    };
    return scoped;
  }
  function resolveAsset(workspaceId, assetId, expectedHash) {
    if (!assetPattern.test(assetId || ""))
      fail(400, "INVALID_ASSET", "资产必须使用已登记 ID");
    const c = scopedCatalog(workspaceId),
      a = c.all.get(c.aliases[assetId] || assetId);
    if (!a || !allowedPath(a.path))
      fail(404, "UNKNOWN_ASSET", "资产不属于当前工作区或已不可读");
    if (a.imported && hash(a.path) !== a.sha256)
      fail(409, "SNAPSHOT_CHANGED", "冻结导入文件已变更，不能冒充原版本");
    if (
      expectedHash !== undefined &&
      (!shaPattern.test(expectedHash) || hash(a.path) !== expectedHash)
    )
      fail(409, "STALE_VERSION", "来源版本已变化，请重新选择并核对后导入");
    return { catalog: c, asset: a };
  }
  function mutate(id, type, input, fn) {
    id = canonicalWorkspaceId(id);
    workspace(id);
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      !/^[a-zA-Z0-9_-]{8,100}$/.test(input.clientOperationId || "")
    )
      fail(400, "INVALID_OPERATION", "新操作需要独立操作 ID");
    const request = canonical({ type, input });
    const ids = family(id),
      placeholders = ids.map(() => "?").join(",");
    const priors = db
      .prepare(
        `SELECT request,payload FROM operations WHERE workspace_id IN (${placeholders}) AND operation_id=?`,
      )
      .all(...ids, input.clientOperationId);
    if (
      priors.length > 1 &&
      priors.some((p) => p.request !== priors[0].request)
    )
      fail(
        409,
        "OPERATION_CONFLICT",
        "合并前多个工作区使用了相同操作 ID 且内容不同",
      );
    const prior = priors[0];
    if (prior) {
      if (prior.request !== request)
        fail(409, "OPERATION_CONFLICT", "此操作 ID 已用于另一条内容");
      return { ...JSON.parse(prior.payload), replayed: true };
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.prepare("INSERT INTO operations VALUES(?,?,?,?)").run(
        id,
        input.clientOperationId,
        request,
        JSON.stringify(result),
      );
      db.exec("COMMIT");
      return { ...result, replayed: false };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  function fields(input, keys) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      fail(400, "INVALID_INPUT", "需要 JSON 对象");
    if (
      Object.keys(input).some(
        (k) => !["clientOperationId", ...keys].includes(k),
      )
    )
      fail(400, "INVALID_FIELD", "不支持额外字段或文件路径");
  }
  function newTopic(id, title) {
    const t = {
      id: "local-" + crypto.randomUUID(),
      title: cleanText(title, "选题标题", 180),
      direction:
        "本篇定位与用途待明确；导入材料不等于确认本账号的表达与发布方案",
      collaboration: {
        longTermGoal: "尚未确认",
        currentTask: "审阅导入材料，明确本账号要表达的内容",
      },
      currentReport: null,
      currentVideo: null,
    };
    db.prepare("INSERT INTO topics VALUES(?,?,?)").run(
      t.id,
      id,
      JSON.stringify(t),
    );
    return t;
  }
  function importAsset(id, input) {
    id = canonicalWorkspaceId(id);
    workspace(id);
    fields(input, [
      "sourceWorkspaceId",
      "sourceAssetId",
      "sourceHash",
      "companions",
      "targetTopicId",
      "targetTitle",
    ]);
    input = {
      ...input,
      sourceWorkspaceId: canonicalWorkspaceId(input.sourceWorkspaceId),
    };
    if (input.sourceWorkspaceId === id)
      fail(400, "SAME_WORKSPACE", "本区资产无需跨账号导入");
    // Scope and source checks happen before idempotent replay as well.
    const { asset: source, catalog: sourceCatalog } = resolveAsset(
      input.sourceWorkspaceId,
      input.sourceAssetId,
    );
    const target = scopedCatalog(id);
    if (
      input.targetTopicId &&
      !target.topics.some((t) => t.id === input.targetTopicId)
    )
      fail(404, "UNKNOWN_TOPIC", "目标选题必须属于当前工作区");
    return mutate(id, "import", input, () => {
      if (!shaPattern.test(input.sourceHash || ""))
        fail(400, "INVALID_HASH", "导入需绑定来源内容哈希");
      const companions = input.companions || [];
      if (!Array.isArray(companions) || companions.length > 30)
        fail(400, "INVALID_INPUT", "附属资产最多 30 份，需逐份明确选择");
      for (const companion of companions)
        if (
          !companion ||
          typeof companion !== "object" ||
          Array.isArray(companion) ||
          Object.keys(companion).some((k) => !["assetId", "hash"].includes(k))
        )
          fail(400, "INVALID_INPUT", "附属资产只能声明已登记 ID 和内容哈希");
      const selected = [
        { assetId: source.id, hash: input.sourceHash },
        ...companions,
      ];
      if (new Set(selected.map((s) => s.assetId)).size !== selected.length)
        fail(400, "INVALID_INPUT", "导入资产重复");
      const originals = selected.map(
        (s) => resolveAsset(input.sourceWorkspaceId, s.assetId, s.hash).asset,
      );
      if (
        originals.some((a) => fs.statSync(a.path).size > 512 * 1024 * 1024) ||
        originals.reduce((n, a) => n + fs.statSync(a.path).size, 0) >
          1024 * 1024 * 1024
      )
        fail(
          413,
          "IMPORT_TOO_LARGE",
          "本次导入超过本地复制范围（单份 512MB、合计 1GB）",
        );
      const t = input.targetTopicId
        ? target.topics.find((t) => t.id === input.targetTopicId)
        : newTopic(id, input.targetTitle || source.name);
      const importId = "import-" + crypto.randomUUID();
      const directory = path.join(storageDir, id, "imports", importId);
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      try {
        const assets = originals.map((a, i) => {
          const ext = /^[a-z0-9]{1,10}$/.test(a.ext) ? a.ext : "txt";
          const copyPath = path.join(directory, i + "." + ext);
          fs.copyFileSync(a.path, copyPath, fs.constants.COPYFILE_EXCL);
          fs.chmodSync(copyPath, 0o600);
          if (
            hash(copyPath) !== selected[i].hash ||
            hash(a.path) !== selected[i].hash
          )
            fail(409, "SOURCE_CHANGED", "复制时来源发生变化，未登记导入");
          const stat = fs.statSync(copyPath);
          return {
            id: digest(id + ":" + importId + ":" + a.id),
            topicId: t.id,
            revisionId: importId,
            name: a.name,
            ext,
            area: a.area || "research",
            stage: a.stage || "report",
            coreStep:
              a.coreStep ||
              (i === 0
                ? ["mp4", "mp3", "wav"].includes(ext)
                  ? "final"
                  : "report"
                : undefined),
            path: copyPath,
            displayPath: "本区导入/" + importId + "/" + a.name,
            logicalUri: "workspace-import://" + id + "/" + importId + "/" + i,
            size: stat.size,
            mtime: stat.mtime.toISOString(),
            sha256: selected[i].hash,
            imported: true,
            sourcePath: a.sourcePath || a.path,
            provenance: {
              sourceWorkspaceId: input.sourceWorkspaceId,
              sourceAssetId: a.id,
              sourceRevisionId: a.revisionId || null,
              sourceHash: selected[i].hash,
            },
          };
        });
        const sourceTopic = sourceCatalog.topics.find(
          (t) => t.id === source.topicId,
        );
        const sourceRevision = sourceTopic?.revisions?.find(
          (r) => r.id === source.revisionId,
        );
        const displayTitle =
          sourceRevision?.assetLabels?.[
            source.logicalUri || source.displayPath
          ] ||
          t.title ||
          source.name;
        const record = {
          id: importId,
          title: source.name,
          displayTitle,
          workspaceId: id,
          targetTopicId: t.id,
          sourceWorkspaceId: input.sourceWorkspaceId,
          sourceAssetId: source.id,
          sourceRevisionId: source.revisionId || null,
          sourceHash: input.sourceHash,
          kind:
            sourceCatalog.topics
              .find((t) => t.id === source.topicId)
              ?.revisions?.find((r) => r.id === source.revisionId)?.kind ===
              "video" || ["mp4", "mp3", "wav"].includes(source.ext)
              ? "video"
              : "report",
          createdAt: new Date().toISOString(),
          assets,
        };
        db.prepare("INSERT INTO imports VALUES(?,?,?,?)").run(
          importId,
          id,
          t.id,
          JSON.stringify(record),
        );
        return {
          import: {
            ...record,
            assets: assets.map(({ path, sourcePath, ...a }) => a),
          },
        };
      } catch (e) {
        fs.rmSync(directory, { recursive: true, force: true });
        throw e;
      }
    });
  }
  function saveCandidate(id, input) {
    id = canonicalWorkspaceId(id);
    fields(input, [
      "candidateId",
      "title",
      "url",
      "summary",
      "source",
      "status",
      "reason",
      "recommendedCarrier",
    ]);
    return mutate(id, "candidate", input, () => {
      const previous = input.candidateId
        ? (() => {
            const ids = family(id),
              placeholders = ids.map(() => "?").join(",");
            return db
              .prepare(
                `SELECT payload FROM candidates WHERE id=? AND workspace_id IN (${placeholders})`,
              )
              .get(input.candidateId, ...ids);
          })()
        : null;
      if (input.candidateId && !previous)
        fail(404, "UNKNOWN_CANDIDATE", "候选不属于当前账号");
      const old = previous ? JSON.parse(previous.payload) : null;
      const status = input.status || "inbox";
      if (
        !["inbox", "consider", "research", "hold", "discard"].includes(status)
      )
        fail(400, "INVALID_INPUT", "候选判断状态无效");
      const url = cleanText(input.url, "来源链接", 2000, true);
      if (url) {
        try {
          if (!["http:", "https:"].includes(new URL(url).protocol))
            throw Error();
        } catch {
          fail(400, "INVALID_URL", "只接受普通网页链接；不会自动访问");
        }
      }
      const reason = cleanText(input.reason, "判断理由", 2000, true);
      if (status !== "inbox" && !reason)
        fail(400, "REASON_REQUIRED", "请说明为什么值得研究、保留或舍弃");
      const at = new Date().toISOString();
      const item = {
        id: old?.id || crypto.randomUUID(),
        workspaceId: id,
        title: cleanText(input.title, "候选标题", 180),
        url,
        summary: cleanText(input.summary, "摘要", 4000, true),
        source: cleanText(input.source, "来源", 500, true),
        status,
        reason,
        recommendedCarrier: cleanText(
          input.recommendedCarrier,
          "载体建议",
          500,
          true,
        ),
        createdAt: old?.createdAt || at,
        updatedAt: at,
        judgments: [
          ...(old?.judgments || []),
          {
            status,
            reason,
            recommendedCarrier: input.recommendedCarrier || "",
            at,
          },
        ],
        collection: "manual",
      };
      db.prepare(
        "INSERT INTO candidates VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      ).run(item.id, id, JSON.stringify(item));
      return { candidate: item };
    });
  }
  return {
    definitions,
    canonicalWorkspaceId,
    family,
    catalog: scopedCatalog,
    workspace,
    summaries: () =>
      definitions().map((w) => ({
        id: w.id,
        canonicalWorkspaceId: w.id,
        aliases: w.aliases || [],
        topicIds: w.topicIds,
        name: w.name,
        kind: w.kind,
        channels: w.channels || (w.account ? [w.account] : []),
        platform: w.account?.platform || null,
        verification: w.account?.verification || null,
      })),
    resolveAsset,
    importAsset,
    saveCandidate,
    inventory: (id) => {
      const w = workspace(id),
        c = scopedCatalog(id);
      return {
        workspace: w,
        records: w.inventory || [],
        topics: c.topics.map((t) => ({
          id: t.id,
          title: t.title,
          assetCount: t.artifacts.length,
        })),
        imports: records("imports", id)
          .map((record) => importedRecord(record, catalog()))
          .map(({ assets, ...r }) => ({
            ...r,
            assets: assets.map(({ path, sourcePath, ...a }) => a),
          })),
        candidates: records("candidates", id),
      };
    },
    close: () => db.close(),
  };
}
