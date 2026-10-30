import { SyncError } from '../errors.ts';
import { childPath, type RemotePath } from '../sync/paths.ts';
import type { EntryType, RemoteEntry } from './types.ts';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/**
 * Turns a network-level error into a {@link SyncError}: certificate problems
 * become `E_TLS_CERT`, resets and timeouts transient `E_CONNECTION`.
 */
export function networkError(error: unknown, what: string): SyncError {
  if (error instanceof SyncError) {
    return error;
  }
  const code = nodeCode(error);
  if (isCertificateError(error)) {
    return new SyncError('E_TLS_CERT', `${what}: the server's certificate was not accepted (${code ?? 'unknown'}): ${errorMessage(error)}`, { cause: error });
  }
  if (code !== undefined && TRANSIENT_NETWORK.has(code)) {
    return new SyncError('E_CONNECTION', `${what}: ${errorMessage(error)}`, { cause: error, transient: true });
  }
  return new SyncError('E_CONNECTION', `${what}: ${errorMessage(error)}`, {
    cause: error,
    transient: /timeout|timed out|socket hang up|closed|no response from server|not connected|connection lost|ended by other party/i.test(errorMessage(error)),
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
