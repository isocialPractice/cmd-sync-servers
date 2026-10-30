import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { Server, Site } from '../../config/schema.ts';
import { resultLine, type SyncResult } from '../../sync/execute.ts';
import { isInside, ROOT, toRemotePath } from '../../sync/paths.ts';
import { safeLine, safeText } from '../../terminal-text.ts';
import { SyncPlan, type PlanItem, type SavedPlan } from '../../sync/plan.ts';
import { SyncSession, type StatusEntry } from '../../sync/session.ts';
import { DIRECTION_TITLES, type Action, type Direction } from '../../sync/types.ts';
import { flag, stringOption, type CommandSpec, type OptionSpecs, type OptionValues } from '../command.ts';
import type { CommandContext } from '../context.ts';
import { CancelledError, UsageError } from '../errors.ts';
import { ExitCode } from '../exit-codes.ts';
import { cliHostAdapter } from '../host.ts';
import { formatPairs, paint } from '../output.ts';
import { plainPreview } from '../plain.ts';
import { editPlan } from '../preview-editor.ts';
import { previewMode, startTui, type PreviewMode } from '../ui.ts';
import { describeServer, protocolLabel } from './shared.ts';

const SYMBOLS: Readonly<Record<Action, readonly [string, string, string]>> = {
  put: ['↑', '^', 'Put'],
  get: ['↓', 'v', 'Get'],
  resolve: ['?', '?', 'Resolve'],
  'delete-remote': ['✕', 'x', 'Delete remote'],
  'delete-local': ['✕', 'x', 'Delete local'],
  skip: ['-', '-', 'Skip'],
  synced: ['=', '=', 'Synchronized'],
};

const HOST_KEY_OPTION: OptionSpecs = {
  'host-key': { type: 'string', value: '<fingerprint>', description: 'Accept this SSH host key (SHA256:...) when it is not pinned yet' },
};

const YES_OPTION: OptionSpecs = {
  yes: { type: 'boolean', short: 'y', description: 'Run without asking for confirmation' },
};

const PREVIEW_OPTION: OptionSpecs = {
  preview: { type: 'string', value: '<mode>', description: 'Show the preview in the terminal UI (tui), your editor, plain prompts, or print it (none)' },
};

/** A path for display: control and bidi characters are shown escaped, never sent to the terminal. */
const displayPath = safeLine;

/** The site-relative paths of command-line arguments, which must lie inside the site's local root. */
export function sitePaths(ctx: CommandContext, site: Site, args: readonly string[]): string[] {
  return args.map((arg) => {
    const absolute = path.resolve(ctx.io.cwd, arg);
    if (!isInside(site.localRoot, absolute)) {
      throw new UsageError(`${arg} is outside the local root of "${site.name}".`);
    }
    const relative = path.relative(site.localRoot, absolute).split(path.sep).join('/');
    return relative === '' ? ROOT : toRemotePath(relative);
  });
}

async function openSession(ctx: CommandContext, values: OptionValues): Promise<SyncSession> {
  const site = await ctx.chooseSite();
  const server = await ctx.chooseServer(site);
  return SyncSession.open({
    registry: await ctx.registry(),
    siteId: site.id,
    serverId: server.id,
    host: await cliHostAdapter(ctx),
    logger: ctx.logger,
    env: ctx.io.env,
    expectedHostKey: stringOption(values, 'host-key'),
  });
}

function checkbox(item: PlanItem): string {
  if (item.state === 'problem') {
    return '[!]';
  }
  return item.checked === true && item.action !== 'skip' ? '[x]' : '[ ]';
}

function previewTitle(plan: SyncPlan, site: Site, server: Server): string {
  return `Synchronize: ${site.name} -> ${server.name} (${protocolLabel(server.protocol)})   ${DIRECTION_TITLES[plan.direction]}${plan.deleteOrphans ? ', deleting files missing on the other side' : ''}`;
}

/** The preview as text: a title, the summary line, then one row per path with a difference. */
export function formatPreview(ctx: CommandContext, plan: SyncPlan, site: Site, server: Server): string {
  const lines = [previewTitle(plan, site, server), plan.summaryLine()];
  if (plan.items.length > 0) {
    lines.push('');
    const width = Math.max(...plan.items.map((item) => (SYMBOLS[item.action][2]).length));
    const pathWidth = Math.min(48, Math.max(...plan.items.map((item) => displayPath(item.path).length)));
    for (const item of plan.items) {
      const [symbol, ascii, label] = SYMBOLS[item.action];
      const status = item.status === '' ? '' : `  ${item.state === 'problem' || item.guarded !== undefined ? paint(item.status, 'yellow', ctx.color) : item.status}`;
      lines.push(`  ${checkbox(item)} ${ctx.ascii ? ascii : symbol} ${label.padEnd(width)}  ${displayPath(item.path).padEnd(pathWidth)}${status}`.trimEnd());
    }
  }
  return `${lines.join('\n')}\n`;
}

