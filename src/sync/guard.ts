import ignore from 'ignore';
import type { Site } from '../config/schema.ts';

/**
 * Files that are almost never meant to be published: environment files,
 * private keys, password databases and version-control or credential folders.
 * A match is listed unchecked, never hidden.
 */
export const DEFAULT_GUARD_PATTERNS: readonly string[] = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.kdbx',
  'id_rsa*',
  'id_ecdsa*',
  'id_ed25519*',
  '.git/',
  '.hg/',
  '.svn/',
  '.ssh/',
  '.aws/',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '*.sqlite-journal',
];

/** Tells which files are sensitive, so a preview lists them unchecked. */
export interface Guard {
  /** The first pattern a site-relative file path matches, or `undefined`. */
  match(path: string): string | undefined;
}

/** The sensitive-file guard of a site: the built-in patterns plus the site's own, unless the site turns it off. */
export function siteGuard(site: Pick<Site, 'sync'>, platform: NodeJS.Platform = process.platform): Guard {
  const { enabled, patterns } = site.sync.guard;
  if (!enabled) {
    return { match: () => undefined };
  }
  const ignoreCase = platform === 'win32' || platform === 'darwin';
  const rules = [...DEFAULT_GUARD_PATTERNS, ...patterns].map((pattern) => ({ pattern, matcher: ignore({ ignorecase: ignoreCase }).add(pattern) }));
  return {
    match(target) {
      return rules.find((rule) => rule.matcher.ignores(target))?.pattern;
    },
  };
}
