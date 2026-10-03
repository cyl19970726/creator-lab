import { test, expect } from 'vitest';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireWorkerLock } from '../src/infrastructure/process-lock.js';

const entry = new URL('../src/infrastructure/process-lock.ts', import.meta.url).href;
test('same-process duplicate owners are refused; release is idempotent', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'creation-lock-'));
  try {
    const lock = await acquireWorkerLock(dir);
    try { await expect(acquireWorkerLock(dir)).rejects.toThrow('Another creation worker'); }
    finally { await lock.release(); await lock.release(); }
    await (await acquireWorkerLock(dir)).release();
  } finally { await rm(dir, {recursive:true,force:true}); }
});

test('SIGSTOP never expires ownership; SIGKILL releases the OS lock', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'creation-crash-lock-'));
  const child = spawn(process.execPath, ['--import','tsx','--input-type=module','-e', `import {acquireWorkerLock} from ${JSON.stringify(entry)}; await acquireWorkerLock(${JSON.stringify(dir)}); console.log('owned'); setInterval(()=>{},1000);`], {stdio:['ignore','pipe','pipe']});
  try {
    await Promise.race([once(child.stdout!, 'data'), once(child, 'exit').then(([code]) => { throw new Error(`lock child exited: ${code}`); })]);
    child.kill('SIGSTOP');
    await expect(acquireWorkerLock(dir)).rejects.toThrow('Another creation worker');
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    await (await acquireWorkerLock(dir)).release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const done = once(child,'exit');child.kill('SIGKILL');await done; }
    await rm(dir, {recursive:true,force:true});
  }
});

test('lock path may not be a symlink', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'creation-lock-symlink-'));
  try {
    await symlink(path.join(dir, 'elsewhere'), path.join(dir,'worker.lock'));
    await expect(acquireWorkerLock(dir)).rejects.toThrow();
  } finally { await rm(dir,{recursive:true,force:true}); }
});
