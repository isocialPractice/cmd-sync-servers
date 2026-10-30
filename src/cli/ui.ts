import type { App, View } from '../tui/app.ts';
import type { TuiServices } from '../tui/services.ts';
import type { Theme } from '../tui/style.ts';
import type { TerminalInput } from '../tui/terminal.ts';
import { choiceOption, flag, type OptionValues } from './command.ts';
import type { CommandContext } from './context.ts';
import { UsageError } from './errors.ts';

export const PREVIEW_MODES = ['tui', 'editor', 'plain', 'none'] as const;
export type PreviewMode = (typeof PREVIEW_MODES)[number];

/** Chooses how `sync` shows its preview when `--preview` is not given: `tui`, `editor`, `plain` or `none`. */
export const UI_ENV = 'SYNC_SERVERS_UI';

/** True when stdin and stdout are a terminal the full-screen UI can drive. */
export function canRunTui(ctx: CommandContext): boolean {
  return ctx.interactive && ctx.io.stdout.isTTY === true && typeof ctx.io.stdin.setRawMode === 'function';
}

/** Plain mode: `--plain`, `TERM=dumb`, or a terminal the full-screen UI cannot drive. */
export function wantsPlain(ctx: CommandContext): boolean {
  return ctx.flags.plain || ctx.io.env.TERM === 'dumb' || !canRunTui(ctx);
}

/**
 * How `sync`, `put` and `get` show a preview: `--preview`, else `none` when
 * nobody can answer (`--yes`, `--dry-run`, `--json` or no terminal), else
 * `SYNC_SERVERS_UI`, else the full-screen UI, or plain mode where it cannot run.
 */
export function previewMode(ctx: CommandContext, values: OptionValues): PreviewMode {
  const explicit = choiceOption(values, 'preview', PREVIEW_MODES);
  if (explicit !== undefined) {
    if (explicit !== 'none') {
      if (flag(values, 'yes')) {
        throw new UsageError('--yes runs without a preview. Drop --yes, or use --preview none.');
      }
      if (!ctx.interactive) {
        throw new UsageError(`--preview ${explicit} needs a terminal. Use --preview none, with --yes to synchronize.`);
      }
      if (ctx.flags.json && explicit !== 'editor') {
        throw new UsageError(`--json keeps stdout for one document, so --preview ${explicit} cannot draw there. Use --preview editor or none.`);
      }
    }
    return explicit === 'tui' && wantsPlain(ctx) ? 'plain' : explicit;
  }
  if (flag(values, 'yes') || flag(values, 'dry-run') || ctx.flags.json || !ctx.interactive) {
    return 'none';
  }
  const fromEnv = ctx.io.env[UI_ENV]?.trim().toLowerCase();
  const mode: PreviewMode = (PREVIEW_MODES as readonly string[]).includes(fromEnv ?? '') ? (fromEnv as PreviewMode) : 'tui';
  return mode === 'tui' && wantsPlain(ctx) ? 'plain' : mode;
}

export function tuiTheme(ctx: CommandContext): Theme {
  return { color: ctx.color, ascii: ctx.ascii };
}

export function tuiServices(ctx: CommandContext): TuiServices {
  return {
    registry: () => ctx.registry(),
    credentialStore: () => ctx.credentialStore(),
    logger: ctx.logger,
    env: ctx.io.env,
    cwd: ctx.io.cwd,
    platform: ctx.io.platform,
  };
}

/** Runs the full-screen UI on the command's terminal, opening `views` bottom first. */
export async function startTui(ctx: CommandContext, views: (services: TuiServices) => readonly View[]): Promise<App> {
  const { runTui } = await import('../tui/run.ts');
  return runTui({
    input: ctx.io.stdin as unknown as TerminalInput,
    output: ctx.io.stdout,
    theme: tuiTheme(ctx),
    views: views(tuiServices(ctx)),
    hookProcess: ctx.io.stdin === (process.stdin as unknown),
  });
}
