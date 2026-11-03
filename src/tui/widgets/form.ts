import type { ViewBody } from '../app.ts';
import { isKey, type Key } from '../keys.ts';
import { span, symbols, type Line, type Theme } from '../style.ts';
import { TextArea } from '../textarea.ts';
import { TextField } from '../textfield.ts';
import { padEnd, textWidth, truncate } from '../text.ts';

interface Base {
  readonly id: string;
  readonly label: string;
  /** Shown in the message bar while the field has focus. */
  readonly help?: string;
}

export interface TextInput extends Base {
  readonly kind: 'text';
  readonly field: TextField;
}

export interface Toggle extends Base {
  readonly kind: 'toggle';
  value: boolean;
}

export interface Choice extends Base {
  readonly kind: 'choice';
  readonly options: readonly { readonly label: string; readonly value: string }[];
  index: number;
}

export interface Lines extends Base {
  readonly kind: 'lines';
  readonly area: TextArea;
  readonly height: number;
}

export interface Button extends Base {
  readonly kind: 'action';
}

export interface Note extends Base {
  readonly kind: 'note';
  text: string;
}

export type FormField = TextInput | Toggle | Choice | Lines | Button | Note;

export const field = {
  text: (id: string, label: string, value = '', options: { masked?: boolean; help?: string } = {}): TextInput => ({
    kind: 'text',
    id,
    label,
    field: new TextField(value, { masked: options.masked ?? false }),
    ...(options.help === undefined ? {} : { help: options.help }),
  }),
  toggle: (id: string, label: string, value: boolean, help?: string): Toggle => ({ kind: 'toggle', id, label, value, ...(help === undefined ? {} : { help }) }),
  choice: (id: string, label: string, options: readonly { label: string; value: string }[], value: string, help?: string): Choice => ({
    kind: 'choice',
    id,
    label,
    options,
    index: Math.max(0, options.findIndex((option) => option.value === value)),
    ...(help === undefined ? {} : { help }),
  }),
  lines: (id: string, label: string, value: string, height: number, help?: string): Lines => ({
    kind: 'lines',
    id,
    label,
    area: new TextArea(value),
    height,
    ...(help === undefined ? {} : { help }),
  }),
  action: (id: string, label: string, help?: string): Button => ({ kind: 'action', id, label, ...(help === undefined ? {} : { help }) }),
  note: (id: string, label: string, text: string): Note => ({ kind: 'note', id, label, text }),
};

export interface FormResult {
  readonly handled: boolean;
  /** The id of an action field activated with Enter. */
  readonly action?: string;
  /** True when a value changed. */
  readonly changed?: boolean;
}

/**
 * Labelled fields in one column: Up and Down move between them, text fields
 * edit in place, Space toggles, Left and Right change a choice, Enter runs an
 * action. Every field has a visible label; problems show under their field.
 */
export class Form {
  readonly fields: FormField[];
  #focus = 0;
  #offset = 0;
  readonly #errors = new Map<string, string>();

  constructor(fields: FormField[]) {
    this.fields = fields;
    this.#focus = Math.max(0, fields.findIndex((item) => item.kind !== 'note'));
  }

  get focused(): FormField | undefined {
    return this.fields[this.#focus];
  }

  focusOn(id: string): void {
    const index = this.fields.findIndex((item) => item.id === id);
    if (index !== -1) {
      this.#focus = index;
    }
  }

  get(id: string): FormField | undefined {
    return this.fields.find((item) => item.id === id);
  }

  text(id: string): string {
    const item = this.get(id);
    if (item?.kind === 'text') {
      return item.field.value.trim();
    }
    return item?.kind === 'lines' ? item.area.value : '';
  }

  toggle(id: string): boolean {
    const item = this.get(id);
    return item?.kind === 'toggle' && item.value;
  }

  choice(id: string): string {
    const item = this.get(id);
    return item?.kind === 'choice' ? (item.options[item.index]?.value ?? '') : '';
  }

  setError(id: string, message: string | undefined): void {
    if (message === undefined) {
      this.#errors.delete(id);
    } else {
      this.#errors.set(id, message);
    }
  }

  clearErrors(): void {
    this.#errors.clear();
  }

  get errors(): ReadonlyMap<string, string> {
    return this.#errors;
  }

  /** True while the focused field takes typed text. */
  capturesText(): boolean {
    const focused = this.focused;
    return focused?.kind === 'text' || focused?.kind === 'lines';
  }

  /** The help of the focused field, or its problem. */
  status(): string | undefined {
    const focused = this.focused;
    if (focused === undefined) {
      return undefined;
    }
    return this.#errors.get(focused.id) ?? focused.help;
  }

  #step(delta: number): boolean {
    for (let index = this.#focus + delta; index >= 0 && index < this.fields.length; index += delta) {
      if (this.fields[index]?.kind !== 'note') {
        this.#focus = index;
        return true;
      }
    }
    return false;
  }

