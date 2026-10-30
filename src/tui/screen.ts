// Ported from kilo's append buffer and editorRefreshScreen
// (https://github.com/antirez/kilo, commit 323d93b2).
// Copyright (c) 2016, Salvatore Sanfilippo. BSD-2-Clause; see THIRD_PARTY_NOTICES.md.
import type { Frame, Line, Theme, Tone } from './style.ts';
import { charWidth, printable } from './text.ts';

const CSI = '\u001b[';

function sgr(tone: Tone | undefined, theme: Theme): string {
  switch (tone) {
    case 'focus':
      return '7';
    case 'dim':
      return '2';
    case 'bold':
      return '1';
    case 'accent':
      return theme.color ? '36' : '1';
    case 'warning':
      return theme.color ? '33' : '';
    case 'error':
      return theme.color ? '31' : '';
    default:
      return '';
  }
}

/** One row as terminal output: styles as SGR sequences, cut to `width` columns. */
export function encodeLine(line: Line, width: number, theme: Theme): string {
  let out = '';
  let used = 0;
  for (const part of line) {
    let text = '';
    for (const char of printable(part.text)) {
      const size = charWidth(char.codePointAt(0) ?? 0);
      if (used + size > width) {
        break;
      }
      text += char;
      used += size;
    }
    if (text === '') {
      continue;
    }
    const code = sgr(part.tone, theme);
    out += code === '' ? text : `${CSI}${code}m${text}${CSI}0m`;
    if (used >= width) {
      break;
    }
  }
  return out;
}

/**
 * Turns frames into terminal output, kilo's way: everything for one frame is
 * appended to one buffer and written at once. Unlike kilo, a row is only
 * rewritten when it changed since the last frame.
 */
export class Renderer {
  #previous: string[] = [];
  #width = 0;

  /** Forgets what is on the screen, so the next frame redraws every row (after a resize). */
  invalidate(): void {
    this.#previous = [];
  }

  /** The output that turns the screen into `frame`. */
  render(frame: Frame, columns: number, rows: number, theme: Theme): string {
    if (columns !== this.#width) {
      this.#width = columns;
      this.#previous = [];
    }
    let buffer = `${CSI}?25l`;
    for (let row = 0; row < rows; row += 1) {
      const text = encodeLine(frame.lines[row] ?? [], columns, theme);
      if (this.#previous[row] !== text) {
        buffer += `${CSI}${String(row + 1)};1H${text}${CSI}0K`;
        this.#previous[row] = text;
      }
    }
    if (frame.cursor !== undefined) {
      buffer += `${CSI}${String(frame.cursor.row + 1)};${String(frame.cursor.col + 1)}H${CSI}?25h`;
    }
    return buffer;
  }
}
