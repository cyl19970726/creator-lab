import { test } from "node:test";
import assert from "node:assert/strict";
import {
  phases,
  steps,
  phaseFor,
  membersFor,
  stageStatus,
  groupFor,
  groupStatus,
  coreIdFor,
  inputsFor,
} from "../src/workflow.mjs";
test("creation stages lead navigation while optional legacy inputs stay reachable", () => {
  assert.deepEqual(
    phases.map((p) => p.steps.length),
    [3, 2, 3],
  );
  assert.deepEqual(
    phases
      .flatMap((p) => p.steps)
      .map((id) => steps.find((s) => s.id === id).code),
    ["B1", "B2", "B3", "C1", "C2", "A1", "A2", "A3"],
  );
  assert.deepEqual(membersFor("architecture"), [
    "video-evidence",
    "architecture",
    "opening",
    "package",
    "design",
  ]);
  for (const id of [
    "video-evidence",
    "architecture",
    "opening",
    "package",
    "design",
    "sample",
    "final",
  ])
    assert.equal(phaseFor(id), "video");
  for (const id of [
    "goal",
    "feedback",
    "outline",
    "evidence",
    "mechanism",
    "report",
    "questions",
    "research-review",
  ])
    assert.equal(phaseFor(id), "research");
  assert.equal(phaseFor("comments"), "publish");
});
test("reused inputs keep their source identity and never become new output or acceptance", () => {
  const input = {
    assetId: "old-goal",
    sourceRevisionId: "v1",
    step: "goal",
    label: "沿用目标",
  };
  const rev = {
    id: "v2",
    coreIds: {},
    inputCoreIds: { goal: input.assetId },
    inputRefs: [input],
    stageStates: { goal: { label: "旧版接受" } },
  };
  assert.equal(coreIdFor(rev, "goal"), "old-goal");
  assert.equal(stageStatus(rev, "goal"), "沿用输入");
  assert.equal(groupStatus(rev, "goal"), "1 项沿用输入");
  assert.deepEqual(inputsFor(rev, "goal"), [input]);
  assert.deepEqual(inputsFor(rev, "report"), []);
  assert.deepEqual(rev.coreIds, {});
});
test("asset presence and grouped counts cannot imply approval or completion", () => {
  assert.equal(stageStatus({ coreIds: { report: "r" } }, "report"), "有产物");
  assert.equal(stageStatus({ coreIds: {} }, "report"), "未登记");
  assert.equal(
    stageStatus(
      {
        coreIds: { report: "r" },
        stageStates: { report: { label: "独立审阅：限定范围接受" } },
      },
      "report",
    ),
    "独立审阅：限定范围接受",
  );
  assert.equal(
    groupStatus({ coreIds: { architecture: "a" } }, "architecture"),
    "1 项关键资产",
  );
});
test("old deep links select their containing new step without losing assets", () => {
  assert.equal(groupFor("video-evidence"), "architecture");
  assert.equal(groupFor("package"), "architecture");
  assert.equal(groupFor("research-review"), "report");
  assert.equal(groupFor("sample"), "final");
  assert.equal(groupFor("comments"), "learning");
});
