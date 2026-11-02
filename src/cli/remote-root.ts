import path from 'node:path';
import type { FolderListing, ServerProbe } from '../transport/probe.ts';
import { safeLine } from '../terminal-text.ts';
import { textWidth } from '../tui/text.ts';
import type { CommandContext } from './context.ts';

/** The indent of each folder line. */
const INDENT = '  ';

/** The space between two columns of folders. */
const GAP = 2;

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/** An absolute folder on the server from what was typed: absolute, or relative to `current`. */
export function resolveRemoteFolder(typed: string, current: string): string {
  const joined = typed.startsWith('/') ? typed : path.posix.join(current, typed);
  const normalized = path.posix.normalize(joined).replace(/(.)\/+$/, '$1');
  return normalized === '' ? '/' : normalized;
}

/**
 * The numbered folder lines, `  1. css/`, one per line. Given the width of
 * a terminal, they are laid out in as many columns as fit, numbered down
 * each column and then across.
 */
export function folderLines(names: readonly string[], width?: number): string[] {
  const shown = names.map((name) => `${safeLine(name)}/`);
  const single = shown.map((name, index) => `${INDENT}${String(index + 1)}. ${name}`);
  if (width === undefined || shown.length < 2) {
    return single;
  }
  const digits = String(shown.length).length;
  const cells = shown.map((name, index) => `${String(index + 1).padStart(digits)}. ${name}`);
  const cellWidth = Math.max(...cells.map(textWidth)) + GAP;
  const fit = Math.floor((width - 1 - INDENT.length + GAP) / cellWidth);
  if (fit < 2) {
    return single;
  }
  const rows = Math.ceil(cells.length / fit);
  const columns = Math.ceil(cells.length / rows);
  const lines: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    let line = INDENT;
    for (let column = 0; column < columns; column += 1) {
      const cell = cells[column * rows + row];
      if (cell !== undefined) {
        line += cell + ' '.repeat(Math.max(0, cellWidth - textWidth(cell)));
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

function describe(listing: FolderListing, intro: string | undefined, width: number | undefined): string[] {
  const where = intro === undefined ? `"${safeLine(listing.path)}"` : `${intro} The account opens in "${safeLine(listing.path)}", which`;
  const files = listing.files === 0 ? '' : plural(listing.files, 'file', 'files');
  if (listing.folders.length === 0) {
    return [files === '' ? `${where} is empty.` : `${where} holds no folders and ${files}.`];
  }
  const lines = [`${where} holds:`, ...folderLines(listing.folders, width)];
  if (files !== '') {
    lines.push(`${INDENT}and ${files}`);
  }
  return lines;
}

/**
 * Lets a person pick the site root from what the server shows, starting at
 * `start`, usually the folder the account opens in. Every folder is listed
 * and numbered, in columns on a terminal and one per line otherwise. Enter
 * accepts the folder shown, a number opens one of its folders, `..` goes
 * up, and a typed path, absolute or relative to the folder shown, is
 * accepted once it exists. `intro` opens the first listing, such as
 * `Signed in as demo-user.`.
 */
export async function chooseRemoteRoot(ctx: CommandContext, probe: Pick<ServerProbe, 'folders' | 'exists'>, start: string, intro?: string): Promise<string> {
  const width = ctx.io.stderr.isTTY === true && !ctx.flags.plain ? ctx.io.stderr.columns : undefined;
  let current = start;
  let first: string | undefined = intro;
  for (;;) {
    let listing: FolderListing;
    try {
      listing = await probe.folders(current);
    } catch (error) {
      ctx.err(`"${safeLine(current)}" cannot be listed: ${error instanceof Error ? safeLine(error.message) : String(error)}\n`);
      if (current === '/') {
        throw error;
      }
      current = '/';
      continue;
    }
    ctx.err(`${describe(listing, first, width).join('\n')}\n`);
    first = undefined;
    for (;;) {
      const answer = await ctx.prompter.ask(`Site root on the server: Enter for "${safeLine(current)}", a number to open a folder, or a path`, current);
      if (answer === current) {
        return current;
      }
      if (/^\d+$/.test(answer)) {
        const name = listing.folders[Number(answer) - 1];
        if (name === undefined) {
          ctx.err(listing.folders.length === 0 ? 'There is no folder to open here. Press Enter, or type a path.\n' : `Enter a number from 1 to ${String(listing.folders.length)}.\n`);
          continue;
        }
        current = resolveRemoteFolder(name, current);
        break;
      }
      if (answer === '..') {
        current = resolveRemoteFolder('..', current);
        break;
      }
      const target = resolveRemoteFolder(answer, current);
      if (await probe.exists(target)) {
        return target;
      }
      ctx.err(`"${safeLine(target)}" was not found on the server.\n`);
    }
  }
}
