import { DatabaseSync } from "node:sqlite";
const actors = new Set(["user", "proxy", "agent", "technical"]);
const fail = (status, code, message, details) => {
  const e = new Error(message);
  Object.assign(e, { status, code, details });
  throw e;
};
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
const clean = (v, n, max = 8000, optional = false) => {
  if (optional && (v === undefined || v === null || v === "")) return "";
  if (typeof v !== "string" || !v.trim() || v.length > max)
    fail(400, "INVALID_INPUT", `${n}缺失或过长`);
  return v.trim();
};
const profile = () =>
  Object.fromEntries(
    ["purpose", "readers", "promise"].map((k) => [
      k,
      { value: "", status: "unknown", sources: [] },
    ]),
  );
const summaryFields = () => ({
  currentCommitment: "",
  currentStageGoal: "",
  currentTask: "",
  currentActor: "",
  recent: "",
  result: "",
  next: "",
  unresolved: "",
});
export function createIntegrationStore({ filename, workspaceStore }) {
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS identity_profiles(workspace_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,payload TEXT NOT NULL,actor TEXT NOT NULL,updated_at TEXT NOT NULL,operation_id TEXT NOT NULL UNIQUE);
 CREATE TABLE IF NOT EXISTS identity_profile_versions(workspace_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,actor TEXT NOT NULL,updated_at TEXT NOT NULL,operation_id TEXT NOT NULL UNIQUE,PRIMARY KEY(workspace_id,revision));
 CREATE TABLE IF NOT EXISTS collaboration_summaries(workspace_id TEXT NOT NULL,topic_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,actor TEXT NOT NULL,updated_at TEXT NOT NULL,operation_id TEXT NOT NULL UNIQUE,PRIMARY KEY(workspace_id,topic_id));
 CREATE TABLE IF NOT EXISTS collaboration_summary_versions(workspace_id TEXT NOT NULL,topic_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,actor TEXT NOT NULL,updated_at TEXT NOT NULL,operation_id TEXT NOT NULL UNIQUE,PRIMARY KEY(workspace_id,topic_id,revision));
 CREATE TABLE IF NOT EXISTS integration_operations(workspace_id TEXT NOT NULL,operation_id TEXT NOT NULL,kind TEXT NOT NULL,request TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(workspace_id,operation_id));`);
  const resolve = (id) => workspaceStore.canonicalWorkspaceId(id);
  const operation = (v) => {
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(v || ""))
      fail(400, "INVALID_OPERATION", "新操作需要独立操作 ID");
    return v;
  };
  function identity(id) {
    const target = resolve(id),
      base = workspaceStore.workspace(target),
      row = db
        .prepare("SELECT * FROM identity_profiles WHERE workspace_id=?")
        .get(target);
    return {
      id: target,
      canonicalWorkspaceId: target,
      aliases: workspaceStore.family(target).filter((x) => x !== target),
      name: base.name,
      kind: base.kind,
      channels: base.channels || (base.account ? [base.account] : []),
      positioning: row
        ? JSON.parse(row.payload)
        : { ...profile(), ...(base.positioning || {}) },
      history: db
        .prepare(
          "SELECT revision,payload,actor,updated_at FROM identity_profile_versions WHERE workspace_id=? ORDER BY revision DESC",
        )
        .all(target)
        .map((r) => ({
          revision: r.revision,
          positioning: JSON.parse(r.payload),
          actorType: r.actor,
          updatedAt: r.updated_at,
        })),
      positioningRevision: row?.revision || 0,
      updatedBy: row?.actor || null,
      updatedAt: row?.updated_at || null,
    };
  }
  function mutate(id, kind, input, fn) {
    const target = resolve(id),
      operationId = operation(input?.clientOperationId),
      request = canonical({ kind, input }),
      prior = db
        .prepare(
          "SELECT request,payload FROM integration_operations WHERE workspace_id=? AND operation_id=?",
        )
        .get(target, operationId);
    if (prior) {
      if (prior.request !== request)
        fail(409, "OPERATION_CONFLICT", "此操作 ID 已用于另一条内容");
      return { ...JSON.parse(prior.payload), replayed: true };
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn(target, operationId);
      db.prepare("INSERT INTO integration_operations VALUES(?,?,?,?,?)").run(
        target,
        operationId,
        kind,
        request,
        JSON.stringify(result),
      );
      db.exec("COMMIT");
      return { ...result, replayed: false };
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  function saveIdentity(id, input) {
    return mutate(id, "identity", input, (target, operationId) => {
      const current = identity(target),
        actor = input.actorType || input.actor;
      if (!actors.has(actor))
        fail(400, "INVALID_ACTOR", "请选择用户、代理、执行者或技术审阅来源");
      if (input.expectedRevision !== current.positioningRevision)
        fail(409, "STALE_POSITIONING", "账号定位已更新，请刷新后重试", {
          current,
        });
      const keys = ["purpose", "readers", "promise"];
      if (
        !input.positioning ||
        Object.keys(input.positioning).some((k) => !keys.includes(k))
      )
        fail(400, "INVALID_POSITIONING", "定位字段不正确");
      const positioning = {};
      for (const key of keys) {
        const item = input.positioning[key];
        if (
          !item ||
          !["confirmed", "proposed", "unknown"].includes(item.status) ||
          !Array.isArray(item.sources)
        )
          fail(400, "INVALID_POSITIONING", "定位须记录状态和来源");
        const value =
          item.status === "unknown" ? "" : clean(item.value, key, 4000);
        if (
          actor !== "user" &&
          item.status === "confirmed" &&
          !(
            current.positioning[key]?.status === "confirmed" &&
            current.positioning[key]?.value === value
          )
        )
          fail(
            403,
            "CONFIRMATION_REQUIRES_USER",
            "代理、执行者或技术来源只能提出定位建议，不能新增或改变用户确认",
          );
        positioning[key] = {
          value,
          status: item.status,
          sources: item.sources,
        };
      }
      const revision = current.positioningRevision + 1,
        at = new Date().toISOString();
      db.prepare(
        "INSERT INTO identity_profile_versions VALUES(?,?,?,?,?,?)",
      ).run(
        target,
        revision,
        JSON.stringify(positioning),
        actor,
        at,
        `${target}:${operationId}`,
      );
      db.prepare(
        `INSERT INTO identity_profiles VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,actor=excluded.actor,updated_at=excluded.updated_at,operation_id=excluded.operation_id`,
      ).run(
        target,
        revision,
        JSON.stringify(positioning),
        actor,
        at,
        `${target}:${operationId}`,
      );
      return {
        identity: {
          ...identity(target),
          positioning,
          positioningRevision: revision,
          updatedBy: actor,
          updatedAt: at,
        },
      };
    });
  }
  function summary(id, topicId) {
    const target = resolve(id),
      topic = workspaceStore
        .catalog(target)
        .topics.find((t) => t.id === topicId);
    if (!topic) fail(404, "UNKNOWN_TOPIC", "选题不属于当前工作区");
    const row = db
        .prepare(
          "SELECT * FROM collaboration_summaries WHERE workspace_id=? AND topic_id=?",
        )
        .get(target, topicId),
      c = topic.collaboration || {},
      fallback = {
        currentCommitment:
          c.currentCommitment || c.longTermGoal || topic.direction || "",
        currentStageGoal: c.currentStageGoal || "",
        currentTask: c.currentTask || "",
        currentActor: c.currentActor || "",
        recent: c.recent || "",
        result: c.result || "",
        next: c.next || "",
        unresolved: c.unresolved || "",
      };
    return {
      workspaceId: target,
      topicId,
      history: db
        .prepare(
          "SELECT revision,payload,actor,updated_at FROM collaboration_summary_versions WHERE workspace_id=? AND topic_id=? ORDER BY revision DESC",
        )
        .all(target, topicId)
        .map((r) => ({
          revision: r.revision,
          fields: JSON.parse(r.payload),
          actorType: r.actor,
          updatedAt: r.updated_at,
        })),
      revision: row?.revision || 0,
      fields: row
        ? JSON.parse(row.payload)
        : { ...summaryFields(), ...fallback },
      updatedBy: row?.actor || null,
      updatedAt: row?.updated_at || null,
    };
  }
  function saveSummary(id, topicId, input) {
    return mutate(id, `summary:${topicId}`, input, (target, operationId) => {
      const actor = input.actorType || input.actor;
      if (!actors.has(actor))
        fail(400, "INVALID_ACTOR", "请选择用户、代理、执行者或技术审阅来源");
      const current = summary(target, topicId);
      if (input.expectedRevision !== current.revision)
        fail(409, "STALE_SUMMARY", "协作摘要已更新，请刷新后重试", { current });
      const keys = Object.keys(summaryFields());
      if (
        !input.fields ||
        Object.keys(input.fields).some((k) => !keys.includes(k))
      )
        fail(400, "INVALID_SUMMARY", "摘要字段不正确");
      const fields = Object.fromEntries(
          keys.map((k) => [k, clean(input.fields[k], k, 8000, true)]),
        ),
        revision = current.revision + 1,
        at = new Date().toISOString();
      db.prepare(
        "INSERT INTO collaboration_summary_versions VALUES(?,?,?,?,?,?,?)",
      ).run(
        target,
        topicId,
        revision,
        JSON.stringify(fields),
        actor,
        at,
        `${target}:${operationId}`,
      );
      db.prepare(
        `INSERT INTO collaboration_summaries VALUES(?,?,?,?,?,?,?) ON CONFLICT(workspace_id,topic_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,actor=excluded.actor,updated_at=excluded.updated_at,operation_id=excluded.operation_id`,
      ).run(
        target,
        topicId,
        revision,
        JSON.stringify(fields),
        actor,
        at,
        `${target}:${operationId}`,
      );
      return {
        summary: {
          workspaceId: target,
          topicId,
          revision,
          fields,
          updatedBy: actor,
          updatedAt: at,
        },
      };
    });
  }
  function catalog(id) {
    const base = workspaceStore.catalog(id),
      positioning = identity(id).positioning;
    return {
      ...base,
      workspace: { ...base.workspace, positioning },
      topics: base.topics.map((topic) => {
        const saved = summary(id, topic.id);
        return {
          ...topic,
          collaboration: {
            ...(topic.collaboration || {}),
            ...saved.fields,
            summaryRevision: saved.revision,
            summaryUpdatedAt: saved.updatedAt,
            updatedAt: saved.updatedAt || topic.collaboration?.updatedAt,
          },
        };
      }),
    };
  }
  return {
    identity,
    saveIdentity,
    summary,
    saveSummary,
    catalog,
    close: () => db.close(),
  };
}
