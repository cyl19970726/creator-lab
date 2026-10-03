import type { WorkflowInput } from '../contracts/index.js';
import { definitionSchema, draftSchema } from '../contracts/index.js';
import { CreationStore, StoreError } from '../infrastructure/store.js';

export function frozenWorkflowInput(store: CreationStore, jobId: string): WorkflowInput {
  const snapshot = store.getSnapshot(jobId);
  const { work, config, parentArtifactId, feedback } = snapshot;
  const { id: workId, commandId: _commandId, workspaceId: _workspaceId, title: _title, createdAt: _createdAt,
    selectedArtifactId: _selectedArtifactId, ...request } = work as typeof work & { commandId?: string };
  const input: WorkflowInput = { ...request, ...config, workId };
  if (!parentArtifactId) return input;
  const draft = store.getArtifact(parentArtifactId, workId);
  if (draft.kind !== 'draft' || !feedback) throw new StoreError(409, 'Revision parent is unavailable');
  const parent = store.detail(workId, work.workspaceId).artifacts.find(a => a.jobId === draft.jobId && a.kind === 'definition');
  if (!parent) throw new StoreError(409, 'Revision definition is unavailable');
  input.revision = { draft: draftSchema.parse(draft.payload), definition: definitionSchema.parse(parent.payload),
    feedback, parentAssetId: draft.vendorRef.id, parentHash: draft.vendorRef.sha256,
    parentRevision: draft.vendorRef.revision };
  return input;
}
