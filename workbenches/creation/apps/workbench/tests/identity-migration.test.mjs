import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateUnifiedIdentities } from "../src/identity-migration.mjs";
function setup(minimaxOwner = "history-unassigned") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "identity-migrate-"));
  const collaborationPath = path.join(dir, "c.sqlite"),
    workspacePath = path.join(dir, "w.sqlite");
  const c = new DatabaseSync(collaborationPath),
    w = new DatabaseSync(workspacePath);
  c.exec("CREATE TABLE events(id TEXT PRIMARY KEY,topic_id TEXT,payload TEXT)");
  w.exec(
    "CREATE TABLE topic_ownership(topic_id TEXT PRIMARY KEY,workspace_id TEXT);CREATE TABLE topics(id TEXT PRIMARY KEY,workspace_id TEXT,payload TEXT)",
  );
  w.prepare("INSERT INTO topic_ownership VALUES(?,?)").run(
    "deepseek-v4-flash",
    "history-unassigned",
  );
  w.prepare("INSERT INTO topic_ownership VALUES(?,?)").run(
    "minimax-h3",
    minimaxOwner,
  );
  c.prepare("INSERT INTO events VALUES(?,?,?)").run(
    "event-1",
    "deepseek-v4-flash",
    JSON.stringify({
      assetId: "a",
      expectedHash: "hash",
      scope: { kind: "partial", label: "sound" },
      text: "original bytes",
    }),
  );
  c.close();
  w.close();
  return { dir, collaborationPath, workspacePath };
}
test("migration is idempotent and keeps original event payload and scope", () => {
  const f = setup();
  try {
    const first = migrateUnifiedIdentities(f),
      second = migrateUnifiedIdentities(f);
    assert.deepEqual(second, first);
    const c = new DatabaseSync(f.collaborationPath);
    const payload = c.prepare("SELECT payload FROM events").get().payload;
    assert.equal(JSON.parse(payload).text, "original bytes");
    assert.equal(
      c.prepare("SELECT original_workspace_id FROM event_scopes").get()
        .original_workspace_id,
      "history-unassigned",
    );
    c.close();
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
test("failed migration validation rolls back ownership and new scopes", () => {
  const f = setup("unexpected");
  try {
    assert.throws(() => migrateUnifiedIdentities(f), /迁移验收失败/);
    const w = new DatabaseSync(f.workspacePath),
      c = new DatabaseSync(f.collaborationPath);
    assert.equal(
      w
        .prepare(
          "SELECT workspace_id FROM topic_ownership WHERE topic_id='deepseek-v4-flash'",
        )
        .get().workspace_id,
      "history-unassigned",
    );
    assert.equal(
      c
        .prepare(
          "SELECT count(*) n FROM sqlite_master WHERE name='event_scopes'",
        )
        .get().n,
      0,
    );
    w.close();
    c.close();
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});
