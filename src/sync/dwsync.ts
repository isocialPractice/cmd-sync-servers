import type { Server } from '../config/schema.ts';

/** The folder Dreamweaver keeps beside the files of each folder of a site. */
export const NOTES_FOLDER = '_notes';
/** The file in that folder that holds the folder's synchronization records. */
export const DWSYNC_FILE = 'dwsync.xml';

/** 1970-01-01 as a FILETIME: 100 nanosecond steps since 1601-01-01 UTC. */
const UNIX_EPOCH = 116444736000000000n;
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/**
 * One `<file>` element of a `dwsync.xml`: a file of the folder, as it was
 * last synchronized with one server.
 *
 * @experimental
 */
export interface DwsyncEntry {
  /** Every attribute as written, in order, so a rewrite keeps the ones it does not know. */
  readonly attributes: readonly (readonly [name: string, value: string])[];
  /** The file's name, without a folder. Empty for an element that cannot be used. */
  readonly name: string;
  /** The server, as Dreamweaver names it. */
  readonly server: string;
  /** The local file's time in 100 nanosecond steps since 1601-01-01 UTC. */
  readonly local: bigint;
  /** The server copy's time as Dreamweaver read it, in the same unit. */
  readonly remote: bigint;
}

/**
 * A parsed `dwsync.xml`.
 *
 * @experimental
 */
export interface DwsyncDocument {
  readonly entries: readonly DwsyncEntry[];
  /** The line end the file uses. */
  readonly newline: '\r\n' | '\n';
}

