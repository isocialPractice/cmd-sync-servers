import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { filesContaining, makeFolder, tempDir, testEnv } from '../helpers/cli.ts';

// A site with two servers is created, edited, resolved from a subfolder and
// removed, all through the built CLI, with a generated password in the
// environment and --debug on, and no file under SYNC_SERVERS_HOME ever holds it.
const cliPath = fileURLToPath(new URL('../../out/cli/main.js', import.meta.url));
const temp = tempDir('sync-servers-e2e-');
const home = makeFolder(temp.dir, 'home');
const root = realpathSync(makeFolder(temp.dir, 'sites', 'my-site'));
const secret = `pw-${randomBytes(12).toString('hex')}`;

after(() => {
  temp.cleanup();
});

function run(cwd: string, ...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, '--debug', ...args], {
    cwd,
    encoding: 'utf8',
    env: testEnv(home, { SYNC_SERVERS_PASSWORD: secret, NO_COLOR: '1' }),
    input: secret,
  });
  assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret), `${args.join(' ')} printed the password`);
  return result;
}

test('a site with two servers is created, edited, resolved from a subfolder and removed', () => {
  assert.equal(run(temp.dir, 'site', 'add', '--name', 'My Site', '--local-root', root).status, 0);
  const production = run(
    temp.dir,
    'server', 'add', '--site', 'My Site', '--name', 'Production', '--host', 'sftp.example.com',
    '--user', 'demo-user', '--remote-root', '/var/www/my-site', '--save-password',
  );
  assert.equal(production.status, 0, production.stderr);
  const staging = run(
    temp.dir,
    'server', 'add', '--site', 'My Site', '--name', 'Staging', '--protocol', 'ftps', '--host', 'ftp.example.org',
    '--user', 'demo-user', '--remote-root', '/public',
  );
  assert.equal(staging.status, 0, staging.stderr);
  assert.equal(run(temp.dir, 'server', 'set-testing', 'Staging', '--site', 'My Site').status, 0);
  assert.equal(run(temp.dir, 'site', 'edit', 'My Site', '--name', 'Sample App').status, 0);
  assert.equal(run(temp.dir, 'server', 'edit', 'Staging', '--site', 'Sample App', '--port', '2121').status, 0);

  const sub = makeFolder(root, 'css');
  const shown = run(sub, 'site', 'show', '--json');
  assert.equal(shown.status, 0, shown.stderr);
  const site = (JSON.parse(shown.stdout) as { site: { name: string; servers: { name: string }[]; testingServerId: string } }).site;
  assert.equal(site.name, 'Sample App');
  assert.deepEqual(site.servers.map((server) => server.name), ['Production', 'Staging']);

  const password = run(sub, 'password', 'set', 'Production', '--stdin');
  assert.equal(password.status, 1);
  assert.match(password.stderr, /never written to a file/);

  assert.equal(run(sub, 'doctor').status, 0);
  assert.equal(run(temp.dir, 'site', 'remove', 'Sample App', '--yes').status, 0);
  const listed = run(temp.dir, 'sites', '--json');
  assert.deepEqual((JSON.parse(listed.stdout) as { sites: unknown[] }).sites, []);

  assert.deepEqual(filesContaining(home, secret), []);
  assert.ok(filesContaining(home, 'Site removed').length > 0, 'the run logs were written');
  assert.equal(path.basename(home), 'home');
});

test('the built CLI synchronizes with a folder server and reports through its exit codes', () => {
  const site = realpathSync(makeFolder(temp.dir, 'sync', 'local'));
  const share = realpathSync(makeFolder(temp.dir, 'sync', 'share'));
  writeFileSync(path.join(site, 'index.html'), 'home');
  assert.equal(run(temp.dir, 'site', 'add', '--name', 'Sample App', '--local-root', site).status, 0);
  assert.equal(run(temp.dir, 'server', 'add', '--site', 'Sample App', '--name', 'Share', '--protocol', 'local', '--remote-root', share).status, 0);
  assert.equal(run(site, 'sync').status, 2);
  const preview = run(site, 'sync', '--put');
  assert.equal(preview.status, 0);
  assert.equal(readdirSync(share).length, 0);
  const synced = run(site, 'sync', '--put', '--yes', '--json');
  assert.equal(synced.status, 0, synced.stderr);
  assert.equal((JSON.parse(synced.stdout) as { result: { done: number } }).result.done, 1);
  assert.equal(readFileSync(path.join(share, 'index.html'), 'utf8'), 'home');
  assert.deepEqual(filesContaining(home, secret), []);
});
