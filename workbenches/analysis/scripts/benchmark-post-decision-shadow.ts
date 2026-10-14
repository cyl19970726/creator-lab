import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { runWorkflow, type AgentRunner } from "@signal-room/workflow";
import { PostgresWorkflowRunStore } from "@signal-room/workflow-postgres";
import { postDecisionShadow, type PostDecisionShadowInput, type ShadowCheckKind } from
  "../packages/research/src/workflows/post-decision-shadow.js";

type ImageFixture = { path: string; sha256: string; label: string; detail?: "low" | "high" | "auto" };
type Fixture = Omit<PostDecisionShadowInput, "images"> & { images: ImageFixture[] };

const usage = "Usage: pnpm --dir workbenches/analysis exec tsx scripts/benchmark-post-decision-shadow.ts --input /absolute/fixture.json [--dry-run]\n" +
  "Fixture: {caseId, kind: evidence_support|cut_check, claim, sourceContext, evidenceRefs: [{artifactId,revision,sha256}], images: [{path,sha256,label,detail?}]}\n" +
  "Live run requires explicit OPENAI_API_KEY and SELF_MEDIA_DATABASE_URL. --dry-run reads and hashes images without network or database access.";

function parseArgs(argv: string[]): { input: string; dryRun: boolean } {
  if (argv.length === 1 && argv[0] === "--help") { process.stdout.write(`${usage}\n`); process.exit(0); }
  let input: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--dry-run") { dryRun = true; continue; }
    if (argv[i] === "--input" && !input && argv[i + 1] && !argv[i + 1]!.startsWith("--")) {
      input = argv[++i]; continue;
    }
    throw new Error("Invalid arguments; run with --help");
  }
  if (!input) throw new Error("--input is required; run with --help");
  return { input: path.resolve(input), dryRun };
}

function asFixture(value: unknown): Fixture {
  if (!value || typeof value !== "object") throw new Error("Fixture must be a JSON object");
  const item = value as Record<string, unknown>;
  if (typeof item.caseId !== "string" || !item.caseId.trim()
    || (item.kind !== "evidence_support" && item.kind !== "cut_check")
    || typeof item.claim !== "string" || !item.claim.trim()
    || typeof item.sourceContext !== "string" || !item.sourceContext.trim()
    || !Array.isArray(item.evidenceRefs) || !item.evidenceRefs.length
    || item.evidenceRefs.some((ref) => !ref || typeof ref !== "object" ||
      !nonempty((ref as Record<string, unknown>).artifactId)
      || !nonempty((ref as Record<string, unknown>).revision)
      || !isSha256((ref as Record<string, unknown>).sha256))
    || !Array.isArray(item.images) || !item.images.length
    || (item.kind === "cut_check" && item.images.length < 2)
    || item.images.some((image) => !image || typeof image !== "object" ||
      !nonempty((image as Record<string, unknown>).path)
      || !isSha256((image as Record<string, unknown>).sha256)
      || !nonempty((image as Record<string, unknown>).label)
      || ((image as Record<string, unknown>).detail !== undefined
        && !["low", "high", "auto"].includes((image as Record<string, unknown>).detail as string)))) {
    throw new Error("Fixture is missing required claim, refs or images");
  }
  return item as unknown as Fixture;
}

function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function isSha256(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value); }

function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  throw new Error("Image must be PNG, JPEG, WebP or GIF");
}

async function loadInput(fixturePath: string): Promise<PostDecisionShadowInput> {
  const fixture = asFixture(JSON.parse(await readFile(fixturePath, "utf8")));
  const images = await Promise.all(fixture.images.map(async (image) => {
    const filePath = path.resolve(path.dirname(fixturePath), image.path);
    const bytes = await readFile(filePath);
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== image.sha256.toLowerCase()) {
      throw new Error(`Image hash mismatch: ${image.label}`);
    }
    return { dataUrl: `data:${mimeFor(filePath)};base64,${bytes.toString("base64")}`,
      sha256: actualHash, label: image.label, ...(image.detail ? { detail: image.detail } : {}) };
  }));
  return { caseId: fixture.caseId, kind: fixture.kind as ShadowCheckKind, claim: fixture.claim,
    sourceContext: fixture.sourceContext, evidenceRefs: fixture.evidenceRefs, images };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const input = await loadInput(options.input);
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify({ status: "prepared", databaseBindingsVerified: false,
      caseId: input.caseId, kind: input.kind,
      evidenceRefs: input.evidenceRefs, images: input.images.map(({ sha256, label }) => ({ sha256, label })) })}\n`);
    return;
  }
  const apiKey = process.env.OPENAI_API_KEY;
  const connectionString = process.env.SELF_MEDIA_DATABASE_URL;
  if (!apiKey || !connectionString) throw new Error("OPENAI_API_KEY and SELF_MEDIA_DATABASE_URL are required for a live run");
  const { OpenAIDecisionsRunner } = await import("@signal-room/workflow-agent-sdk");
  // Resolve the pinned SDK's own OpenAI dependency, without adding an implicit auth or package dependency.
  const sdkRequire = createRequire(new URL("../../../vendor/agent-workflow/packages/agent-sdk/package.json", import.meta.url));
  const OpenAI = sdkRequire("openai").default;
  const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5000 });
  try {
    const store = new PostgresWorkflowRunStore(pool, {
      workspaceId: process.env.SELF_MEDIA_WORKSPACE_ID ?? "creator-lab-analysis" });
    for (const ref of input.evidenceRefs) {
      const actual = await store.getArtifact(ref.artifactId);
      if (!actual || actual.revision !== ref.revision || actual.sha256 !== ref.sha256) {
        throw new Error("Evidence reference does not match a stored artifact");
      }
    }
    const agentRunner: AgentRunner = { run: async () => { throw new Error("Shadow workflow must not invoke an agent"); } };
    const started = performance.now();
    const result = await runWorkflow({ workflow: postDecisionShadow, input, store, agentRunner,
      decisionRunner: new OpenAIDecisionsRunner({ client: new OpenAI({ apiKey }) }) });
    process.stdout.write(`${JSON.stringify({ runId: result.run.id, state: result.run.state,
      databaseBindingsVerified: true,
      elapsedMs: Math.round(performance.now() - started), route: result.output?.route,
      verdict: result.output?.verdict, usage: result.output?.inference.usage })}\n`);
  } finally { await pool.end(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    // Avoid serializing provider/database errors, which may contain credential-bearing request details.
    process.stderr.write(`${error instanceof Error && /^(Invalid arguments|--input is required|Fixture|Image|OPENAI_API_KEY)/.test(error.message)
      ? error.message : "Shadow benchmark failed; inspect the private workflow run events."}\n`);
    process.exitCode = 1;
  });
}
