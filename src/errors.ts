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

/** Options of a {@link SyncError}: the cause, and whether a retry may help. */
export interface SyncErrorOptions extends ErrorOptions {
  /** True when trying again, on a fresh connection, may succeed. */
  readonly transient?: boolean;
  /** The server's reply code, such as an FTP `550` or an SFTP status, when there is one. */
  readonly serverCode?: number;
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

  constructor(code: SyncErrorCode, message: string, options: SyncErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SyncError';
    this.code = code;
    this.transient = options.transient ?? false;
    this.serverCode = options.serverCode;
  }
}

/** True when `error` is a {@link SyncError}, optionally with the given code. */
export function isSyncError(error: unknown, code?: SyncErrorCode): error is SyncError {
  return error instanceof SyncError && (code === undefined || error.code === code);
}