function printResult(ctx: CommandContext, result: SyncResult): void {
  ctx.out(`${resultLine(result)}\n`);
  for (const item of result.items) {
    if (item.outcome === 'failed' || item.outcome === 'stale') {
      ctx.out(`  ${paint(item.outcome === 'stale' ? 'stale' : 'failed', 'red', ctx.color)}  ${displayPath(item.path)}: ${safeText(item.error?.message ?? '')}\n`);
    }
  }
  if (result.unresolved > 0) {
    ctx.out(`${String(result.unresolved)} file(s) still need a decision.\n`);
  }
  if (result.cancelled) {
    ctx.out('Cancelled. Finished files are recorded; partial files were removed.\n');
  }
}

function exitFor(result: SyncResult): ExitCode {
  if (result.cancelled) {
    return ExitCode.cancelled;
  }
  return result.failed > 0 || result.unresolved > 0 ? ExitCode.incomplete : ExitCode.ok;
}

function runnable(plan: SyncPlan): number {
  return plan.items.filter((item) => item.state !== 'problem' && item.checked === true && item.action !== 'skip' && item.action !== 'resolve').length;
}

async function execute(ctx: CommandContext, session: SyncSession, plan: SyncPlan, values: OptionValues): Promise<ExitCode> {
  const result = await session.execute(plan, {
    signal: ctx.io.signal,
    allowMassDelete: flag(values, 'allow-mass-delete'),
    confirmMassDelete: ctx.interactive
      ? async (count, side) => (await ctx.prompter.ask(`This deletes ${String(count)} ${side} files. Type ${String(count)} to go ahead`)) === String(count)
      : undefined,
  });
  if (ctx.flags.json) {
    ctx.json('sync', { plan: plan.toJSON(), result });
  } else {
    printResult(ctx, result);
  }
  return exitFor(result);
}

/** The preview in the full-screen UI, which also runs the plan and shows the results. */
async function previewInTui(ctx: CommandContext, session: SyncSession, plan: SyncPlan): Promise<ExitCode> {
  const { PreviewView } = await import('../../tui/screens/preview.ts');
  const app = await startTui(ctx, () => [new PreviewView(session, plan)]);
  const result = app.outcome as SyncResult | undefined;
  if (result === undefined) {
    throw new CancelledError('Nothing was changed.');
  }
  printResult(ctx, result);
  return exitFor(result);
}

/** Shows a plan in the chosen preview mode, takes the person's choices (or `--yes`), then runs it. */
async function confirmAndRun(ctx: CommandContext, session: SyncSession, plan: SyncPlan, values: OptionValues, mode: PreviewMode): Promise<ExitCode> {
  if (mode !== 'none' && plan.items.length > 0) {
    if (mode === 'tui') {
      return previewInTui(ctx, session, plan);
    }
    let go: boolean;
    if (mode === 'plain') {
      ctx.out(`${previewTitle(plan, session.site, session.server)}\n`);
      go = await plainPreview(ctx, session, plan);
    } else {
      go = await editPlan(plan, session.site, session.server, ctx.io);
    }
    if (!go) {
      throw new CancelledError('Nothing was changed.');
    }
    if (runnable(plan) === 0) {
      ctx.out(plan.summary.resolve > 0 ? `Nothing to synchronize until the ${String(plan.summary.resolve)} decision(s) are made.\n` : 'Nothing to synchronize.\n');
      return plan.summary.resolve > 0 ? ExitCode.incomplete : ExitCode.ok;
    }
    return execute(ctx, session, plan, values);
  }
  return previewAndRun(ctx, session, plan, values);
}

