import { setTimeout as delay } from 'node:timers/promises';
import { SyncError } from '../errors.ts';

/**
 * Options of {@link withRetry}.
 *
 * @experimental
 */
export interface RetryOptions {
  /** Waits before each retry; the number of entries is the number of retries. Default 1, 2 and 4 seconds. */
  readonly delaysMs?: readonly number[];
  /** Stops waiting and retrying when aborted. */
  readonly signal?: AbortSignal | undefined;
  /** Called before each retry. */
  readonly onRetry?: (error: SyncError, retry: number, delayMs: number) => void;
}

/**
 * The waits before the first, second and third retry of a transient failure.
 *
 * @experimental
 */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000];

/** True for errors a fresh connection may get past: resets, timeouts, and FTP 421, 425, 426, 450 and 451. */
export function isTransient(error: unknown): error is SyncError {
  return error instanceof SyncError && error.transient;
}

/**
 * Runs `operation`, and runs it again after each transient failure, waiting
 * the given delays in between. Permanent failures are thrown at once.
 * `operation` receives the attempt number, starting at 0.
 *
 * @experimental
 */
export async function withRetry<T>(operation: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const delays = options.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      const wait = delays[attempt];
      if (!isTransient(error) || wait === undefined || options.signal?.aborted === true) {
        throw error;
      }
      options.onRetry?.(error, attempt + 1, wait);
      await delay(wait, undefined, { signal: options.signal }).catch(() => {
        throw error;
      });
    }
  }
}
