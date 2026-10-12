import type { CreatorResearchBatch } from "../../../contracts/index.js";
import type { Awaitable } from "./awaitable.js";

export interface CreatorResearchBatchRepository {
  /** Returns the prior result or throws when the key exists for another command hash. */
  getByOperationKey(operationKey: string, commandHash: string): Awaitable<CreatorResearchBatch | null>;
  /** Factory must run after reserving the operation and share the repository transaction. */
  create(batch: CreatorResearchBatch | (() => Awaitable<CreatorResearchBatch>), operationKey: string, commandHash: string): Awaitable<CreatorResearchBatch>;
  get(batchId: string): Awaitable<CreatorResearchBatch | null>;
  list(limit?: number): Awaitable<CreatorResearchBatch[]>;
  close(): Awaitable<void>;
}
