import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  symlink,
  realpath,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { exportCovers } from "./covers.mjs";

const svg = (width, height, text = "Full cover") =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#F6F6F2"/><text x="10" y="35" font-family="sans-serif" font-size="16">${text}</text></svg>`;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("real exports preserve the complete source and return pending review with verified PNG sizes", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cover-export-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "accepted.svg");
  const wide = path.join(dir, "wide.svg");
  await writeFile(source, svg(180, 240));
  await writeFile(wide, svg(320, 240, "Dedicated wide cover"));
  const before = await readFile(source);
  const output = path.join(dir, "new-output");
  const result = await exportCovers(
    {
      id: "sample",
      source: path.join(dir, "job.json"),
      coverSource: "accepted.svg",
    },
    output,
  );
  assert.equal(result.review.status, "pending_visual_review");
  assert.deepEqual(
    result.variants.map((v) => [v.ratio, v.width, v.height]),
    [
      ["3:4", 1080, 1440],
      ["4:3", 1440, 1080],
    ],
  );
  for (const variant of result.variants) {
    const png = await readFile(variant.path);
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    assert.deepEqual(
      [png.readUInt32BE(16), png.readUInt32BE(20)],
      [variant.width, variant.height],
    );
    assert.equal(hash(png), variant.sha256);
    assert.equal(variant.review.status, "pending_visual_review");
    assert.equal(variant.fit, "contain");
  }
  assert.deepEqual(result.variants[1].contentBounds, {
    x: 315,
    y: 0,
    width: 810,
    height: 1080,
  });
  assert.deepEqual(await readFile(source), before);
  const exported = await readFile(result.variants[0].path);
  await assert.rejects(
    exportCovers({ cover: source }, output),
    /already exists/,
  );
  assert.deepEqual(await readFile(result.variants[0].path), exported);
  await assert.rejects(exportCovers({ cover: source }, dir), /already exists/);
  assert.deepEqual(await readFile(source), before);

  const dedicated = await exportCovers(
    {
      cover: result.variants[0].path,
      coverSources: { "4:3": wide },
    },
    path.join(dir, "dedicated-output"),
  );
  assert.equal(dedicated.variants[1].source.path, await realpath(wide));
  assert.deepEqual(dedicated.variants[1].contentBounds, {
    x: 0,
    y: 0,
    width: 1440,
    height: 1080,
  });
});

test("rejects missing sources and an existing output symlink without modifying originals", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cover-protection-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(exportCovers({}, path.join(dir, "out")), /cover source/);
  const source = path.join(dir, "source.svg");
  await writeFile(source, svg(180, 240));
  const original = await readFile(source);
  await mkdir(path.join(dir, "existing"));
  await assert.rejects(
    exportCovers({ cover: source }, path.join(dir, "existing")),
    /already exists/,
  );
  await symlink(dir, path.join(dir, "alias"));
  await assert.rejects(
    exportCovers({ cover: source }, path.join(dir, "alias")),
    /already exists/,
  );
  assert.deepEqual(await readFile(source), original);
});

test("rejects text already outside the source viewport instead of presenting a cropped success", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cover-overflow-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "overflow.svg");
  await writeFile(source, svg(180, 240).replace('x="10"', 'x="175"'));
  const output = path.join(dir, "output");
  await assert.rejects(
    exportCovers({ cover: source }, output),
    /Source text already exceeds/,
  );
  const failure = JSON.parse(
    await readFile(path.join(output, "export-failed.json"), "utf8"),
  );
  assert.equal(failure.status, "failed");
  await assert.rejects(readFile(path.join(output, "covers.json")), {
    code: "ENOENT",
  });
});
