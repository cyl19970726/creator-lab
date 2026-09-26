import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [path.join(dir, "src/app.mjs")],
  outdir: path.join(dir, "dist"),
  bundle: true,
  format: "esm",
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  minify: true,
  target: "es2022",
  logLevel: "info",
});
