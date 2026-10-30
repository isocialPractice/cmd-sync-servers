import { silentLogger, type Logger } from '../log/logger.ts';
import { withRetry, isTransient, type RetryOptions } from './retry.ts';
import type { Capabilities, Transport } from './types.ts';

export interface PoolOptions {
  /** The most operations at once. */
  readonly size: number;
  /**
   * True when one connection serves every operation at once, as SFTP does
   * with its requests on one SSH connection; false when each operation needs
   * its own connection, as FTP does.
   */
  readonly shared: boolean;
  readonly logger?: Logger;
}

interface Slot {
  transport: Transport;
  ready: Promise<Capabilities>;
}

/**
 * Hands out connected transports. A connection that fails with a transient
 * error is dropped, so the next operation gets a fresh one. An FTP server
 * that answers 421 (too many connections) shrinks the pool for the rest of
 * the run.
 */
export class TransportPool {
  readonly #factory: () => Transport;
  readonly #shared: boolean;
  readonly #logger: Logger;
  #limit: number;
  #idle: Slot[] = [];
  #busy = 0;
  #sharedSlot: Slot | undefined;
  #waiting: (() => void)[] = [];
  #closed = false;

  constructor(factory: () => Transport, options: PoolOptions) {
    this.#factory = factory;
    this.#shared = options.shared;
    this.#limit = Math.max(1, options.size);
    this.#logger = options.logger ?? silentLogger;
  }

  /** The most operations the pool runs at once now. */
  get limit(): number {
    return this.#limit;
  }

  #open(signal?: AbortSignal): Slot {
    const transport = this.#factory();
    return { transport, ready: transport.connect(signal) };
  }

  async #acquire(signal?: AbortSignal): Promise<Slot> {
    while (this.#busy >= this.#limit) {
      await new Promise<void>((resolve) => this.#waiting.push(resolve));
    }
    this.#busy += 1;
    if (this.#shared) {
      this.#sharedSlot ??= this.#open(signal);
      return this.#sharedSlot;
    }
    return this.#idle.pop() ?? this.#open(signal);
  }

  #release(slot: Slot, broken: boolean): void {
    this.#busy -= 1;
    if (broken) {
      if (this.#sharedSlot === slot) {
        this.#sharedSlot = undefined;
      }
      void slot.transport.close();
    } else if (!this.#shared) {
      if (this.#closed) {
        void slot.transport.close();
      } else {
        this.#idle.push(slot);
      }
    }
    this.#waiting.shift()?.();
  }

  /** Runs `operation` on a connected transport. */
  async run<T>(operation: (transport: Transport) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const slot = await this.#acquire(signal);
    // A connection that never opened is never reused; one that failed transiently is replaced.
    let connected = false;
    let broken = true;
    try {
      await slot.ready;
      connected = true;
      const result = await operation(slot.transport);
      broken = false;
      return result;
    } catch (error) {
      broken = !connected || isTransient(error);
      if (isTransient(error) && error.serverCode === 421 && !this.#shared && this.#limit > 1) {
        this.#limit -= 1;
        this.#logger.warn('The server refused another connection (421); using fewer connections for the rest of the run.', { connections: this.#limit });
      }
      throw error;
    } finally {
      this.#release(slot, broken);
    }
  }

  /** {@link run} with retries after transient failures, each on a fresh connection. */
  runWithRetry<T>(operation: (transport: Transport) => Promise<T>, options: RetryOptions = {}): Promise<T> {
    return withRetry(() => this.run(operation, options.signal), options);
  }

  async close(): Promise<void> {
    this.#closed = true;
    const slots = [...this.#idle, ...(this.#sharedSlot === undefined ? [] : [this.#sharedSlot])];
    this.#idle = [];
    this.#sharedSlot = undefined;
    await Promise.all(slots.map((slot) => slot.transport.close()));
  }
}
