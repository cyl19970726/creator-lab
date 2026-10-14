import assert from "node:assert/strict";
import test from "node:test";
import { captureTimes } from "../scripts/targeted-capture-times.mjs";
import { uniqueTimes } from "../scripts/lib.mjs";

test("explicit OCR times win over adaptive sampling", () => {
  assert.deepEqual(captureTimes({ id: "text", mode: "ocr_review", times: [1.17] }, 1, 2), [1.17]);
});

test("short text windows sample interior captions while broad windows remain bounded", () => {
  const short = captureTimes({ id: "text", mode: "ocr_review" }, 1, 1.6);
  assert.equal(short.length, 8);
  assert.ok(short.some((time) => Math.abs(time - 1.3) < 0.001));
  const broad = captureTimes({ id: "text", mode: "ocr_review" }, 1, 11);
  assert.ok(broad.length <= 42);
  assert.equal(broad.at(-1), 11);
  const long = captureTimes({ id: "text", mode: "ocr_review" }, 1, 21);
  assert.ok(uniqueTimes(long, 22).length <= 60);
  assert.equal(long.at(-1), 21);
  const nonText = captureTimes({ id: "visual", mode: "visual_review" }, 1, 1.6);
  assert.ok(nonText.length < short.length);
});

test("invalid density fails instead of entering an unbounded loop", () => {
  assert.throws(() => captureTimes({ id: "text", mode: "ocr_review", densitySeconds: 0 }, 1, 2), /Invalid densitySeconds/);
  assert.throws(() => captureTimes({ id: "text", mode: "ocr_review", densitySeconds: 0.000001 }, 1, 2), /exceeds 60/);
});