/** Prints the preview, asks for confirmation in a terminal (or takes `--yes`), then runs it. */
async function previewAndRun(ctx: CommandContext, session: SyncSession, plan: SyncPlan, values: OptionValues): Promise<ExitCode> {
  const json = ctx.flags.json;
  const count = runnable(plan);
  if (!json) {
    ctx.out(formatPreview(ctx, plan, session.site, session.server));
  }
  const waiting = plan.summary.resolve;
  if (flag(values, 'dry-run') || count === 0) {
    if (json) {
      ctx.json('sync', { plan: plan.toJSON(), result: null });
    } else if (count === 0) {
      ctx.out(waiting > 0 ? `Nothing to synchronize until the ${String(waiting)} decision(s) are made.\n` : 'Nothing to synchronize.\n');
    }
    return waiting > 0 && count === 0 && !flag(values, 'dry-run') ? ExitCode.incomplete : ExitCode.ok;
  }
  if (!flag(values, 'yes')) {
    if (!ctx.interactive) {
      if (json) {
        ctx.json('sync', { plan: plan.toJSON(), result: null });
      } else {
        ctx.err('Preview only: nothing was transferred. Pass --yes to synchronize.\n');
      }
      return ExitCode.ok;
    }
    if (!(await ctx.prompter.confirm(`Synchronize ${String(count)} file(s)?`, false))) {
      throw new CancelledError('Nothing was changed.');
    }
  }
  return execute(ctx, session, plan, values);
}

function directionFrom(values: OptionValues): Direction | undefined {
  const chosen = (['put', 'get', 'both'] as const).filter((name) => flag(values, name));
  if (chosen.length > 1) {
    throw new UsageError('Pass one of --put, --get or --both.');
  }
  return chosen[0];
}

export const syncCommand: CommandSpec = {
  path: ['sync'],
  args: '[<path>...]',
  summary: 'Synchronize a site with its Remote server: preview, then transfer',
  options: {
    put: { type: 'boolean', description: 'Put newer files to the server' },
    get: { type: 'boolean', description: 'Get newer files from the server' },
    both: { type: 'boolean', description: 'Get and put newer files' },
    delete: { type: 'boolean', description: 'Delete files missing on the other side (never-synchronized ones stay unchecked)' },
    ...YES_OPTION,
    ...PREVIEW_OPTION,
    'dry-run': { type: 'boolean', description: 'Show the preview and transfer nothing' },
    'allow-mass-delete': { type: 'boolean', description: 'Run deletes past the mass-delete limit without asking' },
    'plan-out': { type: 'string', value: '<file>', description: 'Save the plan as JSON' },
    'plan-in': { type: 'string', value: '<file>', description: 'Run a saved plan, if the site and server have not changed since' },
    ...HOST_KEY_OPTION,
  },
  examples: [
    'sync-servers sync --put',
    'sync-servers sync --both --delete --dry-run',
    'sync-servers sync --put --preview editor',
    'sync-servers sync --get css img --yes',
    'sync-servers sync --put --plan-out plan.json',
  ],
  async run(ctx, { values, args }) {
    const mode = previewMode(ctx, values);
    const planIn = stringOption(values, 'plan-in');
    let saved: SavedPlan | undefined;
    if (planIn !== undefined) {
      saved = SyncPlan.fromJSON(JSON.parse(await readFile(path.resolve(ctx.io.cwd, planIn), 'utf8')) as unknown);
      if (directionFrom(values) !== undefined || args.length > 0 || flag(values, 'delete')) {
        throw new UsageError('A saved plan already holds its direction, paths and delete option.');
      }
    }
    let direction = saved?.direction ?? directionFrom(values);
    let deleteOrphans = saved?.deleteOrphans ?? flag(values, 'delete');
    if (direction === undefined) {
      if (!ctx.interactive) {
        throw new UsageError('Pass --put, --get or --both.');
      }
      direction = await ctx.prompter.choose<Direction>('Direction', [
        { label: DIRECTION_TITLES.put, value: 'put' },
        { label: DIRECTION_TITLES.get, value: 'get' },
        { label: DIRECTION_TITLES.both, value: 'both' },
      ]);
      deleteOrphans ||= await ctx.prompter.confirm(direction === 'get' ? 'Delete local files not on the remote server?' : 'Delete remote files not on the local drive?', false);
    }
    const session = await openSession(ctx, values);
    try {
      const scope = saved?.scope ?? (args.length === 0 ? { kind: 'site' as const } : { kind: 'paths' as const, paths: sitePaths(ctx, session.site, args) });
      const plan = await session.plan({ direction, deleteOrphans, scope, signal: ctx.io.signal });
      if (saved !== undefined) {
        plan.applySaved(saved);
      }
      const planOut = stringOption(values, 'plan-out');
      if (planOut !== undefined) {
        await writeFile(path.resolve(ctx.io.cwd, planOut), `${JSON.stringify(plan.toJSON(), null, 2)}\n`, { mode: 0o600 });
      }
      return await confirmAndRun(ctx, session, plan, values, mode);
    } finally {
      await session.close();
    }
  },
};

