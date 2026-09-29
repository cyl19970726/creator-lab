import type { DatabaseSync } from 'node:sqlite';
import { SQLiteWorkflowRunStore } from '@signal-room/workflow-sqlite';
import type { ArtifactDraft, ArtifactRef } from '@signal-room/workflow';

/** Reuses an already published native artifact after a crash before step completion. */
export class RecoveryRunStore extends SQLiteWorkflowRunStore {
  constructor(private readonly databaseConnection: DatabaseSync, private readonly onCreateRun: (id: string) => void,
    private readonly onPublish?: (ref: ArtifactRef, payload: unknown) => void) { super(databaseConnection); }

  override async createRun(record: Parameters<SQLiteWorkflowRunStore['createRun']>[0]) {
    this.databaseConnection.exec('BEGIN IMMEDIATE');
    try {
      const run = await super.createRun(record);
      // The native run and its business binding commit together, before the first model call.
      this.onCreateRun(run.id);
      this.databaseConnection.exec('COMMIT');
      return run;
    } catch (error) { this.databaseConnection.exec('ROLLBACK'); throw error; }
  }

  override async publishArtifact(draft: ArtifactDraft): Promise<ArtifactRef> {
    const steps = await this.listSteps(draft.producedBy.workflowRunId);
    const producer = steps.find(s => s.id === draft.producedBy.stepRunId);
    if (!producer) throw new Error('Native producing step is missing');
    const artifacts = await this.listArtifacts(draft.producedBy.workflowRunId);
    const peers = steps.filter(s => s.kind === producer.kind && s.key === producer.key &&
      s.workflowId === producer.workflowId && s.workflowRevision === producer.workflowRevision &&
      s.inputFingerprint === producer.inputFingerprint && s.configFingerprint === producer.configFingerprint);
    const peerIds = new Set(peers.map(s => s.id));
    const exact = artifacts.filter(ref => peerIds.has(ref.producedBy.stepRunId) && ref.type === draft.type &&
      ref.schemaVersion === draft.schemaVersion && ref.revision === draft.revision && ref.sha256 === draft.sha256 &&
      ref.validation === draft.validation && ref.review === draft.review &&
      JSON.stringify(ref.dependsOn) === JSON.stringify(draft.dependsOn));
    if (exact.length > 1) throw new Error('Multiple native artifacts match one publish operation');
    if (exact.length === 1) {
      const verifiedPayload = this.onPublish ? await this.getArtifactPayload(exact[0]!.id) : undefined;
      await this.appendEvent({ runId: draft.producedBy.workflowRunId, stepRunId: producer.id,
        type: 'artifact.recovered', data: { artifactId: exact[0]!.id } });
      if (this.onPublish) this.onPublish(exact[0]!, verifiedPayload);
      return exact[0]!;
    }
    const ref = await super.publishArtifact(draft);
    if (this.onPublish) this.onPublish(ref, await this.getArtifactPayload(ref.id));
    return ref;
  }
}
