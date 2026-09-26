import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareExpressionRun,
  sha256,
  implementationRevision,
} from "./config.mjs";

test("freezes sources and role-specific methods; changing model changes workflow identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "expression-config-"));
  try {
    await writeFile(join(dir, "report.md"), "实际研究证据");
    const manifest = {
      workspaceId: "token-economics",
      topicId: "journey",
      goal: "理解请求旅程",
      readers: ["非专业读者"],
      positioning: "模型与硬件如何配合",
      research: [{ id: "report", path: "report.md" }],
    };
    const manifestPath = join(dir, "input.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const first = await prepareExpressionRun({
      manifestPath,
      model: "gpt-5.6-sol",
    });
    assert.equal(first.input.research[0].sha256, sha256("实际研究证据"));
    assert.ok(
      first.agents.author.config.skills.every((s) => s.content.length > 0),
    );
    assert.equal(first.agents.reader.config.skills.length, 0);
    assert.equal(
      first.agents.reader.config.threadOptions.sandboxMode,
      "read-only",
    );
    const second = await prepareExpressionRun({
      manifestPath,
      model: "gpt-5.6-terra",
    });
    assert.notEqual(first.revision, second.revision);
    await writeFile(join(dir, "report.md"), "修改研究");
    assert.equal(first.input.research[0].content, "实际研究证据");
    manifest.research[0].sha256 = first.input.research[0].sha256;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(
      prepareExpressionRun({ manifestPath, model: "gpt-5.6-sol" }),
      /Source changed/,
    );
    await assert.rejects(
      prepareExpressionRun({ manifestPath }),
      /Explicit model/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("execution identity includes CLI adapter and built runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "expression-identity-"));
  try {
    await mkdir(join(dir, "tooling/expression-workflow"), { recursive: true });
    for (const name of ["config.mjs", "workflow.mjs", "cli.mjs"])
      await writeFile(join(dir, "tooling/expression-workflow", name), name);
    await writeFile(join(dir, "pnpm-lock.yaml"), "fixed dependencies");
    for (const name of ["core", "codex", "sqlite"]) {
      await mkdir(join(dir, "vendor/agent-workflow/packages", name, "dist"), {
        recursive: true,
      });
      await writeFile(
        join(dir, "vendor/agent-workflow/packages", name, "dist/index.js"),
        name,
      );
    }
    const before = await implementationRevision(dir);
    await writeFile(
      join(dir, "tooling/expression-workflow/cli.mjs"),
      "changed execution adapter",
    );
    const changedCLI = await implementationRevision(dir);
    assert.notEqual(before, changedCLI);
    await writeFile(
      join(dir, "vendor/agent-workflow/packages/core/dist/index.js"),
      "changed compiled runtime",
    );
    assert.notEqual(changedCLI, await implementationRevision(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
