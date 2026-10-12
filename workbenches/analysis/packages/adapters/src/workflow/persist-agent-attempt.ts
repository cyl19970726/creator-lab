import type { AgentRunRequest, AgentRunResult, AgentRunner } from "@signal-room/workflow";

/** Persist successful and failed attempts without hiding the original execution failure. */
export function withAttemptPersistence(runner: AgentRunner,
  persist: (request: AgentRunRequest<unknown>) => Promise<void>): AgentRunner {
  return {
    async run<Input, Output>(request: AgentRunRequest<Input>): Promise<AgentRunResult<Output>> {
      let result: AgentRunResult<Output>;
      try { result = await runner.run<Input, Output>(request); }
      catch (primaryError) {
        try { await persist(request); }
        catch (error) {
          // The primary failure remains authoritative even if its secondary
          // persistence diagnostic cannot be written during a database outage.
          await request.emit("responses.persistence_failed", {
            message: error instanceof Error ? error.message : String(error)
          }).catch(() => {});
        }
        throw primaryError;
      }
      await persist(request);
      return result;
    }
  };
}
