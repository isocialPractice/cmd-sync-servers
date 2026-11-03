import type { App, Hint, View, ViewBody } from '../app.ts';
import { isKey, type Key } from '../keys.ts';
import { span } from '../style.ts';

/** Read-only text that scrolls, such as a diff. */
export class TextView implements View {
  readonly #title: string;
  readonly #lines: readonly string[];
  #offset = 0;
  #height = 10;

  constructor(title: string, lines: readonly string[]) {
    this.#title = title;
    this.#lines = lines;
  }

  title(): string {
    return this.#title;
  }

  hints(): readonly Hint[] {
    return [
      { key: 'Up/Down', label: 'Scroll' },
      { key: 'PgUp/PgDn', label: 'Page' },
      { key: 'Esc', label: 'Back' },
    ];
  }

  status(): string {
    return `Lines ${String(Math.min(this.#lines.length, this.#offset + 1))} to ${String(Math.min(this.#lines.length, this.#offset + this.#height))} of ${String(this.#lines.length)}`;
  }

  body(_width: number, height: number): ViewBody {
    this.#height = height;
    return {
      more: { above: this.#offset > 0, below: this.#offset + height < this.#lines.length },
      lines: this.#lines.slice(this.#offset, this.#offset + height).map((line) => {
        const tone = line.startsWith('+') && !line.startsWith('+++') ? 'accent' : line.startsWith('-') && !line.startsWith('---') ? 'warning' : undefined;
        return [span(` ${line}`, tone)];
      }),
    };
  }

  key(press: Key, app: App): void {
    const last = Math.max(0, this.#lines.length - this.#height);
    if (isKey(press, 'escape') || press.text === 'q') {
      app.pop();
    } else if (isKey(press, 'down') || press.text === 'j') {
      this.#offset = Math.min(last, this.#offset + 1);
    } else if (isKey(press, 'up') || press.text === 'k') {
      this.#offset = Math.max(0, this.#offset - 1);
    } else if (isKey(press, 'pagedown') || isKey(press, 'space')) {
      this.#offset = Math.min(last, this.#offset + this.#height - 1);
    } else if (isKey(press, 'pageup')) {
      this.#offset = Math.max(0, this.#offset - this.#height + 1);
    } else if (isKey(press, 'home')) {
      this.#offset = 0;
    } else if (isKey(press, 'end')) {
      this.#offset = last;
    }
  }
}
