import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import fsExt from 'fs-ext';

/** The worker itself holds this OS lock; no heartbeat expiry or helper process. */
export async function acquireWorkerLock(stateRoot: string): Promise<{ release(): Promise<void> }> {
  if (process.platform === 'win32') throw new Error('The creation worker currently requires a POSIX local filesystem.');
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  // Never unlink this file: a new inode would permit two simultaneous owners.
  const handle = await open(path.join(stateRoot, 'worker.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    await new Promise<void>((resolve, reject) => fsExt.flock(handle.fd, 'exnb', error => error ? reject(error) : resolve()));
  } catch (error) {
    await handle.close();
    if (['EAGAIN', 'EWOULDBLOCK'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      throw new Error('Another creation worker owns this state root. No timeout takeover is allowed.');
    }
    throw error;
  }
  let released = false;
  return { async release() { if (!released) { released = true; await handle.close(); } } };
}
