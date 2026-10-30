// The title, rule, message and footer rows follow the status and message rows
// of kilo's editorRefreshScreen (https://github.com/antirez/kilo, commit 323d93b2).
// Copyright (c) 2016, Salvatore Sanfilippo. BSD-2-Clause; see THIRD_PARTY_NOTICES.md.
import type { App, Hint } from '../app.ts';
import { plain, span, symbols, type Frame, type Line, type Theme } from '../style.ts';
import { padEnd, textWidth, truncate } from '../text.ts';

/** `Key Label   Key Label`, keys in bold: at most seven, and only whole hints that fit `width`. */
export function hintLine(hints: readonly Hint[], width = Number.POSITIVE_INFINITY): Line {
  const parts: Line[number][] = [span('  ')];
  let used = 2;
  for (const [index, hint] of hints.slice(0, 7).entries()) {
    const gap = index > 0 ? 3 : 0;
    const size = gap + textWidth(hint.key) + 1 + textWidth(hint.label);
    if (used + size > width) {
      break;
    }
    if (gap > 0) {
      parts.push(span('   '));
    }
    parts.push(span(hint.key, 'bold'), span(` ${hint.label}`));
    used += size;
  }
  return parts;
}

function titleBar(title: string, primary: string | undefined, columns: number, theme: Theme): Line {
  const right = primary === undefined ? '' : `${primary} `;
  const room = Math.max(1, columns - textWidth(right) - 2);
  const left = ` ${truncate(title, room, symbols(theme).ellipsis)}`;
  return [span(left, 'bold'), span(' '.repeat(Math.max(1, columns - textWidth(left) - textWidth(right)))), span(right, 'accent')];
}

function rule(columns: number, theme: Theme): Line {
  return [span(` ${symbols(theme).rule.repeat(Math.max(0, columns - 2))}`, 'dim')];
}

/** Pads a styled line to `width` columns. */
export function padLine(line: Line, width: number): Line {
  const used = textWidth(plain(line));
  return used >= width ? line : [...line, span(' '.repeat(width - used))];
}

function messageLine(app: App, theme: Theme): Line {
  const message = app.currentMessage();
  if (message !== undefined) {
    const mark = message.tone === 'error' ? `${symbols(theme).remove} ` : message.tone === 'warning' ? '! ' : '';
    return [span(' '), span(`${mark}${message.text}`, message.tone)];
  }
  const busy = app.busyLabel();
  if (busy !== undefined) {
    const frames = symbols(theme).spinner;
    return [span(' '), span(`${frames[app.spinnerFrame() % frames.length] ?? ''} ${busy}`, 'accent'), span('  Esc Cancel', 'dim')];
  }
  const status = app.view?.status?.();
  return status === undefined ? [] : [span(` ${status}`)];
}

/**
 * The whole screen: title bar, optional summary, rule, the view's body, rule,
 * message bar and key hints, with the top dialog drawn over the body.
 */
export function renderFrame(app: App, columns: number, rows: number): Frame {
  const theme = app.theme;
  const view = app.view;
  const lines: Line[] = [titleBar(view?.title() ?? 'sync-servers', view?.primary?.(), columns, theme)];
  const summary = view?.summary?.();
  if (summary !== undefined) {
    lines.push([span(' '), ...summary]);
  }
  lines.push(rule(columns, theme));
  const bodyTop = lines.length;
  const bodyHeight = Math.max(1, rows - bodyTop - 3);
  const body = view?.body(columns, bodyHeight, theme) ?? { lines: [] };
  for (let row = 0; row < bodyHeight; row += 1) {
    lines.push(body.lines[row] ?? []);
  }
  let cursor = body.cursor === undefined ? undefined : { row: bodyTop + body.cursor.row, col: body.cursor.col };
  lines.push(rule(columns, theme), messageLine(app, theme), hintLine(view?.hints() ?? [], columns));

  const dialog = app.topDialog;
  if (dialog !== undefined) {
    const sym = theme.ascii ? { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' } : { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' };
    const width = Math.min(columns - 4, 72);
    const inner = dialog.render(width - 4, theme);
    const heading = ` ${truncate(dialog.title, width - 6, symbols(theme).ellipsis)} `;
    const box: Line[] = [
      [span(`${sym.tl}${sym.h}${heading}${sym.h.repeat(Math.max(0, width - 3 - textWidth(heading)))}${sym.tr}`, 'bold')],
      ...inner.lines.map((line): Line => [span(`${sym.v} `), ...padLine(line, width - 4), span(` ${sym.v}`)]),
      [span(`${sym.bl}${sym.h.repeat(width - 2)}${sym.br}`, 'bold')],
    ];
    const top = bodyTop + Math.max(0, Math.floor((bodyHeight - box.length) / 2));
    const left = Math.max(0, Math.floor((columns - width) / 2));
    box.forEach((line, index) => {
      if (top + index < lines.length - 3) {
        lines[top + index] = [span(' '.repeat(left)), ...line];
      }
    });
    cursor = inner.cursor === undefined ? undefined : { row: top + 1 + inner.cursor.row, col: left + 2 + inner.cursor.col };
  }
  return { lines: lines.slice(0, rows), cursor };
}

/** A text progress bar of `width` columns. */
export function progressBar(done: number, total: number, width: number, theme: Theme): string {
  const sym = symbols(theme);
  const filled = total <= 0 ? width : Math.round((Math.min(done, total) / total) * width);
  return sym.bar.repeat(filled) + sym.barEmpty.repeat(Math.max(0, width - filled));
}

/** Lays out cells in columns separated by two spaces; the last column takes the rest. */
export function columnsLine(cells: readonly string[], widths: readonly number[]): string {
  return cells.map((cell, index) => (index === cells.length - 1 ? cell : padEnd(cell, widths[index] ?? 0))).join('  ');
}
