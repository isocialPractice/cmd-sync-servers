// What must agree before a release is built: the tag, package.json,
// package-lock.json, src/version.ts and a CHANGELOG.md heading.

export interface ReleaseFiles {
  readonly packageJson: string;
  readonly packageLock: string;
  readonly versionTs: string;
  readonly changelog: string;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Every reason the tag cannot be released from these files; empty when it can. */
export function releaseProblems(tag: string, files: ReleaseFiles): string[] {
  const problems: string[] = [];
  const manifest = JSON.parse(files.packageJson) as { version?: unknown };
  const lock = JSON.parse(files.packageLock) as { version?: unknown; packages?: Record<string, { version?: unknown }> };
  const version = typeof manifest.version === 'string' ? manifest.version : '';
  if (!SEMVER.test(version)) {
    problems.push(`package.json has no valid version (${JSON.stringify(manifest.version)}).`);
  }
  if (tag !== `v${version}`) {
    problems.push(`The tag ${JSON.stringify(tag)} is not "v${version}", the version in package.json.`);
  }
  if (lock.version !== version || lock.packages?.['']?.version !== version) {
    problems.push(`package-lock.json does not have version ${version} in both places.`);
  }
  if (!files.versionTs.includes(`export const VERSION = '${version}';`)) {
    problems.push(`src/version.ts does not export VERSION = '${version}'.`);
  }
  if (!new RegExp(`^## \\[${version.replaceAll('.', '\\.')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm').test(files.changelog)) {
    problems.push(`CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" heading.`);
  }
  if (!/-alpha\./.test(version)) {
    problems.push(`${version} is not an alpha; stable releases are not set up yet.`);
  }
  return problems;
}
