// Ported from kilo's rows (erow, editorInsertRow, editorDelRow,
// editorRowAppendString, editorInsertNewline, editorRowsToString) and
// editorMoveCursor (https://github.com/antirez/kilo, commit 323d93b2).
// Copyright (c) 2016, Salvatore Sanfilippo. BSD-2-Clause; see THIRD_PARTY_NOTICES.md.
import type { Key } from './keys.ts';

/**
 * A multi-line text buffer, as kilo keeps its rows, with a cursor and both
 * scroll offsets (`rowoff`, `coloff`). Used for pattern lists.
 */
export class TextArea {
  #rows: string[][];
  #row = 0;
  #col = 0;
  #rowOffset = 0;
  #colOffset = 0;

  constructor(text = '') {
    this.#rows = text === '' ? [[]] : text.split(/\r?\n/).map((line) => Array.from(line));
    if (this.#rows.length === 0) {
      this.#rows = [[]];
    }
  }

  /** editorRowsToString: the rows joined by newlines, trailing empty rows dropped. */
  get value(): string {
    const lines = this.#rows.map((row) => row.join(''));
    while (lines.length > 1 && lines[lines.length - 1] === '') {
      lines.pop();
    }
    return lines.join('\n');
  }

  get lines(): readonly string[] {
    return this.#rows.map((row) => row.join(''));
  }

  get position(): { row: number; col: number } {
    return { row: this.#row, col: this.#col };
  }

  #current(): string[] {
    const row = this.#rows[this.#row];
    if (row === undefined) {
      const created: string[] = [];
      this.#rows[this.#row] = created;
      return created;
    }
    return row;
  }

  /** editorInsertChar. */
  insert(text: string): void {
    for (const char of text) {
      if (char === '\n') {
        this.newline();
      } else {
        this.#current().splice(this.#col, 0, char);
        this.#col += 1;
      }
    }
  }

  /** editorInsertNewline: splits the row at the cursor. */
  newline(): void {
    const row = this.#current();
    const rest = row.splice(this.#col);
    this.#rows.splice(this.#row + 1, 0, rest);
    this.#row += 1;
    this.#col = 0;
  }

  /** editorDelChar: at the start of a row, joins it to the one above (editorRowAppendString, editorDelRow). */
  backspace(): void {
    if (this.#col > 0) {
      this.#current().splice(this.#col - 1, 1);
      this.#col -= 1;
      return;
    }
    if (this.#row === 0) {
      return;
    }
    const removed = this.#rows.splice(this.#row, 1)[0] ?? [];
    this.#row -= 1;
    const above = this.#current();
    this.#col = above.length;
    above.push(...removed);
  }

  /** editorMoveCursor: arrows move within and across rows; the column is clamped to the row. */
  move(direction: 'left' | 'right' | 'up' | 'down' | 'home' | 'end'): void {
    const length = (index: number): number => this.#rows[index]?.length ?? 0;
    switch (direction) {
      case 'left':
        if (this.#col > 0) {
          this.#col -= 1;
        } else if (this.#row > 0) {
          this.#row -= 1;
          this.#col = length(this.#row);
        }
        break;
      case 'right':
        if (this.#col < length(this.#row)) {
          this.#col += 1;
        } else if (this.#row < this.#rows.length - 1) {
          this.#row += 1;
          this.#col = 0;
        }
        break;
      case 'up':
        this.#row = Math.max(0, this.#row - 1);
        break;
      case 'down':
        this.#row = Math.min(this.#rows.length - 1, this.#row + 1);
        break;
      case 'home':
        this.#col = 0;
        break;
      case 'end':
        this.#col = length(this.#row);
        break;
    }
    this.#col = Math.min(this.#col, length(this.#row));
  }

  /** Handles an editing key; returns false for keys it does not use. */
  key(press: Key): boolean {
    if (press.ctrl || press.meta) {
      return false;
    }
    switch (press.name) {
      case 'left':
      case 'right':
      case 'up':
      case 'down':
      case 'home':
      case 'end':
        this.move(press.name);
        return true;
      case 'enter':
        this.newline();
        return true;
      case 'backspace':
        this.backspace();
        return true;
      default:
        if (press.text !== undefined) {
          this.insert(press.text);
          return true;
        }
        return false;
    }
  }

  /** The rows that fit `width` by `height`, scrolled to keep the cursor visible, and the cursor within them. */
  view(width: number, height: number): { lines: string[]; cursor: { row: number; col: number } } {
    if (this.#row < this.#rowOffset) {
      this.#rowOffset = this.#row;
    } else if (this.#row >= this.#rowOffset + height) {
      this.#rowOffset = this.#row - height + 1;
    }
    if (this.#col < this.#colOffset) {
      this.#colOffset = this.#col;
    } else if (this.#col > this.#colOffset + width - 1) {
      this.#colOffset = this.#col - width + 1;
    }
    const lines = this.#rows.slice(this.#rowOffset, this.#rowOffset + height).map((row) => row.slice(this.#colOffset, this.#colOffset + width).join(''));
    return { lines, cursor: { row: this.#row - this.#rowOffset, col: this.#col - this.#colOffset } };
  }
}
