import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export type ValidatedDraftRef = { draftId: string; sha256: string };
type DraftJson = null | boolean | number | string | DraftJson[] | { [key: string]: DraftJson };
export type ValidatedDraftReceipt = ValidatedDraftRef & { pass: boolean; errors: DraftJson[] };
type Entry = ValidatedDraftReceipt & { createdAt: number };
type Manifest = { namespace: string; instanceId: string; entries: Record<string, Entry> };

const lifetimeMs = 24 * 60 * 60 * 1000;
const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function plainJson<T>(value: T): T {
  const bytes = JSON.stringify(value);
  if (typeof bytes !== "string") throw new Error("VALIDATED_DRAFT_NOT_JSON");
  return JSON.parse(bytes) as T;
}

function regular(filename: string): boolean {
  try { return fs.lstatSync(filename).isFile(); } catch { return false; }
}

/** Attempt-local, instance-bound storage for validated model drafts. */
export class ValidatedDraftStore<T> {
  private readonly instanceId = randomUUID();
  private readonly root: string;
  private readonly manifestPath: string;
  private readonly entries = new Map<string, Entry>();

  constructor(directory: string, private readonly namespace: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u.test(namespace)) throw new Error("VALIDATED_DRAFT_NAMESPACE_INVALID");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(directory).isDirectory()) throw new Error("VALIDATED_DRAFT_DIRECTORY_INVALID");
    this.root = path.join(fs.realpathSync(directory), `.validated-drafts-${namespace}-${this.instanceId}`);
    fs.mkdirSync(this.root, { mode: 0o700 });
    this.manifestPath = path.join(this.root, "manifest.json");
    this.writeManifest();
  }

  stage(value: T, validation: { pass: boolean; errors?: unknown[] }): ValidatedDraftReceipt {
    if (typeof validation?.pass !== "boolean" || (validation.errors !== undefined && !Array.isArray(validation.errors))) {
      throw new Error("VALIDATED_DRAFT_VALIDATION_INVALID");
    }
    const cloned = plainJson(value);
    const errors = plainJson(validation.errors ?? []) as DraftJson[];
    const bytes = Buffer.from(`${JSON.stringify(cloned)}\n`, "utf8");
    const draftId = randomUUID();
    const entry: Entry = { draftId, sha256: digest(bytes), pass: validation.pass, errors, createdAt: Date.now() };
    const filename = this.file(draftId);
    fs.writeFileSync(filename, bytes, { flag: "wx", mode: 0o600 });
    this.entries.set(draftId, entry);
    try { this.writeManifest(); } catch (error) {
      this.entries.delete(draftId);
      fs.rmSync(filename, { force: true });
      throw error;
    }
    return { draftId, sha256: entry.sha256, pass: entry.pass, errors: plainJson(entry.errors) };
  }

  resolve(ref: ValidatedDraftRef, options: { requireValid?: boolean } = {}): T {
    if (!ref || typeof ref.draftId !== "string" || typeof ref.sha256 !== "string") {
      throw new Error("VALIDATED_DRAFT_REFERENCE_INVALID");
    }
    const entry = this.entries.get(ref.draftId);
    if (!entry || entry.sha256 !== ref.sha256) throw new Error("VALIDATED_DRAFT_UNKNOWN_OR_SHA_MISMATCH");
    if (Date.now() - entry.createdAt > lifetimeMs) throw new Error("VALIDATED_DRAFT_EXPIRED");
    if (options.requireValid !== false && !entry.pass) throw new Error("VALIDATED_DRAFT_NOT_VALID");
    if (!regular(this.manifestPath)) throw new Error("VALIDATED_DRAFT_MANIFEST_CHANGED");
    const manifest = JSON.parse(fs.readFileSync(this.manifestPath, "utf8")) as Manifest;
    if (manifest.namespace !== this.namespace || manifest.instanceId !== this.instanceId
      || !manifest.entries || !own(manifest.entries, ref.draftId)
      || JSON.stringify(manifest.entries[ref.draftId]) !== JSON.stringify(entry)) {
      throw new Error("VALIDATED_DRAFT_MANIFEST_CHANGED");
    }
    const filename = this.file(ref.draftId);
    if (!regular(filename)) throw new Error("VALIDATED_DRAFT_FILE_CHANGED");
    const bytes = fs.readFileSync(filename);
    if (digest(bytes) !== entry.sha256) throw new Error("VALIDATED_DRAFT_FILE_CHANGED");
    return JSON.parse(bytes.toString("utf8")) as T;
  }

  private file(draftId: string): string { return path.join(this.root, `${draftId}.json`); }

  private writeManifest(): void {
    const manifest: Manifest = { namespace: this.namespace, instanceId: this.instanceId,
      entries: Object.fromEntries(this.entries) };
    const temporary = path.join(this.root, `manifest-${randomUUID()}.tmp`);
    fs.writeFileSync(temporary, `${JSON.stringify(manifest)}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, this.manifestPath);
  }
}
