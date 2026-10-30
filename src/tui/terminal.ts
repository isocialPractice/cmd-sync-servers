// Ported from kilo's enableRawMode, disableRawMode, editorAtExit and window
// size handling (https://github.com/antirez/kilo, commit 323d93b2).
// Copyright (c) 2016, Salvatore Sanfilippo. BSD-2-Clause; see THIRD_PARTY_NOTICES.md.
import { emitKeypressEvents } from 'node:readline';
import { fromKeypress, type Key } from './keys.ts';

export interface TerminalInput {
  readonly isTTY?: boolean | undefined;
  setRawMode?(mode: boolean): unknown;
  on(event: 'keypress', listener: (text: string | undefined, press: unknown) => void): unknown;
  off(event: 'keypress', listener: (text: string | undefined, press: unknown) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

export interface TerminalOutput {
  write(text: string): unknown;
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
  on?(event: 'resize', listener: () => void): unknown;
  off?(event: 'resize', listener: () => void): unknown;
}

export interface TerminalOptions {
  /** Restore the terminal on process exit, signals and uncaught errors. On for the real terminal; off in tests. */
  readonly hookProcess?: boolean;
}

const ENTER_SCREEN = '\u001b[?1049h\u001b[H\u001b[2J\u001b[?25l';
const LEAVE_SCREEN = '\u001b[0m\u001b[?25h\u001b[?1049l';

/**
 * The terminal the UI owns while it runs: raw input, the alternate screen,
 * a hidden cursor, key and resize events. {@link stop} undoes all of it and
 * runs on every exit path, so a crash never leaves the shell in raw mode.
 */
export class Terminal {
  readonly #input: TerminalInput;
  readonly #output: TerminalOutput;
  readonly #hookProcess: boolean;
  #started = false;
  #onKey: ((key: Key) => void) | undefined;
  #onResize: (() => void) | undefined;

  constructor(input: TerminalInput, output: TerminalOutput, options: TerminalOptions = {}) {
    this.#input = input;
    this.#output = output;
    this.#hookProcess = options.hookProcess ?? false;
  }

  get started(): boolean {
    return this.#started;
  }

  size(): { columns: number; rows: number } {
    return { columns: Math.max(20, this.#output.columns ?? 80), rows: Math.max(8, this.#output.rows ?? 24) };
  }

  readonly #keypress = (text: string | undefined, press: unknown): void => {
    this.#onKey?.(fromKeypress(text, press as Parameters<typeof fromKeypress>[1]));
  };

  readonly #resize = (): void => {
    this.#onResize?.();
  };

  readonly #exit = (): void => {
    this.stop();
  };

  readonly #signal = (signal: NodeJS.Signals): void => {
    this.stop();
    process.kill(process.pid, signal);
  };

  readonly #crash = (error: unknown): void => {
    this.stop();
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  };

  start(onKey: (key: Key) => void, onResize: () => void): void {
    if (this.#started) {
      return;
    }
    if (this.#input.isTTY !== true || typeof this.#input.setRawMode !== 'function') {
      throw new Error('The terminal UI needs an interactive terminal. Use --plain or --preview none.');
    }
    this.#onKey = onKey;
    this.#onResize = onResize;
    if (this.#hookProcess) {
      process.once('exit', this.#exit);
      process.once('SIGTERM', this.#signal);
      process.once('SIGHUP', this.#signal);
      process.once('uncaughtException', this.#crash);
      process.once('unhandledRejection', this.#crash);
      emitKeypressEvents(this.#input as NodeJS.ReadableStream);
    }
    this.#input.setRawMode(true);
    this.#input.on('keypress', this.#keypress);
    this.#input.resume();
    this.#output.on?.('resize', this.#resize);
    this.#output.write(ENTER_SCREEN);
    this.#started = true;
  }

  write(text: string): void {
    this.#output.write(text);
  }

  /** Restores the terminal. Safe to call more than once, and from any exit path. */
  stop(): void {
    if (!this.#started) {
      return;
    }
    this.#started = false;
    try {
      this.#output.write(LEAVE_SCREEN);
    } finally {
      this.#input.off('keypress', this.#keypress);
      this.#output.off?.('resize', this.#resize);
      this.#input.setRawMode?.(false);
      this.#input.pause();
      if (this.#hookProcess) {
        process.off('exit', this.#exit);
        process.off('SIGTERM', this.#signal);
        process.off('SIGHUP', this.#signal);
        process.off('uncaughtException', this.#crash);
        process.off('unhandledRejection', this.#crash);
      }
    }
  }
}
