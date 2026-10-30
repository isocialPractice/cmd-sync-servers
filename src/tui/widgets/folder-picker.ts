import path from 'node:path';
import { safeLine } from '../../terminal-text.ts';
import type { FolderListing } from '../../transport/probe.ts';
import type { Dialog } from '../app.ts';
import { isKey } from '../keys.ts';
import { span, symbols, type Line } from '../style.ts';
import { truncate } from '../text.ts';

/** The most rows the picker shows at once; it scrolls to keep the focus in view. */
const ROWS = 12;

type Row = { readonly kind: 'use' } | { readonly kind: 'up' } | { readonly kind: 'folder'; readonly name: string };

/**
 * Picks a folder on a server from what it shows, starting at `start`: Enter
 * opens the focused folder, Backspace or `..` goes up, and `s` or the
 * "Use this folder" row accepts the folder shown, whose path is in the
 * title. Esc resolves `undefined`. `run` keeps each listing in the app's
 * background work, so the screen redraws when it arrives.
 */
export function folderPickerDialog(
  probe: { folders(folder: string): Promise<FolderListing> },
  start: string,
  run: <T>(work: Promise<T>) => Promise<T>,
): Dialog<string | undefined> {
  let current = start;
  let listing: FolderListing | undefined;
  let loading = false;
  let problem: string | undefined;
  let focus = 0;
  let offset = 0;

  const rows = (): Row[] => [
    { kind: 'use' },
    ...(current === '/' ? [] : [{ kind: 'up' } as const]),
    ...(listing?.folders ?? []).map((name): Row => ({ kind: 'folder', name })),
  ];

  const load = (target: string): void => {
    loading = true;
    problem = undefined;
    run(probe.folders(target)).then(
      (found) => {
        listing = found;
        current = found.path;
        focus = 0;
        offset = 0;
        loading = false;
      },
      (error: unknown) => {
        problem = `${safeLine(target)} cannot be opened: ${error instanceof Error ? safeLine(error.message) : String(error)}`;
        loading = false;
      },
    );
  };
  load(start);

  return {
    get title() {
      return `Choose the site's folder: ${safeLine(current)}`;
    },
    render: (width, theme) => {
      const sym = symbols(theme);
      const lines: Line[] = [];
      if (problem !== undefined) {
        lines.push([span(`! ${truncate(problem, width - 2, sym.ellipsis)}`, 'warning')]);
      }
      if (loading) {
        lines.push([span('Loading the folder...', 'dim')]);
      } else {
        const all = rows();
        if (focus < offset) {
          offset = focus;
        } else if (focus >= offset + ROWS) {
          offset = focus - ROWS + 1;
        }
        all.slice(offset, offset + ROWS).forEach((row, index) => {
          const focused = offset + index === focus;
          const label = row.kind === 'use' ? 'Use this folder' : row.kind === 'up' ? '..' : `${safeLine(row.name)}/`;
          lines.push([span(focused ? `${sym.pointer} ` : '  '), span(truncate(label, width - 2, sym.ellipsis), focused ? 'focus' : undefined)]);
        });
        if (all.length > offset + ROWS) {
          lines.push([span(`  and ${String(all.length - offset - ROWS)} more below`, 'dim')]);
        }
        if (listing !== undefined && listing.files > 0) {
          lines.push([span(`  and ${String(listing.files)} file${listing.files === 1 ? '' : 's'}`, 'dim')]);
        }
      }
      lines.push([], [span('Enter Open   Backspace Up   s Use this folder   Esc Cancel', 'dim')]);
      return { lines };
    },
    key: (press, close) => {
      if (isKey(press, 'escape')) {
        close(undefined);
        return;
      }
      if (loading) {
        return;
      }
      const all = rows();
      if (isKey(press, 'up') || press.text === 'k') {
        focus = Math.max(0, focus - 1);
      } else if (isKey(press, 'down') || press.text === 'j') {
        focus = Math.min(all.length - 1, focus + 1);
      } else if (isKey(press, 'home')) {
        focus = 0;
      } else if (isKey(press, 'end')) {
        focus = all.length - 1;
      } else if (press.text === 's') {
        close(current);
      } else if (isKey(press, 'backspace')) {
        if (current !== '/') {
          load(path.posix.dirname(current));
        }
      } else if (isKey(press, 'enter')) {
        const row = all[focus];
        if (row === undefined || row.kind === 'use') {
          close(current);
        } else if (row.kind === 'up') {
          load(path.posix.dirname(current));
        } else {
          load(path.posix.join(current, row.name));
        }
      }
    },
  };
}
