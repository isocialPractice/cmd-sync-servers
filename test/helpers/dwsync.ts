// Builds the `_notes/dwsync.xml` files Dreamweaver keeps in the folders of a
// site, so tests have its synchronization records without running it.
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DWSYNC_FILE, NOTES_FOLDER, serializeDwsync, toFiletime, type DwsyncEntry } from '../../src/sync/dwsync.ts';

/** One file of a folder, as Dreamweaver records it for one server. */
export interface FixtureEntry {
  readonly name: string;
  /** The server as Dreamweaver names it, such as `203.0.113.10//public_html/`. */
  readonly server: string;
  /** The local file's time in 100 nanosecond steps since 1601-01-01 UTC. */
  readonly local: bigint;
  /** The server copy's time as Dreamweaver read it, in the same unit. */
  readonly remote: bigint;
  /** The daylight state when the entry was written. Default `1`, standard time. */
  readonly dst?: number;
}

/** How a fixture's Dreamweaver reads a server's clock, next to how this tool reads it. */
export interface FixtureClock {
  /** How far this tool's reading of a server time is ahead of Dreamweaver's, in seconds. Default 0. */
  readonly seconds?: number;
  /** The step Dreamweaver keeps the server's times in. Default a minute, as for FTP. */
  readonly unit?: 'minute' | 'second';
  /** Seconds added to the recorded time, as Dreamweaver moves the times of a folder server across daylight time. Default 0. */
  readonly shiftSeconds?: number;
  /** The daylight state when the entry was written. Default `1`. */
  readonly dst?: number;
}

/**
 * The entry Dreamweaver would hold for a local file and its server copy:
 * the local file's time to the last 100 nanoseconds, and the server copy's
 * time cut to Dreamweaver's step and moved onto its clock.
 */
export function entryFor(localFile: string, serverMs: number, server: string, clock: FixtureClock = {}): FixtureEntry {
  const unitMs = clock.unit === 'second' ? 1000 : 60_000;
  const at = Math.floor(serverMs / unitMs) * unitMs - (clock.seconds ?? 0) * 1000 + (clock.shiftSeconds ?? 0) * 1000;
  return {
    name: path.basename(localFile),
    server,
    local: toFiletime(lstatSync(localFile, { bigint: true }).mtimeNs),
    remote: toFiletime(BigInt(at) * 1_000_000n),
    ...(clock.dst === undefined ? {} : { dst: clock.dst }),
  };
}

/** The entry with its attributes in the order Dreamweaver writes them. */
export function dwsyncEntry(entry: FixtureEntry): DwsyncEntry {
  return {
    attributes: [
      ['name', entry.name],
      ['server', entry.server],
      ['local', String(entry.local)],
      ['remote', String(entry.remote)],
      ['Dst', String(entry.dst ?? 1)],
    ],
    name: entry.name,
    server: entry.server,
    local: entry.local,
    remote: entry.remote,
  };
}

/** The text of a `dwsync.xml` holding these entries, with the line ends Dreamweaver writes on Windows unless told otherwise. */
export function dwsyncText(entries: readonly FixtureEntry[], newline: '\r\n' | '\n' = '\r\n'): string {
  return serializeDwsync({ entries: entries.map(dwsyncEntry), newline });
}

/** Writes `<folder>/_notes/dwsync.xml` and returns its path. */
export function writeDwsync(folder: string, entries: readonly FixtureEntry[], newline: '\r\n' | '\n' = '\r\n'): string {
  const notes = path.join(folder, NOTES_FOLDER);
  mkdirSync(notes, { recursive: true });
  const file = path.join(notes, DWSYNC_FILE);
  writeFileSync(file, dwsyncText(entries, newline));
  return file;
}
