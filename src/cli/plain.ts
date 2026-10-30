import { readFile } from 'node:fs/promises';
import { createTwoFilesPatch } from 'diff';
import type { PlanItem, SyncPlan } from '../sync/plan.ts';
import type { SyncSession } from '../sync/session.ts';
import type { Action } from '../sync/types.ts';
import type { CommandContext } from './context.ts';
import { paint } from './output.ts';
import { editorPath } from './preview-editor.ts';

const LABELS: Readonly<Record<Action, readonly [string, string, string]>> = {
  put: ['↑', '^', 'Put'],
  get: ['↓', 'v', 'Get'],
  resolve: ['?', '?', 'Resolve'],
  'delete-remote': ['✕', 'x', 'Delete remote'],
  'delete-local': ['✕', 'x', 'Delete local'],
  skip: ['-', '-', 'Skip'],
  synced: ['=', '=', 'Synchronized'],
};

const LETTERS: Readonly<Record<string, Action>> = { p: 'put', g: 'get', s: 'skip', m: 'synced' };

const HELP = [
  'Commands:',
  '  <n>...          check or uncheck rows, such as "3", "1 4" or "2-6"',
  '  p|g|s|m <n>...  set Put, Get, Skip or Synchronized',
  '  x <n>...        delete (asks where, when both copies exist)',
  '  all, none       check or uncheck every row that can run',
  '  diff <n>        show how the two copies differ',
  '  list            show the rows again',
  '  go              synchronize the checked rows',
  '  q               cancel, transferring nothing',
].join('\n');

function box(item: PlanItem): string {
  if (item.state === 'problem') {
    return '[!]';
  }
  return item.checked === true && item.action !== 'skip' && item.action !== 'resolve' ? '[x]' : '[ ]';
}

/** Rows that run on `go`. */
function runnable(plan: SyncPlan): number {
  return plan.items.filter((item) => item.state !== 'problem' && item.checked === true && item.action !== 'skip' && item.action !== 'resolve').length;
}

/** The preview with a number on each row, for plain mode. */
export function formatNumberedPreview(ctx: CommandContext, plan: SyncPlan): string {
  const numberWidth = Math.max(1, ...plan.items.map((item) => String(item.id).length));
  const labelWidth = Math.max(3, ...plan.items.map((item) => LABELS[item.action][2].length));
  const pathWidth = Math.min(48, Math.max(4, ...plan.items.map((item) => editorPath(item.path).length)));
  const lines = [plan.summaryLine()];
  for (const item of plan.items) {
    const [symbol, ascii, label] = LABELS[item.action];
    const warn = item.state === 'problem' || item.guarded !== undefined || item.action === 'resolve';
    const status = item.status === '' ? '' : `  ${warn ? paint(item.status, 'yellow', ctx.color) : item.status}`;
    lines.push(`  ${String(item.id).padStart(numberWidth)} ${box(item)} ${ctx.ascii ? ascii : symbol} ${label.padEnd(labelWidth)}  ${editorPath(item.path).padEnd(pathWidth)}${status}`.trimEnd());
  }
  return `${lines.join('\n')}\n`;
}

/** Reads row numbers such as `3`, `1 4` and `2-6`; `undefined` when a word is not a number or a range. */
export function parseNumbers(words: readonly string[]): number[] | undefined {
  const numbers: number[] = [];
  for (const word of words) {
    const range = /^(\d+)-(\d+)$/.exec(word);
    if (range !== null) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (to < from || to - from > 100_000) {
        return undefined;
      }
      for (let value = from; value <= to; value += 1) {
        numbers.push(value);
      }
    } else if (/^\d+$/.test(word)) {
      numbers.push(Number(word));
    } else {
      return undefined;
    }
  }
  return numbers;
}

async function diffText(session: SyncSession, item: PlanItem, signal: AbortSignal | undefined): Promise<string> {
  const comparison = await session.compare(item.path, signal);
  try {
    const local = comparison.local === undefined ? undefined : await readFile(comparison.local.file);
    const remote = comparison.remote === undefined ? undefined : await readFile(comparison.remote.file);
    if (local !== undefined && remote !== undefined && local.equals(remote)) {
      return 'The local and remote copies are identical.\n';
    }
    const binary = [local, remote].some((data) => data !== undefined && (data.length > 5 * 1024 * 1024 || data.subarray(0, 8192).includes(0)));
    if (binary) {
      const size = (data: Buffer | undefined): string => (data === undefined ? 'missing' : `${String(data.length)} bytes`);
      return `Local:  ${size(local)}\nRemote: ${size(remote)}\n`;
    }
    return createTwoFilesPatch(`local/${item.path}`, `remote/${item.path}`, local?.toString('utf8') ?? '', remote?.toString('utf8') ?? '');
  } finally {
    await comparison.dispose();
  }
}

