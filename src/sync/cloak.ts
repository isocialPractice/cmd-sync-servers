import ignore, { type Ignore } from 'ignore';
import type { Site } from '../config/schema.ts';

/**
 * Turns a cloaking pattern as Dreamweaver users write it into gitignore
 * syntax: a token that starts with a dot and has no `*` or `/` is a suffix
 * (`.psd` cloaks every name ending in `.psd`); everything else already is
 * gitignore syntax (`archive*`, `node_modules/`, `/drafts/`, `!keep.psd`).
 */
export function cloakPatternToGitignore(pattern: string): string {
  const negated = pattern.startsWith('!');
  const body = negated ? pattern.slice(1) : pattern;
  const suffix = body.startsWith('.') && !body.includes('*') && !body.includes('/');
  return `${negated ? '!' : ''}${suffix ? `*${body}` : body}`;
}

/** Splits patterns entered space-separated or one per line into single patterns. */
export function splitPatterns(text: string): string[] {
  return text.split(/\s+/).filter((pattern) => pattern !== '');
}

/** A site's cloaking in one line: `on, 1 pattern(s), 1 path(s), 4 global pattern(s)`. */
export function cloakingSummary(cloaking: Site['cloaking'], globalPatterns: readonly string[]): string {
  const global = cloaking.useGlobalPatterns === false ? 'global patterns not used' : `${String(globalPatterns.length)} global pattern(s)`;
  return `${cloaking.enabled ? 'on' : 'off'}, ${String(cloaking.patterns.length)} pattern(s), ${String(cloaking.paths.length)} path(s), ${global}`;
}

/** Decides whether a site-relative path is cloaked. Folders are passed with `isDir` so `name/` patterns apply. */
export interface Cloak {
  /** False when the site turned cloaking off; nothing is then cloaked. */
  readonly enabled: boolean;
  /** True when every operation should skip `path`. */
  isCloaked(path: string, isDir: boolean): boolean;
}

/**
 * The cloak of a site: the global patterns, unless the site turns them off,
 * then its own patterns, matched together with gitignore semantics so a
 * site's `!pattern` re-includes what a global pattern cloaks; and its single
 * cloaked paths, which cloak everything beneath them. A pattern that starts
 * with `/` is anchored at the site's local root. Cloaked paths are never
 * scanned, listed, transferred or deleted, on either side.
 */
export function siteCloak(site: Pick<Site, 'cloaking'>, platform: NodeJS.Platform = process.platform, globalPatterns: readonly string[] = []): Cloak {
  const { enabled, patterns, paths } = site.cloaking;
  const ignoreCase = platform === 'win32' || platform === 'darwin';
  const all = [...(site.cloaking.useGlobalPatterns === false ? [] : globalPatterns), ...patterns];
  const matcher: Ignore = ignore({ ignorecase: ignoreCase }).add(all.flatMap(splitPatterns).map(cloakPatternToGitignore));
  const fold = (value: string): string => (ignoreCase ? value.toLowerCase() : value);
  const cloakedPaths = paths.map((item) => fold(item.replace(/^\/+|\/+$/g, ''))).filter((item) => item !== '');
  return {
    enabled,
    isCloaked(target, isDir) {
      if (!enabled || target === '') {
        return false;
      }
      const folded = fold(target);
      if (cloakedPaths.some((item) => folded === item || folded.startsWith(`${item}/`))) {
        return true;
      }
      return matcher.ignores(isDir ? `${target}/` : target);
    },
  };
}
