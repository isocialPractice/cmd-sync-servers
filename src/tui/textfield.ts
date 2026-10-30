// Ported from kilo's row editing (editorRowInsertChar, editorRowDelChar,
// editorInsertChar, editorDelChar) and the horizontal part of
// editorMoveCursor (https://github.com/antirez/kilo, commit 323d93b2).
// Copyright (c) 2016, Salvatore Sanfilippo. BSD-2-Clause; see THIRD_PARTY_NOTICES.md.
import type { Key } from './keys.ts';

/**
 * A single-line text buffer with a cursor and a horizontal scroll offset, as
 * kilo keeps `cx` and `coloff` for one row. Characters are code points, so a
 * cursor never splits one. A masked field shows one `*` per character.
 */
export class TextField {
  #chars: string[];
  #cursor: number;
  #offset = 0;
  readonly masked: boolean;
  readonly maxLength: number;

  constructor(value = '', options: { masked?: boolean; maxLength?: number } = {}) {
    this.#chars = Array.from(value);
    this.#cursor = this.#chars.length;
    this.masked = options.masked ?? false;
    this.maxLength = options.maxLength ?? 4096;
  }

  get value(): string {
    return this.#chars.join('');
  }

  set value(text: string) {
    this.#chars = Array.from(text);
    this.#cursor = this.#chars.length;
    this.#offset = 0;
  }

  get cursor(): number {
    return this.#cursor;
  }

  /** editorRowInsertChar: inserts at the cursor and moves it right. */
  insert(text: string): void {
    for (const char of text) {
      if (this.#chars.length >= this.maxLength) {
        return;
      }
      this.#chars.splice(this.#cursor, 0, char);
      this.#cursor += 1;
    }
  }

  /** editorDelChar: removes the character before the cursor. */
  backspace(): void {
    if (this.#cursor > 0) {
      this.#chars.splice(this.#cursor - 1, 1);
      this.#cursor -= 1;
    }
  }

  /** editorRowDelChar: removes the character under the cursor. */
  deleteForward(): void {
    if (this.#cursor < this.#chars.length) {
      this.#chars.splice(this.#cursor, 1);
    }
  }

  move(to: number): void {
    this.#cursor = Math.max(0, Math.min(this.#chars.length, to));
  }

  /** Handles an editing key; returns false for keys it does not use. */
  key(press: Key): boolean {
    if (press.ctrl && press.name === 'u') {
      this.#chars = [];
      this.#cursor = 0;
      return true;
    }
    switch (press.name) {
      case 'left':
        this.move(this.#cursor - 1);
        return true;
      case 'right':
        this.move(this.#cursor + 1);
        return true;
      case 'home':
        this.move(0);
        return true;
      case 'end':
        this.move(this.#chars.length);
        return true;
      case 'backspace':
        this.backspace();
        return true;
      case 'delete':
        this.deleteForward();
        return true;
      default:
        if (press.text !== undefined && !press.ctrl && !press.meta) {
          this.insert(press.text);
          return true;
        }
        return false;
    }
  }

  /**
   * What fits in `width` columns, scrolled so the cursor stays visible
   * (kilo's `coloff`), and the cursor's column within it.
   */
  view(width: number): { text: string; cursor: number } {
    const room = Math.max(1, width - 1);
    if (this.#cursor < this.#offset) {
      this.#offset = this.#cursor;
    } else if (this.#cursor > this.#offset + room) {
      this.#offset = this.#cursor - room;
    }
    const shown = this.#chars.slice(this.#offset, this.#offset + width);
    return { text: this.masked ? '*'.repeat(shown.length) : shown.join(''), cursor: this.#cursor - this.#offset };
  }
}
