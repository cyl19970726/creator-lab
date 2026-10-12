import type { Awaitable } from "./awaitable.js";
export interface CreatorArtifactStore {
  write(runId: string, filename: string, value: unknown, dependencies?: string[]): Awaitable<string>;
  read(reference: string): Awaitable<unknown>;
  archiveReconstructionEvaluations(runId: string, postExternalId: string, revision: number, archiveId: string): Awaitable<void>;
  reconstructionProgress(runId: string, postExternalId: string): Awaitable<string>;
}