function single(direction: 'put' | 'get'): CommandSpec {
  const verb = direction === 'put' ? 'Put' : 'Get';
  return {
    path: [direction],
    args: '<path>...',
    minArgs: 1,
    summary: `${verb} files or folders now, with a preview only when a decision is needed`,
    options: { ...YES_OPTION, ...PREVIEW_OPTION, ...HOST_KEY_OPTION },
    examples: [`sync-servers ${direction} css/site.css`, `sync-servers ${direction} img --site "My Site"`],
    async run(ctx, { values, args }) {
      const mode = previewMode(ctx, values);
      const session = await openSession(ctx, values);
      try {
        const paths = sitePaths(ctx, session.site, args);
        const outcome = await session[direction](paths, { signal: ctx.io.signal });
        if (outcome.result === undefined) {
          return await confirmAndRun(ctx, session, outcome.plan, values, mode);
        }
        if (ctx.flags.json) {
          ctx.json('sync', { plan: outcome.plan.toJSON(), result: outcome.result });
        } else if (outcome.plan.items.length === 0) {
          ctx.out('Already in sync.\n');
        } else {
          printResult(ctx, outcome.result);
        }
        return exitFor(outcome.result);
      } finally {
        await session.close();
      }
    },
  };
}

export const putCommand = single('put');
export const getCommand = single('get');

const STATE_WORDS: Readonly<Record<string, string>> = {
  'local-changed': 'changed',
  'local-only': 'new',
  'local-deleted': 'deleted',
  'first-sync-local-newer': 'newer, never synchronized',
  'remote-changed': 'changed',
  'remote-only': 'new',
  'remote-deleted': 'deleted',
  'first-sync-remote-newer': 'newer, never synchronized',
  'both-changed': 'changed on both sides',
  'first-sync-conflict': 'differs, never synchronized',
  'changed-locally-deleted-remotely': 'changed locally, deleted on the server',
  'deleted-locally-changed-remotely': 'deleted locally, changed on the server',
};

