import type { CliIo } from './io.ts';

/** True when output should use ASCII symbols only: `--ascii`, `TERM=dumb`, or a classic Windows console. */
export function detectAscii(io: CliIo, flag: boolean | undefined): boolean {
  if (flag === true) {
    return true;
  }
  if (io.env.TERM === 'dumb') {
    return true;
  }
  if (io.platform === 'win32' && io.stdout.isTTY === true) {
    // Windows Terminal and the VS Code terminal render UTF-8; the classic console may not.
    return io.env.WT_SESSION === undefined && io.env.TERM_PROGRAM !== 'vscode';
  }
  return false;
}

/** True when output may use colour: a terminal, no `NO_COLOR`, no `--no-color`. */
export function detectColor(io: CliIo, flag: boolean | undefined): boolean {
  if (flag !== undefined) {
    return flag;
  }
  if (io.env.NO_COLOR !== undefined && io.env.NO_COLOR !== '') {
    return false;
  }
  return io.stdout.isTTY === true && io.env.TERM !== 'dumb';
}

const SGR = { yellow: 33, red: 31, cyan: 36, dim: 2 } as const;

export type Tone = keyof typeof SGR;

/** Wraps text in a colour when colour is on; the text itself always carries the meaning. */
export function paint(text: string, tone: Tone, color: boolean): string {
  return color ? `\u001b[${String(SGR[tone])}m${text}\u001b[0m` : text;
}

/** Lays out rows in columns separated by two spaces, with the header first. */
export function formatTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)))
      .join('  ')
      .trimEnd();
  return `${[line(headers), ...rows.map(line)].join('\n')}\n`;
}

/** Lays out `label  value` pairs with the labels aligned. */
export function formatPairs(pairs: readonly (readonly [string, string])[]): string {
  const width = Math.max(0, ...pairs.map(([label]) => label.length));
  return `${pairs.map(([label, value]) => `${label.padEnd(width)}  ${value}`.trimEnd()).join('\n')}\n`;
}

/** A `--json` document: one object with a `schema` naming its kind and version. */
export function jsonDocument(kind: string, data: Record<string, unknown>): string {
  return `${JSON.stringify({ schema: `sync-servers/${kind}@1`, ...data }, null, 2)}\n`;
}
