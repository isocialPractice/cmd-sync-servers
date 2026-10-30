import { randomBytes } from 'node:crypto';
import { lstat, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SyncError } from '../errors.ts';

declare const remotePathBrand: unique symbol;

/**
 * A validated site-relative path: `/`-separated, NFC-normalized, with no
 * empty, `.` or `..` segment and no control character. The site root is `''`.
 * Only this module creates one, so no unvalidated name reaches a transport
 * or the local file system.
 */
export type RemotePath = string & { readonly [remotePathBrand]: true };

/** The site root. */
export const ROOT = '' as RemotePath;

/** The verdict of {@link checkPath}: a validated path, or the reason it was refused. */
export type PathCheck = { readonly ok: true; readonly path: RemotePath } | { readonly ok: false; readonly reason: string };

/** C0 controls, DEL and C1 controls: terminals act on all of them, so no name may hold one. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what this rejects
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const WINDOWS_FORBIDDEN = /[<>:"|?*]/;
const WINDOWS_RESERVED = /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])\s*(?:\..*)?$/i;
/** The shape of a Windows 8.3 short name, such as `GIT~1` or `PROGRA~1.TXT`: another name for a file or folder. */
const WINDOWS_SHORT_NAME = /^[^.~]{1,6}~\d{1,6}(?:\.[^.]{0,3})?$/;
const MAX_NAME_BYTES = 255;

/** Why one path segment cannot be used, or `undefined` when it can. */
export function nameProblem(name: string, platform: NodeJS.Platform = process.platform): string | undefined {
  if (name === '') {
    return 'empty name';
  }
  if (name === '.' || name === '..') {
    return `"${name}" is not a file name`;
  }
  if (name.includes('/')) {
    return 'contains a slash';
  }
  // A backslash is a separator on Windows servers as well as Windows clients, so it is refused everywhere.
  if (name.includes('\\')) {
    return 'contains a backslash';
  }
  if (CONTROL.test(name)) {
    return 'contains a control character';
  }
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) {
    return `longer than ${String(MAX_NAME_BYTES)} bytes`;
  }
  if (platform === 'win32') {
    if (WINDOWS_FORBIDDEN.test(name)) {
      return 'contains a character Windows does not allow (< > : " | ? *)';
    }
    if (/[. ]$/.test(name)) {
      return 'ends with a dot or a space';
    }
    if (WINDOWS_RESERVED.test(name)) {
      return 'reserved device name';
    }
    if (WINDOWS_SHORT_NAME.test(name)) {
      return 'shaped like a short 8.3 name, which Windows may read as another file or folder';
    }
  }
  return undefined;
}

/** Validates a site-relative path such as `css/site.css`. */
export function checkPath(relative: string, platform: NodeJS.Platform = process.platform): PathCheck {
  const normalized = relative.normalize('NFC');
  if (normalized === '') {
    return { ok: true, path: ROOT };
  }
  if (normalized.startsWith('/')) {
    return { ok: false, reason: 'absolute path' };
  }
  for (const segment of normalized.split('/')) {
    const problem = nameProblem(segment, platform);
    if (problem !== undefined) {
      return { ok: false, reason: problem };
    }
  }
  return { ok: true, path: normalized as RemotePath };
}

/** A validated site-relative path, or `E_PATH_UNSAFE`. */
export function toRemotePath(relative: string, platform: NodeJS.Platform = process.platform): RemotePath {
  const result = checkPath(relative, platform);
  if (!result.ok) {
    throw new SyncError('E_PATH_UNSAFE', `${JSON.stringify(relative)} is not a safe path: ${result.reason}.`);
  }
  return result.path;
}

/** The path of `name` inside `parent`, validated. */
export function childPath(parent: RemotePath, name: string, platform: NodeJS.Platform = process.platform): PathCheck {
  const normalized = name.normalize('NFC');
  const problem = nameProblem(normalized, platform);
  if (problem !== undefined) {
    return { ok: false, reason: problem };
  }
  return { ok: true, path: (parent === ROOT ? normalized : `${parent}/${normalized}`) as RemotePath };
}

/** The parent folder of a path; `undefined` for the root. */
export function parentPath(target: RemotePath): RemotePath | undefined {
  if (target === ROOT) {
    return undefined;
  }
  const slash = target.lastIndexOf('/');
  return (slash === -1 ? '' : target.slice(0, slash)) as RemotePath;
}

/** The last segment of a path; `''` for the root. */
export function baseName(target: RemotePath): string {
  return target.slice(target.lastIndexOf('/') + 1);
}

/**
 * The absolute server path of `target` under `remoteRoot`, joined with POSIX
 * rules and checked to stay under the root.
 */
