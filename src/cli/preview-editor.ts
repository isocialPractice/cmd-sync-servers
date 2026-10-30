import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server, Site } from '../config/schema.ts';
import type { PlanItem, SyncPlan } from '../sync/plan.ts';
import { DIRECTION_TITLES, type Action } from '../sync/types.ts';
import { safeLine } from '../terminal-text.ts';
import { protocolLabel } from './commands/shared.ts';
import { runEditor, type EditorEnvironment } from './editor.ts';

/** The action words of editor mode, in the order the header lists them. */
const WORDS: readonly Action[] = ['put', 'get', 'skip', 'synced', 'delete-remote', 'delete-local'];

const ERROR_PREFIX = '# ! ';

/** A path as one line of text: control and bidi characters are escaped. */
export function editorPath(target: string): string {
  return safeLine(target);
}

function box(item: PlanItem): string {
  return item.checked === true && item.action !== 'skip' && item.action !== 'resolve' ? '[x]' : '[ ]';
}

/** The plan as the text file of editor mode: a commented header, then one row per planned item. */
export function formatPlanForEditor(plan: SyncPlan, site: Site, server: Server): string {
  const rows = plan.items.filter((item) => item.state !== 'problem');
  const problems = plan.items.filter((item) => item.state === 'problem');
  const actionWidth = Math.max(7, ...rows.map((item) => item.action.length));
  const numberWidth = Math.max(1, ...plan.items.map((item) => String(item.id).length));
  const pathWidth = Math.min(48, Math.max(4, ...rows.map((item) => editorPath(item.path).length)));
  const lines = [
    `# sync-servers preview: ${site.name} -> ${server.name} (${protocolLabel(server.protocol)})`,
    `# ${DIRECTION_TITLES[plan.direction]}${plan.deleteOrphans ? ', deleting files missing on the other side' : ''}`,
    `# ${plan.summaryLine()}`,
    '#',
    '# Check or uncheck a box, or change the action word, then save and close to',
    '# synchronize. Close without saving, or delete every row, to cancel.',
    `#   ${WORDS.join('  ')}`,
    '#',
    ...rows.map((item) => {
      const row = `${box(item)} ${item.action.padEnd(actionWidth)}  ${String(item.id).padStart(numberWidth)}  ${editorPath(item.path)}`;
      return item.status === '' ? row : `${row.padEnd(row.length + Math.max(0, pathWidth - editorPath(item.path).length))}  # ${item.status}`;
    }),
  ];
  if (problems.length > 0) {
    lines.push('#', '# Cannot be synchronized:');
    for (const item of problems) {
      lines.push(`#   [!] ${String(item.id).padStart(numberWidth)}  ${editorPath(item.path)}  ${item.status}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export interface EditedRow {
  readonly id: number;
  readonly action: Action;
  readonly checked: boolean;
}

export type EditorParse =
  | { readonly kind: 'cancel' }
  | { readonly kind: 'errors'; readonly errors: readonly string[] }
  | { readonly kind: 'ok'; readonly rows: readonly EditedRow[] };

const ROW = /^\[([ xX])\]\s+(\S+)\s+(\d+)\s+(.*)$/;

/**
 * Reads an edited plan. Every row must name a planned item by number, keep
 * its path, and use an action the item allows; a `resolve` row may not be
 * checked. No rows at all means cancel.
 */
export function parseEditedPlan(text: string, plan: SyncPlan): EditorParse {
  const errors: string[] = [];
  const rows: EditedRow[] = [];
  const seen = new Set<number>();
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/);
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      return;
    }
    const where = `Line ${String(index + 1)}`;
    const match = ROW.exec(line);
    if (match === null) {
      errors.push(`${where}: expected "[x] action number path", found "${line}".`);
      return;
    }
    const [, mark = ' ', word = '', number = '', rest = ''] = match;
    const id = Number(number);
    const item = plan.item(id);
    if (item === undefined || item.state === 'problem') {
      errors.push(`${where}: the plan has no row ${number}. Rows can only be changed or deleted, never added.`);
      return;
    }
    if (seen.has(id)) {
      errors.push(`${where}: row ${number} appears twice.`);
      return;
    }
    seen.add(id);
    const shown = editorPath(item.path);
    if (!rest.startsWith(shown) || !/^\s*(?:#.*)?$/.test(rest.slice(shown.length))) {
      errors.push(`${where}: row ${number} is ${shown}; put the path back as it was.`);
      return;
    }
    if (word !== 'resolve' && !(WORDS as readonly string[]).includes(word)) {
      errors.push(`${where}: "${word}" is not an action. Use one of: ${WORDS.join(', ')}.`);
      return;
    }
    const action = word as Action;
    const checked = mark !== ' ';
    if (action === 'resolve') {
      if (item.action !== 'resolve') {
        errors.push(`${where}: "resolve" is not a choice; use one of: ${plan.allowedActions(id).join(', ')}.`);
      } else if (checked) {
        errors.push(`${where}: ${shown} needs a decision. Change "resolve" to one of ${plan.allowedActions(id).join(', ')}, or uncheck it.`);
      } else {
        rows.push({ id, action, checked: false });
      }
      return;
    }
    if (!plan.allowedActions(id).includes(action)) {
      errors.push(`${where}: ${shown} cannot take "${action}"; it can take ${plan.allowedActions(id).join(', ')}.`);
      return;
    }
    rows.push({ id, action, checked });
  });
  if (errors.length > 0) {
    return { kind: 'errors', errors };
  }
  return rows.length === 0 ? { kind: 'cancel' } : { kind: 'ok', rows };
}

/** Applies parsed rows to the plan; planned rows that were deleted are unchecked. */
export function applyEditedRows(plan: SyncPlan, rows: readonly EditedRow[]): void {
  const edited = new Map(rows.map((row) => [row.id, row]));
  for (const item of plan.items) {
    if (item.state === 'problem') {
      continue;
    }
    const row = edited.get(item.id);
    if (row === undefined) {
      if (item.action !== 'resolve') {
        plan.setChecked(item.id, false);
      }
      continue;
    }
    if (row.action === 'resolve') {
      continue;
    }
    if (row.action !== item.action) {
      plan.setAction(item.id, row.action);
    }
    plan.setChecked(item.id, row.checked);
  }
}

/** Opens a file in the editor; resolves what was saved, or `undefined` when it was closed without saving. */
export type EditFile = (file: string) => Promise<void>;

/**
 * Editor mode: writes the plan to a private temp file, opens it in the
 * editor, and applies the edits. Reopens with the problems as comments at the
 * top until the file reads cleanly. Resolves `false` to cancel.
 */
export async function editPlan(plan: SyncPlan, site: Site, server: Server, environment: EditorEnvironment, edit?: EditFile): Promise<boolean> {
  const open = edit ?? ((file: string) => runEditor(file, environment));
  const dir = await mkdtemp(path.join(tmpdir(), 'sync-servers-'));
  try {
    const file = path.join(dir, 'preview.txt');
    let text = formatPlanForEditor(plan, site, server);
    let first = true;
    for (;;) {
      await writeFile(file, text, { mode: 0o600, flag: first ? 'wx' : 'w' });
      first = false;
      const before = (await stat(file)).mtimeMs;
      await open(file);
      const saved = await readFile(file, 'utf8');
      if (saved === text && (await stat(file)).mtimeMs === before) {
        return false;
      }
      const parsed = parseEditedPlan(saved, plan);
      if (parsed.kind === 'cancel') {
        return false;
      }
      if (parsed.kind === 'ok') {
        applyEditedRows(plan, parsed.rows);
        return true;
      }
      const body = saved
        .split(/\r?\n/)
        .filter((line) => !line.startsWith(ERROR_PREFIX))
        .join('\n');
      text = [`${ERROR_PREFIX}Fix these problems, then save and close. Delete every row to cancel.`, ...parsed.errors.map((error) => `${ERROR_PREFIX}  ${error}`), body].join('\n');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
