import { isSyncError, type SyncErrorCode } from '../errors.ts';
import { ExitCode } from './exit-codes.ts';

/** A mistake in how the command was called. Exits with code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** The person cancelled a prompt. Exits with code 4. */
export class CancelledError extends Error {
  constructor(message = 'Cancelled.') {
    super(message);
    this.name = 'CancelledError';
  }
}

const GUARD_CODES: ReadonlySet<SyncErrorCode> = new Set([
  'E_HOST_KEY_MISMATCH',
  'E_INSECURE_PROTOCOL',
  'E_EMPTY_ROOT',
  'E_MASS_DELETE',
  'E_ROOT_DELETE',
]);

const USAGE_CODES: ReadonlySet<SyncErrorCode> = new Set(['E_SITE_NOT_FOUND', 'E_SERVER_NOT_FOUND']);

/** The exit code for an error thrown by a command. */
export function exitCodeFor(error: unknown): ExitCode {
  if (error instanceof UsageError) {
    return ExitCode.usage;
  }
  if (error instanceof CancelledError) {
    return ExitCode.cancelled;
  }
  if (isSyncError(error)) {
    if (GUARD_CODES.has(error.code)) {
      return ExitCode.guarded;
    }
    if (USAGE_CODES.has(error.code)) {
      return ExitCode.usage;
    }
  }
  return ExitCode.error;
}
