import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { digest } from '../storage/content.ts';
import type { CollaborationEvent, Identity } from '../contracts/index.ts';
export function collaborationRepository(path: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(
    `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS schema_version(version INTEGER PRIMARY KEY); INSERT OR IGNORE INTO schema_version VALUES(1); CREATE TABLE IF NOT EXISTS collaboration_events(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,artifact_id TEXT NOT NULL,revision TEXT NOT NULL,sha256 TEXT NOT NULL,command_key TEXT NOT NULL UNIQUE,digest TEXT NOT NULL,event_json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS collaboration_version ON collaboration_events(run_id,artifact_id,revision,sha256);`,
  );
  return {
    append(
      runId: string,
      identity: Identity,
      commandKey: string,
      fields: Pick<CollaborationEvent, 'type'> &
        Partial<Pick<CollaborationEvent, 'body' | 'location' | 'verdict' | 'scope' | 'scopeLabel'>>,
    ) {
      const hash = digest(JSON.stringify({ runId, identity, fields }));
      db.exec('BEGIN IMMEDIATE');
      try {
        const prior = db
          .prepare('SELECT digest,event_json FROM collaboration_events WHERE command_key=?')
          .get(commandKey);
        if (prior) {
          if (prior.digest !== hash) throw new Error('Idempotency key reused with different event');
          db.exec('COMMIT');
          return JSON.parse(prior.event_json as string) as CollaborationEvent;
        }
        const event: CollaborationEvent = {
          id: randomUUID(),
          runId,
          identity,
          actor: 'user',
          createdAt: new Date().toISOString(),
          ...fields,
        };
        db.prepare('INSERT INTO collaboration_events VALUES(?,?,?,?,?,?,?,?)').run(
          event.id,
          runId,
          identity.id,
          identity.revision,
          identity.sha256,
          commandKey,
          hash,
          JSON.stringify(event),
        );
        db.exec('COMMIT');
        return event;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    list(runId: string, identity: Identity): CollaborationEvent[] {
      return db
        .prepare(
          'SELECT event_json FROM collaboration_events WHERE run_id=? AND artifact_id=? AND revision=? AND sha256=? ORDER BY rowid',
        )
        .all(runId, identity.id, identity.revision, identity.sha256)
        .map((r) => JSON.parse(r.event_json as string));
    },
    close() {
      db.close();
    },
  };
}
