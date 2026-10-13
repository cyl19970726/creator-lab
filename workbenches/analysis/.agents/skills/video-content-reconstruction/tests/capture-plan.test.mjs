import assert from "node:assert/strict";
import test from "node:test";
import { planCaptureProtocol } from "../scripts/capture-plan.mjs";

const duration = 123.88;
const budgetPattern = [
  ["ocr_review", 6.56, 10.96], ["ocr_review", 30.44, 43.28],
  ["ui_state_review", 40.4, 53.96], ["ui_state_review", 53.96, 66.32],
  ["before_during_after", 0, 21.2], ["before_during_after", 35.6, 43.28],
  ["before_during_after", 86.08, 108.16], ["before_during_after", 108.16, 123.88]
];
const protocol = { captureActions: budgetPattern.map(([mode, start, end], index) =>
  ({ id: `A${index + 1}`, mode, range: { start, end } })) };

test("rejects the observed 187-time aggregate before extracting a frame", () => {
  const plan = planCaptureProtocol(protocol, duration);
  assert.equal(plan.pass, false);
  assert.equal(plan.totalUniqueTimes, 187);
  assert.deepEqual(plan.actions.map(action => action.cumulativeUniqueTimes), [19, 72, 128, 178, 181, 182, 185, 187]);
  assert.equal(plan.errors[0].path, "/captureActions/4");
  assert.match(plan.errors[0].message, /187\/180 total unique times/);
  assert.match(plan.errors[0].message, /A5 first exceeds the cap at 181/);
});

test("overlapping action times count once and preserve every requested sample", () => {
  const plan = planCaptureProtocol({ captureActions: [
    { id: "A", mode: "exact_times", range: { start: 0, end: 3 }, times: [1, 2] },
    { id: "B", mode: "exact_times", range: { start: 0, end: 3 }, times: [2, 3] }
  ] }, 4, { maxTotalFrames: 3 });
  assert.equal(plan.pass, true);
  assert.equal(plan.totalUniqueTimes, 3);
  assert.deepEqual(plan.actions.map(action => action.selected), [[1, 2], [2, 3]]);
  assert.deepEqual(plan.actions.map(action => action.newUniqueTimes), [2, 1]);
});

test("explicit times, not range, control action and total budgets until the model trims the list", () => {
  const sequence = (start, count) => Array.from({ length: count }, (_, index) => start + index);
  const actions = [
    { id: "A1", mode: "exact_times", range: { start: 1, end: 50 }, times: sequence(1, 50) },
    { id: "A2", mode: "exact_times", range: { start: 51, end: 100 }, times: sequence(51, 50) },
    { id: "A3", mode: "exact_times", range: { start: 101, end: 150 }, times: sequence(101, 50) },
    { id: "A4", mode: "exact_times", range: { start: 0, end: 272 }, times: sequence(151, 122) }
  ];
  const first = planCaptureProtocol({ captureActions: actions }, 300);
  assert.equal(first.pass, false);
  assert.equal(first.totalUniqueTimes, 272);
  assert.equal(first.actions[3].sampleSource, "explicit times");
  assert.deepEqual(first.errors.map(error => error.code), ["ACTION_LIMIT", "TOTAL_LIMIT"]);
  assert.match(first.errors[0].message, /A4 \(0–272s\) requests 122\/60 times from explicit times \(62 over cap\)/);
  assert.match(first.errors[0].message, /changing range alone will not reduce these 122 samples/);
  assert.match(first.errors[1].message, /272\/180 total unique times \(92 over cap\)/);

  actions[3].range = { start: 151, end: 272 };
  const rangeOnly = planCaptureProtocol({ captureActions: actions }, 300);
  assert.equal(rangeOnly.pass, false);
  assert.equal(rangeOnly.actions[3].sampleCount, 122);
  assert.equal(rangeOnly.totalUniqueTimes, 272);

  actions[3].times = sequence(151, 60);
  const actionOnly = planCaptureProtocol({ captureActions: actions }, 300);
  assert.equal(actionOnly.actions[3].sampleCount, 60);
  assert.equal(actionOnly.pass, false);
  assert.equal(actionOnly.totalUniqueTimes, 210);
  assert.deepEqual(actionOnly.errors.map(error => error.path), ["/captureActions/3"]);
  assert.deepEqual(actionOnly.errors.map(error => error.code), ["TOTAL_LIMIT"]);
  assert.match(actionOnly.errors[0].message, /Reduce the protocol-wide union by at least 30 unique times/);

  actions[3].times = sequence(151, 30);
  const compliant = planCaptureProtocol({ captureActions: actions }, 300);
  assert.equal(compliant.pass, true);
  assert.equal(compliant.actions[3].sampleCount, 30);
  assert.equal(compliant.totalUniqueTimes, 180);
  assert.deepEqual(compliant.errors, []);
});
