import { stateRoot } from "./src/paths.mjs";
import { createWorkspaceStore } from "./src/workspace-store.mjs";
import { createCatalogIndex } from "./src/catalog-index.mjs";
import {
  createCollaborationStore,
  CollaborationError,
} from "./src/collaboration-store.mjs";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publicCatalog, safePath, hash } from "./src/catalog.mjs";
import { renderArtifact } from "./src/render.mjs";
import { createIntegrationStore } from "./src/integration-store.mjs";
const base = path.dirname(fileURLToPath(import.meta.url));
const types = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  svg: "image/svg+xml",
  webp: "image/webp",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  srt: "text/plain",
  md: "text/plain",
  json: "application/json",
  txt: "text/plain",
  html: "text/plain",
};
export function createServer({
  index = createCatalogIndex(),
  collaboration,
  workspaces,
  integration,
} = {}) {
  const work =
    workspaces || createWorkspaceStore({ catalog: () => index.read() });
  const identityStore =
    integration ||
    createIntegrationStore({
      filename: workspaces
        ? ":memory:"
        : path.join(stateRoot, "workspaces.sqlite"),
      workspaceStore: work,
    });
  const catalog = (workspaceId) => identityStore.catalog(workspaceId);
  const resolveAsset = (workspaceId, id) => {
    const c = catalog(workspaceId); const a = c.all.get(c.aliases?.[id] || id);
    if (!a) throw new CollaborationError(404, "UNKNOWN_ASSET", "资产不属于当前工作区");
    if (a.workflowIdentity && hash(a.path) !== a.sha256) throw new CollaborationError(409, "SNAPSHOT_CHANGED", "研究资产文件已改变");
    return { catalog: c, asset: a };
  };
  const store =
    collaboration || createCollaborationStore({ catalog, scopeRequired: true });
  const server = http.createServer(async (req, res) => {
    const send = (status, data, type = "application/json") => {
      res.writeHead(status, {
        "Content-Type": type + "; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(typeof data === "string" ? data : JSON.stringify(data));
    };
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    const host = req.headers.host || "";
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host))
      return send(403, { error: "仅允许本机访问" });
    if (req.headers.origin && req.headers.origin !== "http://" + host)
      return send(403, { error: "拒绝跨站请求" });
    const entryNavigation =
      ["GET", "HEAD"].includes(req.method) &&
      req.url.split("?")[0] === "/" &&
      req.headers["sec-fetch-mode"] === "navigate" &&
      req.headers["sec-fetch-dest"] === "document";
    if (
      req.headers["sec-fetch-site"] &&
      !["same-origin", "none"].includes(req.headers["sec-fetch-site"]) &&
      !entryNavigation
    )
      return send(403, { error: "拒绝跨站请求", code: "CROSS_SITE" });
    if (
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
        req.socket.remoteAddress,
      )
    )
      return send(403, { error: "仅允许本机连接", code: "LOCAL_ONLY" });
    try {
      const url = new URL(req.url, "http://" + host);
      if (
        url.pathname === "/api/workspaces" &&
        ["GET", "HEAD"].includes(req.method)
      )
        return send(200, { workspaces: work.summaries() });
      const scopedRoute = url.pathname.match(
        /^\/api\/workspaces\/([a-zA-Z0-9_-]{1,100})(\/.*)$/,
      );
      const requestedWorkspaceId = scopedRoute?.[1];
      const workspaceId = requestedWorkspaceId
        ? work.canonicalWorkspaceId(requestedWorkspaceId)
        : undefined;
      const route = scopedRoute ? "/api" + scopedRoute[2] : url.pathname;
      if (url.pathname.startsWith("/api/") && !workspaceId) {
        if (!["GET", "HEAD"].includes(req.method))
          return send(405, {
            error: "此路由不接受写操作",
            code: "METHOD_NOT_ALLOWED",
          });
        return send(400, {
          error: "请明确选择工作区",
          code: "WORKSPACE_REQUIRED",
        });
      }
      if (workspaceId) work.workspace(workspaceId);
      const summaryRoute = route.match(
        /^\/api\/collaboration-summary\/([a-zA-Z0-9_-]{1,100})$/,
      );
      const collaborationRoute = route.match(
        /^\/api\/collaboration\/([a-zA-Z0-9_-]{1,100})(\/events)?$/,
      );
      if (
        ["POST", "PUT"].includes(req.method) &&
        (collaborationRoute?.[2] ||
          ["/api/imports", "/api/candidates", "/api/identity"].includes(
            route,
          ) ||
          summaryRoute)
      ) {
        if (
          !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
            req.headers["content-type"] || "",
          )
        )
          return send(415, { error: "只接受 JSON", code: "CONTENT_TYPE" });
        if (
          req.headers["content-encoding"] &&
          req.headers["content-encoding"] !== "identity"
        )
          return send(415, {
            error: "不接受压缩请求体",
            code: "CONTENT_ENCODING",
          });
        if (Number(req.headers["content-length"] || 0) > 65536)
          return send(413, {
            error: "意见内容超过 64KiB",
            code: "BODY_TOO_LARGE",
          });
        const chunks = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 65536)
            return send(413, {
              error: "意见内容超过 64KiB",
              code: "BODY_TOO_LARGE",
            });
          chunks.push(chunk);
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return send(400, { error: "JSON 格式不正确", code: "INVALID_JSON" });
        }
        if (collaborationRoute) {
          if (
            !catalog(workspaceId).topics.some(
              (t) => t.id === collaborationRoute[1],
            )
          )
            return send(404, {
              error: "选题不属于当前工作区",
              code: "UNKNOWN_TOPIC",
            });
        }
        const result =
          route === "/api/identity"
            ? identityStore.saveIdentity(workspaceId, body)
            : summaryRoute
              ? identityStore.saveSummary(workspaceId, summaryRoute[1], body)
              : route === "/api/imports"
                ? work.importAsset(workspaceId, body)
                : route === "/api/candidates"
                  ? work.saveCandidate(workspaceId, body)
                  : store.append(collaborationRoute[1], body, workspaceId);
        return send(result.replayed ? 200 : 201, result);
      }
      if (!["GET", "HEAD"].includes(req.method))
        return send(405, {
          error: "此路由不接受写操作",
          code: "METHOD_NOT_ALLOWED",
        });
      if (route === "/api/identity")
        return send(200, identityStore.identity(workspaceId));
      if (summaryRoute)
        return send(200, identityStore.summary(workspaceId, summaryRoute[1]));
      if (collaborationRoute && !collaborationRoute[2]) {
        if (
          !catalog(workspaceId).topics.some(
            (t) => t.id === collaborationRoute[1],
          )
        )
          return send(404, {
            error: "选题不属于当前工作区",
            code: "UNKNOWN_TOPIC",
          });
        return send(
          200,
          store.read(
            collaborationRoute[1],
            url.searchParams.get("assetId") || undefined,
            workspaceId,
          ),
        );
      }
      if (route === "/api/inventory")
        return send(200, {
          ...work.inventory(workspaceId),
          workspace: {
            ...work.workspace(workspaceId),
            ...identityStore.identity(workspaceId),
          },
          topics: catalog(workspaceId).topics.map((t) => ({
            id: t.id,
            title: t.title,
            direction: t.direction,
            assetCount: t.artifacts.length,
          })),
        });
      if (route === "/api/candidates")
        return send(200, { items: work.inventory(workspaceId).candidates });
      if (route === "/api/catalog") {
        return send(200, publicCatalog(catalog(workspaceId)));
      }
      if (route === "/api/search")
        return send(200, {
          items: [...catalog(workspaceId).all.values()]
            .filter((a) =>
              a.name
                .toLocaleLowerCase()
                .includes(
                  (url.searchParams.get("q") || "")
                    .slice(0, 150)
                    .toLocaleLowerCase(),
                ),
            )
            .sort((a, b) => a.name.localeCompare(b.name))
            .slice(0, 50)
            .map((a) => ({
              id: a.id,
              name: a.name,
              topic_id: a.topicId,
              revision_id: a.revisionId,
            })),
        });
      const fingerprint = route.match(/^\/api\/fingerprint\/([a-f0-9]{24})$/);
      if (fingerprint) {
        const { asset: file } = resolveAsset(workspaceId, fingerprint[1]);
        return send(200, {
          assetId: file.id,
          hash: hash(file.path),
          name: file.name,
          revisionId: file.revisionId || null,
        });
      }
      const match = route.match(/^\/api\/(artifact|asset)\/([a-f0-9]{24})$/);
      if (match) {
        const { catalog: c, asset: f } = resolveAsset(
          workspaceId,
          match[2],
        );
        if (!f || !safePath(f.path))
          return send(404, { error: "产物不存在或不在允许范围" });
        if (match[1] === "artifact")
          return send(200, {
            ...renderArtifact(f, c, "/api/workspaces/" + workspaceId),
            hash: f.sha256 || undefined,
            id: f.id,
            name: f.name,
            displayPath: f.displayPath,
            mtime: fs.statSync(f.path).mtime.toISOString(),
          });
        const stat = fs.statSync(f.path),
          range = req.headers.range;
        const mime = types[f.ext] || "application/octet-stream";
        // Even direct SVG navigation cannot execute embedded code.
        res.setHeader(
          "Content-Security-Policy",
          "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
        );
        res.setHeader("Content-Type", mime);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Accept-Ranges", "bytes");
        let start = 0,
          end = stat.size - 1,
          status = 200;
        if (range) {
          const m = range.match(/^bytes=(\d*)-(\d*)$/);
          if (!m || (!m[1] && !m[2])) {
            res.writeHead(416);
            return res.end();
          }
          if (!m[1]) start = Math.max(0, stat.size - Number(m[2]));
          else start = Number(m[1]);
          if (m[1] && m[2]) end = Math.min(Number(m[2]), end);
          if (start > end || start >= stat.size) {
            res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
            return res.end();
          }
          status = 206;
          res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
        }
        res.writeHead(status, {
          "Content-Length": Math.max(0, end - start + 1),
        });
        if (req.method === "HEAD" || stat.size === 0) return res.end();
        const stream = fs.createReadStream(f.path, { start, end });
        stream.on("error", () => res.destroy());
        res.on("close", () => stream.destroy());
        return stream.pipe(res);
      }
      const staticMap = {
        "/": "public/index.html",
        "/style.css": "public/style.css",
        "/workspace.css": "public/workspace.css",
        "/runtime.css": "public/runtime.css",
        "/collaboration.css": "public/collaboration.css",
        "/accounts.css": "public/accounts.css",
        "/app.js": "dist/app.js",
      };
      let resource = staticMap[url.pathname];
      if (/^\/chunks\/[a-zA-Z0-9_.-]+\.js$/.test(url.pathname))
        resource = "dist" + url.pathname;
      if (!resource) return send(404, { error: "不存在的页面" });
      const p = path.join(base, resource);
      if (!fs.existsSync(p))
        return send(503, { error: "先运行 pnpm --filter @creator-lab/creation build 生成前端" });
      const mime = p.endsWith(".js")
        ? "text/javascript"
        : p.endsWith(".css")
          ? "text/css"
          : "text/html";
      return send(200, fs.readFileSync(p, "utf8"), mime);
    } catch (error) {
      if (
        error instanceof CollaborationError ||
        (Number.isInteger(error.status) && error.code)
      )
        return send(error.status, {
          error: error.message,
          code: error.code,
          ...(error.details ? { details: error.details } : {}),
        });
      return send(500, {
        error: "读取暂时失败，请刷新",
        detail: String(error.message).slice(0, 180),
      });
    }
  });
  server.on("close", () => {
    index.close();
    store.close();
    identityStore.close();
    work.close();
  });
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4337);
  createServer().listen(port, "127.0.0.1", () =>
    console.log(`协作工作台 http://127.0.0.1:${port} · 所有请求仅在本机处理`),
  );
}
