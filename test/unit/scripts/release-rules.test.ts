import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { releaseProblems, type ReleaseFiles } from '../../../scripts/lib/release-rules.ts';

function files(version: string, overrides: Partial<ReleaseFiles> = {}): ReleaseFiles {
  return {
    packageJson: JSON.stringify({ name: 'sample-app', version }),
    packageLock: JSON.stringify({ name: 'sample-app', version, packages: { '': { name: 'sample-app', version } } }),
    versionTs: `export const VERSION = '${version}';\n`,
    changelog: `# Changelog\n\n## [${version}] - 2026-10-29\n\n### Added\n`,
    ...overrides,
  };
}

test('a tag that matches every version file and the changelog can be released', () => {
  assert.deepEqual(releaseProblems('v1.0.0', files('1.0.0')), []);
  assert.deepEqual(releaseProblems('v1.1.0-alpha.0', files('1.1.0-alpha.0')), []);
});

test('the repository as committed is releasable at its own version', () => {
  const read = (name: string): string => readFileSync(new URL(`../../../${name}`, import.meta.url), 'utf8');
  const version = (JSON.parse(read('package.json')) as { version: string }).version;
  const repo: ReleaseFiles = {
    packageJson: read('package.json'),
    packageLock: read('package-lock.json'),
    versionTs: read('src/version.ts'),
    changelog: read('CHANGELOG.md'),
  };
  assert.deepEqual(releaseProblems(`v${version}`, repo), []);
});

test('every disagreement is reported', () => {
  const version = '1.0.0-alpha.0.6.0';
  assert.deepEqual(releaseProblems('1.0.0-alpha.0.6.0', files(version)), [`The tag "1.0.0-alpha.0.6.0" is not "v${version}", the version in package.json.`]);
  assert.match(releaseProblems(`v${version}`, files(version, { packageLock: JSON.stringify({ version, packages: { '': { version: '1.0.0-alpha.0.5.0' } } }) })).join('\n'), /package-lock\.json/);
  assert.match(releaseProblems(`v${version}`, files(version, { versionTs: "export const VERSION = '1.0.0-alpha.0.5.0';" })).join('\n'), /src\/version\.ts/);
  assert.match(releaseProblems(`v${version}`, files(version, { changelog: '## [1.0.0-alpha.0.5.0] - 2026-10-28\n' })).join('\n'), /CHANGELOG\.md/);
  assert.match(releaseProblems(`v${version}`, files(version, { changelog: `## [${version}]\n` })).join('\n'), /YYYY-MM-DD/);
  assert.match(releaseProblems('v', files('one')).join('\n'), /no valid version/);
});
