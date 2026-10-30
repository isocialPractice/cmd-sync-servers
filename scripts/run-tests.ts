// Runs the node:test files of the named layers (test/<layer>/**/*.test.ts) in
// one `node --test` process. A layer with no tests yet is reported and passes.
// SYNC_SERVERS_HOME points at a fresh temp folder and SYNC_SERVERS_KEYRING is
// off, so no test can reach the real master list or the OS credential store
// even if it forgets to set its own. `--coverage` also writes
// coverage/lcov.info for scripts/coverage-check.ts.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const coverage = argv.includes('--coverage');
const layers = argv.filter((arg) => arg !== '--coverage');
if (layers.length === 0) {
  process.stderr.write('Usage: node scripts/run-tests.ts [--coverage] <layer>...\n');
  process.exit(2);
}

const files: string[] = [];
for (const layer of layers) {
  const dir = `test/${layer}`;
  const found = existsSync(dir)
    ? readdirSync(dir, { recursive: true, encoding: 'utf8' })
        .filter((name) => name.endsWith('.test.ts'))
        .map((name) => `${dir}/${name.replaceAll('\\', '/')}`)
        .sort()
    : [];
  if (found.length === 0) {
    process.stdout.write(`No tests in ${dir}.\n`);
  }
  files.push(...found);
}

if (files.length === 0) {
  process.exit(0);
}

const coverageFlags = coverage
  ? [
      '--experimental-test-coverage',
      '--test-coverage-include=src/**',
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      '--test-reporter=lcov',
      '--test-reporter-destination=coverage/lcov.info',
    ]
  : [];
if (coverage) {
  mkdirSync('coverage', { recursive: true });
}

const home = mkdtempSync(join(tmpdir(), 'sync-servers-test-'));
try {
  const result = spawnSync(process.execPath, ['--test', ...coverageFlags, ...files], {
    stdio: 'inherit',
    env: { ...process.env, SYNC_SERVERS_HOME: home, SYNC_SERVERS_KEYRING: 'off' },
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}
