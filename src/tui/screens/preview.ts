import { readFile } from 'node:fs/promises';
import { createTwoFilesPatch } from 'diff';
import type { Site } from '../../config/schema.ts';
import type { PlanItem, SyncPlan } from '../../sync/plan.ts';
import type { SyncSession } from '../../sync/session.ts';
import type { Action, Direction } from '../../sync/types.ts';
import type { App, Hint, View, ViewBody } from '../app.ts';
import { isKey, type Key } from '../keys.ts';
import { openSession, type TuiServices } from '../services.ts';
import { span, symbols, type Line, type Theme } from '../style.ts';
import { padEnd, textWidth, truncate, truncatePath } from '../text.ts';
import { choiceDialog, confirmDialog } from '../widgets/dialog.ts';
import { ListState } from '../widgets/list.ts';
import { actionCell, DIRECTION_TITLES, protocolName } from './common.ts';
import { ProgressView } from './progress.ts';
import { TextView } from './text-view.ts';

const FILTERS: readonly { label: string; test: (item: PlanItem) => boolean }[] = [
  { label: 'All', test: () => true },
  { label: 'Put', test: (item) => item.action === 'put' },
  { label: 'Get', test: (item) => item.action === 'get' },
  { label: 'Resolve', test: (item) => item.action === 'resolve' },
  { label: 'Delete', test: (item) => item.action === 'delete-remote' || item.action === 'delete-local' },
  { label: 'Guarded', test: (item) => item.guarded !== undefined },
  { label: 'Errors', test: (item) => item.state === 'problem' },
];

function checkbox(item: PlanItem, theme: Theme): string {
  const sym = symbols(theme);
  if (item.state === 'problem') {
    return sym.problem;
  }
  return item.checked === true && item.action !== 'skip' && item.action !== 'resolve' ? sym.checked : sym.unchecked;
}

/** Rows that will run when the person confirms. */
export function runnable(plan: SyncPlan): number {
  return plan.items.filter((item) => item.state !== 'problem' && item.checked === true && item.action !== 'skip' && item.action !== 'resolve').length;
}

/**
 * The preview of a synchronization, as Dreamweaver's preview: a summary, then
 * one row per file with a difference, each with a checkbox, an action, the
 * path and a status. Unchanged files are counted, never listed.
 */
export class PreviewView implements View {
  readonly #session: SyncSession;
  readonly #plan: SyncPlan;
  readonly #list: ListState<PlanItem>;
  #filter = 0;
  #height = 10;

  constructor(session: SyncSession, plan: SyncPlan) {
    this.#session = session;
    this.#plan = plan;
    this.#list = new ListState<PlanItem>(plan.items, (item) => item.path);
  }

  /** Scans and plans in the background, then shows the preview; `replace` puts it in place of the view in front. */
  static async plan(app: App, services: TuiServices, site: Site, options: { direction: Direction; deleteOrphans: boolean }, replace = false): Promise<void> {
    let session: SyncSession | undefined;
    const plan = await app.task('Comparing the local folder and the server', async (signal) => {
      session = await openSession(app, services, site.id);
      return session.plan({ ...options, signal });
    });
    if (plan === undefined || session === undefined) {
      await session?.close();
      return;
    }
    const view = new PreviewView(session, plan);
    if (replace) {
      app.replace(view);
    } else {
      app.push(view);
    }
  }

  title(): string {
    const { site, server } = this.#session;
    return `Synchronize: ${site.name} -> ${server.name} (${protocolName(server.protocol)})`;
  }

