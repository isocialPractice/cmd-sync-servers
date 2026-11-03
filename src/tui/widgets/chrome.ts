// The title, rule, message and footer rows follow the status and message rows
// of kilo's editorRefreshScreen (https://github.com/antirez/kilo, commit 323d93b2).
// Copyright (c) 2016, Salvatore Sanfilippo. BSD-2-Clause; see THIRD_PARTY_NOTICES.md.
import type { App, Hint } from '../app.ts';
import { plain, span, symbols, type Frame, type Line, type Theme } from '../style.ts';
import { padEnd, textWidth, truncate } from '../text.ts';

/** The most hints a footer menu shows. */
const MAX_HINTS = 8;

/** The indent of each menu row, and the separator between two hints. */
const MENU_INDENT = '  ';
const MENU_SEPARATOR = '  |  ';

/** The fewest body rows a frame keeps before it gives up the scroll edges, then menu rows. */
const MIN_BODY = 3;

/**
 * The footer menu, `Key = Label  |  Key = Label`, keys in bold: at most
 * eight hints, wrapped onto as many rows as `width` needs, a hint never
 * split and no row starting or ending with a separator.
 */
export function hintLines(hints: readonly Hint[], width = Number.POSITIVE_INFINITY): Line[] {
  const rows: Line[] = [];
  let row: Line[number][] = [];
  let used = 0;
  for (const hint of hints.slice(0, MAX_HINTS)) {
    const size = textWidth(hint.key) + 3 + textWidth(hint.label);
    if (row.length > 0 && used + MENU_SEPARATOR.length + size > width - 1) {
      rows.push(row);
      row = [];
    }
    if (row.length === 0) {
      row.push(span(MENU_INDENT));
      used = MENU_INDENT.length;
    } else {
      row.push(span(MENU_SEPARATOR));
      used += MENU_SEPARATOR.length;
    }
    row.push(span(hint.key, 'bold'), span(` = ${hint.label}`));
    used += size;
  }
  if (row.length > 0) {
    rows.push(row);
  }
  return rows;
}

function titleBar(title: string, primary: string | undefined, columns: number, theme: Theme): Line {
  const right = primary === undefined ? '' : `${primary} `;
  const room = Math.max(1, columns - textWidth(right) - 2);
  const left = ` ${truncate(title, room, symbols(theme).ellipsis)}`;
  return [span(left, 'bold'), span(' '.repeat(Math.max(1, columns - textWidth(left) - textWidth(right)))), span(right, 'accent')];
}

/** The solid line above and below the content. */
function rule(columns: number, theme: Theme): Line {
  return [span(` ${symbols(theme).rule.repeat(Math.max(0, columns - 2))}`, 'bold')];
}

/** The row at an edge of the content: a dashed line while rows are hidden past it, else blank. */
function edgeLine(hidden: boolean, columns: number, theme: Theme): Line {
  if (!hidden) {
    return [];
  }
  const unit = symbols(theme).edge;
  const width = Math.max(0, columns - 2);
  return [span(` ${unit.repeat(Math.ceil(width / unit.length)).slice(0, width).trimEnd()}`, 'bold')];
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
 * The whole screen: title bar, optional summary, a solid rule, the top
 * edge, the view's body, the bottom edge, a solid rule, the menu and the
 * message bar, with the top dialog drawn over the edges and the body.
 *
 * The edges show dashes while the body hides rows past them. When the body
 * would get fewer than three rows, the edges go first, then menu rows.
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
  const menu = hintLines(view?.hints() ?? [], columns);
  const room = rows - lines.length - 2;
  const edges = room - 2 - menu.length >= MIN_BODY;
  const menuRows = Math.min(menu.length, Math.max(1, room - (edges ? 2 : 0) - MIN_BODY));
  const bodyHeight = Math.max(1, room - (edges ? 2 : 0) - menuRows);
  const areaTop = lines.length;
  const body = view?.body(columns, bodyHeight, theme) ?? { lines: [] };
  if (edges) {
    lines.push(edgeLine(body.more?.above === true, columns, theme));
  }
  const bodyTop = lines.length;
  for (let row = 0; row < bodyHeight; row += 1) {
    lines.push(body.lines[row] ?? []);
  }
  if (edges) {
    lines.push(edgeLine(body.more?.below === true, columns, theme));
  }
  const areaBottom = lines.length;
  let cursor = body.cursor === undefined ? undefined : { row: bodyTop + body.cursor.row, col: body.cursor.col };
  lines.push(rule(columns, theme), ...menu.slice(0, menuRows), messageLine(app, theme));

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
    const top = areaTop + Math.max(0, Math.floor((areaBottom - areaTop - box.length) / 2));
    const left = Math.max(0, Math.floor((columns - width) / 2));
    box.forEach((line, index) => {
      if (top + index < areaBottom) {
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
