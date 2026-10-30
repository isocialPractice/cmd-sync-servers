import { SyncError } from '../errors.ts';
import { childPath, type RemotePath } from '../sync/paths.ts';
import { safeText } from '../terminal-text.ts';
import type { EntryType, RemoteEntry } from './types.ts';

/** The message of an error from a library or a server, with control characters escaped: servers write the text. */
export function errorMessage(error: unknown): string {
  return safeText(error instanceof Error ? error.message : String(error));
}

function nodeCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

/** Network failures that a fresh connection may get past. */
const TRANSIENT_NETWORK = new Set(['ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']);

const TLS_CERT = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|ALTNAME|HOSTNAME_MISMATCH|INVALID_CA/;

/** True when a Node.js error comes from verifying a TLS certificate. */
export function isCertificateError(error: unknown): boolean {
  const code = nodeCode(error);
  return code !== undefined && TLS_CERT.test(code);
}

/** Where a connection was going, for messages that name the host and port. */
export interface ConnectionTarget {
  readonly host: string;
  readonly port: number;
}

const HOST_NOT_FOUND = new Set(['ENOTFOUND', 'EAI_NONAME', 'EAI_NODATA']);

/**
 * Turns a network-level error into a {@link SyncError}: certificate problems
 * become `E_TLS_CERT`, resets and timeouts transient `E_CONNECTION`. With a
 * target, a host that does not exist and a refused connection get messages
 * that say what to check instead of the library's text.
 */
export function networkError(error: unknown, what: string, target?: ConnectionTarget): SyncError {
  if (error instanceof SyncError) {
    return error;
  }
  const code = nodeCode(error);
  if (isCertificateError(error)) {
    return new SyncError('E_TLS_CERT', `${what}: the server's certificate was not accepted (${code ?? 'unknown'}): ${errorMessage(error)}`, { cause: error });
  }
  if (target !== undefined && code !== undefined && HOST_NOT_FOUND.has(code)) {
    return new SyncError(
      'E_CONNECTION',
      `The host ${safeText(target.host)} was not found. Check the spelling against the FTP or SFTP host your hosting panel shows.`,
      { cause: error },
    );
  }
  if (target !== undefined && code === 'ECONNREFUSED') {
    return new SyncError(
      'E_CONNECTION',
      `${safeText(target.host)} refused the connection on port ${String(target.port)}. Check the protocol and port: SFTP usually uses 22, FTPS 21, implicit FTPS 990.`,
      { cause: error, transient: true },
    );
  }
  if (code !== undefined && TRANSIENT_NETWORK.has(code)) {
    return new SyncError('E_CONNECTION', `${what}: ${errorMessage(error)}`, { cause: error, transient: true });
  }
  return new SyncError('E_CONNECTION', `${what}: ${errorMessage(error)}`, {
    cause: error,
    transient: /timeout|timed out|socket hang up|closed|no response from server|not connected|connection lost|ended by other party/i.test(errorMessage(error)),
  });
}

/** `css/, images/ and js/`: the first five folder names, then `and N more`. */
export function folderList(folders: readonly string[]): string {
  const shown = folders.slice(0, 5).map((name) => `${safeText(name)}/`);
  const more = folders.length - shown.length;
  if (more > 0) {
    return `${shown.join(', ')} and ${String(more)} more`;
  }
  return shown.length <= 1 ? (shown[0] ?? '') : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1) ?? ''}`;
}

/**
 * `E_REMOTE_ROOT` for a remote root that is missing or not a folder, naming
 * the folder the account opens in and what it holds, so the right root can
 * be picked from what the server shows.
 */
export function remoteRootError(
  root: string,
  host: string,
  found: { readonly startingFolder?: string | undefined; readonly folders?: readonly string[] | undefined },
  serverName: string | undefined,
  options: { readonly cause?: unknown; readonly notAFolder?: boolean } = {},
): SyncError {
  const { startingFolder } = found;
  const folders = (found.folders ?? []).slice(0, 50);
  const where =
    startingFolder === undefined
      ? ''
      : ` This account opens in "${safeText(startingFolder)}", which holds ${folders.length === 0 ? 'no folders' : folderList(folders)}.`;
  const server = serverName === undefined ? '' : ` ${/^[\w.-]+$/.test(serverName) ? serverName : JSON.stringify(serverName)}`;
  const what = options.notAFolder === true ? `on ${safeText(host)} is not a folder` : `was not found on ${safeText(host)}`;
  return new SyncError('E_REMOTE_ROOT', `The remote root ${safeText(root)} ${what}.${where} Choose the root with "sync-servers server edit${server}", or pass --remote-root.`, {
    cause: options.cause,
    details: { ...(startingFolder === undefined ? {} : { startingFolder }), folders },
  });
}

/** Rejects with a transient `E_TIMEOUT` when `promise` takes longer than `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, what: string, onTimeout?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new SyncError('E_TIMEOUT', `${what} took longer than ${String(Math.round(ms / 1000))} s.`, { transient: true }));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Throws a cancellation error when `signal` has been aborted. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new SyncError('E_CANCELLED', 'Cancelled.');
  }
}

/** Builds a {@link RemoteEntry} for `name` in `dir`, validating the name. */
export function makeEntry(
  dir: RemotePath,
  name: string,
  type: EntryType,
  size: number,
  mtimeMs: number | undefined,
  platform: NodeJS.Platform,
): RemoteEntry {
  const checked = childPath(dir, name, platform);
  return {
    name,
    path: checked.ok ? checked.path : undefined,
    unsafe: checked.ok ? undefined : checked.reason,
    type,
    size,
    mtimeMs,
  };
}

/** Refuses a listing with more entries than `limit`. */
export function checkListingLimit(count: number, limit: number, where: string): void {
  if (count > limit) {
    throw new SyncError('E_LISTING_LIMIT', `${where} holds more than ${String(limit)} entries; listing it was stopped.`);
  }
}
