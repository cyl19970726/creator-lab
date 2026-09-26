import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { implementationRevision } from "./config.mjs";
import { runCli } from "./cli.mjs";

function output() {
  let value = "";
  return { stream: { write(chunk) { value += chunk; } }, read: () => value };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "expression-cli-"));
  const manifestPath = join(root, "manifest.json");
  await writeFile(manifestPath, "{}\n");
  const researchContent = "Frozen evidence";
  const prepared = {
    implementationRevision: await implementationRevision(),
    revision: "test-revision-1",
    input: {
      workspaceId: "workspace-1",
      topicId: "topic-1",
      goal: "Explain the request journey",
      readers: ["curious non-specialist"],
      positioning: "clear and evidence-bound",
      research: [{ id: "source-1", path: "frozen/source.md", sha256: createHash("sha256").update(researchContent).digest("hex"), content: researchContent }],
    },
    agents: {
      author: { id: "author", revision: "1", model: "fake", reasoningEffort: "medium", promptRevision: "1", skillsRevision: "1", permissionsRevision: "1", config: {} },
      reader: { id: "reader", revision: "1", model: "fake", reasoningEffort: "medium", promptRevision: "1", skillsRevision: "1", permissionsRevision: "1", config: {} },
      editor: { id: "editor", revision: "1", model: "fake", reasoningEffort: "medium", promptRevision: "1", skillsRevision: "1", permissionsRevision: "1", config: {} },
    },
  };
  const stdout = output();
  const result = await runCli(["prepare", manifestPath, "--model", "fake", "--effort", "medium", "--max-revisions", "0"], {
    dataRoot: join(root, "runs"), stdout: stdout.stream, prepareExpressionRun: async () => prepared,
  });
  return { root, prepared, snapshotPath: result.snapshotPath };
}

function fakeRunner(counter) {
  return {
    async run(request) {
      counter.count += 1;
      const { task, candidateRef } = request.input;
      if (task === "core-draft" || task === "full-expand") {
        return { output: {
          title: task === "core-draft" ? "Core expression" : "Full expression",
          document: "Private author diagnostics.",
          publicDocument: "A useful finished document.",
          visuals: [{ id: "visual-1", content: "A concrete visual plan" }],
          materials: [{ id: "material-1", purpose: "support the explanation", required: true, status: "ready" }],
        } };
      }
      if (task === "reader-review") {
        return { output: { candidateSha256: candidateRef.sha256, observations: [{ id: "o1", location: "opening", observation: "clear", severity: "non_blocking" }] } };
      }
      return { output: { candidateSha256: candidateRef.sha256, decision: "pass", findings: [] } };
    },
  };
}

test("prepare freezes a private snapshot and run resumes the same SQLite ledger", async () => {
  const { snapshotPath } = await fixture();
  assert.equal((await stat(snapshotPath)).mode & 0o777, 0o600);
  const counter = { count: 0 };
  const deps = { stdout: output().stream, installSignalHandlers: false, createRunner: async () => fakeRunner(counter) };
  const first = await runCli(["run", snapshotPath], deps);
  assert.equal(first.run.state, "needs_review");
  assert.equal(counter.count, 6);
  const second = await runCli(["run", snapshotPath], deps);
  assert.equal(second.run.id, first.run.id);
  assert.equal(counter.count, 6, "validated work is replayed instead of calling agents again");
  const state = JSON.parse(await readFile(join(snapshotPath, "..", "state.json"), "utf8"));
  assert.equal(state.runId, first.run.id);
});

test("status and export expose artifacts and provenance without agent prompts", async () => {
  const { snapshotPath } = await fixture();
  await runCli(["run", snapshotPath], { stdout: output().stream, installSignalHandlers: false, createRunner: async () => fakeRunner({ count: 0 }) });
  const statusOut = output();
  await runCli(["status", snapshotPath], { stdout: statusOut.stream });
  const report = statusOut.read();
  assert.match(report, /Full expression/);
  assert.match(report, /A useful finished document\./);
  assert.match(report, /Stopping reason: awaiting-human-acceptance/);
  assert.match(report, /Terminal detail/);
  assert.match(report, /Producer step:/);
  assert.doesNotMatch(report, /promptRevision|skillsRevision|private-traces/);
  assert.doesNotMatch(report, /Frozen evidence|frozen\/source\.md/);
  const exportOut = output();
  const exported = await runCli(["export", snapshotPath], { stdout: exportOut.stream });
  assert.equal(await readFile(exported.outputPath, "utf8"), report);
  assert.equal((await stat(exported.outputPath)).mode & 0o777, 0o600);
});

test("an implementation change blocks execution but leaves an old ledger readable", async () => {
  const { snapshotPath } = await fixture();
  const runner = async () => fakeRunner({ count: 0 });
  await runCli(["run", snapshotPath], { stdout: output().stream, installSignalHandlers: false, createRunner: runner });
  await assert.rejects(() => runCli(["resume", snapshotPath], {
    stdout: output().stream,
    installSignalHandlers: false,
    createRunner: runner,
    getImplementationRevision: async () => "new-implementation",
  }), /implementation changed/);
  const statusOut = output();
  await runCli(["status", snapshotPath], { stdout: statusOut.stream, getImplementationRevision: async () => "new-implementation" });
  assert.match(statusOut.read(), /A useful finished document\./);
});

test("tampered snapshots and concurrent execution locks fail closed", async () => {
  const { snapshotPath } = await fixture();
  const lockPath = join(snapshotPath, "..", "execution.lock");
  await writeFile(lockPath, "occupied\n");
  await assert.rejects(() => runCli(["run", snapshotPath], {
    stdout: output().stream, installSignalHandlers: false, createRunner: async () => fakeRunner({ count: 0 }),
  }), /already locked/);
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  snapshot.input.goal = "tampered";
  await writeFile(snapshotPath, JSON.stringify(snapshot));
  await assert.rejects(() => runCli(["status", snapshotPath], { stdout: output().stream }), /integrity check failed/);
});
