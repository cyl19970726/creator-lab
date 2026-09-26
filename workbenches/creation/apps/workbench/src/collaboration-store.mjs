import { stateRoot } from "./paths.mjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { root, safePath, hash } from "./catalog.mjs";

const textTypes = new Set(["md", "json", "txt", "srt", "html", "svg"]);
const shaPattern = /^[a-f0-9]{64}$/;
const actors = new Set(["user", "proxy", "agent", "technical"]);
const canonical = (v) =>
  JSON.stringify(v, (_, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map((k) => [k, x[k]]),
        )
      : x,
  );
export class CollaborationError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code, message) => {
  throw new CollaborationError(status, code, message);
};
function string(v, name, max = 10000) {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    fail(400, "INVALID_INPUT", `${name}缺失或过长`);
  return v;
}
function digest(v) {
  if (!shaPattern.test(v || ""))
    fail(400, "INVALID_HASH", "需要真实内容哈希，请刷新资产");
  return v;
}

export function createCollaborationStore({
  filename = process.env.TOKEN_COLLABORATION_PATH ||
    path.join(stateRoot, "collaboration.sqlite"),
  catalog,
  allowedPath = safePath,
  scopeRequired = false,
} = {}) {
  if (filename !== ":memory:")
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, topic_id TEXT NOT NULL, operation_id TEXT NOT NULL, request TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(topic_id,operation_id));
    CREATE TABLE IF NOT EXISTS versions (topic_id TEXT NOT NULL, asset_id TEXT NOT NULL, hash TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(topic_id,asset_id,hash));
    CREATE TABLE IF NOT EXISTS event_scopes(event_id TEXT PRIMARY KEY,topic_id TEXT NOT NULL,original_workspace_id TEXT NOT NULL,current_workspace_id TEXT NOT NULL,scope_snapshot TEXT NOT NULL,captured_at TEXT NOT NULL);
    PRAGMA user_version=1;`);
  if (filename !== ":memory:") fs.chmodSync(filename, 0o600);
  const hashes = new Map();
  const rows = (topicId) =>
    db
      .prepare("SELECT payload FROM events WHERE topic_id=? ORDER BY rowid")
      .all(topicId)
      .map((r) => JSON.parse(r.payload));
  function topicState(topicId, workspaceId) {
    if (scopeRequired && !workspaceId)
      fail(400, "WORKSPACE_REQUIRED", "请明确选择工作区");
    const c = catalog(workspaceId),
      topic = c.topics.find((t) => t.id === topicId);
    if (!topic) fail(404, "UNKNOWN_TOPIC", "选题不存在");
    const docs = new Set([
      ...(topic.collaboration?.sources || []).map((s) => s.path),
      ...(topic.collaboration?.artifactUris || []),
    ]);
    const assets = new Map((topic.artifacts || []).map((a) => [a.id, a]));
    for (const a of c.docs || [])
      if (docs.has(a.displayPath) || docs.has(a.name)) assets.set(a.id, a);
    const resolve = (id) => {
      if (typeof id !== "string" || !/^[a-f0-9]{24}$/.test(id))
        fail(400, "INVALID_ASSET", "资产必须使用已登记 ID");
      const a = assets.get(c.aliases?.[id] || id);
      if (!a || !allowedPath(a.path))
        fail(404, "UNKNOWN_ASSET", "资产不存在或不属于此选题");
      return a;
    };
    return { topic, assets, resolve };
  }
  function inspect(a, includeText = true) {
    if (!allowedPath(a.path)) fail(404, "UNKNOWN_ASSET", "资产不在允许范围");
    const stat = fs.statSync(a.path);
    if (!stat.isFile()) fail(404, "UNKNOWN_ASSET", "资产不是文件");
    const key = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
    let cached = hashes.get(a.path);
    if (!cached || cached.key !== key) {
      cached = { key, hash: hash(a.path) };
      hashes.set(a.path, cached);
    }
    if (a.imported && cached.hash !== a.sha256)
      fail(409, "SNAPSHOT_CHANGED", "冻结导入文件已变更，不能继续审阅为原版本");
    const text =
      includeText && textTypes.has(a.ext) && stat.size <= 2 * 1024 * 1024
        ? fs.readFileSync(a.path, "utf8")
        : null;
    // Detect a writer changing the file while it is being inspected.
    const after = fs.statSync(a.path);
    if (`${after.size}:${after.mtimeMs}:${after.ctimeMs}:${after.ino}` !== key)
      fail(409, "ASSET_CHANGING", "资产正在修改，请刷新重试");
    return {
      assetId: a.id,
      hash: cached.hash,
      name: a.name,
      ext: a.ext,
      size: stat.size,
      text,
      recordedAt: new Date().toISOString(),
    };
  }
  function savedVersion(topicId, assetId, expectedHash) {
    const r = db
      .prepare(
        "SELECT payload FROM versions WHERE topic_id=? AND asset_id=? AND hash=?",
      )
      .get(topicId, assetId, expectedHash);
    return r ? JSON.parse(r.payload) : null;
  }
  function versionFor(topicId, a, expectedHash, allowSaved = false) {
    if (allowSaved) {
      const saved = savedVersion(topicId, a.id, expectedHash);
      if (saved) return saved;
    }
    const version = inspect(a);
    if (version.hash !== expectedHash)
      fail(
        409,
        "STALE_VERSION",
        "文件已更新；旧版记录保留，请刷新后审阅当前版本",
      );
    return version;
  }
  function authorization(topic) {
    const grant = topic.collaboration?.proxyAuthorization;
    return {
      proxyMayAdvance:
        grant?.enabled === true &&
        typeof grant.source === "string" &&
        !!grant.source.trim(),
      source: grant?.source || null,
      notice: "来源为本机自报记录；代理接受不等于用户本人确认",
    };
  }
  function append(topicId, input, workspaceId) {
    const state = topicState(topicId, workspaceId);
    if (!input || typeof input !== "object" || Array.isArray(input))
      fail(400, "INVALID_INPUT", "需要 JSON 对象");
    string(input.clientOperationId, "操作ID", 100);
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(input.clientOperationId))
      fail(400, "INVALID_OPERATION", "每次新操作需要唯一操作 ID");
    const request = canonical(input);
    const previous = db
      .prepare(
        "SELECT request,payload FROM events WHERE topic_id=? AND operation_id=?",
      )
      .get(topicId, input.clientOperationId);
    if (previous) {
      if (previous.request !== request)
        fail(
          409,
          "OPERATION_CONFLICT",
          "这个操作 ID 已用于另一条内容，请为新操作生成新 ID",
        );
      return { event: JSON.parse(previous.payload), replayed: true };
    }
    const extras = {
      feedback: [],
      response: ["feedbackId", "status"],
      revision: ["parent", "feedbackIds", "impactAssetIds"],
      decision: ["verdict", "advance"],
    };
    if (!Object.hasOwn(extras, input.type))
      fail(400, "INVALID_TYPE", "不支持的事件类型");
    const allowed = new Set([
      "clientOperationId",
      "type",
      "actor",
      "assetId",
      "expectedHash",
      "location",
      "text",
      "scope",
      "stepId",
      ...extras[input.type],
    ]);
    if (Object.keys(input).some((k) => !allowed.has(k)))
      fail(400, "INVALID_FIELD", "事件含未支持字段，不接受文件路径或额外授权");
    if (!actors.has(input.actor))
      fail(400, "INVALID_ACTOR", "请选择用户、代理、执行者或技术审阅来源");
    string(input.text, "说明");
    digest(input.expectedHash);
    if (!input.scope || !["whole", "partial"].includes(input.scope.kind))
      fail(400, "INVALID_SCOPE", "请记录整体或局部范围");
    string(input.scope.label, "范围说明", 1000);
    if (Object.keys(input.scope).some((k) => !["kind", "label"].includes(k)))
      fail(400, "INVALID_SCOPE", "范围字段不支持");
    if (
      input.stepId !== undefined &&
      !/^(A[123]|B[123]|C[12])$/.test(input.stepId)
    )
      fail(400, "INVALID_STEP", "步骤应为 A1 至 C2");
    const loc = input.location;
    if (
      !loc ||
      !["file", "quote", "time"].includes(loc.kind) ||
      Object.keys(loc).some(
        (k) => !["kind", "quote", "label", "seconds"].includes(k),
      )
    )
      fail(400, "INVALID_LOCATION", "请提供文件级或原文引用位置");
    if (loc.label !== undefined) string(loc.label, "位置说明", 200);
    const a = state.resolve(input.assetId),
      history = rows(topicId);
    const event = {
      ...input,
      assetId: a.id,
      id: crypto.randomUUID(),
      topicId,
      at: new Date().toISOString(),
    };
    const versions = [];
    let target;
    if (input.type === "response") {
      const feedback = history.find(
        (e) => e.id === input.feedbackId && e.type === "feedback",
      );
      if (
        !feedback ||
        feedback.assetId !== a.id ||
        feedback.expectedHash !== input.expectedHash
      )
        fail(400, "INVALID_FEEDBACK", "回复必须对应原意见及其版本");
      if (!["open", "addressed", "resolved"].includes(input.status))
        fail(400, "INVALID_STATUS", "意见状态不正确");
      target = versionFor(topicId, a, input.expectedHash, true);
    } else target = versionFor(topicId, a, input.expectedHash);
    versions.push(target);
    if (loc.kind === "quote") {
      if (loc.seconds !== undefined)
        fail(400, "INVALID_LOCATION", "原文引用不接受媒体时间点");
      string(loc.quote, "原文引用", 5000);
      if (target.text === null || !target.text.includes(loc.quote))
        fail(
          400,
          "UNVERIFIED_LOCATION",
          "引用不在该版可保存正文中，请刷新或使用文件级位置",
        );
    } else if (loc.kind === "time") {
      if (
        !Number.isFinite(loc.seconds) ||
        loc.seconds < 0 ||
        !["mp4", "mp3", "wav"].includes(a.ext) ||
        loc.quote !== undefined
      )
        fail(400, "INVALID_LOCATION", "时间点须为音视频的非负秒数");
    } else if (loc.quote !== undefined || loc.seconds !== undefined)
      fail(400, "INVALID_LOCATION", "文件级位置不能伪带精确引用");
    if (input.type === "revision") {
      if (
        !input.parent ||
        Object.keys(input.parent).some((k) => !["assetId", "hash"].includes(k))
      )
        fail(400, "INVALID_PARENT", "需要父版本 ID 与哈希");
      const parent = state.resolve(input.parent.assetId);
      digest(input.parent.hash);
      if (input.parent.hash === target.hash)
        fail(400, "UNCHANGED_VERSION", "修订必须登记实际不同版本");
      versions.push(versionFor(topicId, parent, input.parent.hash, true));
      event.parent = { assetId: parent.id, hash: input.parent.hash };
      if (
        !Array.isArray(input.feedbackIds) ||
        input.feedbackIds.length > 100 ||
        !Array.isArray(input.impactAssetIds) ||
        input.impactAssetIds.length > 100
      )
        fail(400, "INVALID_REVISION", "修订需提供意见和影响资产列表");
      for (const id of input.feedbackIds) {
        const feedback = history.find(
          (e) => e.id === id && e.type === "feedback",
        );
        if (
          !feedback ||
          feedback.assetId !== parent.id ||
          feedback.expectedHash !== input.parent.hash
        )
          fail(400, "INVALID_FEEDBACK", "关联意见必须来自父版本");
      }
      event.feedbackIds = [...new Set(input.feedbackIds)];
      event.impactAssetIds = [
        ...new Set(input.impactAssetIds.map((id) => state.resolve(id).id)),
      ];
    }
    if (input.type === "decision") {
      if (
        !["accept", "return"].includes(input.verdict) ||
        typeof input.advance !== "boolean" ||
        (input.verdict === "return" && input.advance)
      )
        fail(400, "INVALID_DECISION", "决定应为接受或退回，并明确是否继续");
      const grant = authorization(state.topic);
      if (
        input.advance &&
        !(
          input.actor === "user" ||
          (input.actor === "proxy" && grant.proxyMayAdvance)
        )
      )
        fail(
          403,
          "NO_ADVANCE_AUTHORITY",
          "该来源没有代理推进授权，仍可保存审阅意见",
        );
      event.authorizationSource =
        input.actor === "proxy" && input.advance ? grant.source : null;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const v of versions)
        db.prepare("INSERT OR IGNORE INTO versions VALUES(?,?,?,?)").run(
          topicId,
          v.assetId,
          v.hash,
          JSON.stringify(v),
        );
      db.prepare("INSERT INTO events VALUES(?,?,?,?,?)").run(
        event.id,
        topicId,
        input.clientOperationId,
        request,
        JSON.stringify(event),
      );
      const snapshot = {
        workspaceId,
        topicId,
        assetId: event.assetId,
        expectedHash: event.expectedHash,
        scope: event.scope,
      };
      db.prepare("INSERT INTO event_scopes VALUES(?,?,?,?,?,?)").run(
        event.id,
        topicId,
        workspaceId || "history-unassigned",
        workspaceId || "history-unassigned",
        JSON.stringify(snapshot),
        event.at,
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      const concurrent = db
        .prepare(
          "SELECT request,payload FROM events WHERE topic_id=? AND operation_id=?",
        )
        .get(topicId, input.clientOperationId);
      if (concurrent?.request === request)
        return { event: JSON.parse(concurrent.payload), replayed: true };
      if (concurrent)
        fail(409, "OPERATION_CONFLICT", "这个操作 ID 已用于另一条内容");
      throw e;
    }
    return { event, replayed: false };
  }
  function read(topicId, selectedId, workspaceId) {
    const state = topicState(topicId, workspaceId),
      rawEvents = rows(topicId),
      events = rawEvents.map((event) => {
        const row = db
          .prepare("SELECT * FROM event_scopes WHERE event_id=?")
          .get(event.id);
        return {
          ...event,
          originalAttribution: row
            ? { workspaceId: row.original_workspace_id, topicId }
            : null,
          currentAttribution: { workspaceId, topicId },
          scopeSnapshot: row ? JSON.parse(row.scope_snapshot) : null,
          scopeChanged: !!row && row.original_workspace_id !== workspaceId,
        };
      });
    const ids = new Set(
      events
        .flatMap((e) => [
          e.assetId,
          ...(e.impactAssetIds || []),
          e.parent?.assetId,
        ])
        .filter(Boolean),
    );
    if (selectedId) ids.add(state.resolve(selectedId).id);
    const assets = [...state.assets.values()].map((a) => {
      let currentHash = null,
        available = false;
      try {
        available = !!allowedPath(a.path) && fs.statSync(a.path).isFile();
        if (available && ids.has(a.id)) currentHash = inspect(a, false).hash;
      } catch {
        available = false;
      }
      return {
        id: a.id,
        name: a.name,
        displayPath: a.displayPath || a.logicalUri,
        revisionId: a.revisionId || null,
        coreStep: a.coreStep || null,
        current: [state.topic.currentReport, state.topic.currentVideo].includes(
          a.revisionId,
        ),
        hash: currentHash,
        available,
      };
    });
    const live = new Map(assets.map((a) => [a.id, a]));
    const stale = (e) => live.get(e.assetId)?.hash !== e.expectedHash;
    const opinions = events
      .filter((e) => e.type === "feedback")
      .map((e) => {
        const responses = events.filter(
          (r) => r.type === "response" && r.feedbackId === e.id,
        );
        const revisions = events.filter(
          (r) => r.type === "revision" && r.feedbackIds.includes(e.id),
        );
        const changes = events.filter(
          (r) =>
            (r.type === "response" && r.feedbackId === e.id) ||
            (r.type === "revision" && r.feedbackIds.includes(e.id)),
        );
        const last = changes.at(-1);
        return {
          ...e,
          status:
            last?.type === "response"
              ? last.status
              : last
                ? "addressed"
                : "open",
          responses,
          revisionIds: revisions.map((r) => r.id),
          stale: stale(e),
        };
      });
    const decisions = events
      .filter((e) => e.type === "decision")
      .map((e) => {
        const later = events.slice(events.findIndex((x) => x.id === e.id) + 1);
        const superseded = later.some(
          (x) =>
            x.type === "decision" &&
            x.assetId === e.assetId &&
            (x.actor === e.actor || x.verdict === "return") &&
            (x.scope.kind === "whole" ||
              (e.scope.kind === "whole" && x.verdict === "return") ||
              canonical(x.scope) === canonical(e.scope)),
        );
        const affected = later.some(
          (x) =>
            x.type === "revision" &&
            (x.parent.assetId === e.assetId ||
              x.impactAssetIds.includes(e.assetId)),
        );
        const isStale = stale(e) || affected || superseded;
        return {
          ...e,
          stale: isStale,
          superseded,
          affected,
          canProceed:
            !isStale &&
            e.verdict === "accept" &&
            e.advance &&
            (e.actor === "user" ||
              (e.actor === "proxy" && !!e.authorizationSource)),
          userConfirmed:
            e.actor === "user" && !isStale && e.verdict === "accept",
        };
      });
    return {
      schemaVersion: 1,
      topicId,
      context: {
        direction: state.topic.direction || "",
        ...(state.topic.collaboration || {}),
      },
      authorization: authorization(state.topic),
      assets,
      events: rawEvents,
      eventAttributions: Object.fromEntries(
        events.map((event) => [
          event.id,
          {
            originalAttribution: event.originalAttribution,
            currentAttribution: event.currentAttribution,
            scopeSnapshot: event.scopeSnapshot,
            scopeChanged: event.scopeChanged,
          },
        ]),
      ),
      opinions,
      decisions,
      revisions: events.filter((e) => e.type === "revision"),
      versions: db
        .prepare("SELECT payload FROM versions WHERE topic_id=? ORDER BY rowid")
        .all(topicId)
        .map((r) => JSON.parse(r.payload)),
    };
  }
  function migrateReviewScopes(
    legacyOwnership,
    currentOwnership = legacyOwnership,
  ) {
    if (!legacyOwnership || typeof legacyOwnership !== "object")
      fail(400, "INVALID_MIGRATION", "需要显式历史归属映射");
    db.exec("BEGIN IMMEDIATE");
    try {
      let inserted = 0;
      for (const event of db
        .prepare("SELECT id,topic_id,payload FROM events ORDER BY rowid")
        .all()) {
        const payload = JSON.parse(event.payload),
          original = legacyOwnership[event.topic_id];
        if (!original)
          fail(
            409,
            "MISSING_LEGACY_SCOPE",
            `缺少 ${event.topic_id} 的历史归属`,
          );
        const snapshot = {
          workspaceId: original,
          topicId: event.topic_id,
          assetId: payload.assetId,
          expectedHash: payload.expectedHash,
          scope: payload.scope,
        };
        const result = db
          .prepare("INSERT OR IGNORE INTO event_scopes VALUES(?,?,?,?,?,?)")
          .run(
            event.id,
            event.topic_id,
            original,
            currentOwnership[event.topic_id] || original,
            JSON.stringify(snapshot),
            new Date().toISOString(),
          );
        inserted += Number(result.changes);
      }
      db.exec("COMMIT");
      return {
        inserted,
        total: db.prepare("SELECT count(*) n FROM events").get().n,
      };
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  function updateCurrentAttribution(topicId, workspaceId) {
    db.prepare(
      "UPDATE event_scopes SET current_workspace_id=? WHERE topic_id=?",
    ).run(workspaceId, topicId);
  }
  return {
    append,
    read,
    migrateReviewScopes,
    updateCurrentAttribution,
    close: () => db.close(),
  };
}
