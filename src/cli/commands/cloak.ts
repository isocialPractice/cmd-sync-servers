import { existsSync } from 'node:fs';
import path from 'node:path';
import { isInside } from '../../config/registry.ts';
import type { Site } from '../../config/schema.ts';
import { flag, type CommandSpec, type OptionValues } from '../command.ts';
import type { CommandContext } from '../context.ts';
import { UsageError } from '../errors.ts';
import { formatPairs } from '../output.ts';

interface Targets {
  paths: string[];
  patterns: string[];
}

/** The site-relative, `/`-separated form of a path inside the local root. */
function siteRelative(site: Site, absolute: string, original: string): string {
  if (!isInside(site.localRoot, absolute)) {
    throw new UsageError(`${original} is outside the local root of "${site.name}".`);
  }
  const relative = path.relative(site.localRoot, absolute).split(path.sep).join('/');
  if (relative === '') {
    throw new UsageError('The local root itself cannot be cloaked. Turn cloaking off with --disable instead.');
  }
  return relative;
}

/**
 * Sorts arguments into paths and patterns: an argument naming an existing
 * file or folder inside the local root is a path, anything else is a pattern
 * (several patterns may be given space-separated). `--path` and `--pattern` force one.
 */
function classify(ctx: CommandContext, site: Site, args: readonly string[], values: OptionValues): Targets {
  if (flag(values, 'path') && flag(values, 'pattern')) {
    throw new UsageError('Pass --path or --pattern, not both.');
  }
  const targets: Targets = { paths: [], patterns: [] };
  for (const arg of args) {
    const absolute = path.resolve(ctx.io.cwd, arg);
    const looksLikePath = existsSync(absolute) && isInside(site.localRoot, absolute);
    if (flag(values, 'path') || (!flag(values, 'pattern') && looksLikePath)) {
      targets.paths.push(siteRelative(site, absolute, arg));
    } else {
      targets.patterns.push(...arg.split(/\s+/).filter((pattern) => pattern !== ''));
    }
  }
  return targets;
}

function showCloaking(ctx: CommandContext, site: Site): void {
  const { enabled, patterns, paths } = site.cloaking;
  if (ctx.flags.json) {
    ctx.json('cloaking', { siteId: site.id, enabled, patterns, paths });
    return;
  }
  ctx.out(
    formatPairs([
      ['Cloaking', enabled ? 'on' : 'off'],
      ['Patterns', patterns.length === 0 ? '(none)' : patterns.join('  ')],
      ['Paths', paths.length === 0 ? '(none)' : paths.join('  ')],
    ]),
  );
}

const TARGET_OPTIONS = {
  path: { type: 'boolean', description: 'Treat every argument as a path inside the local root' },
  pattern: { type: 'boolean', description: 'Treat every argument as a pattern' },
} as const;

export const cloakCommand: CommandSpec = {
  path: ['cloak'],
  args: '[<path or pattern>...]',
  summary: 'Cloak files and folders so no operation touches them, or list what is cloaked',
  options: {
    ...TARGET_OPTIONS,
    list: { type: 'boolean', description: 'Show the cloaking settings' },
    enable: { type: 'boolean', description: 'Turn cloaking on for the site' },
    disable: { type: 'boolean', description: 'Turn cloaking off for the site, keeping its patterns' },
  },
  examples: ['sync-servers cloak .psd "archive*" node_modules/', 'sync-servers cloak img/raw', 'sync-servers cloak --list'],
  async run(ctx, { values, args }) {
    const site = await ctx.chooseSite();
    if (flag(values, 'enable') && flag(values, 'disable')) {
      throw new UsageError('Pass --enable or --disable, not both.');
    }
    const toggling = flag(values, 'enable') || flag(values, 'disable');
    if (flag(values, 'list') || (args.length === 0 && !toggling)) {
      showCloaking(ctx, site);
      return undefined;
    }
    const targets = classify(ctx, site, args, values);
    const updated = await (await ctx.registry()).update(site.id, (draft) => {
      if (toggling) {
        draft.cloaking.enabled = flag(values, 'enable');
      }
      for (const item of targets.paths) {
        if (!draft.cloaking.paths.includes(item)) {
          draft.cloaking.paths.push(item);
        }
      }
      for (const item of targets.patterns) {
        if (!draft.cloaking.patterns.includes(item)) {
          draft.cloaking.patterns.push(item);
        }
      }
    });
    if (ctx.flags.json) {
      showCloaking(ctx, updated);
      return undefined;
    }
    for (const item of targets.paths) {
      ctx.out(`Cloaked path: ${item}\n`);
    }
    for (const item of targets.patterns) {
      ctx.out(`Cloaked pattern: ${item}\n`);
    }
    if (toggling) {
      ctx.out(`Cloaking is ${updated.cloaking.enabled ? 'on' : 'off'} for "${site.name}".\n`);
    } else if (!updated.cloaking.enabled) {
      ctx.out(`Cloaking is off for "${site.name}". Turn it on with "sync-servers cloak --enable".\n`);
    }
    return undefined;
  },
};

export const uncloakCommand: CommandSpec = {
  path: ['uncloak'],
  args: '<path or pattern>...',
  minArgs: 1,
  summary: 'Remove cloaked paths or patterns',
  options: TARGET_OPTIONS,
  examples: ['sync-servers uncloak .psd', 'sync-servers uncloak img/raw'],
  async run(ctx, { values, args }) {
    const site = await ctx.chooseSite();
    const removed: string[] = [];
    const missing: string[] = [];
    const updated = await (await ctx.registry()).update(site.id, (draft) => {
      for (const arg of args) {
        const asPattern = !flag(values, 'path') && draft.cloaking.patterns.includes(arg.trim());
        if (asPattern) {
          draft.cloaking.patterns = draft.cloaking.patterns.filter((pattern) => pattern !== arg.trim());
          removed.push(`pattern: ${arg.trim()}`);
          continue;
        }
        const absolute = path.resolve(ctx.io.cwd, arg);
        const relative =
          !flag(values, 'pattern') && isInside(site.localRoot, absolute) ? siteRelative(site, absolute, arg) : undefined;
        if (relative !== undefined && draft.cloaking.paths.includes(relative)) {
          draft.cloaking.paths = draft.cloaking.paths.filter((item) => item !== relative);
          removed.push(`path: ${relative}`);
        } else {
          missing.push(arg);
        }
      }
    });
    if (ctx.flags.json) {
      showCloaking(ctx, updated);
      return undefined;
    }
    for (const item of removed) {
      ctx.out(`Uncloaked ${item}\n`);
    }
    for (const item of missing) {
      ctx.err(`Not cloaked: ${item}\n`);
    }
    return undefined;
  },
};