/**
 * The preview in plain mode: numbered rows and typed commands, with no
 * cursor movement, so screen readers and logging terminals follow it.
 * Resolves `true` to synchronize the checked rows, `false` to cancel.
 */
export async function plainPreview(ctx: CommandContext, session: SyncSession, plan: SyncPlan): Promise<boolean> {
  const ask = ctx.prompter;
  ctx.out(formatNumberedPreview(ctx, plan));
  ctx.out('Type "help" for commands, "go" to synchronize, "q" to cancel.\n');
  const rows = (numbers: readonly number[]): PlanItem[] | undefined => {
    const found: PlanItem[] = [];
    const missing: number[] = [];
    for (const id of numbers) {
      const item = plan.item(id);
      if (item === undefined) {
        missing.push(id);
      } else {
        found.push(item);
      }
    }
    if (missing.length > 0) {
      ctx.out(`No row ${missing.join(', ')}. Rows go from 1 to ${String(plan.items.length)}.\n`);
      return undefined;
    }
    return found;
  };
  const setAction = (item: PlanItem, action: Action): void => {
    if (plan.allowedActions(item.id).includes(action)) {
      plan.setAction(item.id, action);
    } else {
      ctx.out(`${String(item.id)}: ${editorPath(item.path)} cannot take ${LABELS[action][2]}; it can take ${plan.allowedActions(item.id).join(', ')}.\n`);
    }
  };
  for (;;) {
    const [command = '', ...rest] = (await ask.ask('preview')).split(/\s+/).filter((word) => word !== '');
    const lower = command.toLowerCase();
    if (lower === '') {
      continue;
    }
    if (lower === 'q' || lower === 'quit') {
      return false;
    }
    if (lower === 'help' || lower === '?') {
      ctx.out(`${HELP}\n`);
    } else if (lower === 'list' || lower === 'l') {
      ctx.out(formatNumberedPreview(ctx, plan));
    } else if (lower === 'go') {
      const count = runnable(plan);
      if (count === 0) {
        ctx.out('Nothing is checked. Check rows by number, or set an action with p, g, s or m.\n');
      } else if (await ask.confirm(`Synchronize ${String(count)} file(s)?`, false)) {
        return true;
      }
    } else if (lower === 'all' || lower === 'none') {
      for (const item of plan.items) {
        if (item.state !== 'problem' && item.action !== 'resolve' && item.action !== 'skip') {
          plan.setChecked(item.id, lower === 'all');
        }
      }
      ctx.out(`${plan.summaryLine()}\n`);
    } else if (lower === 'diff' || lower === 'd') {
      const numbers = parseNumbers(rest);
      const [item] = numbers === undefined || numbers.length !== 1 ? [] : (rows(numbers) ?? []);
      if (item === undefined) {
        ctx.out('Name one row, such as "diff 3".\n');
      } else if (item.state === 'problem') {
        ctx.out(`${item.status}\n`);
      } else {
        ctx.out(await diffText(session, item, ctx.io.signal));
      }
    } else if (lower in LETTERS || lower === 'x') {
      const numbers = parseNumbers(rest);
      if (numbers === undefined || numbers.length === 0) {
        ctx.out(`Name rows after "${lower}", such as "${lower} 3" or "${lower} 2-6".\n`);
        continue;
      }
      const items = rows(numbers);
      if (items === undefined) {
        continue;
      }
      for (const item of items) {
        const letter = LETTERS[lower];
        if (letter !== undefined) {
          setAction(item, letter);
          continue;
        }
        const deletes = plan.allowedActions(item.id).filter((action) => action === 'delete-remote' || action === 'delete-local');
        const action =
          deletes.length > 1
            ? await ask.choose<Action>(`Delete ${editorPath(item.path)} where?`, [
                { label: 'On the server', value: 'delete-remote' },
                { label: 'On this computer (kept in the recovery folder)', value: 'delete-local' },
              ])
            : deletes[0];
        if (action === undefined) {
          ctx.out(`${String(item.id)}: ${editorPath(item.path)} cannot be deleted here.\n`);
        } else {
          setAction(item, action);
        }
      }
      ctx.out(`${plan.summaryLine()}\n`);
    } else {
      const numbers = parseNumbers([command, ...rest]);
      if (numbers === undefined) {
        ctx.out(`Unknown command "${command}". Type "help" for commands.\n`);
        continue;
      }
      const items = rows(numbers);
      if (items === undefined) {
        continue;
      }
      for (const item of items) {
        if (item.state === 'problem') {
          ctx.out(`${String(item.id)}: ${item.status}\n`);
        } else if (item.action === 'resolve') {
          ctx.out(`${String(item.id)}: choose an action first: p Put, g Get, s Skip or m Synchronized.\n`);
        } else {
          plan.setChecked(item.id, item.checked !== true);
        }
      }
      ctx.out(`${plan.summaryLine()}\n`);
    }
  }
}
