// Fails when `npm pack` would ship anything outside the `files` allowlist, or
// anything that looks like a test fixture, a key or local working material.
import { spawnSync } from 'node:child_process';
import { checkPackPaths } from './lib/pack-rules.ts';

interface PackResult {
  files: { path: string }[];
}

const npmCli = process.env.npm_execpath;
if (npmCli === undefined || npmCli === '') {
  process.stderr.write('pack-check: run it through "npm run pack:check".\n');
  process.exit(2);
}

const result = spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts'], {
  encoding: 'utf8',
});
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(1);
}

const [pack] = JSON.parse(result.stdout) as PackResult[];
if (pack === undefined) {
  process.stderr.write('pack-check: npm pack returned no result.\n');
  process.exit(1);
}

const paths = pack.files.map((file) => file.path);
const problems = checkPackPaths(paths);
if (problems.length > 0) {
  process.stderr.write(`pack-check: ${String(problems.length)} problem(s)\n`);
  for (const problem of problems) {
    process.stderr.write(`  ${problem}\n`);
  }
  process.exit(1);
}
process.stdout.write(`pack-check: ${String(paths.length)} files, all allowlisted.\n`);
