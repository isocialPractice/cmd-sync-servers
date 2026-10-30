import type { Dialog, Hint, ViewBody } from '../app.ts';
import { isKey, type Key } from '../keys.ts';
import { span, symbols, type Line } from '../style.ts';
import { TextField } from '../textfield.ts';
import { textWidth } from '../text.ts';

/** Wraps text to `width` columns at spaces. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      if (line !== '' && textWidth(line) + 1 + textWidth(word) > width) {
        lines.push(line);
        line = word;
      } else {
        line = line === '' ? word : `${line} ${word}`;
      }
    }
    lines.push(line);
  }
  return lines;
}

function buttons(labels: readonly string[], focus: number): Line {
  const parts: Line[number][] = [];
  labels.forEach((label, index) => {
    if (index > 0) {
      parts.push(span('  '));
    }
    parts.push(span(`[ ${label} ]`, index === focus ? 'focus' : undefined));
  });
  return parts;
}

/** Yes or no, with the safe answer focused unless `defaultYes`. */
export function confirmDialog(title: string, message: string, options: { yes?: string; no?: string; defaultYes?: boolean } = {}): Dialog<boolean> {
  const labels = [options.yes ?? 'Yes', options.no ?? 'Cancel'];
  let focus = options.defaultYes === true ? 0 : 1;
  return {
    title,
    render: (width) => ({ lines: [...wrap(message, width).map((text) => [span(text)]), [], buttons(labels, focus)] }),
    key: (press, close) => {
      if (isKey(press, 'left') || isKey(press, 'right') || isKey(press, 'tab') || isKey(press, 'shift+tab')) {
        focus = 1 - focus;
      } else if (isKey(press, 'enter')) {
        close(focus === 0);
      } else if (isKey(press, 'escape') || press.text === 'n') {
        close(false);
      } else if (press.text === 'y') {
        close(true);
      }
    },
  };
}

/** One of several options, chosen with the arrows and Enter; Esc gives `cancel`. */
export function choiceDialog<T>(title: string, message: string, options: readonly { label: string; value: T }[], cancel: T, initial = 0): Dialog<T> {
  let focus = initial;
  return {
    title,
    render: (width, theme) => ({
      lines: [
        ...wrap(message, width).map((text) => [span(text)]),
        [],
        ...options.map((option, index): Line => [
          span(index === focus ? `${symbols(theme).pointer} ` : '  '),
          span(option.label, index === focus ? 'focus' : undefined),
        ]),
      ],
    }),
    key: (press, close) => {
      if (isKey(press, 'up') || press.text === 'k') {
        focus = Math.max(0, focus - 1);
      } else if (isKey(press, 'down') || press.text === 'j') {
        focus = Math.min(options.length - 1, focus + 1);
      } else if (isKey(press, 'enter')) {
        close((options[focus] ?? { value: cancel }).value);
      } else if (isKey(press, 'escape')) {
        close(cancel);
      }
    },
  };
}

/**
 * A line of text to type, optionally masked for secrets. `check` returns a
 * problem to show, or undefined to accept. Esc resolves `undefined`.
 */
export function inputDialog(
  title: string,
  message: string,
  options: { masked?: boolean; initial?: string; check?: (value: string) => string | undefined } = {},
): Dialog<string | undefined> {
  const field = new TextField(options.initial ?? '', { masked: options.masked ?? false });
  let problem: string | undefined;
  return {
    title,
    render: (width): ViewBody => {
      const intro = wrap(message, width).map((text): Line => [span(text)]);
      const view = field.view(width - 2);
      return {
        lines: [...intro, [], [span('> '), span(view.text, 'focus')], ...(problem === undefined ? [] : [[span(`! ${problem}`, 'warning')]])],
        cursor: { row: intro.length + 1, col: 2 + view.cursor },
      };
    },
    key: (press: Key, close) => {
      if (isKey(press, 'enter')) {
        problem = options.check?.(field.value);
        if (problem === undefined) {
          close(field.value);
        }
      } else if (isKey(press, 'escape')) {
        close(undefined);
      } else {
        field.key(press);
      }
    },
  };
}

/** Text to read; Enter or Esc closes it. */
export function messageDialog(title: string, message: string): Dialog<undefined> {
  return {
    title,
    render: (width) => ({ lines: [...wrap(message, width).map((text) => [span(text)]), [], buttons(['OK'], 0)] }),
    key: (press, close) => {
      if (isKey(press, 'enter') || isKey(press, 'escape')) {
        close(undefined);
      }
    },
  };
}

/** Every key of a screen, opened with `?`. */
export function helpDialog(title: string, hints: readonly Hint[]): Dialog<undefined> {
  const width = Math.max(...hints.map((hint) => textWidth(hint.key)), 3);
  return {
    title: `Keys: ${title}`,
    render: () => ({
      lines: [
        ...hints.map((hint): Line => [span(hint.key.padEnd(width), 'bold'), span(`  ${hint.label}`)]),
        [],
        [span('Esc Close', 'dim')],
      ],
    }),
    key: (press, close) => {
      if (isKey(press, 'escape') || isKey(press, 'enter') || press.text === '?' || press.text === 'q') {
        close(undefined);
      }
    },
  };
}