export function joinRemote(remoteRoot: string, target: RemotePath): string {
  if (!remoteRoot.startsWith('/') || CONTROL.test(remoteRoot)) {
    throw new SyncError('E_PATH_UNSAFE', `The remote root ${JSON.stringify(remoteRoot)} must be an absolute path with no control characters.`);
  }
  const root = path.posix.normalize(remoteRoot).replace(/(?<=.)\/+$/, '');
  const joined = target === ROOT ? root : path.posix.join(root, target);
  const prefix = root === '/' ? '/' : `${root}/`;
  if (joined !== root && !joined.startsWith(prefix)) {
    throw new SyncError('E_PATH_UNSAFE', `${JSON.stringify(target)} would leave the remote root.`);
  }
  return joined;
}

/** True when `target` is `root` or inside it. Ignores case where the platform's file systems usually do. */
export function isInside(root: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const ignoreCase = platform === 'win32' || platform === 'darwin';
  const a = ignoreCase ? root.toLowerCase() : root;
  const b = ignoreCase ? target.toLowerCase() : target;
  const relative = p.relative(a, b);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${p.sep}`) && !p.isAbsolute(relative));
}

/** The local path of `target` under `localRoot`, checked to stay inside it. */
export function joinLocal(localRoot: string, target: RemotePath): string {
  const joined = target === ROOT ? path.resolve(localRoot) : path.join(path.resolve(localRoot), ...target.split('/'));
  if (!isInside(path.resolve(localRoot), joined)) {
    throw new SyncError('E_PATH_UNSAFE', `${JSON.stringify(target)} would leave the local root.`);
  }
  return joined;
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

/** The nearest of `target` and its folders that exists, with its real path. */
async function nearestExisting(target: string, resolve: (file: string) => Promise<string>): Promise<{ path: string; real: string }> {
  try {
    return { path: target, real: await resolve(target) };
  } catch (error) {
    const parent = path.dirname(target);
    if (!hasCode(error, 'ENOENT') || parent === target) {
      throw error;
    }
    return nearestExisting(parent, resolve);
  }
}

/** The real path of `target`, or of its nearest folder that exists. `resolve` is replaceable in tests. */
export async function realpathOfNearest(target: string, resolve: (file: string) => Promise<string> = realpath): Promise<string> {
  return (await nearestExisting(target, resolve)).real;
}

/**
 * The local path of `target`, safe to write: its parent's real path is inside
 * the real local root (so no linked folder leads out of it), and is the very
 * folder the path names, so no link, junction or Windows short name stands
 * in for another folder. The target itself is not a symbolic link or
 * junction. `resolve` is replaceable in tests.
 */
export async function safeLocalTarget(localRoot: string, target: RemotePath, resolve: (file: string) => Promise<string> = realpath): Promise<string> {
  const realRoot = await resolve(localRoot);
  const full = joinLocal(realRoot, target);
  if (target === ROOT) {
    return realRoot;
  }
  const parent = await nearestExisting(path.dirname(full), resolve);
  if (!isInside(realRoot, parent.real)) {
    throw new SyncError('E_PATH_UNSAFE', `${JSON.stringify(target)} leads out of the local root through a linked folder.`);
  }
  const named = parent.path.normalize('NFC');
  const real = parent.real.normalize('NFC');
  if (!isInside(named, real) || !isInside(real, named)) {
    throw new SyncError('E_PATH_UNSAFE', `${JSON.stringify(target)} is reached through a linked folder or another name for a folder, and is not written through.`);
  }
  try {
    if ((await lstat(full)).isSymbolicLink()) {
      throw new SyncError('E_PATH_UNSAFE', `${JSON.stringify(target)} is a symbolic link and is not written through.`);
    }
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) {
      throw error;
    }
  }
  return full;
}

/** The names that differ from another name only by case; on a case-insensitive file system none of them is safe. */
export function caseCollisions(names: Iterable<string>): Set<string> {
  const byFolded = new Map<string, string[]>();
  for (const name of names) {
    const folded = name.normalize('NFC').toLowerCase();
    byFolded.set(folded, [...(byFolded.get(folded) ?? []), name]);
  }
  const colliding = new Set<string>();
  for (const group of byFolded.values()) {
    if (new Set(group).size > 1) {
      for (const name of group) {
        colliding.add(name);
      }
    }
  }
  return colliding;
}

/**
 * Probes whether the file system holding `dir` tells names apart by case:
 * writes a lower-case file and looks for its upper-case name. `look` is the
 * lookup, replaceable in tests.
 */
export async function isCaseSensitive(dir: string, look: (file: string) => Promise<unknown> = stat): Promise<boolean> {
  const name = `.sync-servers-case-${randomBytes(6).toString('hex')}`;
  const probe = path.join(dir, name);
  await writeFile(probe, '', { flag: 'wx', mode: 0o600 });
  let sensitive: boolean;
  try {
    await look(path.join(dir, name.toUpperCase()));
    sensitive = false;
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) {
      throw error;
    }
    sensitive = true;
  } finally {
    await rm(probe, { force: true });
  }
  return sensitive;
}
