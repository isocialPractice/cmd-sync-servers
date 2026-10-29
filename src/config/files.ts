import { randomBytes } from 'node:crypto';
import { chmod, copyFile, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Error codes Windows reports while another process briefly holds a file open. */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

/** True when `error` is a Node.js file system error with the given code. */
export function hasErrorCode(error: unknown, code: string): boolean {
  return errorCode(error) === code;
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (attempt >= 9 || code === undefined || !TRANSIENT_RENAME_CODES.has(code)) {
        throw error;
      }
      await delay(20 * (attempt + 1));
    }
  }
}

export interface AtomicWriteOptions {
  /** Copies the file being replaced here first, when it exists. */
  readonly backup?: string;
  /** File mode on POSIX. Default `0o600`. */
  readonly mode?: number;
}

/**
 * Replaces `target` with `data` so a reader sees either the old or the new
 * content, never a partial file: the data goes to a temp file in the same
 * folder, is flushed to disk, then renamed over the target.
 */
export async function writeFileAtomic(target: string, data: string, options: AtomicWriteOptions = {}): Promise<void> {
  const mode = options.mode ?? 0o600;
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const handle = await open(temp, 'wx', mode);
    try {
      await handle.writeFile(data, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (options.backup !== undefined) {
      try {
        await copyFile(target, options.backup);
        await chmod(options.backup, mode);
      } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) {
          throw error;
        }
      }
    }
    await renameWithRetry(temp, target);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
