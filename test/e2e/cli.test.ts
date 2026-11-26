import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../../src/version.ts';
import { tempDir } from '../helpers/cli.ts';

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

test('the built program lists the files of a time range, with both of its date packages loaded', () => {
  const site = tempDir('sync-servers-e2e-site-');
  const share = tempDir('sync-servers-e2e-share-');
  try {
    writeFileSync(join(site.dir, 'index.html'), '<h1>Home</h1>');
    assert.equal(runCli('site', 'add', '--name', 'My Site', '--local-root', site.dir).status, 0);
    assert.equal(runCli('server', 'add', '--site', 'My Site', '--name', 'Share', '--protocol', 'local', '--remote-root', share.dir).status, 0);
    const before = Date.now();
    const result = runCli('sync', '--site', 'My Site', '--put', 'recent', '--range', '1d', '--dry-run', '--json');
    assert.equal(result.status, 0, result.stderr);
    const document = JSON.parse(result.stdout) as {
      schema: string;
      plan: { scope: unknown; items: { path: string; action: string; checked: boolean }[] };
      result: unknown;
      range: { text: string; since: string };
    };
    assert.equal(document.schema, 'sync-servers/sync@1');
    assert.deepEqual(document.plan.items.map((item) => [item.path, item.action, item.checked]), [['index.html', 'put', true]]);
    assert.deepEqual(document.plan.scope, { kind: 'paths', paths: ['index.html'] });
    assert.equal(document.result, null);
    assert.equal(document.range.text, '1d');
    const since = Date.parse(document.range.since);
    assert.ok(since >= before - 86_400_000 && since <= Date.now() - 86_400_000, 'the range starts one day before the clock of this computer');
    assert.deepEqual(readdirSync(share.dir), [], 'a dry run transfers nothing');

    const refused = runCli('sync', '--site', 'My Site', '--put', 'recent', '--range', '--help');
    assert.equal(refused.status, 2, 'a help flag where the range belongs is a usage error of sync-servers, not a help page of another program');
    assert.doesNotMatch(refused.stdout, /timecal/i);
  } finally {
    site.cleanup();
    share.cleanup();
  }
});