export const statusCommand: CommandSpec = {
  path: ['status'],
  args: '[<path>...]',
  summary: 'Show what changed on each side since the last sync; transfers nothing',
  options: HOST_KEY_OPTION,
  examples: ['sync-servers status', 'sync-servers status css --json'],
  async run(ctx, { values, args }) {
    const session = await openSession(ctx, values);
    try {
      const scope = args.length === 0 ? undefined : { kind: 'paths' as const, paths: sitePaths(ctx, session.site, args) };
      const report = await session.status({ ...(scope === undefined ? {} : { scope }), signal: ctx.io.signal });
      if (ctx.flags.json) {
        ctx.json('status', { siteId: session.site.id, serverId: session.server.id, ...report });
        return undefined;
      }
      const last = report.lastSyncedAt === undefined ? 'never synchronized' : `last synchronized ${new Date(report.lastSyncedAt).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
      ctx.out(`${session.site.name} <-> ${describeServer(session.server)}, ${last}\n`);
      const section = (title: string, entries: readonly StatusEntry[]): void => {
        ctx.out(`\n${title} (${String(entries.length)})\n`);
        for (const entry of entries) {
          ctx.out(`  ${displayPath(entry.path)}  ${STATE_WORDS[entry.state] ?? entry.state}\n`);
        }
      };
      section('Local changes', report.local);
      section('Server changes', report.remote);
      section('Conflicts', report.conflicts);
      if (report.problems.length > 0) {
        ctx.out(`\nCannot be synchronized (${String(report.problems.length)})\n`);
        for (const problem of report.problems) {
          ctx.out(`  ${displayPath(problem.path)}  ${problem.status}\n`);
        }
      }
      ctx.out(`\nIn sync: ${String(report.inSync)} file(s).\n`);
      return undefined;
    } finally {
      await session.close();
    }
  },
};

export const markSyncedCommand: CommandSpec = {
  path: ['mark-synced'],
  args: '<path>...',
  minArgs: 1,
  summary: 'Record files as in sync without transferring them',
  options: HOST_KEY_OPTION,
  examples: ['sync-servers mark-synced css/site.css', 'sync-servers mark-synced .'],
  async run(ctx, { values, args }) {
    const session = await openSession(ctx, values);
    try {
      const count = await session.markSynchronized(sitePaths(ctx, session.site, args), ctx.io.signal);
      if (ctx.flags.json) {
        ctx.json('mark-synced', { marked: count });
      } else {
        ctx.out(`Marked ${String(count)} file(s) as synchronized.\n`);
      }
      return undefined;
    } finally {
      await session.close();
    }
  },
};

export const stateResetCommand: CommandSpec = {
  path: ['state', 'reset'],
  summary: 'Forget the sync records of a site and server; the next sync starts from scratch',
  options: YES_OPTION,
  examples: ['sync-servers state reset', 'sync-servers state reset --site "My Site" --yes'],
  async run(ctx, { values }) {
    const session = await openSession(ctx, values);
    try {
      const target = `"${session.site.name}: ${session.server.name}"`;
      if (!flag(values, 'yes')) {
        if (!ctx.interactive) {
          throw new UsageError('Pass --yes to reset the sync records without a terminal.');
        }
        if (!(await ctx.prompter.confirm(`Forget the sync records of ${target}?`, false))) {
          throw new CancelledError('Nothing was changed.');
        }
      }
      await session.resetState();
      ctx.out(`Forgot the sync records of ${target}. The next sync compares both sides from scratch.\n`);
      return undefined;
    } finally {
      await session.close();
    }
  },
};

const DIFF_LIMIT = 5 * 1024 * 1024;

async function describeFile(file: string | undefined, size: number): Promise<{ text: string | undefined; sha256: string | undefined }> {
  if (file === undefined) {
    return { text: '', sha256: undefined };
  }
  const data = await readFile(file);
  const sha256 = createHash('sha256').update(data).digest('hex');
  const binary = size > DIFF_LIMIT || data.subarray(0, 8192).includes(0);
  return { text: binary ? undefined : data.toString('utf8'), sha256 };
}

export const diffCommand: CommandSpec = {
  path: ['diff'],
  args: '<path>',
  minArgs: 1,
  maxArgs: 1,
  summary: 'Show how the local and remote copies of a file differ',
  options: HOST_KEY_OPTION,
  examples: ['sync-servers diff css/site.css'],
  async run(ctx, { values, args }) {
    const session = await openSession(ctx, values);
    try {
      const [target] = sitePaths(ctx, session.site, args);
      if (target === undefined || target === ROOT) {
        throw new UsageError('Name a file inside the site.');
      }
      const comparison = await session.compare(target, ctx.io.signal);
      try {
        const local = await describeFile(comparison.local?.file, comparison.local?.size ?? 0);
        const remote = await describeFile(comparison.remote?.file, comparison.remote?.size ?? 0);
        const identical = comparison.local !== undefined && comparison.remote !== undefined && local.sha256 === remote.sha256;
        const binary = local.text === undefined || remote.text === undefined;
        const patch =
          identical || binary
            ? undefined
            : createTwoFilesPatch(`local/${comparison.path}`, `remote/${comparison.path}`, local.text ?? '', remote.text ?? '');
        if (ctx.flags.json) {
          const side = (info: typeof comparison.local, hash: string | undefined) => (info === undefined ? null : { size: info.size, mtimeMs: info.mtimeMs ?? null, sha256: hash });
          ctx.json('diff', { path: comparison.path, identical, binary, local: side(comparison.local, local.sha256), remote: side(comparison.remote, remote.sha256), patch: patch ?? null });
          return undefined;
        }
        if (identical) {
          ctx.out('The local and remote copies are identical.\n');
        } else if (patch !== undefined) {
          // File contents are shown with their control characters escaped, so a file cannot drive the terminal.
          ctx.out(safeText(patch));
        } else {
          const row = (info: typeof comparison.local, hash: string | undefined): string =>
            info === undefined ? 'missing' : `${String(info.size)} bytes, ${info.mtimeMs === undefined ? 'time unknown' : new Date(info.mtimeMs).toISOString()}, sha256 ${hash ?? ''}`;
          ctx.out(formatPairs([
            ['Local', row(comparison.local, local.sha256)],
            ['Remote', row(comparison.remote, remote.sha256)],
          ]));
        }
        return undefined;
      } finally {
        await comparison.dispose();
      }
    } finally {
      await session.close();
    }
  },
};
