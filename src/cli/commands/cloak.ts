import { existsSync } from 'node:fs';
import path from 'node:path';
import { isInside } from '../../sync/paths.ts';
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

/** Patterns as typed: several may be given in one argument, separated by spaces. */
function patternsOf(args: readonly string[]): string[] {
  return args.flatMap((arg) => arg.split(/\s+/).filter((pattern) => pattern !== ''));
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
      targets.patterns.push(...patternsOf([arg]));
    }
  }
  return targets;
}

/** Whether a site uses the global patterns: unless it turned them off. */
function usesGlobal(site: Site): boolean {
  return site.cloaking.useGlobalPatterns !== false;
}

async function showCloaking(ctx: CommandContext, site: Site): Promise<void> {
  const { enabled, patterns, paths } = site.cloaking;
  const global = (await ctx.registry()).globalCloaking.patterns;
  if (ctx.flags.json) {
    ctx.json('cloaking', { siteId: site.id, enabled, useGlobalPatterns: usesGlobal(site), globalPatterns: usesGlobal(site) ? global : [], patterns, paths });
    return;
  }
  ctx.out(
    formatPairs([
      ['Cloaking', enabled ? 'on' : 'off'],
      ['Global patterns', !usesGlobal(site) ? 'not used by this site' : global.length === 0 ? '(none)' : global.join('  ')],
      ['Patterns', patterns.length === 0 ? '(none)' : patterns.join('  ')],
      ['Paths', paths.length === 0 ? '(none)' : paths.join('  ')],
    ]),
  );
}

function showGlobal(ctx: CommandContext, patterns: readonly string[]): void {
  if (ctx.flags.json) {
    ctx.json('cloaking-global', { patterns });
    return;
  }
  ctx.out(formatPairs([['Global patterns', patterns.length === 0 ? '(none)' : patterns.join('  ')]]));
}

/** Options that act on one site, which `--global` refuses. */
const ONE_SITE = ['path', 'enable', 'disable', 'use-global', 'ignore-global'] as const;

/** Refuses what cannot go with `--global`, which changes every site. */
function checkGlobal(ctx: CommandContext, values: OptionValues): void {
  if (ctx.flags.site !== undefined) {
    throw new UsageError('--global changes every site, so it cannot go with --site. Drop --site, or drop --global.');
  }
  for (const name of ONE_SITE) {
    if (flag(values, name)) {
      throw new UsageError(`--${name} acts on one site, so it cannot go with --global. Drop --${name}, or drop --global.`);
    }
  }
}

const TARGET_OPTIONS = {
  path: { type: 'boolean', description: 'Treat every argument as a path inside the local root' },
  pattern: { type: 'boolean', description: 'Treat every argument as a pattern' },
} as const;

const GLOBAL_OPTION = { type: 'boolean', description: 'Work on the global patterns, which every site uses before its own' } as const;

export const cloakCommand: CommandSpec = {
  path: ['cloak'],
  args: '[<path or pattern>...]',
  summary: 'Cloak files and folders so no operation touches them, in one site or every site, or list what is cloaked',
  options: {
    ...TARGET_OPTIONS,
    global: GLOBAL_OPTION,
    list: { type: 'boolean', description: 'Show the cloaking settings' },
    enable: { type: 'boolean', description: 'Turn cloaking on for the site' },
    disable: { type: 'boolean', description: 'Turn cloaking off for the site, keeping its patterns' },
    'use-global': { type: 'boolean', description: 'Use the global patterns in the site, as sites do unless told otherwise' },
    'ignore-global': { type: 'boolean', description: 'Stop using the global patterns in the site' },
  },
  examples: [
    'sync-servers cloak .psd "archive*" node_modules/',
    'sync-servers cloak img/raw',
    'sync-servers cloak --global .git/ node_modules/',
    'sync-servers cloak --list',
  ],
  async run(ctx, { values, args }) {
    if (flag(values, 'global')) {
      checkGlobal(ctx, values);
      const registry = await ctx.registry();
      if (flag(values, 'list') || args.length === 0) {
        showGlobal(ctx, registry.globalCloaking.patterns);
        return undefined;
      }
      const patterns = patternsOf(args);
      const updated = await registry.updateGlobalCloaking((cloaking) => {
        for (const item of patterns) {
          if (!cloaking.patterns.includes(item)) {
            cloaking.patterns.push(item);
          }
        }
      });
      if (ctx.flags.json) {
        showGlobal(ctx, updated.patterns);
        return undefined;
      }
      for (const item of patterns) {
        ctx.out(`Cloaked in every site: ${item}\n`);
      }
      return undefined;
    }
    const site = await ctx.chooseSite();
    if (flag(values, 'enable') && flag(values, 'disable')) {
      throw new UsageError('Pass --enable or --disable, not both.');
    }
    if (flag(values, 'use-global') && flag(values, 'ignore-global')) {
      throw new UsageError('Pass --use-global or --ignore-global, not both.');
    }
    const toggling = flag(values, 'enable') || flag(values, 'disable');
    const choosingGlobal = flag(values, 'use-global') || flag(values, 'ignore-global');
    if (flag(values, 'list') || (args.length === 0 && !toggling && !choosingGlobal)) {
      await showCloaking(ctx, site);
      return undefined;
    }
    const targets = classify(ctx, site, args, values);
    const updated = await (await ctx.registry()).update(site.id, (draft) => {
      if (toggling) {
        draft.cloaking.enabled = flag(values, 'enable');
      }
      if (flag(values, 'ignore-global')) {
        draft.cloaking.useGlobalPatterns = false;
      } else if (flag(values, 'use-global')) {
        delete draft.cloaking.useGlobalPatterns;
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
      await showCloaking(ctx, updated);
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
    if (choosingGlobal) {
      ctx.out(`"${site.name}" ${usesGlobal(updated) ? 'uses' : 'does not use'} the global cloaking patterns.\n`);
    }
    return undefined;
  },
};

export const uncloakCommand: CommandSpec = {
  path: ['uncloak'],
  args: '<path or pattern>...',
  minArgs: 1,
  summary: 'Remove cloaked paths or patterns, from one site or from the global patterns',
  options: { ...TARGET_OPTIONS, global: GLOBAL_OPTION },
  examples: ['sync-servers uncloak .psd', 'sync-servers uncloak img/raw', 'sync-servers uncloak --global node_modules/'],
  async run(ctx, { values, args }) {
    if (flag(values, 'global')) {
      checkGlobal(ctx, values);
      const patterns = patternsOf(args);
      const missing: string[] = [];
      const updated = await (await ctx.registry()).updateGlobalCloaking((cloaking) => {
        for (const item of patterns) {
          if (cloaking.patterns.includes(item)) {
            cloaking.patterns = cloaking.patterns.filter((pattern) => pattern !== item);
          } else {
            missing.push(item);
          }
        }
      });
      if (ctx.flags.json) {
        showGlobal(ctx, updated.patterns);
        return undefined;
      }
      for (const item of patterns.filter((pattern) => !missing.includes(pattern))) {
        ctx.out(`Uncloaked in every site: ${item}\n`);
      }
      for (const item of missing) {
        ctx.err(`Not a global pattern: ${item}\n`);
      }
      return undefined;
    }
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
      await showCloaking(ctx, updated);
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
