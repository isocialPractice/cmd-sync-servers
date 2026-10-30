import { Transform, type TransformCallback, type Writable } from 'node:stream';
import { SyncError } from '../errors.ts';

function stalled(what: string, ms: number): SyncError {
  return new SyncError('E_TIMEOUT', `${what} stalled: no data moved for ${String(Math.round(ms / 1000))} s.`, { transient: true });
}

/**
 * A pass-through stream that fails with a transient `E_TIMEOUT` when no data
 * has moved for `ms` milliseconds, so a stalled download is aborted and can be
 * retried. Backpressure counts as no movement, so it also catches a receiver
 * that stopped reading.
 */
export class StallGuard extends Transform {
  readonly #ms: number;
  readonly #what: string;
  #timer: NodeJS.Timeout | undefined;

  constructor(ms: number, what: string) {
    super();
    this.#ms = ms;
    this.#what = what;
    this.#arm();
  }

  #arm(): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.destroy(stalled(this.#what, this.#ms));
    }, this.#ms);
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.#arm();
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    clearTimeout(this.#timer);
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    clearTimeout(this.#timer);
    callback(error);
  }
}

/**
 * Destroys `stream` with a transient `E_TIMEOUT` when its `bytesWritten`
 * stops growing for `ms` milliseconds before it finishes. Catches an upload
 * whose writes the server never acknowledges, which a pass-through guard
 * cannot see once the source has ended.
 */
export function watchUpload(stream: Writable & { readonly bytesWritten?: number }, ms: number, what: string): void {
  let last = -1;
  let idle = 0;
  const step = Math.max(50, Math.floor(ms / 4));
  const timer = setInterval(() => {
    const now = stream.bytesWritten ?? 0;
    idle = now === last ? idle + step : 0;
    last = now;
    if (idle >= ms) {
      stop();
      stream.destroy(stalled(what, ms));
    }
  }, step);
  const stop = (): void => {
    clearInterval(timer);
  };
  stream.once('close', stop);
  stream.once('finish', stop);
  stream.once('error', stop);
}
