import type { Dirent } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import { hasErrorCode, writeFileAtomic } from '../config/files.ts';
import { ensurePrivateDir } from '../config/paths.ts';
import type { Logger } from '../log/logger.ts';
import { classify, type CompareOptions, type EntryMatch } from './classify.ts';
import type { Cloak } from './cloak.ts';
import {
  daylightState,
  DWSYNC_FILE,
  filetimeToMs,
  NOTES_FOLDER,
  parseDwsync,
  sameServerName,
  serializeDwsync,
  toFiletime,
  type DwsyncDocument,
  type DwsyncEntry,
} from './dwsync.ts';
import { baseName, parentPath, resolveLocalTarget, ROOT, toRemotePath, type LinkPolicy, type RemotePath } from './paths.ts';
import type { ScanResult } from './scan-local.ts';
import type { RecordMirror, SyncRecord } from './state.ts';

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
 * Every readable `dwsync.xml` under a local folder with the file it came
 * from, breadth first. Links are never followed, cloaked folders are left
 * out, and the walk ends at the folder limit.
 */
async function* dwsyncDocuments(localRoot: string, options: DreamweaverSearchOptions): AsyncGenerator<{ file: string; document: DwsyncDocument }> {
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
      const file = path.join(notes, DWSYNC_FILE);
      const read = await readDwsyncFile(file);
      if (read.state === 'ok') {
        yield { file, document: read.document };
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
  for await (const { document } of dwsyncDocuments(localRoot, options)) {
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

/** The line end of a new `dwsync.xml`: what Dreamweaver writes on that system. */
function newlineOf(platform: NodeJS.Platform): '\r\n' | '\n' {
  return platform === 'win32' ? '\r\n' : '\n';
}

/** Writes a `dwsync.xml` whole, or removes it, and its `_notes` folder with it when nothing else is there, once no entry is left. */
async function writeDwsyncFile(file: string, document: DwsyncDocument): Promise<void> {
  if (document.entries.length === 0) {
    await rm(file, { force: true });
    await rmdir(path.dirname(file)).catch(() => undefined);
    return;
  }
  await mkdir(path.dirname(file), { recursive: true });
  // The mode a new file of the site gets: the system's own, not the private one of the settings.
  await writeFileAtomic(file, serializeDwsync(document), { mode: 0o666 });
}

/**
 * Removes every entry that names `server` from the `_notes/dwsync.xml` of a
 * local folder and the folders below it, leaving the entries of other
 * servers. Returns how many it removed.
 */
export async function removeDreamweaverEntries(localRoot: string, server: string, options: Pick<DreamweaverSearchOptions, 'signal'> = {}): Promise<number> {
  let removed = 0;
  for await (const { file, document } of dwsyncDocuments(localRoot, { ...options, maxFolders: Number.POSITIVE_INFINITY })) {
    const kept = document.entries.filter((entry) => entry.name === '' || !sameServerName(entry.server, server));
    if (kept.length < document.entries.length) {
      removed += document.entries.length - kept.length;
      await writeDwsyncFile(file, { entries: kept, newline: document.newline });
    }
  }
  return removed;
}

/**
 * Removes `_notes/dwsync.xml` from a folder that holds nothing else, so the
 * folder can be removed as emptied. A folder with any other file, a `_notes`
 * with anything else in it, and a link are left as they are.
 */
export async function removeLeftoverNotes(folder: string): Promise<void> {
  const names = await readdir(folder);
  const [only] = names;
  if (names.length !== 1 || only?.toLowerCase() !== NOTES_FOLDER) {
    return;
  }
  const notes = path.join(folder, only);
  const inside = (await lstat(notes)).isDirectory() ? await readdir(notes) : [];
  const [record] = inside;
  if (inside.length !== 1 || record?.toLowerCase() !== DWSYNC_FILE) {
    return;
  }
  const file = path.join(notes, record);
  if ((await lstat(file)).isFile()) {
    await rm(file);
    await rmdir(notes);
  }
}

/** The step Dreamweaver keeps a server's times in. */
export type ClockUnit = 'minute' | 'second';

const UNIT_MS: Readonly<Record<ClockUnit, number>> = { minute: 60_000, second: 1000 };
const HOUR_SECONDS = 3600;
const MAX_OFFSET_SECONDS = 16 * HOUR_SECONDS;
const MIN_AGREEING = 3;
/** One minute in the 100 nanosecond steps of a `dwsync.xml`. */
const WHOLE_MINUTE = 600_000_000n;

/**
 * How Dreamweaver reads one server's clock, next to how this tool reads it:
 * the step its times are cut to, and how far this tool's reading is ahead
 * of Dreamweaver's. The difference is the same for every file of a server,
 * apart from one hour of daylight time.
 */
export class DreamweaverClock {
  readonly unit: ClockUnit;
  /** This tool's reading of a server time minus Dreamweaver's, in seconds. */
  readonly offsetSeconds: number;

  constructor(unit: ClockUnit, offsetSeconds: number) {
    this.unit = unit;
    this.offsetSeconds = offsetSeconds;
  }

  /** This tool's reading of a server time minus the time an entry holds, both cut to the unit, in seconds. */
  static step(unit: ClockUnit, serverMs: number, entryRemote: bigint): number {
    const unitMs = UNIT_MS[unit];
    return (Math.floor(serverMs / unitMs) - Math.floor(filetimeToMs(entryRemote) / unitMs)) * (unitMs / 1000);
  }

  /** True when an entry's server time is this server time as Dreamweaver reads it, give or take the hour of daylight time. */
  matches(serverMs: number, entryRemote: bigint): boolean {
    const off = DreamweaverClock.step(this.unit, serverMs, entryRemote) - this.offsetSeconds;
    return off === 0 || Math.abs(off) === HOUR_SECONDS;
  }

  /**
   * The server time Dreamweaver would record. With `zoneOffsetMinutes`, for
   * a local or network folder, the time is moved by the difference between
   * the zone offset now and the zone offset at that time, as Dreamweaver
   * moves it.
   */
  remoteFor(serverMs: number, nowMs: number, zoneOffsetMinutes?: (atMs: number) => number): bigint {
    const unitMs = UNIT_MS[this.unit];
    const at = Math.floor(serverMs / unitMs) * unitMs - this.offsetSeconds * 1000;
    const shift = zoneOffsetMinutes === undefined ? 0 : (zoneOffsetMinutes(nowMs) - zoneOffsetMinutes(at)) * 60_000;
    return toFiletime(BigInt(at + shift) * 1_000_000n);
  }
}

/**
 * The clock of a server from the entries of one scan. `steps` holds, for
 * each entry whose local file is unchanged, this tool's reading of the
 * server copy's time minus the entry's. The clock is the step most entries
 * share, when at least three share it, no step other than one an hour away
 * ties with it, and it is at most 16 hours. With no entry of the server's
 * name in the site (`entries` is 0) there is nothing to agree with, and the
 * clock is this tool's own. Otherwise it is not known.
 */
export function learnClock(steps: readonly number[], unit: ClockUnit, entries: number): DreamweaverClock | undefined {
  if (entries === 0) {
    return new DreamweaverClock(unit, 0);
  }
  const counts = new Map<number, number>();
  for (const step of steps) {
    counts.set(step, (counts.get(step) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || Math.abs(a[0]) - Math.abs(b[0]) || a[0] - b[0]);
  const [best, ...others] = ranked;
  if (best === undefined || best[1] < MIN_AGREEING || Math.abs(best[0]) > MAX_OFFSET_SECONDS) {
    return undefined;
  }
  const tied = others.some(([step, count]) => count === best[1] && Math.abs(step - best[0]) !== HOUR_SECONDS);
  return tied ? undefined : new DreamweaverClock(unit, best[0]);
}

const clockFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  server: z.string().min(1),
  unit: z.enum(['minute', 'second']),
  offsetSeconds: z.number().int(),
});

/**
 * Where the clock of one site and server is kept: `<state>/sites/<siteId>/<serverId>.dwsync.json`.
 *
 * @experimental
 */
export function clockFile(stateDir: string, siteId: string, serverId: string): string {
  return path.join(stateDir, 'sites', siteId, `${serverId}.dwsync.json`);
}

/** The clock a file holds for `server`; `undefined` when there is none, it is for another server name, or it cannot be read. */
async function readClock(file: string, server: string): Promise<DreamweaverClock | undefined> {
  try {
    const parsed = clockFileSchema.safeParse(JSON.parse(await readFile(file, 'utf8')));
    return parsed.success && sameServerName(parsed.data.server, server) ? new DreamweaverClock(parsed.data.unit, parsed.data.offsetSeconds) : undefined;
  } catch {
    return undefined;
  }
}

/** What a scan knows when it asks Dreamweaver's records about it. */
export interface EvidenceInput {
  readonly local: ScanResult;
  readonly remote: ScanResult;
  /** The tool's own records within the scan. */
  readonly records: ReadonlyMap<string, SyncRecord>;
  readonly compare: CompareOptions;
  /** True when the scan covered the whole site. Only then is the clock learned. */
  readonly wholeSite: boolean;
}

/** What Dreamweaver's records say about the files of a scan. */
export interface Evidence {
  /** For files both sides have that the tool's own records do not show in sync: which sides are as the entry says. */
  readonly entries: Map<string, EntryMatch>;
  /** Files in sync by the tool's own records that the folder's `dwsync.xml` does not show so, listed by the scan that learns the clock. */
  readonly catchUp: Set<string>;
}

/** Options of {@link DreamweaverNotes}. */
export interface DreamweaverNotesOptions {
  /** The site's local root. */
  readonly localRoot: string;
  /** How the site treats links: a `_notes` reached through a link is read and written only as that allows, and never outside the root. */
  readonly symlinks: LinkPolicy;
  /** The server as Dreamweaver names it. */
  readonly server: string;
  /** True for a local or network folder, whose recorded times Dreamweaver moves by the hour of daylight time. */
  readonly folderServer: boolean;
  /** The file the server's clock is kept in. */
  readonly clockFile: string;
  readonly logger: Logger;
  /** True when local names do not differ by case. */
  readonly caseInsensitive: () => Promise<boolean>;
  /** The minutes the zone is behind UTC at a time. Default: this computer's. */
  readonly zoneOffsetMinutes?: ((atMs: number) => number) | undefined;
  /** The time now. Default: the system clock. */
  readonly now?: (() => number) | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

/** True when a local time is the one an entry holds: the same millisecond. */
function sameLocalTime(localMs: number, entryLocal: bigint): boolean {
  return Math.abs(localMs - filetimeToMs(entryLocal)) < 1;
}

/**
 * The synchronization records Dreamweaver keeps for one site and server, in
 * the `_notes/dwsync.xml` of each folder: read as evidence for a plan, and
 * written as a second copy of the tool's own records. Nothing is used or
 * written until the server's clock is known, a file that is not understood
 * in full is left as it is, and the entries of other servers are kept.
 */
export class DreamweaverNotes implements RecordMirror {
  readonly #options: DreamweaverNotesOptions;
  readonly #zone: (atMs: number) => number;
  readonly #now: () => number;
  readonly #queue = new Map<string, SyncRecord | undefined>();
  readonly #warned = new Set<string>();
  #documents = new Map<string, DwsyncDocument | undefined>();
  #clock: DreamweaverClock | undefined;
  #clockRead = false;
  #learned: DreamweaverClock | undefined;
  #saving: Promise<void> = Promise.resolve();

  constructor(options: DreamweaverNotesOptions) {
    this.#options = options;
    this.#zone = options.zoneOffsetMinutes ?? ((atMs) => new Date(atMs).getTimezoneOffset());
    this.#now = options.now ?? Date.now;
  }

  /** True once the server's clock is known: kept from an earlier run, or learned by the last scan. */
  get clockKnown(): boolean {
    return this.#clock !== undefined || this.#learned !== undefined;
  }

  async #savedClock(): Promise<DreamweaverClock | undefined> {
    if (!this.#clockRead) {
      this.#clock = await readClock(this.#options.clockFile, this.#options.server);
      this.#clockRead = true;
    }
    return this.#clock;
  }

  /** Keeps a clock the last scan learned, so later runs use it and entries are written. Does nothing when none was learned. */
  async commitClock(): Promise<void> {
    const learned = this.#learned;
    if (learned === undefined) {
      return;
    }
    this.#clock = learned;
    this.#clockRead = true;
    this.#learned = undefined;
    await ensurePrivateDir(path.dirname(this.#options.clockFile));
    const text = JSON.stringify({ schemaVersion: 1, server: this.#options.server, unit: learned.unit, offsetSeconds: learned.offsetSeconds });
    await writeFileAtomic(this.#options.clockFile, `${text}\n`);
  }

  /** Forgets the clock and removes its file. */
  async forgetClock(): Promise<void> {
    this.#clock = undefined;
    this.#learned = undefined;
    this.#clockRead = true;
    await rm(this.#options.clockFile, { force: true });
  }

  #warnOnce(key: string, message: string): void {
    if (!this.#warned.has(key)) {
      this.#warned.add(key);
      this.#options.logger.warn(message);
    }
  }

  /** The `dwsync.xml` of a folder of the site, or `undefined` when it may not be reached. */
  async #notesFile(folder: string): Promise<string | undefined> {
    const sitePath = folder === ROOT ? `${NOTES_FOLDER}/${DWSYNC_FILE}` : `${folder}/${NOTES_FOLDER}/${DWSYNC_FILE}`;
    try {
      const resolved = await resolveLocalTarget(this.#options.localRoot, toRemotePath(sitePath), this.#options.symlinks);
      if (!resolved.outside) {
        return resolved.file;
      }
    } catch {
      // Refused below, with the links the site does not follow.
    }
    this.#warnOnce(sitePath, `${sitePath} is reached through a link this site does not follow, or leads out of it. Dreamweaver's records there are neither read nor written.`);
    return undefined;
  }

  async #read(folder: string): Promise<{ file: string; read: DwsyncRead } | undefined> {
    const file = await this.#notesFile(folder);
    if (file === undefined) {
      return undefined;
    }
    const read = await readDwsyncFile(file);
    if (read.state === 'damaged') {
      const sitePath = folder === ROOT ? `${NOTES_FOLDER}/${DWSYNC_FILE}` : `${folder}/${NOTES_FOLDER}/${DWSYNC_FILE}`;
      this.#warnOnce(`damaged:${sitePath}`, `${sitePath} could not be read as Dreamweaver synchronization records. It is left as it is, and the files of its folder are compared without it.`);
    }
    return { file, read };
  }

  /** The records of a folder, read once per scan. */
  async #document(folder: string): Promise<DwsyncDocument | undefined> {
    if (!this.#documents.has(folder)) {
      const found = await this.#read(folder);
      this.#documents.set(folder, found?.read.state === 'ok' ? found.read.document : undefined);
    }
    return this.#documents.get(folder);
  }

  #names(entry: DwsyncEntry, name: string, insensitive: boolean): boolean {
    if (entry.name === '' || !sameServerName(entry.server, this.#options.server)) {
      return false;
    }
    return entry.name === name || (insensitive && entry.name.toLowerCase() === name.toLowerCase());
  }

  async #entry(target: RemotePath, insensitive: boolean): Promise<DwsyncEntry | undefined> {
    const document = await this.#document(parentPath(target) ?? ROOT);
    return document?.entries.find((entry) => this.#names(entry, baseName(target), insensitive));
  }

  /**
   * The clock of the server from every `dwsync.xml` of the scanned folders.
   * Reads them all, which a scan does only while the clock is not known.
   */
  async #learn(input: EvidenceInput, insensitive: boolean): Promise<DreamweaverClock | undefined> {
    let named = 0;
    let seconds = false;
    for (const folder of [ROOT, ...input.local.dirs]) {
      const document = await this.#document(folder);
      for (const entry of document?.entries ?? []) {
        if (entry.name !== '' && sameServerName(entry.server, this.#options.server)) {
          named += 1;
          seconds ||= entry.remote % WHOLE_MINUTE !== 0n;
        }
      }
    }
    const unit: ClockUnit = seconds || (named === 0 && this.#options.folderServer) ? 'second' : 'minute';
    const steps: number[] = [];
    if (named > 0) {
      for (const [target, local] of input.local.files) {
        const remote = input.remote.files.get(target);
        if (remote?.mtimeMs === undefined || local.mtimeMs === undefined) {
          continue;
        }
        const entry = await this.#entry(target, insensitive);
        if (entry !== undefined && sameLocalTime(local.mtimeMs, entry.local)) {
          steps.push(DreamweaverClock.step(unit, remote.mtimeMs, entry.remote) + this.#daylightShift(entry, remote.mtimeMs));
        }
      }
    }
    return learnClock(steps, unit, named);
  }

  /**
   * The seconds Dreamweaver moved the server time of a folder server's
   * entry: the zone offset when the entry was written, which its `Dst`
   * names, minus the zone offset at that time. Taken out of a step, so the
   * clock learned is the same whatever the season the entries were written
   * in. Zero for other servers, where Dreamweaver's rule is not known.
   */
  #daylightShift(entry: DwsyncEntry, serverMs: number): number {
    const state = entry.attributes.find(([name]) => name === 'Dst')?.[1];
    if (!this.#options.folderServer || (state !== '1' && state !== '2')) {
      return 0;
    }
    const year = new Date(serverMs).getUTCFullYear();
    const january = this.#zone(Date.UTC(year, 0, 1));
    const july = this.#zone(Date.UTC(year, 6, 1));
    const written = state === '2' ? Math.min(january, july) : Math.max(january, july);
    return (written - this.#zone(serverMs)) * 60;
  }

  /**
   * What Dreamweaver's records say about the files both sides have. Reads
   * only the folders that hold a file the tool's own records do not show in
   * sync, except in the scan that learns the clock, which reads them all
   * and also lists the files Dreamweaver's records are behind on.
   */
  async evidence(input: EvidenceInput): Promise<Evidence> {
    const entries = new Map<string, EntryMatch>();
    const catchUp = new Set<string>();
    this.#documents = new Map();
    this.#learned = undefined;
    const insensitive = await this.#options.caseInsensitive();
    let clock = await this.#savedClock();
    const learning = clock === undefined && input.wholeSite;
    if (learning) {
      clock = await this.#learn(input, insensitive);
      this.#learned = clock;
    }
    if (clock === undefined) {
      return { entries, catchUp };
    }
    for (const [target, local] of input.local.files) {
      const remote = input.remote.files.get(target);
      if (remote?.mtimeMs === undefined || local.mtimeMs === undefined) {
        continue;
      }
      const state = classify(local, remote, input.records.get(target), input.compare);
      if (state === 'refresh-record' || (state === 'in-sync' && !learning)) {
        continue;
      }
      const entry = await this.#entry(target, insensitive);
      const match = entry === undefined ? undefined : { local: sameLocalTime(local.mtimeMs, entry.local), remote: clock.matches(remote.mtimeMs, entry.remote) };
      if (state === 'in-sync') {
        if (match?.local !== true || !match.remote) {
          catchUp.add(target);
        }
      } else if (match !== undefined) {
        entries.set(target, match);
      }
    }
    return { entries, catchUp };
  }

  set(target: string, record: SyncRecord): void {
    this.#queue.set(target, record);
  }

  delete(target: string): void {
    this.#queue.set(target, undefined);
  }

  /** Writes the queued changes to the folders' `dwsync.xml`, one save at a time. A failure is logged, never thrown. */
  save(): Promise<void> {
    this.#saving = this.#saving.then(() => this.#flush());
    return this.#saving;
  }

  async #flush(): Promise<void> {
    if (this.#queue.size === 0) {
      return;
    }
    const changes = [...this.#queue.entries()];
    this.#queue.clear();
    const clock = await this.#savedClock();
    if (clock === undefined) {
      // Until the clock is known, an entry could only be written wrong.
      return;
    }
    const insensitive = await this.#options.caseInsensitive();
    const folders = new Map<string, [RemotePath, SyncRecord | undefined][]>();
    for (const [target, record] of changes) {
      const checked = toRemotePath(target);
      const folder = parentPath(checked) ?? ROOT;
      folders.set(folder, [...(folders.get(folder) ?? []), [checked, record]]);
    }
    for (const [folder, items] of folders) {
      try {
        await this.#writeFolder(folder, items, clock, insensitive);
      } catch (error) {
        this.#options.logger.warn(`Dreamweaver's records of ${folder === ROOT ? 'the site folder' : folder} could not be updated.`, { error });
      }
    }
  }

  async #writeFolder(folder: string, items: readonly [RemotePath, SyncRecord | undefined][], clock: DreamweaverClock, insensitive: boolean): Promise<void> {
    const found = await this.#read(folder);
    if (found === undefined || found.read.state === 'damaged') {
      return;
    }
    const existing = found.read.state === 'ok' ? found.read.document : undefined;
    const entries = [...(existing?.entries ?? [])];
    const spelling = entries.find((entry) => entry.name !== '' && sameServerName(entry.server, this.#options.server))?.server ?? this.#options.server;
    let changed = false;
    for (const [target, record] of items) {
      const name = baseName(target);
      const index = entries.findIndex((entry) => this.#names(entry, name, insensitive));
      if (record === undefined) {
        if (index >= 0) {
          entries.splice(index, 1);
          changed = true;
        }
        continue;
      }
      const next = await this.#entryFor(target, name, record, clock, entries[index], spelling);
      if (next === undefined) {
        continue;
      }
      if (index >= 0) {
        entries[index] = next;
      } else {
        entries.push(next);
      }
      changed = true;
    }
    if (changed && (existing !== undefined || entries.length > 0)) {
      await writeDwsyncFile(found.file, { entries, newline: existing?.newline ?? newlineOf(this.#options.platform ?? process.platform) });
    }
  }

  /** The local file's time to the last 100 nanoseconds, when the file is still the one the record describes. */
  async #localTime(target: RemotePath, record: SyncRecord): Promise<bigint | undefined> {
    try {
      const resolved = await resolveLocalTarget(this.#options.localRoot, target, this.#options.symlinks);
      // A double cannot hold 100 nanosecond steps of a present-day time, and Dreamweaver compares to the last digit.
      const info = await lstat(resolved.file, { bigint: true });
      const sameTime = record.local.mtimeMs !== undefined && info.mtimeNs / 1_000_000n === BigInt(Math.floor(record.local.mtimeMs));
      return info.isFile() && Number(info.size) === record.local.size && sameTime ? toFiletime(info.mtimeNs) : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * The entry Dreamweaver would have written for a record, keeping the
   * attributes of the entry it replaces that this tool does not know.
   * `undefined` when no entry can be written, or the one there already
   * says the same and so stays as Dreamweaver wrote it.
   */
  async #entryFor(target: RemotePath, name: string, record: SyncRecord, clock: DreamweaverClock, existing: DwsyncEntry | undefined, server: string): Promise<DwsyncEntry | undefined> {
    const remoteMs = record.remote.mtimeMs;
    if (remoteMs === undefined) {
      return undefined;
    }
    const local = await this.#localTime(target, record);
    if (local === undefined || (existing !== undefined && existing.local === local && clock.matches(remoteMs, existing.remote))) {
      return undefined;
    }
    const now = this.#now();
    const remote = clock.remoteFor(remoteMs, now, this.#options.folderServer ? this.#zone : undefined);
    const values = new Map<string, string>([
      ['name', existing?.name ?? name],
      ['server', existing?.server ?? server],
      ['local', String(local)],
      ['remote', String(remote)],
      ['Dst', String(daylightState(now, this.#zone))],
    ]);
    const attributes: [string, string][] = (existing?.attributes ?? []).map(([key, value]) => [key, values.get(key) ?? value]);
    for (const [key, value] of values) {
      if (!attributes.some(([present]) => present === key)) {
        attributes.push([key, value]);
      }
    }
    return { attributes, name: existing?.name ?? name, server: existing?.server ?? server, local, remote };
  }
}
