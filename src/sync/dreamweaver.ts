import type { Dirent } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { hasErrorCode } from '../config/files.ts';
import type { Cloak } from './cloak.ts';
import { DWSYNC_FILE, NOTES_FOLDER, parseDwsync, type DwsyncDocument } from './dwsync.ts';

/** The largest `dwsync.xml` that is read. A larger one is treated as damaged. */
export const MAX_DWSYNC_BYTES = 8 * 1024 * 1024;

const DEFAULT_MAX_FOLDERS = 2000;

/** What reading a `dwsync.xml` found: its entries, no file, or a file that cannot be used. */
export type DwsyncRead =
  | { readonly state: 'ok'; readonly document: DwsyncDocument }
  | { readonly state: 'missing' }
  | { readonly state: 'damaged' };

/**
 * Reads one `dwsync.xml`. A file that is not a plain file, is over the size
 * limit, cannot be read or is not a dwsync document is `damaged`, and is
 * then neither used nor rewritten.
 */
export async function readDwsyncFile(file: string): Promise<DwsyncRead> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_DWSYNC_BYTES) {
      return { state: 'damaged' };
    }
    const document = parseDwsync(await readFile(file, 'utf8'));
    return document === undefined ? { state: 'damaged' } : { state: 'ok', document };
  } catch (error) {
    return hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ENOTDIR') ? { state: 'missing' } : { state: 'damaged' };
  }
}

/** Options of {@link findDreamweaverServers} and {@link hasDreamweaverRecords}. */
export interface DreamweaverSearchOptions {
  /** Cloaked folders are not looked into. */
  readonly cloak?: Cloak | undefined;
  /** The most folders looked into. Default 2,000. */
  readonly maxFolders?: number | undefined;
  /** Stops the search; what was found so far is returned. */
  readonly signal?: AbortSignal | undefined;
}

/** A server Dreamweaver synchronized a folder with, and how many of its entries name that server. */
export interface DreamweaverServerCount {
  /** The server as Dreamweaver names it, such as `203.0.113.10//public_html/`. */
  readonly server: string;
  /** How many file entries carry that name. */
  readonly files: number;
}

/**
 * Every readable `dwsync.xml` under a local folder, breadth first. Links are
 * never followed, cloaked folders are left out, and the walk ends at the
 * folder limit.
 */
async function* dwsyncDocuments(localRoot: string, options: DreamweaverSearchOptions): AsyncGenerator<DwsyncDocument> {
  const limit = options.maxFolders ?? DEFAULT_MAX_FOLDERS;
  const queue: { dir: string; at: string }[] = [{ dir: localRoot, at: '' }];
  let folders = 0;
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (options.signal?.aborted === true || folders >= limit) {
      return;
    }
    folders += 1;
    const notes = path.join(next.dir, NOTES_FOLDER);
    const notesInfo = await lstat(notes).catch(() => undefined);
    if (notesInfo?.isDirectory() === true) {
      const read = await readDwsyncFile(path.join(notes, DWSYNC_FILE));
      if (read.state === 'ok') {
        yield read.document;
      }
    }
    let children: Dirent[];
    try {
      children = await readdir(next.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      // A link to a folder is not a folder here, so the search never leaves the local folder.
      if (!child.isDirectory() || child.name.toLowerCase() === NOTES_FOLDER) {
        continue;
      }
      const at = next.at === '' ? child.name : `${next.at}/${child.name}`;
      if (options.cloak?.isCloaked(at, true) === true) {
        continue;
      }
      queue.push({ dir: path.join(next.dir, child.name), at });
    }
  }
}

/**
 * The servers Dreamweaver synchronized a local folder with, from the
 * `_notes/dwsync.xml` of the folder and the folders below it, with the most
 * used first. Names that differ only by case or a final `/` count as one.
 *
 * @experimental
 */
export async function findDreamweaverServers(localRoot: string, options: DreamweaverSearchOptions = {}): Promise<DreamweaverServerCount[]> {
  const counts = new Map<string, { server: string; files: number }>();
  for await (const document of dwsyncDocuments(localRoot, options)) {
    for (const entry of document.entries) {
      if (entry.name === '') {
        continue;
      }
      const key = entry.server.replace(/\/+$/, '').toLowerCase();
      const count = counts.get(key) ?? { server: entry.server, files: 0 };
      count.files += 1;
      counts.set(key, count);
    }
  }
  return [...counts.values()].sort((a, b) => b.files - a.files || (a.server < b.server ? -1 : a.server > b.server ? 1 : 0));
}

/**
 * True when a local folder, or a folder below it, holds a readable
 * `_notes/dwsync.xml`: the folder was synchronized with Dreamweaver.
 *
 * @experimental
 */
export async function hasDreamweaverRecords(localRoot: string, options: DreamweaverSearchOptions = {}): Promise<boolean> {
  const documents = dwsyncDocuments(localRoot, options);
  const first = await documents.next();
  await documents.return(undefined);
  return first.done !== true;
}
