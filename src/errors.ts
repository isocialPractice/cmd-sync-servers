import type { CertificateInfo } from './host.ts';

/** Stable codes carried by every {@link SyncError}. */
export type SyncErrorCode =
  | 'E_HOST_KEY_MISMATCH'
  | 'E_TLS_CERT'
  | 'E_INSECURE_PROTOCOL'
  | 'E_AUTH'
  | 'E_PATH_UNSAFE'
  | 'E_MASS_DELETE'
  | 'E_EMPTY_ROOT'
  | 'E_STALE_ITEM'
  | 'E_CONFIG_INVALID'
  | 'E_SITE_NOT_FOUND'
  | 'E_SERVER_NOT_FOUND'
  | 'E_CREDENTIAL_STORE'
  | 'E_LOCKED'
  | 'E_CONNECTION'
  | 'E_TIMEOUT'
  | 'E_REMOTE'
  | 'E_REMOTE_ROOT'
  | 'E_LISTING_LIMIT'
  | 'E_ROOT_DELETE'
  | 'E_PLAN_INVALID'
  | 'E_CANCELLED';

/**
 * Facts about an error that a program can act on, beyond its code. Never
 * holds a secret.
 */
export interface SyncErrorDetails {
  /** `E_AUTH`: the server refused the sign-in, no source had a secret, or a saved secret was not sent because the server changed. */
  readonly reason?: 'rejected' | 'missing' | 'saved-for-elsewhere';
  /** `E_TLS_CERT`: the certificate that did not verify. */
  readonly certificate?: CertificateInfo;
  /** `E_REMOTE_ROOT`: the folder the account opens in after signing in. */
  readonly startingFolder?: string;
  /** `E_REMOTE_ROOT`: up to 50 folder names in the starting folder. */
  readonly folders?: readonly string[];
}

/** Options of a {@link SyncError}: the cause, and whether a retry may help. */
export interface SyncErrorOptions extends ErrorOptions {
  /** True when trying again, on a fresh connection, may succeed. */
  readonly transient?: boolean;
  /** The server's reply code, such as an FTP `550` or an SFTP status, when there is one. */
  readonly serverCode?: number;
  /** Facts a program can act on, such as why a sign-in failed. */
  readonly details?: SyncErrorDetails;
}

/**
 * The error type of the engine. `code` is stable across versions; `message`
 * is written for people and never contains a secret.
 */
export class SyncError extends Error {
  /** What went wrong, stable across versions, for programs to act on. */
  readonly code: SyncErrorCode;
  /** True when trying again, on a fresh connection, may succeed. */
  readonly transient: boolean;
  /** The server's reply code, when the server gave one. */
  readonly serverCode: number | undefined;
  /** Facts a program can act on, such as why a sign-in failed or which certificate did not verify. */
  readonly details: SyncErrorDetails | undefined;

  constructor(code: SyncErrorCode, message: string, options: SyncErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SyncError';
    this.code = code;
    this.transient = options.transient ?? false;
    this.serverCode = options.serverCode;
    this.details = options.details;
  }
}

/** True when `error` is a {@link SyncError}, optionally with the given code. */
export function isSyncError(error: unknown, code?: SyncErrorCode): error is SyncError {
  return error instanceof SyncError && (code === undefined || error.code === code);
}
