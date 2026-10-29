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
  | 'E_LOCKED';

/**
 * The error type of the engine. `code` is stable across versions; `message`
 * is written for people and never contains a secret.
 */
export class SyncError extends Error {
  readonly code: SyncErrorCode;

  constructor(code: SyncErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SyncError';
    this.code = code;
  }
}

/** True when `error` is a {@link SyncError}, optionally with the given code. */
export function isSyncError(error: unknown, code?: SyncErrorCode): error is SyncError {
  return error instanceof SyncError && (code === undefined || error.code === code);
}