  key(press: Key): FormResult {
    const focused = this.focused;
    if (focused === undefined) {
      return { handled: false };
    }
    if (focused.kind === 'lines') {
      const { row } = focused.area.position;
      const last = focused.area.lines.length - 1;
      if ((isKey(press, 'up') && row === 0) || (isKey(press, 'down') && row >= last)) {
        return { handled: this.#step(isKey(press, 'up') ? -1 : 1) };
      }
      return focused.area.key(press) ? { handled: true, changed: !['left', 'right', 'up', 'down', 'home', 'end'].includes(press.name) } : { handled: false };
    }
    if (isKey(press, 'up')) {
      return { handled: this.#step(-1) };
    }
    if (isKey(press, 'down')) {
      return { handled: this.#step(1) };
    }
    switch (focused.kind) {
      case 'text':
        if (isKey(press, 'enter')) {
          return { handled: this.#step(1) };
        }
        return focused.field.key(press) ? { handled: true, changed: !['left', 'right', 'home', 'end'].includes(press.name) } : { handled: false };
      case 'toggle':
        if (isKey(press, 'space') || isKey(press, 'enter')) {
          focused.value = !focused.value;
          return { handled: true, changed: true };
        }
        return { handled: false };
      case 'choice':
        if (isKey(press, 'left') || isKey(press, 'right') || isKey(press, 'space') || isKey(press, 'enter')) {
          const delta = isKey(press, 'left') ? -1 : 1;
          focused.index = (focused.index + delta + focused.options.length) % focused.options.length;
          return { handled: true, changed: true };
        }
        return { handled: false };
      case 'action':
        return isKey(press, 'enter') || isKey(press, 'space') ? { handled: true, action: focused.id } : { handled: false };
      default:
        return { handled: false };
    }
  }

  /** The columns values need: a choice its longest option, a text field room to type. */
  #valueRoom(): number {
    return Math.max(
      3,
      ...this.fields.map((item) => {
        switch (item.kind) {
          case 'choice':
            return Math.max(...item.options.map((option) => textWidth(option.label))) + 4;
          case 'text':
          case 'lines':
            return 16;
          default:
            return 3;
        }
      }),
    );
  }

  render(width: number, height: number, theme: Theme, active: boolean): ViewBody {
    const sym = symbols(theme);
    const longest = Math.max(0, ...this.fields.filter((item) => item.kind !== 'action').map((item) => textWidth(item.label)));
    const labelWidth = Math.min(longest, Math.max(8, width - 4 - this.#valueRoom()));
    const valueWidth = Math.max(8, width - labelWidth - 4);
    const rows: { line: Line; field: number; cursor?: number }[] = [];
    this.fields.forEach((item, index) => {
      const focused = active && index === this.#focus;
      const tone = focused ? 'focus' : undefined;
      const label = span(`  ${padEnd(truncate(item.label, labelWidth, sym.ellipsis), labelWidth)}  `, focused ? 'bold' : undefined);
      switch (item.kind) {
        case 'text': {
          const view = item.field.view(valueWidth);
          rows.push({ line: [label, span(padEnd(view.text, Math.min(valueWidth, Math.max(textWidth(view.text) + 1, 12))), tone)], field: index, ...(focused ? { cursor: labelWidth + 4 + view.cursor } : {}) });
          break;
        }
        case 'toggle':
          rows.push({ line: [label, span(item.value ? sym.checked : sym.unchecked, tone)], field: index });
          break;
        case 'choice':
          rows.push({ line: [label, span(`< ${item.options[item.index]?.label ?? ''} >`, tone)], field: index });
          break;
        case 'note':
          rows.push({ line: [label, span(truncate(item.text, valueWidth, sym.ellipsis), 'dim')], field: index });
          break;
        case 'action':
          rows.push({ line: [span('  '), span(`[ ${item.label} ]`, focused ? 'focus' : 'accent')], field: index });
          break;
        case 'lines': {
          rows.push({ line: [label], field: index });
          const view = item.area.view(valueWidth, item.height);
          for (let line = 0; line < item.height; line += 1) {
            rows.push({
              line: [span(`  ${' '.repeat(labelWidth)}  `), span(padEnd(view.lines[line] ?? '', valueWidth), focused ? 'focus' : 'dim')],
              field: index,
              ...(focused && line === view.cursor.row ? { cursor: labelWidth + 4 + view.cursor.col } : {}),
            });
          }
          break;
        }
      }
      const problem = this.#errors.get(item.id);
      if (problem !== undefined) {
        rows.push({ line: [span(`  ${' '.repeat(labelWidth)}  `), span(`! ${truncate(problem, valueWidth - 2, sym.ellipsis)}`, 'warning')], field: index });
      }
    });
    const focusRows = rows.map((row, index) => (row.field === this.#focus ? index : -1)).filter((index) => index !== -1);
    const first = focusRows[0] ?? 0;
    const lastRow = focusRows[focusRows.length - 1] ?? 0;
    if (first < this.#offset) {
      this.#offset = first;
    } else if (lastRow >= this.#offset + height) {
      this.#offset = lastRow - height + 1;
    }
    const shown = rows.slice(this.#offset, this.#offset + height);
    const cursorIndex = shown.findIndex((row) => row.cursor !== undefined);
    const cursorRow = shown[cursorIndex];
    return {
      lines: shown.map((row) => row.line),
      cursor: active && cursorRow?.cursor !== undefined ? { row: cursorIndex, col: cursorRow.cursor } : undefined,
      more: { above: this.#offset > 0, below: this.#offset + shown.length < rows.length },
    };
  }
}
