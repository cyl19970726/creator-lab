import { apiPath, currentWorkspaceId } from "./workspace-api.mjs";
import MarkdownIt from "markdown-it";
import { safeDetails } from "./safe-details.mjs";
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const date = (value) =>
  value
    ? new Date(value).toLocaleString("zh-CN", { hour12: false })
    : "时间未记录";
const md = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
}).use(safeDetails);
function sections(text) {
  const lines = text.split("\n"),
    tokens = md.parse(text, {}),
    headings = [];
  for (let index = 0; index < tokens.length; index++)
    if (tokens[index].type === "heading_open" && tokens[index].tag === "h2")
      headings.push({
        title: tokens[index + 1].content,
        line: tokens[index].map[0],
      });
  return new Map(
    headings.map((heading, index) => [
      heading.title,
      lines
        .slice(heading.line, headings[index + 1]?.line ?? lines.length)
        .join("\n")
        .trim(),
    ]),
  );
}
export function changedSections(before, after) {
  const old = sections(before),
    current = sections(after);
  return [...new Set([...old.keys(), ...current.keys()])]
    .filter((title) => old.get(title) !== current.get(title))
    .map((title) => ({
      title,
      kind: !old.has(title) ? "新增" : !current.has(title) ? "移除" : "修改",
    }));
}
export function relatedTextVersions(assetId, currentHash, versions, revisions) {
  const key = (version) => version.assetId + ":" + version.hash;
  const pending = [
    ...versions.filter((version) => version.assetId === assetId),
    { assetId, hash: currentHash },
  ];
  const seen = new Set();
  while (pending.length) {
    const version = pending.pop();
    if (seen.has(key(version))) continue;
    seen.add(key(version));
    for (const revision of revisions)
      if (
        revision.assetId === version.assetId &&
        revision.expectedHash === version.hash &&
        revision.parent
      )
        pending.push(revision.parent);
  }
  return versions.filter(
    (version) => seen.has(key(version)) && typeof version.text === "string",
  );
}
function normalizedPath(value) {
  try {
    return decodeURIComponent(
      new URL(
        value.startsWith("/") ? value : "/workspace/" + value,
        "http://local",
      ).pathname,
    );
  } catch {
    return value;
  }
}
export function renderVersionMarkdown(text, { file, assets, historical }) {
  const renderMD = new MarkdownIt({
    html: false,
    linkify: false,
    typographer: false,
  }).use(safeDetails);
  const resolve = (href) => {
    if (!file.displayPath) return null;
    try {
      const url = new URL(
        href,
        "http://local" + normalizedPath(file.displayPath),
      );
      const path = decodeURIComponent(url.pathname);
      return assets.find((asset) => normalizedPath(asset.displayPath) === path);
    } catch {
      return null;
    }
  };
  renderMD.renderer.rules.image = (tokens, index) => {
    const token = tokens[index],
      src = token.attrGet("src") || "",
      label = token.content || "原文配图",
      asset = resolve(src);
    return `<span class="snapshot-attachment"><b>${escape(label)}</b><span>${historical ? "原文引用的图片；未保存该图片的历史快照" : "正文引用的当前图片"}</span>${asset ? `<button class="text-button" data-snapshot-asset="${escape(asset.id)}">查看当前登记图片 →</button>` : "<small>图片未纳入当前读取目录</small>"}</span>`;
  };
  const link =
    renderMD.renderer.rules.link_open ||
    ((tokens, index, options, env, self) =>
      self.renderToken(tokens, index, options));
  renderMD.renderer.rules.link_open = (tokens, index, options, env, self) => {
    const token = tokens[index],
      href = token.attrGet("href") || "";
    if (/^https?:/i.test(href)) {
      token.attrSet("target", "_blank");
      token.attrSet("rel", "noopener noreferrer");
      token.attrSet(
        "title",
        historical ? "外部网页当前内容；不是历史快照" : "外部网页",
      );
    } else if (!href.startsWith("#")) {
      const asset = resolve(href);
      token.attrSet("href", "#");
      if (asset) {
        token.attrSet("data-snapshot-asset", asset.id);
        token.attrSet(
          "title",
          historical
            ? "打开当前登记文件；不是此正文版本的附件快照"
            : "打开登记文件",
        );
      } else {
        token.attrSet("data-snapshot-unavailable", "true");
        token.attrSet("title", "原文链接未纳入当前目录");
      }
    }
    return link(tokens, index, options, env, self);
  };
  const env = {},
    tokens = renderMD.parse(text, env),
    headings = [];
  for (let index = 0; index < tokens.length; index++)
    if (tokens[index].type === "heading_open") {
      const id = "snapshot-heading-" + headings.length;
      tokens[index].attrSet("id", id);
      headings.push({ title: tokens[index + 1]?.content || "", id });
    }
  return {
    html:
      renderMD.renderer.render(tokens, renderMD.options, env) +
      "</details>".repeat(env.safeDetailsLevel || 0),
    headings,
  };
}
export async function openVersionReader({
  file,
  title,
  versions,
  revisions,
  selectedHash,
  selectedAssetId = file.id,
  currentHash,
  assets,
  onNavigate,
  onDrawDiagram,
}) {
  document.querySelector("#version-reader-dialog")?.remove();
  const dialog = document.createElement("dialog");
  dialog.id = "version-reader-dialog";
  dialog.className = "snapshot-dialog";
  dialog.innerHTML = '<p role="status">正在读取正文版本…</p>';
  document.body.append(dialog);
  dialog.showModal();
  dialog.addEventListener("close", () => dialog.remove());
  let current;
  try {
    const response = await fetch(apiPath("artifact/") + file.id);
    if (!response.ok) throw Error("当前正文无法读取");
    const result = await response.json();
    current = result.text;
    if (typeof current !== "string") throw Error("此资产没有可读取的正文");
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(current),
    );
    currentHash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch (error) {
    dialog.innerHTML = `<button data-close class="button">关闭</button><p>${escape(error.message)}</p>`;
    dialog.querySelector("[data-close]").onclick = () => dialog.close();
    return;
  }
  const oldVersions = versions.filter(
    (version) =>
      !(version.assetId === file.id && version.hash === currentHash) &&
      typeof version.text === "string",
  );
  let selected =
    oldVersions.find(
      (version) =>
        version.assetId === selectedAssetId && version.hash === selectedHash,
    ) || oldVersions.at(-1);
  let view =
    (selectedAssetId === file.id && selectedHash === currentHash) || !selected
      ? "current"
      : "before";
  const draw = () => {
    if (!dialog.isConnected) return;
    const before = selected?.text ?? current;
    const changes = changedSections(before, current);
    const records = revisions.filter(
      (revision) =>
        revision.parent?.assetId === selected?.assetId &&
        revision.parent?.hash === selected?.hash &&
        revision.assetId === file.id &&
        revision.expectedHash === currentHash,
    );
    const body = view === "before" ? before : current;
    const sourceFile =
      view === "before"
        ? {
            ...assets.find((asset) => asset.id === selected?.assetId),
            name: selected?.name,
            ext: selected?.ext,
          }
        : file;
    const rendered =
      sourceFile.ext === "md"
        ? renderVersionMarkdown(body, {
            file: sourceFile,
            assets,
            historical: view === "before",
          })
        : {
            html: `<pre class="snapshot-plain">${escape(body)}</pre>`,
            headings: [],
          };
    dialog.innerHTML = `<header class="snapshot-header"><div><small>正文版本审阅</small><h2>${escape(title)}</h2></div><button class="button" data-close aria-label="关闭版本审阅">关闭 ×</button></header><section class="snapshot-summary"><h3>这次改了什么</h3>${records.length ? records.map((record) => `<p>${escape(record.text)}</p>`).join("") : "<p>以下按保留正文比较章节；未登记的修改原因不作推断。</p>"}<div class="snapshot-changes">${changes.length ? changes.map((change, index) => `<button class="text-button" data-change="${index}">${escape(change.kind + " · " + change.title)}</button>`).join("") : "<span>这两个版本没有章节正文变化。</span>"}</div></section><div class="snapshot-toolbar"><div class="snapshot-tabs"><button data-snapshot-view="before" ${!selected ? "disabled" : ""} class="${view === "before" ? "selected" : ""}">修订前</button><button data-snapshot-view="current" class="${view === "current" ? "selected" : ""}">当前正文</button></div>${oldVersions.length ? `<label>对照版本<select id="snapshot-version">${oldVersions.map((version, index) => `<option value="${index}" ${version.assetId === selected?.assetId && version.hash === selected?.hash ? "selected" : ""}>${escape(version.name || "正文")} · 保存于 ${escape(date(version.recordedAt))}</option>`).join("")}</select></label>` : ""}<span class="snapshot-identity">${view === "before" ? `修订前：${escape(selected?.name || "保留正文")} · 保存于 ${escape(date(selected?.recordedAt))}` : `当前：${escape(file.name || title)}`}</span></div><div class="snapshot-content"><p class="snapshot-scope">${view === "before" ? "此版本保留文字与文内图解代码。图片、视频及链接目标未随正文保存；打开附件会查看当前登记文件。" : "当前正文取自实际文件。附件按当前目录打开；旧版本的接受范围不自动沿用。"}</p><article class="prose snapshot-prose">${rendered.html}</article><details class="snapshot-source"><summary>版本依据</summary><p>${escape(sourceFile.displayPath || sourceFile.name || "原资产路径未保留")}</p><p>${escape(view === "before" ? selected?.hash : currentHash)}</p></details></div>`;
    dialog.querySelector("[data-close]").onclick = () => dialog.close();
    dialog.querySelectorAll("[data-snapshot-view]").forEach(
      (button) =>
        (button.onclick = () => {
          view = button.dataset.snapshotView;
          draw();
        }),
    );
    dialog
      .querySelector("#snapshot-version")
      ?.addEventListener("change", (event) => {
        selected = oldVersions[Number(event.target.value)];
        draw();
      });
    dialog.querySelectorAll("[data-change]").forEach(
      (button) =>
        (button.onclick = () => {
          const heading = rendered.headings.find(
            (heading) =>
              heading.title === changes[Number(button.dataset.change)].title,
          );
          if (heading)
            dialog
              .querySelector("#" + heading.id)
              ?.scrollIntoView({ block: "start", behavior: "smooth" });
        }),
    );
    dialog.querySelectorAll("[data-snapshot-asset]").forEach(
      (link) =>
        (link.onclick = (event) => {
          event.preventDefault();
          dialog.close();
          onNavigate(link.dataset.snapshotAsset);
        }),
    );
    dialog.querySelectorAll("[data-snapshot-unavailable]").forEach(
      (link) =>
        (link.onclick = (event) => {
          event.preventDefault();
          link.title = "该原文链接暂时无法在工作台打开";
        }),
    );
    dialog
      .querySelectorAll(
        '.snapshot-prose a[href^="#"]:not([data-snapshot-asset]):not([data-snapshot-unavailable])',
      )
      .forEach(
        (link) =>
          (link.onclick = (event) => {
            event.preventDefault();
            const id = link.getAttribute("href").slice(1);
            dialog
              .querySelector("#" + CSS.escape(id))
              ?.scrollIntoView({ block: "start" });
          }),
      );
    dialog.querySelectorAll("code.language-mermaid").forEach((code) => {
      const frame = document.createElement("div");
      frame.className = "embedded-diagram";
      const source = code.textContent;
      code.parentElement.replaceWith(frame);
      onDrawDiagram?.(frame, source);
    });
  };
  draw();
}
