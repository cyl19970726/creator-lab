import { DatabaseSync } from "node:sqlite";

// Explicit, idempotent migration. Call only against backups/temp copies first.
export function migrateUnifiedIdentities({ collaborationPath, workspacePath }) {
  const db = new DatabaseSync(collaborationPath);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    db.prepare("ATTACH DATABASE ? AS workspace").run(workspacePath);
    db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS event_scopes(event_id TEXT PRIMARY KEY,topic_id TEXT NOT NULL,original_workspace_id TEXT NOT NULL,current_workspace_id TEXT NOT NULL,scope_snapshot TEXT NOT NULL,captured_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workspace.ownership_events(id TEXT PRIMARY KEY,topic_id TEXT NOT NULL,from_workspace_id TEXT NOT NULL,to_workspace_id TEXT NOT NULL,scope_snapshot TEXT NOT NULL,created_at TEXT NOT NULL,operation_id TEXT NOT NULL UNIQUE);
    INSERT OR IGNORE INTO event_scopes
      SELECT e.id,e.topic_id,
        CASE WHEN e.topic_id IN ('deepseek-v4-flash','minimax-h3') THEN 'history-unassigned'
          ELSE COALESCE((SELECT workspace_id FROM workspace.topics WHERE id=e.topic_id),'history-unassigned') END,
        CASE WHEN e.topic_id='deepseek-v4-flash' THEN 'token-economics'
          WHEN COALESCE((SELECT workspace_id FROM workspace.topics WHERE id=e.topic_id),'') IN ('token-xiaohongshu','token-douyin','token-channels') THEN 'token-economics'
          WHEN COALESCE((SELECT workspace_id FROM workspace.topics WHERE id=e.topic_id),'') IN ('hhh-xiaohongshu','hhh-douyin','hhh-channels') THEN 'hhh'
          ELSE 'history-unassigned' END,
        json_object('workspaceId',CASE WHEN e.topic_id IN ('deepseek-v4-flash','minimax-h3') THEN 'history-unassigned' ELSE COALESCE((SELECT workspace_id FROM workspace.topics WHERE id=e.topic_id),'history-unassigned') END,'topicId',e.topic_id,'assetId',json_extract(e.payload,'$.assetId'),'expectedHash',json_extract(e.payload,'$.expectedHash'),'scope',json_extract(e.payload,'$.scope')),
        strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM events e;
    INSERT OR IGNORE INTO workspace.ownership_events
      VALUES('migration-deepseek-token','deepseek-v4-flash','history-unassigned','token-economics',
        json_object('eventCount',(SELECT count(*) FROM events WHERE topic_id='deepseek-v4-flash'),'originalWorkspaceId','history-unassigned'),
        strftime('%Y-%m-%dT%H:%M:%fZ','now'),'migration-deepseek-token-v1');
    UPDATE workspace.topic_ownership SET workspace_id='token-economics' WHERE topic_id='deepseek-v4-flash' AND workspace_id='history-unassigned';`);
    const result = {
      events: db.prepare("SELECT count(*) n FROM events").get().n,
      scoped: db.prepare("SELECT count(*) n FROM event_scopes").get().n,
      deepseekOwner: db
        .prepare(
          "SELECT workspace_id FROM workspace.topic_ownership WHERE topic_id='deepseek-v4-flash'",
        )
        .get()?.workspace_id,
      minimaxOwner: db
        .prepare(
          "SELECT workspace_id FROM workspace.topic_ownership WHERE topic_id='minimax-h3'",
        )
        .get()?.workspace_id,
    };
    const invalid = db
      .prepare(
        `SELECT count(*) n FROM events e LEFT JOIN event_scopes s ON s.event_id=e.id
    WHERE s.event_id IS NULL OR s.topic_id<>e.topic_id
      OR json_extract(s.scope_snapshot,'$.assetId') IS NOT json_extract(e.payload,'$.assetId')
      OR json_extract(s.scope_snapshot,'$.expectedHash') IS NOT json_extract(e.payload,'$.expectedHash')
      OR (e.topic_id='deepseek-v4-flash' AND s.current_workspace_id<>'token-economics')
      OR (e.topic_id='minimax-h3' AND s.current_workspace_id<>'history-unassigned')`,
      )
      .get().n;

    if (
      invalid > 0 ||
      result.events !== result.scoped ||
      result.deepseekOwner !== "token-economics" ||
      result.minimaxOwner !== "history-unassigned"
    )
      throw new Error("迁移验收失败：事件范围或选题归属不完整");
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    db.close();
  }
}
