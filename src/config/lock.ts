import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { SyncError } from '../errors.ts';
import { hasErrorCode } from './files.ts';

export interface LockOptions {
  /** A lock older than this is taken over. Default 30 seconds. */
  readonly staleMs?: number;
  /** How long to wait for a held lock before failing with `E_LOCKED`. Default 5 seconds. */
  readonly timeoutMs?: number;
}

interface LockOwner {
  pid: number;
  host: string;
  createdAt: string;
}

async function readOwner(lockPath: string): Promise<Partial<LockOwner>> {
  try {
    return JSON.parse(await readFile(lockPath, 'utf8')) as Partial<LockOwner>;
  } catch {
    return {};
  }
}

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return hasErrorCode(error, 'ESRCH');
  }
}

async function isStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs > staleMs) {
      return true;
    }
  } catch (error) {
    // Released between our attempt and this check: try again at once.
    return hasErrorCode(error, 'ENOENT');
  }
  const owner = await readOwner(lockPath);
  return owner.host === hostname() && typeof owner.pid === 'number' && owner.pid !== process.pid && processIsGone(owner.pid);
}

/**
 * Runs `task` while holding `lockPath`, a file created exclusively so only
 * one process at a time (the CLI or the VS Code extension) writes the files
 * it guards. A lock left by a process that died is taken over.
 */
export async function withFileLock<T>(lockPath: string, task: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const staleMs = options.staleMs ?? 30_000;
  const deadline = Date.now() + (options.timeoutMs ?? 5_000);
  const owner: LockOwner = { pid: process.pid, host: hostname(), createdAt: new Date().toISOString() };

  for (let wait = 10; ; wait = Math.min(wait * 2, 200)) {
    try {
      await writeFile(lockPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) {
        throw error;
      }
    }
    if (await isStale(lockPath, staleMs)) {
      await rm(lockPath, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      const holder = await readOwner(lockPath);
      const who = typeof holder.pid === 'number' ? ` (process ${String(holder.pid)})` : '';
      throw new SyncError(
        'E_LOCKED',
        `${lockPath} is held by another sync-servers process${who}. Try again, or delete the lock file if no other process is running.`,
      );
    }
    await delay(wait);
  }

  try {
    return await task();
  } finally {
    await rm(lockPath, { force: true });
  }
}
