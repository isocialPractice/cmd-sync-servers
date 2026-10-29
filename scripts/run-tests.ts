// Runs the node:test files of the named layers (test/<layer>/**/*.test.ts) in
// one `node --test` process. A layer with no tests yet is reported and passes.
// SYNC_SERVERS_HOME points at a fresh temp folder, so no test can reach the
// real master list even if it forgets to set its own.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const layers = process.argv.slice(2);
if (layers.length === 0) {
  process.stderr.write('Usage: node scripts/run-tests.ts <layer>...\n');
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

const home = mkdtempSync(join(tmpdir(), 'sync-servers-test-'));
try {
  const result = spawnSync(process.execPath, ['--test', ...files], {
    stdio: 'inherit',
    env: { ...process.env, SYNC_SERVERS_HOME: home },
  });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}
