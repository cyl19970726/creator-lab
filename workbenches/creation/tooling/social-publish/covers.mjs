/**
 * Local static cover export; no publishing or review approval.
 *
 * exportCovers(job, outputDir) accepts:
 *   coverSource: path | { path, background?, fonts?: [{path,family,weight?}] }
 *   coverSources: { "3:4"?: source, "4:3"?: source } // optional designed variants
 *   cover: path // existing publish-job fallback
 * Paths resolve relative to job.source (the job JSON filename), else cwd.
 * SVG/PNG/JPEG/WebP sources retain their full viewport with contain, never crop.
 * outputDir MUST be new. Review state is always pending_visual_review.
 * CLI: node tooling/social-publish/covers.mjs JOB.json NEW_OUTPUT_DIR
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const variants = [
  { ratio: "3:4", width: 1080, height: 1440, filename: "cover-3x4.png" },
  { ratio: "4:3", width: 1440, height: 1080, filename: "cover-4x3.png" },
];
const review = () => ({
  status: "pending_visual_review",
  note: "自动导出与尺寸检查不代表视觉审核或平台裁切审核通过。",
});
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const escapeHTML = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

async function readSource(value, base) {
  const spec = typeof value === "string" ? { path: value } : value;
  if (!spec?.path || typeof spec.path !== "string")
    throw Error("Missing cover source path");
  const file = await fs.realpath(path.resolve(base, spec.path));
  const extension = path.extname(file).toLowerCase();
  const mime = {
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
  }[extension];
  if (!mime)
    throw Error(
      `Unsupported cover source ${extension}; use a static SVG, PNG, JPEG or WebP`,
    );
  const bytes = await fs.readFile(file);
  const fonts = [];
  for (const font of spec.fonts || []) {
    if (!font?.path || !font.family || /[<>\r\n]/u.test(font.family))
      throw Error("A font needs a local path and family");
    const fontPath = await fs.realpath(path.resolve(base, font.path));
    const data = await fs.readFile(fontPath);
    const weight = Number(font.weight ?? 400);
    if (!Number.isInteger(weight) || weight < 1 || weight > 1000)
      throw Error("Invalid font weight");
    fonts.push({
      path: fontPath,
      family: font.family,
      weight,
      sha256: hash(data),
      data,
    });
  }
  return {
    path: file,
    mime,
    bytes,
    sha256: hash(bytes),
    background: spec.background,
    fonts,
  };
}

async function renderCover(browser, source, variant) {
  const context = await browser.newContext({
    viewport: { width: variant.width, height: variant.height },
    deviceScaleFactor: 1,
    javaScriptEnabled: false,
  });
  const blocked = [];
  // Only the explicitly supplied local font bytes are served. No external request leaves this context.
  await context.route("**/*", async (route) => {
    const requested = route.request().url();
    const index = source.fonts.findIndex(
      (_, i) => requested === `https://cover-export.invalid/font/${i}`,
    );
    if (index >= 0)
      return route.fulfill({
        body: source.fonts[index].data,
        contentType: "font/otf",
        headers: { "access-control-allow-origin": "*" },
      });
    blocked.push(requested);
    await route.abort();
  });
  try {
    const page = await context.newPage();
    const fontCSS = source.fonts
      .map(
        (f, i) =>
          `@font-face{font-family:${JSON.stringify(f.family)};font-weight:${f.weight};src:url("https://cover-export.invalid/font/${i}")}`,
      )
      .join("\n");
    const content =
      source.mime === "image/svg+xml"
        ? source.bytes.toString("utf8")
        : `<img src="data:${source.mime};base64,${source.bytes.toString("base64")}" alt="Source cover">`;
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>${fontCSS}
html,body{margin:0;padding:0;overflow:hidden}#source{position:absolute;left:0;top:0;transform-origin:0 0}#source>svg,#source>img{display:block}</style></head><body><div id="source">${content}</div></body></html>`,
      { waitUntil: "load" },
    );
    const dimensions = await page.evaluate(
      async ({ fonts, background }) => {
        const container = document.querySelector("#source");
        const element = container.firstElementChild;
        if (!element || !["svg", "img"].includes(element.tagName.toLowerCase()))
          throw Error("Source must have one SVG or image root");
        let width, height, inferred;
        if (element.tagName.toLowerCase() === "svg") {
          const number = (value) =>
            /^\d+(?:\.\d+)?(?:px)?$/u.test(value || "")
              ? Number.parseFloat(value)
              : null;
          width =
            number(element.getAttribute("width")) ||
            element.viewBox.baseVal.width;
          height =
            number(element.getAttribute("height")) ||
            element.viewBox.baseVal.height;
          if (!(width > 0 && height > 0))
            throw Error("SVG needs numeric dimensions or a viewBox");
          element.style.width = `${width}px`;
          element.style.height = `${height}px`;
          const rect = element.querySelector("rect");
          const box = rect?.getBBox();
          const view = element.viewBox.baseVal;
          if (
            box &&
            box.x <= view.x &&
            box.y <= view.y &&
            box.width >= (view.width || width) &&
            box.height >= (view.height || height)
          ) {
            const fill = getComputedStyle(rect).fill;
            if (
              fill !== "none" &&
              Number(getComputedStyle(rect).fillOpacity) === 1
            )
              inferred = fill;
          }
        } else {
          await element.decode();
          width = element.naturalWidth;
          height = element.naturalHeight;
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(element, 0, 0, 1, 1, 0, 0, 1, 1);
          const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
          if (a === 255) inferred = `rgb(${r}, ${g}, ${b})`;
        }
        if (!(width > 0 && height > 0) || width > 16384 || height > 16384)
          throw Error("Invalid or unsupported source dimensions");
        for (const font of fonts) {
          const loaded = await document.fonts.load(
            `${font.weight} 32px ${JSON.stringify(font.family)}`,
            "模型Aa",
          );
          if (!loaded.length || loaded.some((face) => face.status !== "loaded"))
            throw Error(`Font did not load: ${font.family}`);
        }
        await document.fonts.ready;
        const overflow = [...element.querySelectorAll("text")].flatMap(
          (text) => {
            const box = text.getBoundingClientRect();
            return box.left < -0.5 ||
              box.top < -0.5 ||
              box.right > width + 0.5 ||
              box.bottom > height + 0.5
              ? [
                  {
                    text: text.textContent,
                    x: box.x,
                    y: box.y,
                    width: box.width,
                    height: box.height,
                  },
                ]
              : [];
          },
        );
        if (overflow.length)
          throw Error(
            `Source text already exceeds its viewport: ${overflow.map((item) => item.text).join(" / ")}`,
          );
        const color = background || inferred || "#ffffff";
        if (!CSS.supports("color", color))
          throw Error("Invalid cover background color");
        return {
          width,
          height,
          background: color,
          backgroundBasis: background
            ? "explicit"
            : inferred
              ? "source_background"
              : "default_white",
          textOverflow:
            element.tagName.toLowerCase() === "svg" ? overflow : null,
        };
      },
      {
        fonts: source.fonts.map(({ family, weight }) => ({ family, weight })),
        background: source.background,
      },
    );
    if (blocked.length)
      throw Error(
        "Source requested external resources; embed them or provide local font paths before exporting",
      );
    const scale = Math.min(
      variant.width / dimensions.width,
      variant.height / dimensions.height,
    );
    const contentBounds = {
      x: (variant.width - dimensions.width * scale) / 2,
      y: (variant.height - dimensions.height * scale) / 2,
      width: dimensions.width * scale,
      height: dimensions.height * scale,
    };
    await page.evaluate(
      ({ dimensions, variant, scale, bounds }) => {
        document.documentElement.style.width =
          document.body.style.width = `${variant.width}px`;
        document.documentElement.style.height =
          document.body.style.height = `${variant.height}px`;
        document.body.style.background = dimensions.background;
        const container = document.querySelector("#source");
        container.style.width = `${dimensions.width}px`;
        container.style.height = `${dimensions.height}px`;
        container.style.transform = `translate(${bounds.x}px,${bounds.y}px) scale(${scale})`;
      },
      { dimensions, variant, scale, bounds: contentBounds },
    );
    const png = await page.screenshot({ type: "png", animations: "disabled" });
    if (
      png.readUInt32BE(16) !== variant.width ||
      png.readUInt32BE(20) !== variant.height
    )
      throw Error("Unexpected PNG dimensions");
    return { png, dimensions, contentBounds, scale };
  } finally {
    await context.close();
  }
}

