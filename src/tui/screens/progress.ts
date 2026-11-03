import { resultLine, type ItemResult, type SyncResult } from '../../sync/execute.ts';
import type { SyncPlan } from '../../sync/plan.ts';
import type { SyncSession } from '../../sync/session.ts';
import type { App, Hint, View, ViewBody } from '../app.ts';
import { isKey, type Key } from '../keys.ts';
import { span, symbols, type Line, type Theme } from '../style.ts';
import { padEnd, truncate, truncatePath } from '../text.ts';
import { progressBar } from '../widgets/chrome.ts';
import { inputDialog } from '../widgets/dialog.ts';
import { ListState } from '../widgets/list.ts';
import { protocolName } from './common.ts';
import { runnable } from './preview.ts';

/** Runs a plan, showing overall progress and the file in hand; Esc cancels cleanly. */
export class ProgressView implements View {
  readonly #session: SyncSession;
  readonly #plan: SyncPlan;
  readonly #total: number;
  #completed = 0;
  #bytes = 0;
  #current = '';
  #started = false;

  constructor(session: SyncSession, plan: SyncPlan) {
    this.#session = session;
    this.#plan = plan;
    this.#total = runnable(plan);
  }

  title(): string {
    return `Synchronizing: ${this.#session.site.name} -> ${this.#session.server.name} (${protocolName(this.#session.server.protocol)})`;
  }

  hints(): readonly Hint[] {
    return [{ key: 'Esc', label: 'Cancel' }];
  }

  async shown(app: App): Promise<void> {
    if (this.#started) {
      return;
    }
    this.#started = true;
    const result = await app.task('Synchronizing', (signal) =>
      this.#session.execute(this.#plan, {
        signal,
        onProgress: (event) => {
          if (event.type === 'transfer') {
            this.#completed = event.completed;
            this.#bytes = event.bytes;
            this.#current = event.path;
            app.redraw();
          }
        },
        confirmMassDelete: async (count, side) =>
          (await app.dialog(
            inputDialog('Many deletes', `This deletes ${String(count)} ${side} files. Type ${String(count)} to go ahead, or press Esc to stop.`),
          )) === String(count),
      }),
    );
    await this.#session.close();
    if (result === undefined) {
      app.pop();
      return;
    }
    app.outcome = result;
    app.replace(new ResultsView(this.#session, result));
  }

  body(width: number, _height: number, theme: Theme): ViewBody {
    const barWidth = Math.max(10, Math.min(50, width - 30));
    return {
      lines: [
        [],
        [span(`  ${String(this.#completed)} of ${String(this.#total)} files   `), span(progressBar(this.#completed, this.#total, barWidth, theme), 'accent')],
        [span(`  ${(this.#bytes / 1024).toFixed(0)} KB moved`, 'dim')],
        [],
        [span(`  ${truncatePath(this.#current, width - 4, symbols(theme).ellipsis)}`)],
      ],
    };
  }

  key(): void {
    // Esc and Ctrl+C go to the running task; the app handles them.
  }
}

const OUTCOME_WORDS: Readonly<Record<ItemResult['outcome'], string>> = {
  done: 'done',
  failed: 'failed',
  stale: 'stale',
  skipped: 'skipped',
  cancelled: 'cancelled',
};

/** Failures first, then what did not run, then what was done. */
const OUTCOME_ORDER: Readonly<Record<ItemResult['outcome'], number>> = {
  failed: 0,
  stale: 1,
  cancelled: 2,
  done: 3,
  skipped: 4,
};

/** What a run did, failures first. */
export class ResultsView implements View {
  readonly #session: SyncSession;
  readonly #result: SyncResult;
  readonly #list: ListState<ItemResult>;
  #height = 10;

  constructor(session: SyncSession, result: SyncResult) {
    this.#session = session;
    this.#result = result;
    this.#list = new ListState(
      result.items.toSorted((a, b) => OUTCOME_ORDER[a.outcome] - OUTCOME_ORDER[b.outcome]),
      (item) => item.path,
    );
  }

  title(): string {
    return `Results: ${this.#session.site.name} -> ${this.#session.server.name}`;
  }

  summary(): Line {
    const extra = this.#result.unresolved > 0 ? `   ${String(this.#result.unresolved)} still need a decision` : '';
    return [span(resultLine(this.#result)), span(extra, 'warning')];
  }

  hints(): readonly Hint[] {
    return [
      { key: 'Up/Down', label: 'Move' },
      { key: 'Esc', label: 'Done' },
    ];
  }

  status(): string | undefined {
    const item = this.#list.selected;
    return item?.error === undefined ? item?.path : `${item.path}: ${item.error.message}`;
  }

  body(width: number, height: number, theme: Theme): ViewBody {
    this.#height = height;
    const { start, items, above, below } = this.#list.window(height);
    return {
      more: { above, below },
      lines: items.map((item, offset): Line => {
        const focused = start + offset === this.#list.index;
        const bad = item.outcome === 'failed' || item.outcome === 'stale';
        const word = padEnd(OUTCOME_WORDS[item.outcome], 9);
        const text = `  ${word} ${truncatePath(item.path, Math.max(10, Math.floor(width / 2)), symbols(theme).ellipsis)}`;
        const detail = item.error === undefined ? '' : `  ${truncate(item.error.message, Math.max(0, width - text.length - 2), symbols(theme).ellipsis)}`;
        if (focused) {
          return [span(padEnd(text + detail, width), 'focus')];
        }
        return [span(text, bad ? 'error' : item.outcome === 'done' ? undefined : 'dim'), span(detail, 'dim')];
      }),
    };
  }

  key(press: Key, app: App): void {
    if (this.#list.key(press, this.#height)) {
      return;
    }
    if (isKey(press, 'escape') || isKey(press, 'enter') || press.text === 'q') {
      app.pop();
    }
  }
}
