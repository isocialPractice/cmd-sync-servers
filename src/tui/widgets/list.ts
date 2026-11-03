// Scrolling follows the rowoff handling of kilo's editorMoveCursor, and the
// filter its incremental editorFind (https://github.com/antirez/kilo, commit 323d93b2).
// Copyright (c) 2016, Salvatore Sanfilippo. BSD-2-Clause; see THIRD_PARTY_NOTICES.md.
import { isKey, type Key } from '../keys.ts';
import { TextField } from '../textfield.ts';

/**
 * A selectable list that scrolls to keep the selection in view, with a
 * filter typed after `/` that narrows the list as you type.
 */
export class ListState<T> {
  #items: readonly T[];
  readonly #text: (item: T) => string;
  readonly filter = new TextField();
  filtering = false;
  #index = 0;
  #offset = 0;

  constructor(items: readonly T[], text: (item: T) => string) {
    this.#items = items;
    this.#text = text;
  }

  get items(): readonly T[] {
    return this.#items;
  }

  set items(items: readonly T[]) {
    this.#items = items;
    this.#clamp();
  }

  /** The items that match the filter, ignoring case. */
  get visible(): readonly T[] {
    const query = this.filter.value.toLowerCase();
    return query === '' ? this.#items : this.#items.filter((item) => this.#text(item).toLowerCase().includes(query));
  }

  get index(): number {
    return this.#index;
  }

  get selected(): T | undefined {
    return this.visible[this.#index];
  }

  #clamp(): void {
    this.#index = Math.max(0, Math.min(this.#index, this.visible.length - 1));
  }

  /** Moves the selection to the first item that matches. */
  select(predicate: (item: T) => boolean): void {
    const found = this.visible.findIndex(predicate);
    if (found !== -1) {
      this.#index = found;
    }
  }

  move(delta: number): void {
    this.#index += delta;
    this.#clamp();
  }

  /** Handles moving and filtering keys; returns false for any other key. */
  key(press: Key, pageHeight: number): boolean {
    if (this.filtering) {
      if (isKey(press, 'enter') || isKey(press, 'down') || isKey(press, 'up')) {
        this.filtering = false;
        return isKey(press, 'enter') || this.key(press, pageHeight);
      }
      if (isKey(press, 'escape')) {
        this.filter.value = '';
        this.filtering = false;
      } else {
        this.filter.key(press);
        this.#index = 0;
      }
      this.#clamp();
      return true;
    }
    if (press.text === '/') {
      this.filtering = true;
      return true;
    }
    if (isKey(press, 'up') || press.text === 'k') {
      this.move(-1);
    } else if (isKey(press, 'down') || press.text === 'j') {
      this.move(1);
    } else if (isKey(press, 'pageup')) {
      this.move(-Math.max(1, pageHeight - 1));
    } else if (isKey(press, 'pagedown')) {
      this.move(Math.max(1, pageHeight - 1));
    } else if (isKey(press, 'home')) {
      this.#index = 0;
    } else if (isKey(press, 'end')) {
      this.#index = this.visible.length - 1;
      this.#clamp();
    } else if (isKey(press, 'escape') && this.filter.value !== '') {
      this.filter.value = '';
      this.#clamp();
    } else {
      return false;
    }
    return true;
  }

  /**
   * kilo's rowoff: the rows to draw in `height`, scrolled so the selection
   * is visible, and whether rows are hidden above and below them.
   */
  window(height: number): { start: number; items: readonly T[]; above: boolean; below: boolean } {
    const visible = this.visible;
    if (this.#index < this.#offset) {
      this.#offset = this.#index;
    } else if (this.#index >= this.#offset + height) {
      this.#offset = this.#index - height + 1;
    }
    this.#offset = Math.max(0, Math.min(this.#offset, Math.max(0, visible.length - height)));
    const items = visible.slice(this.#offset, this.#offset + height);
    return { start: this.#offset, items, above: this.#offset > 0, below: this.#offset + items.length < visible.length };
  }

  /** `/filter` while filtering or filtered, for a status line. */
  filterText(): string | undefined {
    return this.filtering || this.filter.value !== '' ? `/${this.filter.value}` : undefined;
  }
}
