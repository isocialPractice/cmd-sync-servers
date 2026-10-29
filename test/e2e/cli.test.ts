import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../../src/version.ts';

// The built CLI, as `npm install` would run it.
const cli = fileURLToPath(new URL('../../out/cli/main.js', import.meta.url));
const home = mkdtempSync(join(tmpdir(), 'sync-servers-e2e-'));

after(() => {
  rmSync(home, { recursive: true, force: true });
});

function runCli(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SYNC_SERVERS_HOME: home, NO_COLOR: '1' },
  });
}

test('the built CLI starts with a node shebang', () => {
  assert.ok(readFileSync(cli, 'utf8').startsWith('#!/usr/bin/env node\n'));
});

test('--version prints the version and exits 0', () => {
  const result = runCli('--version');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${VERSION}\n`);
  assert.equal(result.stderr, '');
});

test('--help prints usage and exits 0', () => {
  const result = runCli('--help');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Usage:$/m);
  assert.equal(result.stderr, '');
});

test('no arguments prints usage and exits 0', () => {
  const result = runCli();
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Usage:$/m);
});

test('an unknown option is a usage error: exit 2, message on stderr only', () => {
  const result = runCli('--no-such-option');
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^sync-servers: /);
  assert.match(result.stderr, /--help/);
});

test('an unknown command is a usage error: exit 2', () => {
  const result = runCli('no-such-command');
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /unknown command "no-such-command"/);
});
