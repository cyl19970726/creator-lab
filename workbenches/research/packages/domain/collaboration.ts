import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { digest } from '../storage/content.ts';
import type { CollaborationEvent, Identity } from '../contracts/index.ts';

const WORKSPACE_ID = 'research-workbench';

export async function migrateResearchCollaboration(pool: Pool, workspaceId = WORKSPACE_ID) {
  await pool.query(`CREATE TABLE IF NOT EXISTS research_collaboration_events (
    workspace_id text NOT NULL,
    id text NOT NULL,
    run_id text NOT NULL,
    artifact_id text NOT NULL,
    revision text NOT NULL,
    sha256 text NOT NULL,
    command_key text NOT NULL,
    digest text NOT NULL,
    event_json jsonb NOT NULL,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (workspace_id, id),
    UNIQUE (workspace_id, command_key)
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS research_collaboration_version
    ON research_collaboration_events(workspace_id, run_id, artifact_id, revision, sha256, created_at, id)`);
}

/** User events are append-only and always bind to the exact artifact identity. */
export function collaborationRepository(pool: Pool, workspaceId = WORKSPACE_ID) {
  if (!workspaceId.trim()) throw new Error('Research workspace identity is required');
  const transaction = async <T>(work: (client: PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  };
  return {
    async append(
      runId: string,
      identity: Identity,
      commandKey: string,
      fields: Pick<CollaborationEvent, 'type'> &
        Partial<Pick<CollaborationEvent, 'body' | 'location' | 'verdict' | 'scope' | 'scopeLabel'>>,
    ): Promise<CollaborationEvent> {
      const eventDigest = digest(JSON.stringify({ runId, identity, fields }));
      return transaction(async client => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [workspaceId, commandKey]);
        const prior = await client.query<{ digest: string; event_json: CollaborationEvent }>(
          'SELECT digest,event_json FROM research_collaboration_events WHERE workspace_id=$1 AND command_key=$2 FOR UPDATE',
          [workspaceId, commandKey],
        );
        if (prior.rows[0]) {
          if (prior.rows[0].digest !== eventDigest) throw new Error('Idempotency key reused with different event');
          return prior.rows[0].event_json;
        }
        const event: CollaborationEvent = {
          id: randomUUID(), runId, identity, actor: 'user', createdAt: new Date().toISOString(), ...fields,
        };
        await client.query(`INSERT INTO research_collaboration_events
          (workspace_id,id,run_id,artifact_id,revision,sha256,command_key,digest,event_json,created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
        [workspaceId, event.id, runId, identity.id, identity.revision, identity.sha256, commandKey,
          eventDigest, JSON.stringify(event), event.createdAt]);
        return event;
      });
    },
    async list(runId: string, identity: Identity): Promise<CollaborationEvent[]> {
      const result = await pool.query<{ event_json: CollaborationEvent }>(
        `SELECT event_json FROM research_collaboration_events
         WHERE workspace_id=$1 AND run_id=$2 AND artifact_id=$3 AND revision=$4 AND sha256=$5
         ORDER BY created_at,id`,
        [workspaceId, runId, identity.id, identity.revision, identity.sha256],
      );
      return result.rows.map(row => row.event_json);
    },
  };
}
