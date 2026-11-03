import { SyncError } from '../errors.ts';
import type { TransportPool } from '../transport/pool.ts';
import type { RetryOptions } from '../transport/retry.ts';
import type { RemoteEntry } from '../transport/types.ts';
import type { Cloak } from './cloak.ts';
import { STATUS, unsafeNameStatus } from './messages.ts';
import { isPartName } from './part.ts';
import { ROOT, type RemotePath } from './paths.ts';
import { underCloak, type ScanResult } from './scan-local.ts';

/** The deepest folder a scan descends into, so a server cannot keep a scan going forever. */
export const MAX_REMOTE_DEPTH = 64;
/** The most entries one scan takes in, across every folder. */
export const MAX_REMOTE_ENTRIES = 1_000_000;

export interface RemoteScanOptions {
  readonly pool: TransportPool;
  readonly cloak: Cloak;
  readonly scopes: readonly RemotePath[];
  /** Folders listed at once. */
  readonly concurrency: number;
  readonly retry?: RetryOptions;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((files: number, folders: number) => void) | undefined;
}

/**
 * Lists the files under the server's remote root. Cloaked folders are never
 * listed; symbolic links are reported and never followed; names that are not
 * safe on this system are reported, never used. Servers whose listings carry
 * no times are asked file by file (FTP MDTM).
 */
export async function scanRemote(options: RemoteScanOptions): Promise<ScanResult> {
  const result: ScanResult = { files: new Map(), dirs: new Set(), problems: [], cloaked: 0, linked: new Map() };
  const mutable = result as { cloaked: number };
  const { pool, cloak } = options;
  const retry = { ...options.retry, signal: options.signal };
  const untimed: RemotePath[] = [];
  let queue: RemotePath[] = [];
  let entries = 0;

  const take = (parent: RemotePath, entry: RemoteEntry): void => {
    entries += 1;
    if (entries > MAX_REMOTE_ENTRIES) {
      throw new SyncError('E_LISTING_LIMIT', `The server lists more than ${String(MAX_REMOTE_ENTRIES)} entries under its root; the scan was stopped. Cloak large folders, or synchronize some paths only.`);
    }
    if (isPartName(entry.name)) {
      // A partial copy left by an interrupted transfer is never synchronized as a file.
      return;
    }
    if (entry.path === undefined) {
      result.problems.push({
        path: parent === ROOT ? entry.name : `${parent}/${entry.name}`,
        side: 'remote',
        kind: 'unsafe',
        status: unsafeNameStatus(entry.unsafe ?? 'unknown'),
      });
      return;
    }
    const target = entry.path;
    if (entry.type === 'symlink') {
      result.problems.push({ path: target, side: 'remote', kind: 'symlink', status: STATUS.symlink });
    } else if (entry.type === 'dir') {
      if (cloak.isCloaked(target, true)) {
        mutable.cloaked += 1;
      } else if (target.split('/').length > MAX_REMOTE_DEPTH) {
        throw new SyncError('E_LISTING_LIMIT', `The server's folders go deeper than ${String(MAX_REMOTE_DEPTH)} levels at ${target.slice(0, 200)}; the scan was stopped.`);
      } else {
        result.dirs.add(target);
        queue.push(target);
      }
    } else if (entry.type === 'file') {
      if (cloak.isCloaked(target, false)) {
        mutable.cloaked += 1;
      } else {
        result.files.set(target, { size: entry.size, mtimeMs: entry.mtimeMs });
        if (entry.mtimeMs === undefined) {
          untimed.push(target);
        }
      }
    } else {
      result.problems.push({ path: target, side: 'remote', kind: 'other', status: STATUS.notAFile });
    }
  };

  for (const scope of options.scopes) {
    if (scope === ROOT) {
      queue.push(ROOT);
      continue;
    }
    if (underCloak(cloak, scope, false) || underCloak(cloak, scope, true)) {
      mutable.cloaked += 1;
      continue;
    }
    const entry = await pool.runWithRetry((transport) => transport.stat(scope), retry);
    if (entry !== undefined) {
      take(scope, { ...entry, path: scope });
    }
  }

  while (queue.length > 0 && options.signal?.aborted !== true) {
    const batch = queue.slice(0, Math.max(1, options.concurrency));
    queue = queue.slice(batch.length);
    const listings = await Promise.all(batch.map((dir) => pool.runWithRetry((transport) => transport.list(dir), retry)));
    batch.forEach((dir, index) => {
      for (const entry of listings[index] ?? []) {
        take(dir, entry);
      }
    });
    options.onProgress?.(result.files.size, result.dirs.size);
  }

  for (let start = 0; start < untimed.length; start += options.concurrency) {
    const slice = untimed.slice(start, start + Math.max(1, options.concurrency));
    const stats = await Promise.all(slice.map((target) => pool.runWithRetry((transport) => transport.stat(target), retry)));
    slice.forEach((target, index) => {
      const entry = stats[index];
      if (entry !== undefined) {
        result.files.set(target, { size: entry.size, mtimeMs: entry.mtimeMs });
      }
    });
  }
  return result;
}
