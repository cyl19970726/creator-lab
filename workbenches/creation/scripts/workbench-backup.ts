import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { acquireWorkerLock } from '../src/infrastructure/process-lock.js';

const manifestName = '.workbench-backup-manifest.json';
const schemaVersion = 'workbench-state-v1';
interface FileRecord { path: string; bytes: number; sha256: string; mode: number }
interface Manifest { schema: typeof schemaVersion; createdAt: string; sqliteUserVersion: number; files: FileRecord[] }
const sensitiveDirectories = new Set(['.codex', 'CODEX_HOME', 'codex-home', 'credentials', 'secrets']);
const sensitiveFiles = new Set(['auth.json', 'credentials.json', 'secrets.json', 'worker.lock', '.env', 'config.toml']);
const shaPattern = /^[a-f0-9]{64}$/;
function excluded(relative: string, directory: boolean): boolean {
  const name = path.basename(relative);
  if (!relative.includes(path.sep) && name === '.api-process') return true;
  if (name === manifestName) throw new Error('Source contains the reserved backup manifest name');
  if (directory) return sensitiveDirectories.has(name);
  return sensitiveFiles.has(name) || name.startsWith('.env.');
}
function inside(parent: string, child: string): boolean { return child === parent || child.startsWith(`${parent}${path.sep}`); }
async function regularRoot(root: string): Promise<string> {
  const absolute = path.resolve(root);
  const stat = await lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Root must be a real directory, not a symlink');
  return await realpath(absolute);
}
async function prospective(destination: string): Promise<string> {
  const absolute = path.resolve(destination);
  const parent = await realpath(path.dirname(absolute));
  return path.join(parent, path.basename(absolute));
}
async function assertFresh(destination: string): Promise<{ path: string; existed: boolean }> {
  const target = await prospective(destination);
  try {
    const stat = await lstat(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Destination must be an empty real directory');
    if ((await readdir(target)).length) throw new Error('Destination is not empty');
    return { path: target, existed: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { path: target, existed: false };
  }
}
async function listFiles(root: string, skipManifest = false): Promise<Array<{ absolute: string; relative: string; mode: number; bytes: number }>> {
  const found: Array<{ absolute: string; relative: string; mode: number; bytes: number }> = [];
  async function walk(directory: string, prefix = ''): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const relative = prefix ? path.join(prefix, name) : name;
      const absolute = path.join(directory, name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Symlink is forbidden in workbench state: ${relative}`);
      if (skipManifest && relative === manifestName) continue;
      if (excluded(relative, stat.isDirectory())) continue;
      if (stat.isDirectory()) await walk(absolute, relative);
      else if (stat.isFile()) found.push({ absolute, relative: relative.split(path.sep).join('/'), mode: stat.mode & 0o777, bytes: stat.size });
      else throw new Error(`Non-regular entry is forbidden in workbench state: ${relative}`);
    }
  }
  await walk(root);
  return found;
}
async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function sqliteIntegrity(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const result = db.prepare('PRAGMA integrity_check').all();
    if (result.length !== 1 || result[0]?.integrity_check !== 'ok') throw new Error('Copied SQLite integrity_check failed');
    const foreign = db.prepare('PRAGMA foreign_key_check').all();
    if (foreign.length) throw new Error('Copied SQLite foreign_key_check failed');
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wb_cases'").get()) throw new Error('Not a workbench control database');
    return Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  } finally { db.close(); }
}
async function copyTree(files: Array<{ absolute: string; relative: string; mode: number }>, destination: string): Promise<void> {
  for (const file of files) {
    const target = path.join(destination, file.relative);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(file.absolute, target);
    await chmod(target, file.mode & 0o700 || 0o600);
  }
}
function checkRelative(relative: string): void {
  if (!relative || relative.startsWith('/') || relative.includes('\\') || relative.split('/').some(segment => !segment || segment === '.' || segment === '..') || path.posix.normalize(relative) !== relative || relative === manifestName) {
    throw new Error(`Invalid manifest path: ${relative}`);
  }
}
async function verifyManifest(backupRoot: string): Promise<Manifest> {
  const manifestFile = path.join(backupRoot, manifestName);
  const manifestStat = await lstat(manifestFile);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error('Backup manifest is missing or not regular');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Manifest;
  if (manifest.schema !== schemaVersion || !Number.isInteger(manifest.sqliteUserVersion) || !Array.isArray(manifest.files) || !Number.isFinite(Date.parse(manifest.createdAt))) throw new Error('Unsupported backup manifest');
  const names = new Set<string>();
  for (const record of manifest.files) {
    checkRelative(record.path);
    if (names.has(record.path) || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || !shaPattern.test(record.sha256) || !Number.isInteger(record.mode) || record.mode < 0 || record.mode > 0o777) throw new Error('Invalid or duplicate backup file record');
    names.add(record.path);
  }
  if (!names.has('workbench.sqlite')) throw new Error('Backup lacks workbench.sqlite');
  const actual = await listFiles(backupRoot, true);
  const actualNames = actual.map(file => file.relative).sort();
  if (actualNames.length !== names.size || actualNames.some((name, i) => name !== [...names].sort()[i])) throw new Error('Backup file set differs from manifest');
  for (const record of manifest.files) {
    const file = actual.find(item => item.relative === record.path)!;
    if (file.bytes !== record.bytes || await sha256(file.absolute) !== record.sha256) throw new Error(`Backup file hash mismatch: ${record.path}`);
  }
  if (sqliteIntegrity(path.join(backupRoot, 'workbench.sqlite')) !== manifest.sqliteUserVersion) throw new Error('Backup database schema version differs from manifest');
  return manifest;
}
export async function backupWorkbench(stateRoot: string, destination: string): Promise<Manifest> {
  const source = await regularRoot(stateRoot);
  if (sensitiveDirectories.has(path.basename(source))) throw new Error('Credential or CODEX_HOME directory cannot be used as a workbench state root');
  const target = await prospective(destination);
  if (inside(source, target) || inside(target, source)) throw new Error('Backup destination must be separate from the state root');
  const fresh = await assertFresh(destination);
  if (fresh.existed) throw new Error('Backup destination must not already exist');
  let apiLock: Awaited<ReturnType<typeof acquireWorkerLock>> | undefined;
  let workerLock: Awaited<ReturnType<typeof acquireWorkerLock>> | undefined;
  let created = false;
  try {
    apiLock = await acquireWorkerLock(path.join(source, '.api-process'));
    workerLock = await acquireWorkerLock(source);
    const files = await listFiles(source);
    if (!files.some(file => file.relative === 'workbench.sqlite')) throw new Error('No workbench.sqlite in state root');
    await mkdir(target, { mode: 0o700 }); created = true;
    await copyTree(files, target);
    const sqliteUserVersion = sqliteIntegrity(path.join(target, 'workbench.sqlite'));
    const copiedFiles = await listFiles(target);
    const records: FileRecord[] = [];
    for (const file of copiedFiles) records.push({ path: file.relative, bytes: file.bytes, sha256: await sha256(file.absolute), mode: file.mode });
    const manifest: Manifest = { schema: schemaVersion, createdAt: new Date().toISOString(), sqliteUserVersion, files: records };
    await writeFile(path.join(target, manifestName), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    return manifest;
  } catch (error) {
    if (created) await rm(target, { recursive: true, force: true });
    throw error;
  } finally {
    await workerLock?.release();
    await apiLock?.release();
  }
}
export async function restoreWorkbench(backupDir: string, destination: string): Promise<Manifest> {
  const source = await regularRoot(backupDir);
  const target = await prospective(destination);
  if (inside(source, target) || inside(target, source)) throw new Error('Restore destination must be separate from the backup');
  const manifest = await verifyManifest(source);
  const fresh = await assertFresh(destination);
  let created = false;
  try {
    if (!fresh.existed) { await mkdir(target, { mode: 0o700 }); created = true; }
    else await chmod(target, 0o700);
    const files = manifest.files.map(record => ({ absolute: path.join(source, record.path), relative: record.path, mode: record.mode }));
    await copyTree(files, target);
    const restored = await listFiles(target);
    for (const record of manifest.files) {
      const file = restored.find(item => item.relative === record.path);
      if (!file || file.bytes !== record.bytes || await sha256(file.absolute) !== record.sha256) throw new Error(`Restored file differs: ${record.path}`);
    }
    if (sqliteIntegrity(path.join(target, 'workbench.sqlite')) !== manifest.sqliteUserVersion) throw new Error('Restored SQLite schema differs from manifest');
    return manifest;
  } catch (error) {
    if (created) await rm(target, { recursive: true, force: true });
    throw error;
  }
}
const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entry && entry === fileURLToPath(import.meta.url)) {
  const [, , operation, source, destination] = process.argv;
  if (!source || !destination || !['backup', 'restore'].includes(operation ?? '')) {
    process.stderr.write('Usage: workbench-backup.ts backup <stateRoot> <destination> | restore <backupDir> <destination>\n');
    process.exitCode = 2;
  } else {
    (operation === 'backup' ? backupWorkbench(source, destination) : restoreWorkbench(source, destination))
      .then(manifest => process.stdout.write(JSON.stringify({ schema: manifest.schema, createdAt: manifest.createdAt, files: manifest.files.length }) + '\n'))
      .catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
  }
}
