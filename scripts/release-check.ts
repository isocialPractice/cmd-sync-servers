// Fails a release whose tag, version files and changelog disagree.
// Usage: node scripts/release-check.ts v1.0.0
import { readFileSync } from 'node:fs';
import { releaseProblems } from './lib/release-rules.ts';

const tag = process.argv[2] ?? '';
const problems = releaseProblems(tag, {
  packageJson: readFileSync('package.json', 'utf8'),
  packageLock: readFileSync('package-lock.json', 'utf8'),
  versionTs: readFileSync('src/version.ts', 'utf8'),
  changelog: readFileSync('CHANGELOG.md', 'utf8'),
});
if (problems.length > 0) {
  process.stderr.write(`release-check: ${String(problems.length)} problem(s)\n`);
  for (const problem of problems) {
    process.stderr.write(`  ${problem}\n`);
  }
  process.exit(1);
}
process.stdout.write(`release-check: ${tag} matches package.json, package-lock.json, src/version.ts and CHANGELOG.md.\n`);
