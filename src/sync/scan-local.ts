import { createHash } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';
import { lstat, opendir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { hasErrorCode, writeFileAtomic } from '../config/files.ts';
import { ensurePrivateDir } from '../config/paths.ts';
import type { Cloak } from './cloak.ts';
import { STATUS, unsafeNameStatus } from './messages.ts';
import { childPath, isInside, joinLocal, parentPath, ROOT, type RemotePath } from './paths.ts';
import type { Observation, ScanProblem } from './types.ts';

export interface ScanResult {
  /** Files by site-relative path. */
  readonly files: Map<RemotePath, Observation>;
  readonly dirs: Set<RemotePath>;
  readonly problems: ScanProblem[];
  /** Files and folders left out by cloaking. */
  readonly cloaked: number;
}

export interface LocalScanOptions {
  /** The site's local root. */
  readonly root: string;
  readonly cloak: Cloak;
  readonly symlinks: 'skip' | 'follow-inside-root';
  readonly checksum: boolean;
  /** Where to start: the site root, or single paths. */
  readonly scopes: readonly RemotePath[];
  readonly platform?: NodeJS.Platform;
  /** Keeps hashes between runs, so unchanged files are not read again. */
  readonly cache?: HashCache | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onProgress?: ((files: number) => void) | undefined;
}

/** SHA-256 hashes of local files, reused while size and time are unchanged. */
export class HashCache {
  readonly #file: string | undefined;
  readonly #entries = new Map<string, { size: number; mtimeMs: number; sha256: string }>();
  #dirty = false;

  private constructor(file: string | undefined) {
    this.#file = file;
  }

  /** A cache kept in `file`, or held only in memory when `file` is undefined. */
  static async open(file: string | undefined): Promise<HashCache> {
    const cache = new HashCache(file);
    if (file === undefined) {
      return cache;
    }
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as { entries?: Record<string, { size: number; mtimeMs: number; sha256: string }> };
      for (const [key, value] of Object.entries(parsed.entries ?? {})) {
        cache.#entries.set(key, value);
      }
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        cache.#dirty = true;
      }
    }
    return cache;
  }

  async hash(target: string, full: string, info: Stats): Promise<string> {
    const cached = this.#entries.get(target);
    if (cached?.size === info.size && cached.mtimeMs === info.mtimeMs) {
      return cached.sha256;
    }
    const digest = createHash('sha256');
    await pipeline(createReadStream(full), digest);
    const sha256 = digest.digest('hex');
    this.#entries.set(target, { size: info.size, mtimeMs: info.mtimeMs, sha256 });
    this.#dirty = true;
    return sha256;
  }

  async save(): Promise<void> {
    if (this.#file === undefined || !this.#dirty) {
      return;
    }
    await ensurePrivateDir(path.dirname(this.#file));
    await writeFileAtomic(this.#file, `${JSON.stringify({ schemaVersion: 1, entries: Object.fromEntries(this.#entries) })}\n`);
    this.#dirty = false;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return hasErrorCode(error, code);
}

/** True when `target` or a folder above it is cloaked. */
export function underCloak(cloak: Cloak, target: RemotePath, isDir: boolean): boolean {
  for (let ancestor = parentPath(target); ancestor !== undefined && ancestor !== ROOT; ancestor = parentPath(ancestor)) {
    if (cloak.isCloaked(ancestor, true)) {
      return true;
    }
  }
  return cloak.isCloaked(target, isDir);
}

/**
 * Lists the files under the site's local root. Cloaked folders are never
 * entered; symbolic links are reported and skipped, or followed only while
 * they stay inside the root; names this system cannot use are reported.
 */
export async function scanLocal(options: LocalScanOptions): Promise<ScanResult> {
  const platform = options.platform ?? process.platform;
  const result: ScanResult = { files: new Map(), dirs: new Set(), problems: [], cloaked: 0 };
  const mutable = result as { cloaked: number };
  const realRoot = await realpath(options.root);
  const visited = new Set<string>([realRoot]);
  const queue: RemotePath[] = [];

  const addFile = async (target: RemotePath, full: string, info: Stats): Promise<void> => {
    const sha256 = options.checksum ? await (options.cache ?? (await HashCache.open(undefined))).hash(target, full, info) : undefined;
    result.files.set(target, { size: info.size, mtimeMs: info.mtimeMs, ...(sha256 === undefined ? {} : { sha256 }) });
    if (result.files.size % 500 === 0) {
      options.onProgress?.(result.files.size);
    }
  };

  const visit = async (target: RemotePath, full: string, info: Stats): Promise<void> => {
    let entry = info;
    if (entry.isSymbolicLink()) {
      if (options.symlinks === 'skip') {
        result.problems.push({ path: target, side: 'local', kind: 'symlink', status: STATUS.symlink });
        return;
      }
      const real = await realpath(full).catch(() => undefined);
      if (real === undefined || !isInside(realRoot, real, platform)) {
        result.problems.push({ path: target, side: 'local', kind: 'symlink', status: STATUS.symlink });
        return;
      }
      if (visited.has(real)) {
        return;
      }
      entry = await stat(full);
      if (entry.isDirectory()) {
        visited.add(real);
      }
    }
    if (entry.isDirectory()) {
      if (options.cloak.isCloaked(target, true)) {
        mutable.cloaked += 1;
        return;
      }
      result.dirs.add(target);
      queue.push(target);
    } else if (entry.isFile()) {
      if (options.cloak.isCloaked(target, false)) {
        mutable.cloaked += 1;
        return;
      }
      await addFile(target, full, entry);
    } else {
      result.problems.push({ path: target, side: 'local', kind: 'other', status: STATUS.notAFile });
    }
  };

  for (const scope of options.scopes) {
    if (scope === ROOT) {
      queue.push(ROOT);
      continue;
    }
    if (underCloak(options.cloak, scope, false) || underCloak(options.cloak, scope, true)) {
      mutable.cloaked += 1;
      continue;
    }
    const full = joinLocal(realRoot, scope);
    try {
      await visit(scope, full, await lstat(full));
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) {
        throw error;
      }
    }
  }

  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (options.signal?.aborted === true) {
      break;
    }
    const folder = joinLocal(realRoot, next);
    for await (const dirent of await opendir(folder)) {
      const child = childPath(next, dirent.name, platform);
      if (!child.ok) {
        result.problems.push({
          path: next === ROOT ? dirent.name : `${next}/${dirent.name}`,
          side: 'local',
          kind: 'unsafe',
          status: unsafeNameStatus(child.reason),
        });
        continue;
      }
      const full = path.join(folder, dirent.name);
      await visit(child.path, full, await lstat(full));
    }
  }
  options.onProgress?.(result.files.size);
  return result;
}
