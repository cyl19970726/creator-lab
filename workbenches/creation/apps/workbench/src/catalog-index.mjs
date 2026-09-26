import { stateRoot } from "./paths.mjs";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildCatalog, root } from "./catalog.mjs";
// This database is a disposable projection. Source files remain authoritative.
export function createCatalogIndex({
  filename = process.env.TOKEN_INDEX_PATH ||
    path.join(stateRoot, "index.sqlite"),
  build = buildCatalog,
  intervalMs = 15000,
} = {}) {
  if (filename !== ":memory:")
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA user_version=1; CREATE TABLE IF NOT EXISTS snapshot(id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY, topic_id TEXT, revision_id TEXT, name TEXT, payload TEXT NOT NULL);",
  );
  if (filename !== ":memory:") fs.chmodSync(filename, 0o600);
  let current = null,
    error = null;
  const saved = db.prepare("SELECT payload FROM snapshot WHERE id=1").get();
  if (saved) {
    try {
      const data = JSON.parse(saved.payload);
      current = { ...data, all: new Map(data.files.map((f) => [f.id, f])) };
      delete current.files;
    } catch {
      error = "旧索引无法读取";
    }
  }
  function refresh() {
    try {
      const next = build();
      const { all, ...rest } = next;
      const serialized = JSON.stringify({ ...rest, files: [...all.values()] });
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("INSERT OR REPLACE INTO snapshot VALUES(1,?)").run(
          serialized,
        );
        db.exec("DELETE FROM artifacts");
        const insert = db.prepare("INSERT INTO artifacts VALUES(?,?,?,?,?)");
        for (const f of all.values())
          insert.run(
            f.id,
            f.topicId || "",
            f.revisionId || "",
            f.name,
            JSON.stringify(f),
          );
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      current = next;
      error = null;
      return true;
    } catch (e) {
      error = String(e.message);
      return false;
    }
  }
  refresh();
  const timer = intervalMs > 0 ? setInterval(refresh, intervalMs) : null;
  timer?.unref();
  return {
    read() {
      if (!current) throw Error(error || "索引尚未生成");
      return {
        ...current,
        index: {
          backend: "sqlite",
          schemaVersion: 1,
          refreshedAt: current.generatedAt,
          error,
          stale: !!error,
          intervalSeconds: intervalMs / 1000,
        },
      };
    },
    refresh,
    search(q) {
      return db
        .prepare(
          "SELECT id,name,topic_id,revision_id FROM artifacts WHERE name LIKE ? ORDER BY name LIMIT 50",
        )
        .all("%" + q + "%");
    },
    close() {
      if (timer) clearInterval(timer);
      db.close();
    },
  };
}
