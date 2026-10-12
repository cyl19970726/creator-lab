import { expect, it, vi } from "vitest";
import type { AgentRunRequest, AgentRunner } from "@signal-room/workflow";
import { withAttemptPersistence } from "./persist-agent-attempt.js";

const request = () => ({ emit: vi.fn(async () => {}) }) as unknown as AgentRunRequest<unknown>;

it("keeps a Builder failure and records a simultaneous artifact persistence failure", async () => {
  const primary = new Error("BUILDER_INTEGRITY_DEPTH_FRAME_STRIP_COVERAGE");
  const runner: AgentRunner = { async run() { throw primary; } };
  const persist = vi.fn(async () => { throw new Error("Unregistered media symlink"); });
  const input = request();
  await expect(withAttemptPersistence(runner, persist).run(input)).rejects.toBe(primary);
  expect(persist).toHaveBeenCalledOnce();
  expect(input.emit).toHaveBeenCalledWith("responses.persistence_failed", { message: "Unregistered media symlink" });
});

it("does not register a successful model output when artifact persistence fails", async () => {
  const failure = new Error("database unavailable");
  const runner: AgentRunner = { async run() { return { output: undefined as never }; } };
  await expect(withAttemptPersistence(runner, async () => { throw failure; }).run(request())).rejects.toBe(failure);
});

it("keeps the primary failure when even the diagnostic cannot be stored", async () => {
  const primary = new Error("invalid candidate");
  const input = request();
  input.emit = vi.fn(async () => { throw new Error("event store unavailable"); });
  const runner: AgentRunner = { async run() { throw primary; } };
  await expect(withAttemptPersistence(runner, async () => { throw new Error("database unavailable"); })
    .run(input)).rejects.toBe(primary);
});