export async function exportCovers(job, outputDir) {
  const base = job.source
    ? path.dirname(path.resolve(job.source))
    : process.cwd();
  const sources = [];
  for (const variant of variants)
    sources.push(
      await readSource(
        job.coverSources?.[variant.ratio] ?? job.coverSource ?? job.cover,
        base,
      ),
    );
  if (!outputDir) throw Error("A new output directory is required");
  const directory = path.resolve(outputDir);
  await fs.mkdir(path.dirname(directory), { recursive: true });
  try {
    await fs.mkdir(directory);
  } catch (error) {
    if (error.code === "EEXIST")
      throw Error(
        `Output directory already exists; choose a new directory: ${directory}`,
      );
    throw error;
  }
  const result = {
    schemaVersion: 1,
    jobId: job.id ?? null,
    status: "exported",
    review: review(),
    variants: [],
    manifestPath: path.join(directory, "covers.json"),
    previewPath: path.join(directory, "preview.html"),
  };
  let browser;
  try {
    // Existing project Playwright and installed Chrome; never installs a browser or changes a user profile.
    browser = await chromium.launch({ channel: "chrome", headless: true });
    for (const [i, variant] of variants.entries()) {
      const source = sources[i];
      const rendered = await renderCover(browser, source, variant);
      const output = path.join(directory, variant.filename);
      await fs.writeFile(output, rendered.png, { flag: "wx" });
      const warnings = [];
      if (
        rendered.contentBounds.width < variant.width ||
        rendered.contentBounds.height < variant.height
      )
        warnings.push(
          "完整原设计等比置入，留白会让内容在缩略图中变小；可另供该比例布局，尚待视觉审核。",
        );
      if (source.mime === "image/svg+xml" && !source.fonts.length)
        warnings.push("未指定字体文件，使用本机字体；换机器需复核字形和布局。");
      result.variants.push({
        ratio: variant.ratio,
        path: output,
        width: variant.width,
        height: variant.height,
        sha256: hash(rendered.png),
        bytes: rendered.png.length,
        fit: "contain",
        contentBounds: rendered.contentBounds,
        scale: rendered.scale,
        background: rendered.dimensions.background,
        backgroundBasis: rendered.dimensions.backgroundBasis,
        source: {
          path: source.path,
          sha256: source.sha256,
          width: rendered.dimensions.width,
          height: rendered.dimensions.height,
          fonts: source.fonts.map(({ data, ...font }) => font),
        },
        checks: {
          pngDimensionsVerified: true,
          sourceTextOverflow: rendered.dimensions.textOverflow,
        },
        warnings,
        review: review(),
      });
    }
    for (const source of sources) {
      if (hash(await fs.readFile(source.path)) !== source.sha256)
        throw Error(
          "Source changed while exporting; outputs require regeneration",
        );
    }
    const cards = result.variants
      .map(
        (v) =>
          `<section><h2>${v.ratio} · ${v.width} × ${v.height}</h2><p>${v.fit} · 待视觉审核</p><a href="${path.basename(v.path)}"><img src="${path.basename(v.path)}" alt="${v.ratio} cover preview"></a><p>${v.warnings.map(escapeHTML).join(" ") || "比例与原稿一致；仍需确认缩略图和平台预览。"}</p></section>`,
      )
      .join("");
    await fs.writeFile(
      result.previewPath,
      `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>封面比例预览</title><style>body{font:16px system-ui;margin:32px;color:#233329;background:#eef1ed}main{display:flex;flex-wrap:wrap;gap:32px}section{width:420px}img{display:block;width:100%;height:auto}p{line-height:1.6}</style><h1>封面比例预览</h1><p>复用原设计完整等比导出；自动导出不代表视觉审核通过。</p><main>${cards}</main></html>`,
      { flag: "wx" },
    );
    await fs.writeFile(
      result.manifestPath,
      JSON.stringify(result, null, 2) + "\n",
      { flag: "wx" },
    );
    return result;
  } catch (error) {
    await fs.writeFile(
      path.join(directory, "export-failed.json"),
      JSON.stringify(
        { status: "failed", message: error.message, review: review() },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const [file, output] = process.argv.slice(2);
  if (!file || !output) {
    console.error(
      "Usage: node tooling/social-publish/covers.mjs JOB.json NEW_OUTPUT_DIR",
    );
    process.exitCode = 1;
  } else {
    try {
      const source = path.resolve(file);
      const job = { ...JSON.parse(await fs.readFile(source, "utf8")), source };
      console.log(JSON.stringify(await exportCovers(job, output), null, 2));
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
