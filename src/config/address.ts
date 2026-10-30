import { isIP, isIPv6 } from 'node:net';
import type { Protocol } from './schema.ts';

/** The parts of a server address found in the Host field. */
export interface ServerAddress {
  /** The host name or IP address, without brackets. */
  readonly host: string;
  /** The port, when the address names one. */
  readonly port?: number | undefined;
  /** The protocol, when the address starts with `sftp://`, `ftps://`, `ftpes://` or `ftp://`. */
  readonly protocol?: Exclude<Protocol, 'local'> | undefined;
  /** The user, when the address holds `user@`. */
  readonly username?: string | undefined;
  /** The folder after the host in an `sftp://` or `ftp://` address. */
  readonly remoteRoot?: string | undefined;
  /** Something to tell the person about how the address was read. */
  readonly note?: string | undefined;
  /** A port that is usually not FTP or SFTP, worth a question before it is used. */
  readonly warning?: string | undefined;
}

/** The result of {@link parseServerAddress}: the parts, or a problem to show. */
export type ServerAddressResult = { readonly ok: true; readonly address: ServerAddress } | { readonly ok: false; readonly problem: string };

const SCHEMES: Readonly<Record<string, Exclude<Protocol, 'local'>>> = {
  sftp: 'sftp',
  ftpes: 'ftps',
  // ftps:// means implicit TLS, as curl and most clients read it.
  ftps: 'ftps-implicit',
  ftp: 'ftps',
};

/** Ports that web control panels and web servers listen on. */
const WEB_PORTS: ReadonlySet<number> = new Set([80, 443, 2082, 2083, 2086, 2087, 2095, 2096, 8443]);

const WEB_ADDRESS = 'That is a web address. Enter the FTP or SFTP host your hosting panel shows, such as ftp.example.com.';
const HOST_NAME = /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?$/;

function fail(problem: string): ServerAddressResult {
  return { ok: false, problem };
}

function decode(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

function hostProblem(host: string): string | undefined {
  if (host === '') {
    return 'Enter the host, such as sftp.example.com.';
  }
  if (isIP(host) !== 0) {
    return undefined;
  }
  if (host.length > 253 || !HOST_NAME.test(host) || host.includes('..')) {
    return `"${host}" is not a host name or IP address.`;
  }
  return undefined;
}

function parsePort(text: string): number | string {
  if (!/^\d{1,5}$/.test(text) || Number(text) < 1 || Number(text) > 65535) {
    return 'The port must be a number from 1 to 65535.';
  }
  return Number(text);
}

/** Splits `host`, `host:port`, `[v6]`, `[v6]:port` or a bare IPv6 address. */
function splitHostPort(text: string): { host: string; port?: number } | string {
  if (text.startsWith('[')) {
    const close = text.indexOf(']');
    if (close === -1) {
      return 'An IPv6 address in brackets needs the closing "]".';
    }
    const host = text.slice(1, close);
    if (!isIPv6(host)) {
      return `"${host}" is not an IPv6 address.`;
    }
    const rest = text.slice(close + 1);
    if (rest === '') {
      return { host };
    }
    if (!rest.startsWith(':')) {
      return `Only a port may follow "[${host}]", as in [${host}]:2222.`;
    }
    const port = parsePort(rest.slice(1));
    return typeof port === 'string' ? port : { host, port };
  }
  const colons = text.split(':').length - 1;
  if (colons > 1) {
    return isIPv6(text) ? { host: text } : `"${text}" is not a host name or IP address. Write an IPv6 address with a port as [2001:db8::10]:2222.`;
  }
  if (colons === 1) {
    const at = text.indexOf(':');
    const port = parsePort(text.slice(at + 1));
    return typeof port === 'string' ? port : { host: text.slice(0, at), port };
  }
  return { host: text };
}

/**
 * Reads what a person typed in a Host field: a host name or IP address,
 * `host:port`, `[IPv6]:port`, `user@host` (split at the last `@`, so a user
 * such as `demo-user@example.com` works), or an `sftp://`, `ftpes://`,
 * `ftps://` or `ftp://` address with a user, port and folder. `ftp://` means
 * FTPS with explicit TLS: plain FTP is never chosen from an address.
 */
export function parseServerAddress(text: string): ServerAddressResult {
  const value = text.trim();
  if (value === '') {
    return fail('Enter the host, such as sftp.example.com.');
  }
  if (/\s/.test(value)) {
    return fail('A host has no spaces. Enter the host alone, such as sftp.example.com.');
  }
  let rest = value;
  let protocol: Exclude<Protocol, 'local'> | undefined;
  let note: string | undefined;
  let remoteRoot: string | undefined;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(value);
  if (scheme !== null) {
    const name = (scheme[1] ?? '').toLowerCase();
    if (name === 'http' || name === 'https') {
      return fail(WEB_ADDRESS);
    }
    protocol = SCHEMES[name];
    if (protocol === undefined) {
      return fail(`"${name}://" is not an address this tool connects to. Use sftp://, ftpes://, ftps:// or ftp://, or enter the host alone.`);
    }
    if (name === 'ftp') {
      note = 'An ftp:// address connects with FTPS (explicit TLS). Plain FTP, which sends the password in clear text, is chosen with --protocol ftp --allow-insecure.';
    }
    rest = value.slice(scheme[0].length);
    const slash = rest.indexOf('/');
    if (slash !== -1) {
      const folder = decode(rest.slice(slash).replace(/\/+$/, ''));
      if (folder === undefined) {
        return fail('The folder in the address is not valid.');
      }
      remoteRoot = folder === '' ? undefined : folder;
      rest = rest.slice(0, slash);
    }
  } else if (value.includes('/') || value.includes('\\')) {
    return fail(WEB_ADDRESS);
  }
  let username: string | undefined;
  const at = rest.lastIndexOf('@');
  if (at !== -1) {
    const user = decode(rest.slice(0, at));
    if (user === undefined || user === '') {
      return fail('Enter a user before the "@", or leave the user out.');
    }
    if (user.includes(':')) {
      return fail('Leave the password out of the address: it is asked for when connecting.');
    }
    username = user;
    rest = rest.slice(at + 1);
  }
  const split = splitHostPort(rest);
  if (typeof split === 'string') {
    return fail(split);
  }
  const problem = hostProblem(split.host);
  if (problem !== undefined) {
    return fail(problem);
  }
  const { port } = split;
  const warning =
    port !== undefined && WEB_PORTS.has(port) ? `Port ${String(port)} is usually a web control panel or web server, not FTP or SFTP.` : undefined;
  return { ok: true, address: { host: split.host, port, protocol, username, remoteRoot, note, warning } };
}

/**
 * Why a `host` value in `sites.json` is not a host alone, or `undefined` when
 * it is. A port, a user, a protocol or a folder each have their own field.
 */
export function hostFieldProblem(value: string): string | undefined {
  const parsed = parseServerAddress(value);
  if (!parsed.ok) {
    return parsed.problem;
  }
  const { address } = parsed;
  if (address.protocol !== undefined || address.remoteRoot !== undefined) {
    return 'Holds a whole address: keep the host name alone, such as sftp.example.com, and set "protocol", "port", "username" and "remoteRoot" on their own.';
  }
  if (address.username !== undefined) {
    return `Holds a user name: set "username": ${JSON.stringify(address.username)} and keep the host name alone.`;
  }
  if (address.port !== undefined) {
    return `Holds a port: set "port": ${String(address.port)} and keep the host name alone.`;
  }
  if (address.host !== value) {
    return `Write the IPv6 address without brackets: ${address.host}.`;
  }
  return undefined;
}
