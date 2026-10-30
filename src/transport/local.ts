import { createReadStream, createWriteStream, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, opendir, rename, rmdir, stat, unlink, utimes } from 'node:fs/promises';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { SyncError } from '../errors.ts';
import { baseName, joinLocal, parentPath, ROOT, safeLocalTarget, type RemotePath } from '../sync/paths.ts';
import { checkListingLimit, errorMessage, makeEntry } from './common.ts';
import { DEFAULT_LISTING_LIMIT, type Capabilities, type EntryType, type RemoteEntry, type Transport } from './types.ts';

export interface LocalTransportOptions {
  /** The folder that plays the server: local, a mounted drive, or a network share. */
  readonly root: string;
  readonly listingLimit?: number;
  readonly platform?: NodeJS.Platform;
}

function typeOf(info: Stats): EntryType {
  if (info.isSymbolicLink()) {
    return 'symlink';
  }
  if (info.isDirectory()) {
    return 'dir';
  }
  return info.isFile() ? 'file' : 'other';
}

function fsCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

function fsError(error: unknown, what: string): SyncError {
  if (error instanceof SyncError) {
    return error;
  }
  const code = fsCode(error);
  return new SyncError('E_REMOTE', `${what}: ${errorMessage(error)}`, {
    cause: error,
    transient: code === 'EBUSY' || code === 'EAGAIN',
  });
}

/**
 * The `local` protocol: the "server" is another folder, such as a mounted
 * drive or a UNC share. Symbolic links are listed but never followed or
 * written through.
 */
export class LocalTransport implements Transport {
  readonly #root: string;
  readonly #limit: number;
  readonly #platform: NodeJS.Platform;

  constructor(options: LocalTransportOptions) {
    this.#root = path.resolve(options.root);
    this.#limit = options.listingLimit ?? DEFAULT_LISTING_LIMIT;
    this.#platform = options.platform ?? process.platform;
  }

  async connect(): Promise<Capabilities> {
    let info: Stats;
    try {
      info = await stat(this.#root);
    } catch (error) {
      throw new SyncError('E_REMOTE_ROOT', `The folder ${this.#root} was not found: ${errorMessage(error)}`, { cause: error });
    }
    if (!info.isDirectory()) {
      throw new SyncError('E_REMOTE_ROOT', `${this.#root} is not a folder.`);
    }
    return {
      protocol: 'local',
      mtimePrecisionMs: 1,
      canSetMtime: true,
      canChmod: this.#platform !== 'win32',
      atomicReplace: true,
      software: undefined,
      tls: undefined,
      hostKey: undefined,
      features: [],
    };
  }

  #entry(target: RemotePath, info: Stats): RemoteEntry {
    return makeEntry(parentPath(target) ?? ROOT, target === ROOT ? '' : baseName(target), typeOf(info), info.size, info.mtimeMs, this.#platform);
  }

  async list(dir: RemotePath): Promise<RemoteEntry[]> {
    const folder = joinLocal(this.#root, dir);
    const entries: RemoteEntry[] = [];
    try {
      for await (const dirent of await opendir(folder)) {
        checkListingLimit(entries.length + 1, this.#limit, folder);
        const info = await lstat(path.join(folder, dirent.name));
        entries.push(makeEntry(dir, dirent.name, typeOf(info), info.size, info.mtimeMs, this.#platform));
      }
    } catch (error) {
      throw fsError(error, `Listing ${folder}`);
    }
    return entries;
  }

  async stat(target: RemotePath): Promise<RemoteEntry | undefined> {
    try {
      return this.#entry(target, await lstat(joinLocal(this.#root, target)));
    } catch (error) {
      if (fsCode(error) === 'ENOENT') {
        return undefined;
      }
      throw fsError(error, `Reading ${target}`);
    }
  }

  async get(target: RemotePath, to: Writable, signal?: AbortSignal): Promise<void> {
    const source = await safeLocalTarget(this.#root, target);
    try {
      await pipeline(createReadStream(source), to, { signal });
    } catch (error) {
      throw fsError(error, `Reading ${target}`);
    }
  }

  async put(from: Readable, target: RemotePath, signal?: AbortSignal): Promise<void> {
    const destination = await safeLocalTarget(this.#root, target);
    try {
      await pipeline(from, createWriteStream(destination), { signal });
    } catch (error) {
      throw fsError(error, `Writing ${target}`);
    }
  }

  async rename(from: RemotePath, to: RemotePath, overwrite: boolean): Promise<void> {
    const source = await safeLocalTarget(this.#root, from);
    const destination = await safeLocalTarget(this.#root, to);
    if (!overwrite && (await this.stat(to)) !== undefined) {
      throw new SyncError('E_REMOTE', `Renaming ${from}: ${to} already exists.`);
    }
    try {
      await rename(source, destination);
    } catch (error) {
      throw fsError(error, `Renaming ${from} to ${to}`);
    }
  }

  async remove(target: RemotePath): Promise<void> {
    const full = await safeLocalTarget(this.#root, target);
    try {
      if ((await lstat(full)).isDirectory()) {
        await rmdir(full);
      } else {
        await unlink(full);
      }
    } catch (error) {
      throw fsError(error, `Removing ${target}`);
    }
  }

  async mkdir(target: RemotePath): Promise<void> {
    const full = await safeLocalTarget(this.#root, target);
    try {
      await mkdir(full);
    } catch (error) {
      if (fsCode(error) === 'EEXIST' && (await lstat(full)).isDirectory()) {
        return;
      }
      throw fsError(error, `Creating ${target}`);
    }
  }

  async setMtime(target: RemotePath, mtimeMs: number): Promise<void> {
    const full = await safeLocalTarget(this.#root, target);
    try {
      await utimes(full, new Date(mtimeMs), new Date(mtimeMs));
    } catch (error) {
      throw fsError(error, `Setting the time of ${target}`);
    }
  }

  async chmod(target: RemotePath, mode: number): Promise<void> {
    const full = await safeLocalTarget(this.#root, target);
    try {
      await chmod(full, mode);
    } catch (error) {
      throw fsError(error, `Changing the permissions of ${target}`);
    }
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
