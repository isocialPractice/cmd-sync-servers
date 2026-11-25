// Builds the `_notes/dwsync.xml` files Dreamweaver keeps in the folders of a
// site, so tests have its synchronization records without running it.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DWSYNC_FILE, NOTES_FOLDER, serializeDwsync, type DwsyncEntry } from '../../src/sync/dwsync.ts';

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
