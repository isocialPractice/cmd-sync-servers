import { constants as fsConstants, type Stats } from 'node:fs';
import { lstat, mkdir, open, rename, rm, rmdir, utimes, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { Server, Site } from '../config/schema.ts';
import { isSyncError, SyncError } from '../errors.ts';
import type { Logger } from '../log/logger.ts';
import type { TransportPool } from '../transport/pool.ts';
import { withRetry, type RetryOptions } from '../transport/retry.ts';
import type { Capabilities, RemoteEntry, Transport } from '../transport/types.ts';
import { STATUS } from './messages.ts';
import { cappedFile, partName, partPath } from './part.ts';
import { parentPath, ROOT, safeLocalTarget, toRemotePath, type RemotePath } from './paths.ts';
import type { PlanItem, SyncPlan } from './plan.ts';
import type { Recovery } from './recovery.ts';
import type { SyncRecords } from './state.ts';
import type { Action, Observation, ProgressEvent } from './types.ts';

/**
 * How a row ended: transferred or deleted (`done`), `failed`, skipped because
 * a side changed since the preview (`stale`), not run (`skipped`), or not
 * reached before a cancel (`cancelled`).
 */
export type ItemOutcome = 'done' | 'failed' | 'stale' | 'skipped' | 'cancelled';

/** What happened to one row of a plan. */
export interface ItemResult {
  /** The row number in the plan. */
  readonly id: number;
  /** The site-relative path. */
  readonly path: string;
  /** The action the row had. */
  readonly action: Action;
  readonly outcome: ItemOutcome;
  /** Why it failed or was stale: a {@link SyncErrorCode} and a message without secrets. */
  readonly error?: { readonly code: string; readonly message: string };
  /** Where a local file that was deleted or overwritten was kept. */
  readonly recoveredTo?: string;
}

/** What a run did, as returned by {@link SyncSession.execute}. */
export interface SyncResult {
  /** Every row, failures first. */
  readonly items: readonly ItemResult[];
  /** Rows transferred, deleted or recorded. */
  readonly done: number;
  /** Rows that failed, including stale ones. */
  readonly failed: number;
  /** Rows not run: unchecked, skipped, or not reached. */
  readonly skipped: number;
  /** Rows still waiting for a decision. */
  readonly unresolved: number;
  /** True when the signal stopped the run before every row was reached. */
  readonly cancelled: boolean;
}

/** Options of {@link SyncSession.execute}. */
export interface ExecuteOptions {
  /** Stops the run cleanly: no new transfer starts, partial files are removed, and finished rows are recorded. */
  readonly signal?: AbortSignal | undefined;
  /** Receives a `transfer` event per row and a `done` event at the end. */
  readonly onProgress?: ((event: ProgressEvent) => void) | undefined;
  /** Runs deletes past the mass-delete threshold without asking. */
  readonly allowMassDelete?: boolean | undefined;
  /** Asks a person to confirm a mass delete, for example by typing the count. */
  readonly confirmMassDelete?: ((count: number, side: 'local' | 'remote') => Promise<boolean>) | undefined;
}

export interface ExecuteContext {
  readonly site: Site;
  readonly server: Server;
  readonly localRoot: string;
  readonly pool: TransportPool;
  readonly capabilities: () => Promise<Capabilities>;
  readonly records: SyncRecords;
  readonly recovery: Recovery;
  readonly logger: Logger;
  readonly retry: RetryOptions;
  readonly remoteRootIsTop: boolean;
}

/** `Synchronized 36 files. 1 failed. 0 skipped.` */
export function resultLine(result: SyncResult): string {
  const files = result.done === 1 ? 'file' : 'files';
  return `Synchronized ${String(result.done)} ${files}. ${String(result.failed)} failed. ${String(result.skipped)} skipped.`;
}

function observe(info: Stats): Observation {
  return { size: info.size, mtimeMs: info.mtimeMs };
}

function remoteObservation(entry: RemoteEntry | undefined): Observation | undefined {
  return entry === undefined || entry.type !== 'file' ? undefined : { size: entry.size, mtimeMs: entry.mtimeMs };
}

function same(now: Observation | undefined, then: Observation | undefined): boolean {
  if (now === undefined || then === undefined) {
    return now === then;
  }
  return now.size === then.size && (now.mtimeMs === undefined || then.mtimeMs === undefined || now.mtimeMs === then.mtimeMs);
}

async function statLocal(file: string): Promise<Stats | undefined> {
  try {
    const info = await lstat(file);
    return info.isFile() ? info : undefined;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

function stale(target: string): SyncError {
  return new SyncError('E_STALE_ITEM', `${target}: ${STATUS.stale}`);
}

/**
 * Opens a local file to upload, refusing it when it is no longer the file
 * that was checked: a link put in its place after the check is not followed
 * on POSIX, and on every system the open file must be the same one (device
 * and inode) with the same size.
 */
async function openUnchanged(file: string, checked: Stats, target: RemotePath): Promise<Readable> {
  const flags = fsConstants.O_RDONLY | (process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW);
  let handle: FileHandle;
  try {
    handle = await open(file, flags);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error.code === 'ELOOP' || error.code === 'ENOENT')) {
      throw stale(target);
    }
    throw error;
  }
  try {
    const info = await handle.stat();
    // Windows reports no device number for a path, only for an open file, so there the inode decides.
    const sameDevice = process.platform === 'win32' || info.dev === checked.dev;
    if (!info.isFile() || !sameDevice || info.ino !== checked.ino || info.size !== checked.size) {
      throw stale(target);
    }
  } catch (error) {
    await handle.close();
    throw error;
  }
  return handle.createReadStream();
}

class Run {
  readonly #plan: SyncPlan;
  readonly #context: ExecuteContext;
  readonly #options: ExecuteOptions;
  readonly #createdDirs = new Set<string>([ROOT]);
  readonly #results: ItemResult[] = [];
  #completed = 0;
  #bytes = 0;
  #total = 0;

  constructor(plan: SyncPlan, context: ExecuteContext, options: ExecuteOptions) {
    this.#plan = plan;
    this.#context = context;
    this.#options = options;
  }

  async #guards(checked: readonly PlanItem[]): Promise<void> {
    const plan = this.#plan;
    const { site, server } = this.#context;
    const deletesRemote = checked.filter((item) => item.action === 'delete-remote').length;
    const deletesLocal = checked.filter((item) => item.action === 'delete-local').length;
    if (plan.scope.kind === 'site') {
      if (deletesRemote > 0 && plan.localFiles === 0) {
        throw new SyncError('E_EMPTY_ROOT', `The local root of "${site.name}" is empty, so mirroring it would delete every file on "${server.name}". Nothing was changed.`);
      }
      if (deletesLocal > 0 && plan.remoteFiles === 0) {
        throw new SyncError('E_EMPTY_ROOT', `The remote root of "${server.name}" is empty, so mirroring it would delete every local file of "${site.name}". Nothing was changed.`);
      }
    }
    if (deletesRemote > 0 && this.#context.remoteRootIsTop && server.options.allowRootDeletes !== true) {
      throw new SyncError('E_ROOT_DELETE', `The remote root of "${server.name}" is the top of the server. Deletes there are refused unless the server sets allowRootDeletes. Nothing was changed.`);
    }
    const { maxCount, maxPercent } = site.sync.massDelete;
    for (const [side, count, total] of [
      ['remote', deletesRemote, plan.remoteFiles],
      ['local', deletesLocal, plan.localFiles],
    ] as const) {
      const tooMany = count > maxCount || (total > 0 && (count / total) * 100 > maxPercent);
      if (count === 0 || !tooMany || this.#options.allowMassDelete === true) {
        continue;
      }
      const confirmed = (await this.#options.confirmMassDelete?.(count, side)) ?? false;
      if (!confirmed) {
        throw new SyncError(
          'E_MASS_DELETE',
          `${String(count)} ${side} deletes is more than ${String(maxCount)} files or ${String(maxPercent)} % of that side. Nothing was changed. Confirm the count, or pass --allow-mass-delete.`,
        );
      }
    }
  }

  async run(): Promise<SyncResult> {
    const plan = this.#plan;
    const { records, recovery } = this.#context;
    const checked = plan.items.filter((item) => item.state !== 'problem' && item.checked === true && item.action !== 'skip' && item.action !== 'resolve');
    await this.#guards(checked);

    for (const update of plan.silent) {
      if (update.record === undefined) {
        records.delete(update.path);
      } else {
        records.set(update.path, update.record);
      }
    }

    const transfers = checked.filter((item) => item.action === 'put' || item.action === 'get' || item.action === 'synced');
    const deletes = checked
      .filter((item) => item.action === 'delete-remote' || item.action === 'delete-local')
      .sort((a, b) => b.path.split('/').length - a.path.split('/').length || (a.path < b.path ? 1 : -1));
    this.#total = transfers.length + deletes.length;

    const concurrency = Math.max(1, Math.min(this.#context.site.sync.concurrency, this.#context.pool.limit));
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let item = transfers[next++]; item !== undefined; item = transfers[next++]) {
        await this.#runItem(item);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, transfers.length)) }, worker));
    for (const item of deletes) {
      await this.#runItem(item);
    }
    if (plan.deleteOrphans && this.#options.signal?.aborted !== true) {
      await this.#removeEmptiedFolders(deletes);
    }
    await records.save();
    const overLimit = await recovery.prune().catch((error: unknown) => {
      this.#context.logger.warn('The recovery folder could not be pruned.', { error });
      return false;
    });
    if (overLimit) {
      this.#context.logger.warn(`The local files kept from this run hold more than the recovery limit of ${String(this.#context.site.sync.recovery.maxMegabytes)} MB. They are kept until the next run; older runs were removed.`, {
        folder: recovery.runDir,
      });
    }

    const listed = new Set(this.#results.map((result) => result.id));
    for (const item of plan.items) {
      if (!listed.has(item.id)) {
        this.#results.push({ id: item.id, path: item.path, action: item.action, outcome: 'skipped' });
      }
    }
    const order: Record<ItemOutcome, number> = { failed: 0, stale: 1, cancelled: 2, done: 3, skipped: 4 };
    const items = this.#results.sort((a, b) => order[a.outcome] - order[b.outcome] || a.id - b.id);
    const done = items.filter((item) => item.outcome === 'done').length;
    const failed = items.filter((item) => item.outcome === 'failed' || item.outcome === 'stale').length;
    this.#options.onProgress?.({ type: 'done', completed: done, failed });
    return {
      items,
      done,
      failed,
      skipped: items.length - done - failed,
      unresolved: plan.items.filter((item) => item.action === 'resolve').length,
      cancelled: this.#options.signal?.aborted === true,
    };
  }

  #cancelled(): boolean {
    return this.#options.signal?.aborted === true;
  }

  async #runItem(item: PlanItem): Promise<void> {
    if (this.#cancelled()) {
      this.#results.push({ id: item.id, path: item.path, action: item.action, outcome: 'cancelled' });
      return;
    }
    const target = toRemotePath(item.path);
    let recoveredTo: string | undefined;
    try {
      await withRetry(
        () =>
          this.#context.pool.run(async (transport) => {
            recoveredTo = await this.#perform(item, target, transport);
          }, this.#options.signal),
        { ...this.#context.retry, signal: this.#options.signal },
      );
      this.#results.push({ id: item.id, path: item.path, action: item.action, outcome: 'done', ...(recoveredTo === undefined ? {} : { recoveredTo }) });
      this.#progress(item, 'done');
    } catch (error) {
      const outcome = isSyncError(error, 'E_STALE_ITEM') ? 'stale' : this.#cancelled() ? 'cancelled' : 'failed';
      const code = isSyncError(error) ? error.code : 'E_ERROR';
      const message = this.#context.logger.redactor.redact(error instanceof Error ? error.message : String(error));
      this.#context.logger.warn(`${item.action} ${item.path} ${outcome}: ${message}`, { code });
      this.#results.push({ id: item.id, path: item.path, action: item.action, outcome, error: { code, message } });
      this.#progress(item, outcome === 'stale' ? 'stale' : 'failed');
    }
    await this.#context.records.checkpoint();
  }

  #progress(item: PlanItem, outcome: 'done' | 'failed' | 'stale'): void {
    this.#completed += 1;
    this.#options.onProgress?.({
      type: 'transfer',
      path: item.path,
      action: item.action,
      outcome,
      completed: this.#completed,
      total: this.#total,
      bytes: this.#bytes,
    });
  }

  /** Re-checks both sides, then runs one item. Returns where a local file was kept, if one was. */
  async #perform(item: PlanItem, target: RemotePath, transport: Transport): Promise<string | undefined> {
    const { localRoot, records, recovery } = this.#context;
    const localFile = await safeLocalTarget(localRoot, target);
    const localInfo = await statLocal(localFile);
    const remoteEntry = await transport.stat(target);
    const localNow = localInfo === undefined ? undefined : observe(localInfo);
    const remoteNow = remoteObservation(remoteEntry);
    if (!same(localNow, item.local) || !same(remoteNow, item.remote)) {
      throw stale(item.path);
    }
    switch (item.action) {
      case 'put':
        await this.#put(target, localFile, localInfo, item.local?.sha256, transport);
        return undefined;
      case 'get':
        return this.#get(target, localFile, localInfo, remoteNow, transport);
      case 'synced':
        if (localNow !== undefined && remoteNow !== undefined) {
          const sha256 = item.local?.sha256;
          records.set(target, { local: { ...localNow, ...(sha256 === undefined ? {} : { sha256 }) }, remote: remoteNow, syncedAt: Date.now() });
        }
        return undefined;
      case 'delete-remote':
        await transport.remove(target);
        records.delete(target);
        return undefined;
      case 'delete-local': {
        const kept = await recovery.keep(localFile, target);
        records.delete(target);
        return kept;
      }
      default:
        return undefined;
    }
  }

  async #ensureRemoteDirs(dir: RemotePath | undefined, transport: Transport): Promise<void> {
    if (dir === undefined || this.#createdDirs.has(dir)) {
      return;
    }
    await this.#ensureRemoteDirs(parentPath(dir), transport);
    await transport.mkdir(dir);
    const mode = this.#context.server.options.remoteDirMode;
    if (mode !== undefined && transport.chmod !== undefined) {
      await transport.chmod(dir, parseInt(mode, 8)).catch((error: unknown) => {
        this.#context.logger.warn(`Could not set the permissions of ${dir}.`, { error });
      });
    }
    this.#createdDirs.add(dir);
  }

  async #put(target: RemotePath, localFile: string, localInfo: Stats | undefined, sha256: string | undefined, transport: Transport): Promise<void> {
    if (localInfo === undefined) {
      throw stale(target);
    }
    const { server, records, logger } = this.#context;
    const capabilities = await this.#context.capabilities();
    await this.#ensureRemoteDirs(parentPath(target), transport);
    const part = partPath(target);
    let renaming = false;
    try {
      await transport.put(await openUnchanged(localFile, localInfo, target), part, this.#options.signal);
      const uploaded = await transport.stat(part);
      if (uploaded?.size !== localInfo.size) {
        throw new SyncError('E_REMOTE', `Uploading ${target}: the server holds ${String(uploaded?.size ?? 0)} of ${String(localInfo.size)} bytes.`, { transient: true });
      }
      renaming = true;
      await transport.rename(part, target, true);
    } catch (error) {
      // A server without an atomic replace removes the old copy before the rename; if the
      // rename then fails, the partial copy is the only one left, so it stays.
      const oldCopyThere = !renaming || (await transport.stat(target).catch(() => undefined)) !== undefined;
      if (oldCopyThere) {
        await transport.remove(part).catch(() => undefined);
      } else {
        logger.warn(`The new copy of ${target} could not replace the old one, which is gone. It is kept on the server as ${part}.`);
      }
      throw error;
    }
    this.#bytes += localInfo.size;
    if (capabilities.canSetMtime && transport.setMtime !== undefined) {
      await transport.setMtime(target, localInfo.mtimeMs).catch((error: unknown) => {
        logger.warn(`Could not set the time of ${target} on the server.`, { error });
      });
    }
    if (server.options.remoteFileMode !== undefined && transport.chmod !== undefined) {
      await transport.chmod(target, parseInt(server.options.remoteFileMode, 8)).catch((error: unknown) => {
        logger.warn(`Could not set the permissions of ${target}.`, { error });
      });
    }
    const after = remoteObservation(await transport.stat(target));
    if (after !== undefined) {
      records.set(target, { local: { ...observe(localInfo), ...(sha256 === undefined ? {} : { sha256 }) }, remote: after, syncedAt: Date.now() });
    }
  }

  async #get(target: RemotePath, localFile: string, localInfo: Stats | undefined, remoteNow: Observation | undefined, transport: Transport): Promise<string | undefined> {
    if (remoteNow === undefined) {
      throw stale(target);
    }
    const { records, recovery } = this.#context;
    await mkdir(path.dirname(localFile), { recursive: true });
    const safeFile = await safeLocalTarget(this.#context.localRoot, target);
    const part = path.join(path.dirname(safeFile), partName(target));
    let kept: string | undefined;
    try {
      await transport.get(target, cappedFile(part, { flags: 'wx', maxBytes: remoteNow.size, what: `Downloading ${target}` }), this.#options.signal);
      const downloaded = await lstat(part);
      if (downloaded.size !== remoteNow.size) {
        throw new SyncError('E_REMOTE', `Downloading ${target}: received ${String(downloaded.size)} of ${String(remoteNow.size)} bytes.`, { transient: true });
      }
      // With recovery off, the rename replaces the old file in one step, so it is never removed first.
      if (localInfo !== undefined && recovery.enabled) {
        kept = await recovery.keep(safeFile, target);
      }
      try {
        await rename(part, safeFile);
      } catch (error) {
        if (kept !== undefined) {
          await recovery.restore(kept, safeFile);
          kept = undefined;
        }
        throw error;
      }
    } catch (error) {
      await rm(part, { force: true });
      throw error;
    }
    this.#bytes += remoteNow.size;
    if (remoteNow.mtimeMs !== undefined) {
      const time = new Date(remoteNow.mtimeMs);
      await utimes(safeFile, time, time);
    }
    const after = await lstat(safeFile);
    records.set(target, { local: observe(after), remote: remoteNow, syncedAt: Date.now() });
    return kept;
  }

  /** With the delete option on, removes folders a delete left empty that the other side does not have. */
  async #removeEmptiedFolders(deletes: readonly PlanItem[]): Promise<void> {
    const done = new Set(this.#results.filter((result) => result.outcome === 'done').map((result) => result.path));
    const folders = new Map<string, 'local' | 'remote'>();
    for (const item of deletes) {
      if (!done.has(item.path)) {
        continue;
      }
      const side = item.action === 'delete-remote' ? 'remote' : 'local';
      for (let dir = parentPath(toRemotePath(item.path)); dir !== undefined && dir !== ROOT; dir = parentPath(dir)) {
        folders.set(`${side}:${dir}`, side);
      }
    }
    const ordered = [...folders.entries()].sort(([a], [b]) => b.split('/').length - a.split('/').length);
    for (const [key, side] of ordered) {
      const dir = toRemotePath(key.slice(side.length + 1));
      try {
        if (side === 'remote') {
          if (this.#plan.localDirs.has(dir)) {
            continue;
          }
          await this.#context.pool.run(async (transport) => {
            if ((await transport.list(dir)).length === 0) {
              await transport.remove(dir);
            }
          });
        } else if (!this.#plan.remoteDirs.has(dir)) {
          await rmdir(await safeLocalTarget(this.#context.localRoot, dir)).catch((error: unknown) => {
            if (!(typeof error === 'object' && error !== null && 'code' in error && (error.code === 'ENOTEMPTY' || error.code === 'EEXIST' || error.code === 'ENOENT'))) {
              throw error;
            }
          });
        }
      } catch (error) {
        this.#context.logger.warn(`Could not remove the emptied folder ${dir}.`, { error });
      }
    }
  }
}

/** Runs the checked rows of a plan. */
export function executePlan(plan: SyncPlan, context: ExecuteContext, options: ExecuteOptions = {}): Promise<SyncResult> {
  return new Run(plan, context, options).run();
}
