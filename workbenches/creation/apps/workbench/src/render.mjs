import { safeDetails } from "./safe-details.mjs";
import MarkdownIt from "markdown-it";
import fs from "node:fs";
import path from "node:path";
import { safePath } from "./catalog.mjs";
export const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function renderArtifact(file, catalog, apiPrefix = "/api") {
  if (file.size > 8e6)
    return { kind: "large", message: "该文件较大，请使用原始文件查看。" };
  const text = fs.readFileSync(file.path, "utf8");
  if (file.ext === "json") {
    try {
      return { kind: "json", data: JSON.parse(text), text };
    } catch {
      return { kind: "text", text, error: "JSON尚未写完整或格式错误" };
    }
  }
  if (file.ext !== "md") return { kind: "text", text };
  const md = new MarkdownIt({
    html: false,
    linkify: false,
    typographer: false,
  });
  md.use(safeDetails);
  const headings = [];
  const related = [...catalog.all.values()].filter(
    (candidate) =>
      !file.imported ||
      (candidate.imported && candidate.revisionId === file.revisionId),
  );
  const byPath = new Map(
    related.flatMap((f) => [
      [f.path, f],
      ...(f.sourcePath ? [[f.sourcePath, f]] : []),
    ]),
  );
  const resolve = (url) => {
    try {
      const [raw, fragment] = url.split("#");
      const candidate = path.resolve(
        path.dirname(file.sourcePath || file.path),
        decodeURIComponent(raw),
      );
      const p = byPath.has(candidate) ? candidate : safePath(candidate);
      return { file: byPath.get(p), fragment };
    } catch {
      return {};
    }
  };
  const image = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx],
      src = token.attrGet("src");
    if (/^https?:|^data:/i.test(src))
      return `<span class="unavailable">外部图片未自动加载：${escape(src)}</span>`;
    const f = resolve(src).file;
    if (!f) return '<span class="unavailable">图片未纳入当前读取范围</span>';
    token.attrSet("src", apiPrefix + "/asset/" + f.id);
    token.attrSet("loading", "lazy");
    token.attrSet("data-zoom", f.id);
    return image(tokens, idx, options, env, self);
  };
  const link =
    md.renderer.rules.link_open ||
    ((tokens, idx, options, env, self) =>
      self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const t = tokens[idx],
      href = t.attrGet("href") || "";
    if (/^https?:/i.test(href)) {
      t.attrSet("target", "_blank");
      t.attrSet("rel", "noopener noreferrer");
    } else if (!href.startsWith("#")) {
      const { file: f, fragment } = resolve(href);
      if (f) {
        t.attrSet(
          "href",
          "#artifact=" +
            f.id +
            (fragment ? "&anchor=" + encodeURIComponent(fragment) : ""),
        );
        t.attrSet("data-artifact", f.id);
      } else {
        t.attrSet("href", "#");
        t.attrSet("data-unavailable", "true");
        t.attrSet("title", "该本地链接未纳入只读目录");
      }
    }
    return link(tokens, idx, options, env, self);
  };
  const env = {};
  const tokens = md.parse(text, env);
  let count = 0;
  for (let i = 0; i < tokens.length; i++)
    if (tokens[i].type === "heading_open") {
      const title = tokens[i + 1]?.content || "",
        id = "heading-" + count++;
      tokens[i].attrSet("id", id);
      headings.push({ id, title, level: Number(tokens[i].tag.slice(1)) });
    }
  return {
    kind: "markdown",
    html:
      md.renderer.render(tokens, md.options, env) +
      "</details>".repeat(env.safeDetailsLevel || 0),
    headings,
    text,
  };
}
