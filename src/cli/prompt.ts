import { CancelledError } from './errors.ts';
import type { CliInput, CliOutput } from './io.ts';

type Step = 'more' | 'done';

/**
 * Line prompts for the CLI, written to stderr so stdout stays clean for
 * output. Secrets are read with echo off and are never shown. One Prompter
 * owns stdin for the life of a command, so typed-ahead or piped answers are
 * never lost between questions.
 */
export class Prompter {
  readonly #input: CliInput;
  readonly #output: CliOutput;
  #buffer = '';
  #ended = false;
  #attached = false;
  #wake: (() => void) | undefined;
  #skipLineFeed = false;

  constructor(input: CliInput, output: CliOutput) {
    this.#input = input;
    this.#output = output;
  }

  readonly #onData = (chunk: Buffer | string): void => {
    this.#buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this.#wake?.();
  };

  readonly #onEnd = (): void => {
    this.#ended = true;
    this.#wake?.();
  };

  /** Releases stdin so the process can exit. */
  close(): void {
    if (this.#attached) {
      this.#input.off('data', this.#onData);
      this.#input.off('end', this.#onEnd);
      this.#input.pause();
      this.#attached = false;
    }
  }

  /** Reads characters until `consume` says done. Resolves false when input ended first. */
  async #read(consume: (char: string) => Step): Promise<boolean> {
    if (!this.#attached) {
      this.#input.on('data', this.#onData);
      this.#input.on('end', this.#onEnd);
      this.#attached = true;
    }
    this.#input.resume();
    try {
      for (;;) {
        while (this.#buffer.length > 0) {
          const char = String.fromCodePoint(this.#buffer.codePointAt(0) ?? 0);
          this.#buffer = this.#buffer.slice(char.length);
          if (this.#skipLineFeed && char === '\n') {
            this.#skipLineFeed = false;
            continue;
          }
          this.#skipLineFeed = char === '\r';
          if (consume(char) === 'done') {
            return true;
          }
        }
        if (this.#ended) {
          return false;
        }
        await new Promise<void>((resolve) => {
          this.#wake = resolve;
        });
        this.#wake = undefined;
      }
    } finally {
      this.#input.pause();
    }
  }

  async #line(): Promise<string | undefined> {
    let text = '';
    const complete = await this.#read((char) => {
      if (char === '\r' || char === '\n') {
        return 'done';
      }
      text += char;
      return 'more';
    });
    return complete || text !== '' ? text : undefined;
  }

  /** Asks a question and returns the trimmed answer, or `fallback` for an empty one. Throws {@link CancelledError} at end of input. */
  async ask(question: string, fallback?: string): Promise<string> {
    const hint = fallback === undefined || fallback === '' ? '' : ` [${fallback}]`;
    this.#output.write(`${question}${hint}: `);
    const answer = await this.#line();
    if (answer === undefined) {
      this.#output.write('\n');
      throw new CancelledError();
    }
    const trimmed = answer.trim();
    return trimmed === '' ? (fallback ?? '') : trimmed;
  }

  /** Asks until `check` accepts the answer; `check` returns an error message or undefined. */
  async askValid(question: string, check: (answer: string) => string | undefined, fallback?: string): Promise<string> {
    for (;;) {
      const answer = await this.ask(question, fallback);
      const problem = check(answer);
      if (problem === undefined) {
        return answer;
      }
      this.#output.write(`${problem}\n`);
    }
  }

  /** Asks a yes or no question. */
  async confirm(question: string, fallback = false): Promise<boolean> {
    for (;;) {
      const answer = (await this.ask(`${question} (${fallback ? 'Y/n' : 'y/N'})`)).toLowerCase();
      if (answer === '') {
        return fallback;
      }
      if (answer === 'y' || answer === 'yes') {
        return true;
      }
      if (answer === 'n' || answer === 'no') {
        return false;
      }
      this.#output.write('Answer y or n.\n');
    }
  }

  /** Offers numbered choices and returns the chosen value. */
  async choose<T>(question: string, choices: readonly { label: string; value: T }[], fallbackIndex = 0): Promise<T> {
    this.#output.write(`${question}\n`);
    choices.forEach((choice, index) => {
      this.#output.write(`  ${String(index + 1)}. ${choice.label}\n`);
    });
    for (;;) {
      const answer = await this.ask('Choose a number', String(fallbackIndex + 1));
      const index = Number(answer) - 1;
      const choice = Number.isInteger(index) ? choices[index] : undefined;
      if (choice !== undefined) {
        return choice.value;
      }
      this.#output.write(`Enter a number from 1 to ${String(choices.length)}.\n`);
    }
  }

  /**
   * Reads a secret with echo off. Backspace and Ctrl+U edit, Enter finishes,
   * Ctrl+C cancels. The value is never written anywhere.
   */
  async secret(question: string): Promise<string> {
    this.#output.write(question);
    const raw = this.#input.isTTY === true && typeof this.#input.setRawMode === 'function';
    if (raw) {
      this.#input.setRawMode?.(true);
    }
    // One entry per character as typed, so backspace removes a whole character.
    const typed: string[] = [];
    const state = { cancelled: false, inEscape: false };
    let complete: boolean;
    try {
      complete = await this.#read((char) => {
        if (state.inEscape) {
          // Skip the rest of an arrow-key or function-key sequence.
          state.inEscape = !/[A-Za-z~]/.test(char);
          return 'more';
        }
        if (char === '\r' || char === '\n') {
          return 'done';
        }
        if (char === '\u0003' || (char === '\u0004' && typed.length === 0)) {
          state.cancelled = true;
          return 'done';
        }
        if (char === '\u001b') {
          state.inEscape = true;
        } else if (char === '\u007f' || char === '\b') {
          typed.pop();
        } else if (char === '\u0015') {
          typed.length = 0;
        } else if (char >= ' ') {
          typed.push(char);
        }
        return 'more';
      });
    } finally {
      if (raw) {
        this.#input.setRawMode?.(false);
      }
      this.#output.write('\n');
    }
    if (state.cancelled || (!complete && typed.length === 0)) {
      throw new CancelledError();
    }
    return typed.join('');
  }
}