const LEAD = /^\s*(?:<\?xml(?:\s[^>]*)?\?>)?\s*/;
const EMPTY_ROOT = /^<dwsync\s*\/>\s*$/;
const ROOT_OPEN = /^<dwsync\s*>/;
const ROOT_CLOSE = /<\/dwsync\s*>\s*$/;
const ELEMENT = /\s*<file(?:\s+[^\s=<>/"']+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*\/>/y;
const ATTRIBUTE = /[^\s=<>/"']+\s*=\s*(?:"[^"<]*"|'[^'<]*')/g;
const REFERENCE = /&(?:#\d{1,7}|#x[0-9A-Fa-f]{1,6}|[a-z]+);/g;
const WHOLE_NUMBER = /^\d{1,20}$/;

const ENTITIES: ReadonlyMap<string, string> = new Map([
  ['&amp;', '&'],
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&apos;', "'"],
]);

/** Turns the five XML entities and numeric references into their characters; anything else stays as written. */
function unescapeValue(value: string): string {
  return value.replace(REFERENCE, (reference) => {
    if (!reference.startsWith('&#')) {
      return ENTITIES.get(reference) ?? reference;
    }
    const code = reference.startsWith('&#x') ? parseInt(reference.slice(3, -1), 16) : Number(reference.slice(2, -1));
    return code >= 1 && code <= 0x10ffff ? String.fromCodePoint(code) : reference;
  });
}

const ESCAPES: ReadonlyMap<string, string> = new Map([
  ['&', '&amp;'],
  ['<', '&lt;'],
  ['>', '&gt;'],
  ['"', '&quot;'],
  ['\t', '&#9;'],
  ['\n', '&#10;'],
  ['\r', '&#13;'],
]);

/** Escapes what an attribute value in double quotes cannot hold as it is. An apostrophe stays, as Dreamweaver writes it. */
function escapeValue(value: string): string {
  return value.replace(/[&<>"\t\n\r]/g, (character) => String(ESCAPES.get(character)));
}

function toEntry(element: string): DwsyncEntry | undefined {
  const attributes: [string, string][] = [];
  const seen = new Set<string>();
  for (const [pair] of element.matchAll(ATTRIBUTE)) {
    const equals = pair.indexOf('=');
    const name = pair.slice(0, equals).trim();
    if (seen.has(name)) {
      return undefined;
    }
    seen.add(name);
    attributes.push([name, unescapeValue(pair.slice(equals + 1).trim().slice(1, -1))]);
  }
  const value = (name: string): string => attributes.find(([key]) => key === name)?.[1] ?? '';
  const name = value('name');
  const server = value('server');
  const local = value('local');
  const remote = value('remote');
  if (name === '' || server === '' || !WHOLE_NUMBER.test(local) || !WHOLE_NUMBER.test(remote)) {
    // Kept so a rewrite does not lose it, and never matched: it names no file.
    return { attributes, name: '', server, local: 0n, remote: 0n };
  }
  return { attributes, name, server, local: BigInt(local), remote: BigInt(remote) };
}

/**
 * Parses a `dwsync.xml`: an optional declaration, then `<dwsync>` holding
 * nothing but `<file ... />` elements. Returns `undefined` for anything
 * else, such as a document type, another element, text or a comment, so a
 * file that is not understood in full is never used or rewritten. No entity
 * beyond the five XML ones and numeric references is expanded.
 *
 * @experimental
 */
export function parseDwsync(text: string): DwsyncDocument | undefined {
  const whole = text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
  const newline = whole.includes('\r\n') ? '\r\n' : '\n';
  const body = whole.replace(LEAD, '');
  if (EMPTY_ROOT.test(body)) {
    return { entries: [], newline };
  }
  const open = ROOT_OPEN.exec(body);
  const close = ROOT_CLOSE.exec(body);
  if (open === null || close === null) {
    return undefined;
  }
  const inner = body.slice(open[0].length, close.index);
  const entries: DwsyncEntry[] = [];
  let at = 0;
  for (;;) {
    ELEMENT.lastIndex = at;
    const element = ELEMENT.exec(inner);
    if (element === null) {
      break;
    }
    const entry = toEntry(element[0]);
    if (entry === undefined) {
      return undefined;
    }
    entries.push(entry);
    at = ELEMENT.lastIndex;
  }
  return inner.slice(at).trim() === '' ? { entries, newline } : undefined;
}

/**
 * The text of a `dwsync.xml` as Dreamweaver writes it: the declaration, one
 * element per line, and no line end after the closing tag.
 *
 * @experimental
 */
export function serializeDwsync(document: DwsyncDocument): string {
  const lines = ['<?xml version="1.0" encoding="utf-8" ?>', '<dwsync>'];
  for (const entry of document.entries) {
    lines.push(['<file', ...entry.attributes.map(([name, value]) => `${name}="${escapeValue(value)}"`), '/>'].join(' '));
  }
  lines.push('</dwsync>');
  return lines.join(document.newline);
}

/**
 * True for `_notes/dwsync.xml` in any folder of a site. `target` is a
 * site-relative path with `/` between folders.
 *
 * @experimental
 */
export function isDwsyncPath(target: string, caseInsensitive: boolean): boolean {
  const path = caseInsensitive ? target.toLowerCase() : target;
  const file = `${NOTES_FOLDER}/${DWSYNC_FILE}`;
  return path === file || path.endsWith(`/${file}`);
}

/** A time in nanoseconds since 1970-01-01 UTC as a FILETIME. */
export function toFiletime(unixNanoseconds: bigint): bigint {
  return unixNanoseconds / 100n + UNIX_EPOCH;
}

/** A FILETIME as milliseconds since 1970-01-01 UTC, with the steps below a millisecond as a fraction. */
export function filetimeToMs(filetime: bigint): number {
  const steps = filetime - UNIX_EPOCH;
  return Number(steps / 10000n) + Number(steps % 10000n) / 10000;
}

function systemZoneOffset(atMs: number): number {
  return new Date(atMs).getTimezoneOffset();
}

/**
 * The daylight state Dreamweaver records with an entry: `1` in standard
 * time, `2` in daylight time, `0` where the time zone has no daylight time.
 * `zoneOffsetMinutes` gives the minutes a zone is behind UTC at a time, as
 * `Date.prototype.getTimezoneOffset` does; the default asks this computer.
 */
export function daylightState(atMs: number, zoneOffsetMinutes: (atMs: number) => number = systemZoneOffset): 0 | 1 | 2 {
  const year = new Date(atMs).getUTCFullYear();
  const january = zoneOffsetMinutes(Date.UTC(year, 0, 1));
  const july = zoneOffsetMinutes(Date.UTC(year, 6, 1));
  if (january === july) {
    return 0;
  }
  return zoneOffsetMinutes(atMs) === Math.min(january, july) ? 2 : 1;
}

/**
 * The name Dreamweaver gives a server in `dwsync.xml`: the one the server
 * sets, or the host, `/`, and the remote root ending in `/`, such as
 * `sftp.example.com//var/www/my-site/`. For a local or network folder it is
 * the folder with `/` between its parts and at its end.
 *
 * @experimental
 */
export function dreamweaverServerName(server: Pick<Server, 'protocol' | 'host' | 'remoteRoot'> & { readonly options: Pick<Server['options'], 'dreamweaverServer'> }): string {
  if (server.options.dreamweaverServer !== undefined) {
    return server.options.dreamweaverServer;
  }
  if (server.protocol === 'local') {
    return `${server.remoteRoot.replaceAll('\\', '/').replace(/\/+$/, '')}/`;
  }
  return `${server.host ?? ''}/${server.remoteRoot.replace(/\/+$/, '')}/`;
}

/** True when two Dreamweaver server names mean the same server: case and a final `/` do not count. */
export function sameServerName(a: string, b: string): boolean {
  const fold = (name: string): string => name.replace(/\/+$/, '').toLowerCase();
  return fold(a) === fold(b);
}
