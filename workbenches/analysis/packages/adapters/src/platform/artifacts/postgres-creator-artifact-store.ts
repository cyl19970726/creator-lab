import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { PostgresBlobStore } from "@signal-room/workflow-spaces";
import type { CreatorArtifactStore } from "../../../../research/index.js";
import { artifactPath, artifactRef } from "../../core/artifacts.js";
import { runArtifactDir } from "../../core/config.js";
import { AnalysisPgContext } from "../database/analysis-pg-context.js";

type ArtifactRow = { reference: string; run_id: string; logical_name: string; blob_key: string;
  sha256: string; bytes: string | number; chunk_keys: string[]; dependencies: string[]; created_at: string };
const CHUNK_BYTES = 8 * 1024 * 1024;
const permittedText = /\.(?:json|jsonl|md|txt|srt|vtt|csv|tsv|html|xml|ya?ml)$/i;
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
async function hashFile(filename: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const part of createReadStream(filename)) hash.update(part as Buffer);
  return hash.digest("hex");
}
function versionedFilename(filename: string, hash: string): string {
  const extension = path.extname(filename), stem = extension ? filename.slice(0,-extension.length) : filename;
  return `${stem}.${hash.slice(0,12)}${extension}`;
}
function parseReference(reference: string): { runId: string; filename: string } {
  const match = reference.match(/^\/artifacts\/([0-9a-f-]+)\/(.+)$/i);
  if (!match?.[1] || !match[2]) throw new Error(`无法解析 artifact reference: ${reference}`);
  artifactPath(reference); // existing traversal boundary
  return { runId: match[1], filename: match[2] };
}

/** PostgreSQL is authoritative; local files are disposable reader/media materializations. */
export class PostgresCreatorArtifactStore implements CreatorArtifactStore {
  private readonly blobs: PostgresBlobStore;
  constructor(private readonly context: AnalysisPgContext, blobs?: PostgresBlobStore) {
    this.blobs = blobs ?? new PostgresBlobStore(context.pool);
  }

  async migrate(): Promise<void> { await this.blobs.migrate(); }

  async write(runId: string, filename: string, value: unknown, dependencies: string[] = []): Promise<string> {
    const bytes = Buffer.from(`${JSON.stringify(value,null,2)}\n`,"utf8");
    const reference = artifactRef(runId,versionedFilename(filename,sha256(bytes)));
    await this.store(reference,filename,bytes,dependencies);
    await this.materialize(reference);
    return reference;
  }

  async read(reference: string): Promise<unknown> {
    const bytes = await this.bytes(reference);
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  }

  /** Import an exact legacy reference without rewriting stored run/report pointers. */
  async ingest(reference: string, sourcePath: string, logicalName?: string, dependencies: string[] = []): Promise<void> {
    const parsed = parseReference(reference);
    const bytes = await fs.readFile(sourcePath);
    await this.store(reference,logicalName ?? path.basename(parsed.filename),bytes,dependencies);
  }

