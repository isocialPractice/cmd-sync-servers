import { randomUUID } from 'node:crypto';
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
  /** Tells this holder's lock from any other, so a holder only ever removes its own. */
  token: string;
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

/** The token of the lock when it is stale, `null` when it is held, `undefined` when it was just released. */
async function staleToken(lockPath: string, staleMs: number): Promise<string | null | undefined> {
  let info;
  try {
    info = await stat(lockPath);
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
  const owner = await readOwner(lockPath);
  const token = owner.token ?? '';
  if (Date.now() - info.mtimeMs > staleMs) {
    return token;
  }
  const gone = owner.host === hostname() && typeof owner.pid === 'number' && owner.pid !== process.pid && processIsGone(owner.pid);
  return gone ? token : null;
}

/**
 * Removes a stale lock. Only one waiter at a time may do it, under a second,
 * short-lived lock, and it checks again under that lock that the file is
 * still the same stale lock: a waiter that found the lock stale a moment ago
 * never removes the fresh lock another waiter has taken since.
 */
async function takeOver(lockPath: string, stale: string, staleMs: number): Promise<void> {
  const guard = `${lockPath}.takeover`;
  try {
    await writeFile(guard, String(process.pid), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) {
      throw error;
    }
    // Another waiter is taking over; a guard left by a crash is cleared once it is old.
    const info = await stat(guard).catch(() => undefined);
    if (info !== undefined && Date.now() - info.mtimeMs > staleMs) {
      await rm(guard, { force: true });
    }
    return;
  }
  try {
    if ((await staleToken(lockPath, staleMs)) === stale) {
      await rm(lockPath, { force: true });
    }
  } finally {
    await rm(guard, { force: true });
  }
}

/**
 * Runs `task` while holding `lockPath`, a file created exclusively so only
 * one process at a time (the CLI or the VS Code extension) writes the files
 * it guards. A lock left by a process that died is taken over, and a holder
 * only ever removes its own lock.
 */
export async function withFileLock<T>(lockPath: string, task: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const staleMs = options.staleMs ?? 30_000;
  const deadline = Date.now() + (options.timeoutMs ?? 5_000);
  const owner: LockOwner = { pid: process.pid, host: hostname(), createdAt: new Date().toISOString(), token: randomUUID() };

  for (let wait = 10; ; wait = Math.min(wait * 2, 200)) {
    try {
      await writeFile(lockPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if (!hasErrorCode(error, 'EEXIST')) {
        throw error;
      }
    }
    const stale = await staleToken(lockPath, staleMs);
    if (stale === undefined) {
      continue;
    }
    if (stale !== null) {
      await takeOver(lockPath, stale, staleMs);
    } else if (Date.now() >= deadline) {
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
    if ((await readOwner(lockPath)).token === owner.token) {
      await rm(lockPath, { force: true });
    }
  }
}
