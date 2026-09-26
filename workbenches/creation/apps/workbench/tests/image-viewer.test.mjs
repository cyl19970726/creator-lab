import { test } from "node:test";
import assert from "node:assert/strict";
import { imageLayout } from "../src/image-viewer.mjs";

test("original-size viewing preserves readable figure detail on a narrow screen", () => {
  const fit = imageLayout(1024, 1088, 358, 630);
  const original = imageLayout(1024, 1088, 358, 630, 1);
  assert.equal(fit.width, 358);
  assert.equal(original.width, 1024);
  assert.equal(original.height, 1088);
  assert.equal(20 * original.scale, 20);
});
test("fit respects height and adjustable zoom has bounded real dimensions", () => {
  assert.equal(imageLayout(1024, 1088, 1200, 544).scale, 0.5);
  assert.equal(imageLayout(1024, 1088, 358, 630, 1.5).width, 1536);
  assert.equal(imageLayout(1024, 1088, 358, 630, 9).scale, 4);
});