  /** Capture one runner attempt; media bytes live in a separate managed root. */
  async ingestRun(runId: string, sourceRoot: string, subdirectory = "."):
    Promise<{ ingested: number; ingestedMedia: number; bytes: number }> {
    const root = path.resolve(sourceRoot,runId);
    const start = path.resolve(root,subdirectory);
    if (start !== root && !start.startsWith(`${root}${path.sep}`)) throw new Error("Runner directory escapes run root");
    let component = root;
    if ((await fs.lstat(component)).isSymbolicLink()) throw new Error(`Runner directory is a symlink: ${component}`);
    for (const name of path.relative(root,start).split(path.sep).filter((part) => part && part !== ".")) {
      component = path.join(component,name);
      if ((await fs.lstat(component)).isSymbolicLink()) throw new Error(`Runner directory is a symlink: ${component}`);
    }
    const managedRoot = process.env.SELF_MEDIA_MANAGED_MEDIA_DIR;
    let ingested = 0, ingestedMedia = 0, totalBytes = 0;
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await fs.readdir(directory,{withFileTypes:true})) {
        const absolute = path.join(directory,entry.name);
        const relative = path.relative(root,absolute).split(path.sep).join("/");
        const reference = artifactRef(runId,relative);
        if (entry.isSymbolicLink()) {
          if (permittedText.test(entry.name)) throw new Error(`Text artifact cannot be a symlink: ${absolute}`);
          await this.assertManagedMediaLink(reference,absolute);
          continue;
        }
        if (entry.isDirectory()) { await visit(absolute); continue; }
        if (!entry.isFile()) continue;
        if (!permittedText.test(entry.name)) {
          if (!managedRoot) throw new Error("SELF_MEDIA_MANAGED_MEDIA_DIR is required for new media");
          await this.ingestMedia(reference,absolute,managedRoot);
          ingestedMedia++;
          continue;
        }
        const bytes = await fs.readFile(absolute);
        await this.store(reference,relative,bytes,[]);
        ingested++; totalBytes += bytes.byteLength;
      }
    };
    await visit(start);
    return { ingested, ingestedMedia, bytes: totalBytes };
  }

  private async assertManagedMediaLink(reference: string, filename: string): Promise<void> {
    const result = await this.context.query<{ managed_path:string; bytes:string|number }>(
      "SELECT managed_path,bytes FROM analysis_media_refs WHERE reference=$1",[reference]);
    const row = result.rows[0];
    if (!row || path.resolve(path.dirname(filename),await fs.readlink(filename)) !== row.managed_path)
      throw new Error(`Unregistered media symlink: ${reference}`);
    const stat = await fs.stat(row.managed_path);
    if (!stat.isFile() || stat.size !== Number(row.bytes)) throw new Error(`Managed media changed: ${reference}`);
  }

  private async ingestMedia(reference: string, source: string, managedRoot: string): Promise<void> {
    const parsed = parseReference(reference);
    const root = path.resolve(managedRoot);
    const destination = path.resolve(root,parsed.runId,parsed.filename);
    if (!destination.startsWith(`${root}${path.sep}`)) throw new Error("Media path escapes managed root");
    const sourceStat = await fs.stat(source);
    const sourceHash = await hashFile(source);
    await fs.mkdir(path.dirname(destination),{recursive:true});
    try {
      if (await hashFile(destination) !== sourceHash) throw new Error(`Managed media conflict: ${reference}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const temporary = `${destination}.ingesting-${process.pid}-${Math.random().toString(36).slice(2)}`;
      try {
        await fs.copyFile(source,temporary);
        if (await hashFile(temporary) !== sourceHash) throw new Error(`Media copy changed: ${reference}`);
        try { await fs.link(temporary,destination); }
        catch (linkError) { if ((linkError as NodeJS.ErrnoException).code !== "EEXIST") throw linkError; }
      } finally { await fs.rm(temporary,{force:true}); }
      if (await hashFile(destination) !== sourceHash) throw new Error(`Managed media conflict: ${reference}`);
    }
    await this.context.transaction(async () => {
      await this.context.assertLease(undefined,parsed.runId);
      await this.context.query(`INSERT INTO analysis_media_refs
        (reference,run_id,managed_path,sha256,bytes,created_at) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT(reference) DO NOTHING`,
      [reference,parsed.runId,destination,sourceHash,sourceStat.size,sourceStat.mtime.toISOString()]);
      const result = await this.context.query<{ managed_path:string; sha256:string; bytes:string|number }>(
        "SELECT managed_path,sha256,bytes FROM analysis_media_refs WHERE reference=$1",[reference]);
      const row = result.rows[0];
      if (!row || row.managed_path !== destination || row.sha256 !== sourceHash || Number(row.bytes) !== sourceStat.size)
        throw new Error(`Immutable media reference conflict: ${reference}`);
    });
  }

  async bytes(reference: string): Promise<Uint8Array> {
    const result = await this.context.query<ArtifactRow>(
      "SELECT * FROM analysis_artifact_refs WHERE reference=$1", [reference]);
    const row = result.rows[0];
    if (!row) throw new Error(`artifact 未登记: ${reference}`);
    const chunks = Array.isArray(row.chunk_keys) && row.chunk_keys.length ? row.chunk_keys : [row.blob_key];
    const parts = await Promise.all(chunks.map((key) => this.blobs.get(key)));
    const bytes = Buffer.concat(parts.map((part) => Buffer.from(part)));
    if (bytes.byteLength !== Number(row.bytes) || sha256(bytes) !== row.sha256) {
      throw new Error(`artifact 内容校验失败: ${reference}`);
    }
    return bytes;
  }

  async materialize(reference: string): Promise<string> {
    parseReference(reference);
    const target = artifactPath(reference);
    const bytes = await this.bytes(reference);
    await this.assertNoSymlinkParents(target);
    await fs.mkdir(path.dirname(target),{recursive:true});
    const temporary = `${target}.materializing-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await fs.writeFile(temporary,bytes);
    await fs.rename(temporary,target);
    return target;
  }

  async list(runId: string): Promise<ArtifactRow[]> {
    const result = await this.context.query<ArtifactRow>(
      "SELECT * FROM analysis_artifact_refs WHERE run_id=$1 ORDER BY created_at,reference", [runId]);
    return result.rows;
  }

  async materializeAll(): Promise<{ files: number; bytes: number }> {
    const result = await this.context.query<ArtifactRow>(
      "SELECT * FROM analysis_artifact_refs ORDER BY run_id,reference");
    let bytes = 0;
    for (const row of result.rows) {
      await this.materialize(row.reference);
      bytes += Number(row.bytes);
    }
    return { files: result.rows.length, bytes };
  }

  /** Restore each managed media file as an individual read-only cache link. */
  async materializeMediaAll(): Promise<{ files: number; bytes: number }> {
    const result = await this.context.query<{ reference:string; managed_path:string; bytes:string|number; sha256:string }>(
      "SELECT reference,managed_path,bytes,sha256 FROM analysis_media_refs ORDER BY reference");
    let bytes = 0;
    for (const row of result.rows) {
      parseReference(row.reference);
      const target = artifactPath(row.reference);
      await this.assertNoSymlinkParents(target);
      const stat = await fs.stat(row.managed_path);
      if (!stat.isFile() || stat.size !== Number(row.bytes)) throw new Error(`Managed media is missing or changed: ${row.reference}`);
      await fs.mkdir(path.dirname(target),{recursive:true});
      try {
        const existing = await fs.lstat(target);
        if (existing.isSymbolicLink()) {
          if (path.resolve(path.dirname(target),await fs.readlink(target)) !== row.managed_path)
            throw new Error(`Media cache path is occupied: ${target}`);
        } else if (existing.isFile() && existing.size === stat.size && await hashFile(target) === row.sha256) {
          // A runner's just-ingested file becomes a disposable cache link on restart.
          await fs.unlink(target);
          await fs.symlink(row.managed_path,target);
        } else {
          throw new Error(`Media cache path is occupied: ${target}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await fs.symlink(row.managed_path,target);
      }
      bytes += stat.size;
    }
    return { files:result.rows.length,bytes };
  }

  async verifyManagedMedia(reference: string): Promise<boolean> {
    const result = await this.context.query<{ managed_path:string; sha256:string; bytes:string|number }>(
      "SELECT managed_path,sha256,bytes FROM analysis_media_refs WHERE reference=$1",[reference]);
    const row = result.rows[0];
    if (!row) return false;
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const part of createReadStream(row.managed_path)) {
      hash.update(part as Buffer); bytes += (part as Buffer).byteLength;
    }
    return bytes === Number(row.bytes) && hash.digest("hex") === row.sha256;
  }

  /** Verify that a restored cache link belongs to this exact registered media reference. */
  async verifyManagedMediaLink(reference: string, filename: string): Promise<boolean> {
    try {
      if (path.resolve(filename) !== path.resolve(artifactPath(reference))) return false;
      if (!(await fs.lstat(filename)).isSymbolicLink()) return false;
      await this.assertManagedMediaLink(reference, filename);
      return await this.verifyManagedMedia(reference);
    } catch { return false; }
  }

  async archiveReconstructionEvaluations(runId: string, postExternalId: string, revision: number, archiveId: string): Promise<void> {
    const root = path.join(runArtifactDir(runId),"video-reconstructions",postExternalId);
    const history = path.join(root,"pipeline-retry-history",`revision-${revision}-${archiveId}`);
    const names = ["evaluation.json","evaluation.md","gate-report.json",
      "runtime-three-lens-evaluation.json","runtime-three-lens-gate-report.json"];
    let created = false;
    for (const name of names) {
      const source = path.join(root,name);
      try {
        await fs.access(source);
        if (!created) { await fs.mkdir(history,{recursive:true}); created = true; }
        await fs.rename(source,path.join(history,name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  async reconstructionProgress(runId: string, postExternalId: string): Promise<string> {
    const root = path.join(runArtifactDir(runId),"video-reconstructions",postExternalId);
    const stages = [
      ["gate-report.json","gate_report"],["evaluation.json","independent_evaluation"],
      ["reconstruction.json","structured_reconstruction"],
      [path.join("targeted-evidence","targeted-evidence.json"),"targeted_capture"],
      ["capture-protocol.json","capture_protocol"],["probe.json","round_one_probe"],
      [path.join("evidence","evidence-pack.json"),"evidence_pack"]
    ] as const;
    for (const [filename,stage] of stages) {
      try { await fs.access(path.join(root,filename)); return stage; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    return "runner_start";
  }

  private async store(reference: string, logicalName: string, bytes: Uint8Array, dependencies: string[]): Promise<void> {
    const { runId } = parseReference(reference), hash = sha256(bytes), key = `analysis/artifact/${hash}`;
    const chunkKeys: string[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
      const part = bytes.subarray(offset,offset+CHUNK_BYTES);
      const chunkKey = `analysis/artifact/chunk/${sha256(part)}`;
      await this.blobs.put(chunkKey,part);
      chunkKeys.push(chunkKey);
    }
    if (chunkKeys.length === 0) {
      const chunkKey = `analysis/artifact/chunk/${sha256(new Uint8Array())}`;
      await this.blobs.put(chunkKey,new Uint8Array());
      chunkKeys.push(chunkKey);
    }
    await this.context.transaction(async () => {
      await this.context.assertLease(undefined,runId);
      await this.context.query(`INSERT INTO analysis_artifact_refs
      (reference,run_id,logical_name,blob_key,sha256,bytes,chunk_keys,dependencies,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9) ON CONFLICT(reference) DO NOTHING`,
    [reference,runId,logicalName,key,hash,bytes.byteLength,JSON.stringify(chunkKeys),
      JSON.stringify([...new Set(dependencies)]),new Date().toISOString()]);
      const result = await this.context.query<ArtifactRow>("SELECT * FROM analysis_artifact_refs WHERE reference=$1",[reference]);
      const row = result.rows[0];
      if (!row || row.sha256 !== hash || Number(row.bytes) !== bytes.byteLength || row.blob_key !== key
        || JSON.stringify(row.chunk_keys) !== JSON.stringify(chunkKeys)) {
        throw new Error(`Immutable artifact reference conflict: ${reference}`);
      }
    });
  }

  private async assertNoSymlinkParents(target: string): Promise<void> {
    const runsRoot = path.resolve(runArtifactDir("00000000-0000-0000-0000-000000000000"),"..");
    let current = path.dirname(target);
    while (current.startsWith(`${runsRoot}${path.sep}`) || current === runsRoot) {
      try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Artifact cache traverses a symlink: ${current}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (current === runsRoot) break;
      current = path.dirname(current);
    }
  }
}