  primary(): string {
    return DIRECTION_TITLES[this.#plan.direction];
  }

  summary(): Line {
    const filter = FILTERS[this.#filter];
    const shown = this.#filter === 0 ? '' : `   Showing ${filter?.label ?? ''}: ${String(this.#list.items.length)}`;
    return [span(this.#plan.summaryLine()), span(shown, 'dim')];
  }

  hints(): readonly Hint[] {
    return [
      { key: 'Space', label: 'CHECK/UNCHECK ALL' },
      { key: 'c', label: 'Check/Uncheck' },
      { key: 'p', label: 'Put' },
      { key: 'g', label: 'Get' },
      { key: 's', label: 'Skip' },
      { key: 'd', label: 'Diff' },
      { key: 'a', label: 'All' },
      { key: 'q', label: 'Quit' },
      { key: 'Enter', label: 'Synchronize' },
    ];
  }

  keys(): readonly Hint[] {
    return [
      { key: 'Space', label: 'Check or uncheck every row: unchecks them all when most are checked, else checks them all' },
      { key: 'c', label: 'Check or uncheck the focused row' },
      ...this.hints().filter((hint) => !['Space', 'c', 'q'].includes(hint.key)),
      { key: 'm', label: 'Mark synchronized: record both copies as in sync' },
      { key: 'x', label: 'Delete' },
      { key: 'Tab', label: 'Show All, Put, Get, Resolve, Delete, Guarded or Errors' },
      { key: '/', label: 'Find a path' },
      { key: 'Esc', label: 'Back, transferring nothing' },
      { key: 'q', label: 'Quit, transferring nothing, as Ctrl+C does' },
    ];
  }

  capturesText(): boolean {
    return this.#list.filtering;
  }

  status(): string | undefined {
    const filter = this.#list.filterText();
    if (filter !== undefined) {
      return filter;
    }
    const item = this.#list.selected;
    if (item === undefined) {
      return undefined;
    }
    return item.status === '' ? item.path : `${item.path}: ${item.status}`;
  }

  body(width: number, height: number, theme: Theme): ViewBody {
    this.#height = height;
    if (this.#plan.items.length === 0) {
      return { lines: [[], [span('  Nothing to synchronize: every compared file is in sync.')]] };
    }
    const sym = symbols(theme);
    const visible = this.#list.visible;
    if (visible.length === 0) {
      return { lines: [[], [span(this.#list.filterText() === undefined ? '  No rows match this filter. Tab shows the next one.' : '  No path matches. Esc clears the search.')]] };
    }
    const longest = Math.max(4, ...visible.map((item) => textWidth(item.path)));
    const pathWidth = Math.min(longest, Math.max(12, Math.floor((width - 20) * 0.45)));
    const statusWidth = Math.max(0, width - pathWidth - 20);
    const { start, items, above, below } = this.#list.window(height);
    return {
      more: { above, below },
      lines: items.map((item, offset): Line => {
        const focused = start + offset === this.#list.index;
        const row = `  ${checkbox(item, theme)} ${actionCell(item.action, theme)}  ${padEnd(truncatePath(item.path, pathWidth, sym.ellipsis), pathWidth)}  `;
        const status = truncate(item.status, statusWidth, sym.ellipsis);
        const warn = item.state === 'problem' || item.guarded !== undefined || item.action === 'resolve';
        if (focused) {
          return [span(padEnd(row + status, width), 'focus')];
        }
        return [span(row), span(status, warn ? 'warning' : undefined)];
      }),
    };
  }

  #refilter(): void {
    const test = FILTERS[this.#filter]?.test ?? (() => true);
    this.#list.items = this.#plan.items.filter(test);
  }

  /** The rows a checkbox acts on: not a problem, and with an action that runs. */
  #checkable(): PlanItem[] {
    return this.#plan.items.filter((row) => row.state !== 'problem' && row.action !== 'resolve' && row.action !== 'skip');
  }

  /**
   * Checks or unchecks every row by what most rows are: unchecks them all
   * when more are checked than not, and otherwise checks them all, so the
   * next press turns them all the other way.
   */
  #checkByMost(app: App): void {
    const rows = this.#checkable();
    if (rows.length === 0) {
      app.message('No row can be checked. A row that needs a decision takes p, g, s or m first.', 'warning');
      return;
    }
    const checked = rows.filter((row) => row.checked === true).length;
    const check = checked <= rows.length - checked;
    for (const row of rows) {
      this.#plan.setChecked(row.id, check);
    }
    app.message(`${check ? 'Checked' : 'Unchecked'} all ${String(rows.length)} ${rows.length === 1 ? 'file' : 'files'}.`);
  }

  #setAction(app: App, item: PlanItem, action: Action): void {
    if (!this.#plan.allowedActions(item.id).includes(action)) {
      app.message(`${action === 'put' ? 'Put' : action === 'get' ? 'Get' : 'That'} is not possible for ${item.path}: ${item.state === 'problem' ? item.status : 'that copy does not exist.'}`, 'warning');
      return;
    }
    this.#plan.setAction(item.id, action);
  }

  async #diff(app: App, item: PlanItem): Promise<void> {
    const lines = await app.task(`Comparing ${item.path}`, async (signal) => {
      const comparison = await this.#session.compare(item.path, signal);
      try {
        const local = comparison.local === undefined ? undefined : await readFile(comparison.local.file);
        const remote = comparison.remote === undefined ? undefined : await readFile(comparison.remote.file);
        const binary = [local, remote].some((data) => data !== undefined && (data.length > 5 * 1024 * 1024 || data.subarray(0, 8192).includes(0)));
        if (binary) {
          return [
            `Local:  ${local === undefined ? 'missing' : `${String(local.length)} bytes`}`,
            `Remote: ${remote === undefined ? 'missing' : `${String(remote.length)} bytes`}`,
            '',
            'Binary files are compared by size only here; use "sync-servers diff --json" for their hashes.',
          ];
        }
        const patch = createTwoFilesPatch(`local/${item.path}`, `remote/${item.path}`, local?.toString('utf8') ?? '', remote?.toString('utf8') ?? '');
        return local !== undefined && remote !== undefined && local.equals(remote) ? ['The local and remote copies are identical.'] : patch.split('\n');
      } finally {
        await comparison.dispose();
      }
    });
    if (lines !== undefined) {
      app.push(new TextView(`Diff: ${item.path}`, lines));
    }
  }

  async key(press: Key, app: App): Promise<void> {
    if (this.#list.key(press, this.#height)) {
      return;
    }
    const item = this.#list.selected;
    if (isKey(press, 'escape')) {
      await this.#session.close();
      app.pop();
      return;
    }
    if (press.text === 'q') {
      await this.#session.close();
      app.quit();
      return;
    }
    if (isKey(press, 'tab') || isKey(press, 'shift+tab')) {
      this.#filter = (this.#filter + (isKey(press, 'tab') ? 1 : FILTERS.length - 1)) % FILTERS.length;
      this.#refilter();
      return;
    }
    if (press.text === 'a') {
      const checkable = this.#checkable();
      const all = checkable.every((row) => row.checked === true);
      for (const row of checkable) {
        this.#plan.setChecked(row.id, !all);
      }
      return;
    }
    if (isKey(press, 'space')) {
      this.#checkByMost(app);
      return;
    }
    if (isKey(press, 'enter')) {
      const count = runnable(this.#plan);
      if (count === 0) {
        app.message('Nothing is checked. c checks the focused row, Space every row.', 'warning');
        return;
      }
      const go = await app.dialog(confirmDialog('Synchronize', `Synchronize ${String(count)} file(s) now?`, { yes: 'Synchronize', defaultYes: true }));
      if (go) {
        app.replace(new ProgressView(this.#session, this.#plan));
      }
      return;
    }
    if (item === undefined) {
      return;
    }
    if (press.text === 'c') {
      if (item.state === 'problem') {
        app.message(item.status, 'warning');
      } else if (item.action === 'resolve') {
        app.message('Choose an action first: p Put, g Get, s Skip or m Synchronized.', 'warning');
      } else {
        this.#plan.setChecked(item.id, item.checked !== true);
      }
    } else if (press.text === 'p') {
      this.#setAction(app, item, 'put');
    } else if (press.text === 'g') {
      this.#setAction(app, item, 'get');
    } else if (press.text === 's') {
      this.#setAction(app, item, 'skip');
    } else if (press.text === 'm') {
      this.#setAction(app, item, 'synced');
    } else if (press.text === 'x') {
      const deletes = this.#plan.allowedActions(item.id).filter((action) => action === 'delete-remote' || action === 'delete-local');
      const choice =
        deletes.length > 1
          ? await app.dialog(
              choiceDialog<Action | undefined>('Delete', `Delete ${item.path} where?`, [
                { label: 'On the server', value: 'delete-remote' },
                { label: 'On this computer (kept in the recovery folder)', value: 'delete-local' },
              ], undefined),
            )
          : deletes[0];
      if (choice !== undefined) {
        this.#setAction(app, item, choice);
      }
    } else if (press.text === 'd') {
      if (item.state === 'problem') {
        app.message(item.status, 'warning');
      } else {
        await this.#diff(app, item);
      }
    }
  }
}
