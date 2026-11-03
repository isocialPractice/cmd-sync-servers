import { createHash } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';
import { lstat, opendir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { hasErrorCode, writeFileAtomic } from '../config/files.ts';
import { ensurePrivateDir } from '../config/paths.ts';
import type { Cloak } from './cloak.ts';
import { STATUS, unsafeNameStatus } from './messages.ts';
import { isPartName } from './part.ts';
import { baseName, checkPath, childPath, isInside, parentPath, ROOT, type LinkPolicy, type RemotePath } from './paths.ts';
import type { Observation, ProblemKind, ScanProblem } from './types.ts';

/** Where a file reached through a followed symbolic link or junction really is. */
export interface LinkedFile {
  /** Its real path. */
  readonly real: string;
  /** True when that path is outside the real local root. */
  readonly outside: boolean;
}

export interface ScanResult {
  /** Files by site-relative path. */
  readonly files: Map<RemotePath, Observation>;
  readonly dirs: Set<RemotePath>;
  readonly problems: ScanProblem[];
  /** Files and folders left out by cloaking. */
  readonly cloaked: number;
  /** The local files reached through a followed link, with where they really are; empty for a server. */
  readonly linked: Map<RemotePath, LinkedFile>;
}

export interface LocalScanOptions {
  /** The site's local root. */
  readonly root: string;
  readonly cloak: Cloak;
  readonly symlinks: LinkPolicy;
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

/** A folder the scan enters, with where it really is and the folders above it. */
interface Folder {
  readonly path: RemotePath;
  /** Its real path: under the real root, or where a followed link leads. */
  readonly real: string;
  /** True when a followed link leads to it or to a folder above it. */
  readonly linked: boolean;
  readonly parent: Folder | undefined;
}

/**
 * Lists the files under the site's local root. Cloaked folders are never
 * entered; names this system cannot use are reported. Symbolic links and
 * junctions are reported under `skip`. Under `follow-inside-root` and
 * `follow` they are followed, a file link as a file and a folder link as a
 * folder whose files are listed under the link's path, unless they lead
 * nowhere, lead back into a folder above them, or, with
 * `follow-inside-root`, lead out of the real root; then they are reported
 * with the reason. An entry is cloaked when its site path is, or when a
 * link leads to a place inside the site that is.
 */
export async function scanLocal(options: LocalScanOptions): Promise<ScanResult> {
  const platform = options.platform ?? process.platform;
  const result: ScanResult = { files: new Map(), dirs: new Set(), problems: [], cloaked: 0, linked: new Map() };
  const mutable = result as { cloaked: number };
  const realRoot = await realpath(options.root);
  const top: Folder = { path: ROOT, real: realRoot, linked: false, parent: undefined };
  const queue: Folder[] = [];
  const reported = new Set<string>();

  const problem = (target: string, kind: ProblemKind, status: string): void => {
    // Several single paths under one link report it once.
    if (!reported.has(target)) {
      reported.add(target);
      result.problems.push({ path: target, side: 'local', kind, status });
    }
  };

  const samePlace = (a: string, b: string): boolean => isInside(a, b, platform) && isInside(b, a, platform);

  /** True when `real` is the real path of `parent` or of a folder above it: entering it would never end. */
  const loops = (real: string, parent: Folder): boolean => {
    for (let up: Folder | undefined = parent; up !== undefined; up = up.parent) {
      if (samePlace(up.real, real)) {
        return true;
      }
    }
    return false;
  };

  /** The real path a link leads to, or `undefined` after reporting why it is not followed. */
  const follow = async (target: RemotePath, full: string): Promise<string | undefined> => {
    if (options.symlinks === 'skip') {
      problem(target, 'symlink', STATUS.linkNotFollowed);
      return undefined;
    }
    const real = await realpath(full).catch(() => undefined);
    if (real === undefined) {
      problem(target, 'symlink', STATUS.linkBroken);
      return undefined;
    }
    if (options.symlinks === 'follow-inside-root' && !isInside(realRoot, real, platform)) {
      problem(target, 'symlink', STATUS.linkOutside);
      return undefined;
    }
    return real;
  };

  /** True when `target`, or the place inside the site a followed link leads it to, is cloaked. */
  const cloakedAt = (target: RemotePath, real: string, linked: boolean, isDir: boolean): boolean => {
    if (options.cloak.isCloaked(target, isDir)) {
      return true;
    }
    if (!linked || !isInside(realRoot, real, platform)) {
      return false;
    }
    const at = checkPath(path.relative(realRoot, real).split(path.sep).join('/'), platform);
    return at.ok && at.path !== ROOT && underCloak(options.cloak, at.path, isDir);
  };

  const addFile = async (target: RemotePath, full: string, info: Stats): Promise<void> => {
    const sha256 = options.checksum ? await (options.cache ?? (await HashCache.open(undefined))).hash(target, full, info) : undefined;
    result.files.set(target, { size: info.size, mtimeMs: info.mtimeMs, ...(sha256 === undefined ? {} : { sha256 }) });
    if (result.files.size % 500 === 0) {
      options.onProgress?.(result.files.size);
    }
  };

  const visit = async (target: RemotePath, full: string, info: Stats, parent: Folder): Promise<void> => {
    let entry = info;
    let real = full;
    let linked = parent.linked;
    if (info.isSymbolicLink()) {
      const followed = await follow(target, full);
      if (followed === undefined) {
        return;
      }
      entry = await stat(full);
      real = followed;
      linked = true;
    }
    if (entry.isDirectory()) {
      if (linked && loops(real, parent)) {
        problem(target, 'symlink', STATUS.linkLoop);
        return;
      }
      if (cloakedAt(target, real, linked, true)) {
        mutable.cloaked += 1;
        return;
      }
      result.dirs.add(target);
      queue.push({ path: target, real, linked, parent });
    } else if (entry.isFile()) {
      if (cloakedAt(target, real, linked, false)) {
        mutable.cloaked += 1;
        return;
      }
      await addFile(target, full, entry);
      if (linked) {
        result.linked.set(target, { real, outside: !isInside(realRoot, real, platform) });
      }
    } else {
      problem(target, 'other', STATUS.notAFile);
    }
  };

  /**
   * The folder holding a single path, reached from the root the way a full
   * scan reaches it, so a link above the path is followed or reported by
   * the same rules. `undefined` when it does not exist or is not followed.
   */
  const reach = async (scope: RemotePath): Promise<Folder | undefined> => {
    const segments = scope.split('/');
    let folder = top;
    for (const [index, segment] of segments.slice(0, -1).entries()) {
      const at = segments.slice(0, index + 1).join('/') as RemotePath;
      const full = path.join(folder.real, segment);
      let info: Stats;
      try {
        info = await lstat(full);
      } catch (error) {
        if (hasCode(error, 'ENOENT')) {
          return undefined;
        }
        throw error;
      }
      let real = full;
      let linked = folder.linked;
      if (info.isSymbolicLink()) {
        const followed = await follow(at, full);
        if (followed === undefined) {
          return undefined;
        }
        info = await stat(full);
        real = followed;
        linked = true;
      }
      if (!info.isDirectory()) {
        return undefined;
      }
      if (linked && loops(real, folder)) {
        problem(at, 'symlink', STATUS.linkLoop);
        return undefined;
      }
      folder = { path: at, real, linked, parent: folder };
    }
    return folder;
  };

  for (const scope of options.scopes) {
    if (scope === ROOT) {
      queue.push(top);
      continue;
    }
    if (underCloak(options.cloak, scope, false) || underCloak(options.cloak, scope, true)) {
      mutable.cloaked += 1;
      continue;
    }
    const folder = await reach(scope);
    if (folder === undefined) {
      continue;
    }
    const full = path.join(folder.real, baseName(scope));
    try {
      await visit(scope, full, await lstat(full), folder);
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
    for await (const dirent of await opendir(next.real)) {
      if (isPartName(dirent.name)) {
        // A partial copy left by an interrupted transfer is never synchronized as a file.
        continue;
      }
      const child = childPath(next.path, dirent.name, platform);
      if (!child.ok) {
        result.problems.push({
          path: next.path === ROOT ? dirent.name : `${next.path}/${dirent.name}`,
          side: 'local',
          kind: 'unsafe',
          status: unsafeNameStatus(child.reason),
        });
        continue;
      }
      const full = path.join(next.real, dirent.name);
      await visit(child.path, full, await lstat(full), next);
    }
  }
  options.onProgress?.(result.files.size);
  return result;
}
