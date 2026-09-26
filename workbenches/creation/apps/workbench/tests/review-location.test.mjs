import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceQuote, visibleQuote } from "../src/review-location.mjs";
test("visible selection crossing emphasis and links binds literal original source", () => {
  const source =
    "报告帮助**非专业读者**理解[模型](https://example.com/model)怎样运行。";
  const quote = sourceQuote(source, "非专业读者理解模型怎样运行");
  assert.ok(source.includes(quote));
  assert.equal(visibleQuote(quote), "非专业读者理解模型怎样运行");
});
test("source matching does not invent a quote or silently bind missing text", () => {
  assert.equal(sourceQuote("有据可查的原文", "原文"), "原文");
  assert.equal(sourceQuote("有据可查的原文", "不存在的文字"), null);
});
