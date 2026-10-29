import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { defaultPaths } from '../../../src/config/paths.ts';
import { SiteRegistry } from '../../../src/config/registry.ts';
import { MemoryCredentialStore } from '../../../src/credentials/memory.ts';
import { cli, filesContaining, makeFolder, tempDir } from '../../helpers/cli.ts';

let temp: ReturnType<typeof tempDir>;
let home: string;
let root: string;

beforeEach(() => {
  temp = tempDir();
  home = makeFolder(temp.dir, 'home');
  root = makeFolder(temp.dir, 'sites', 'my-site');
});

afterEach(() => {
  temp.cleanup();
});

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- a typed JSON.parse keeps the assertions readable
function json<T>(text: string): T {
  return JSON.parse(text) as T;
}

async function addSite(name = 'My Site', localRoot = root): Promise<string> {
  const result = await cli({ home }, 'site', 'add', '--name', name, '--local-root', localRoot, '--json');
  assert.equal(result.code, 0, result.stderr);
  return json<{ site: { id: string } }>(result.stdout).site.id;
}

async function addProduction(site = 'My Site'): Promise<void> {
  const result = await cli(
    { home },
    'server', 'add', '--site', site, '--name', 'Production', '--host', 'sftp.example.com',
    '--user', 'demo-user', '--remote-root', '/var/www/my-site',
  );
  assert.equal(result.code, 0, result.stderr);
}

test('site add needs its options without a terminal', async () => {
  const result = await cli({ home }, 'site', 'add', '--name', 'My Site');
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Pass --name and --local-root/);
});

test('site add refuses a duplicate name and a missing folder', async () => {
  await addSite();
  const duplicate = await cli({ home }, 'site', 'add', '--name', 'my site', '--local-root', root);
  assert.equal(duplicate.code, 2);
  assert.match(duplicate.stderr, /already exists/);
  const missing = await cli({ home }, 'site', 'add', '--name', 'Sample App', '--local-root', path.join(root, 'nope'));
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /Folder not found/);
});

test('sites lists the master list as a table and as JSON', async () => {
  await addSite();
  await addProduction();
  const table = await cli({ home }, 'sites');
  assert.match(table.stdout, /^Name {5}Local root/);
  assert.match(table.stdout, /My Site +.+ +Production\n$/);
  const listed = json<{ schema: string; sites: { name: string; remoteServer: { name: string } }[] }>((await cli({ home }, 'sites', '--json')).stdout);
  assert.equal(listed.schema, 'sync-servers/sites@1');
  assert.equal(listed.sites[0]?.remoteServer.name, 'Production');
});

test('servers get roles: the first is Remote, --testing sets Testing', async () => {
  await addSite();
  await addProduction();
  const staging = await cli(
    { home },
    'server', 'add', '--site', 'My Site', '--name', 'Staging', '--protocol', 'ftps', '--host', 'ftp.example.org',
    '--remote-root', '/public', '--testing',
  );
  assert.equal(staging.code, 0, staging.stderr);
  assert.match(staging.stdout, /It is the Testing server/);
  const listed = json<{ servers: { name: string; remote: boolean; testing: boolean; port: number }[] }>(
    (await cli({ home }, 'server', 'list', '--site', 'My Site', '--json')).stdout,
  );
  assert.deepEqual(
    listed.servers.map((server) => [server.name, server.remote, server.testing, server.port]),
    [
      ['Production', true, false, 22],
      ['Staging', false, true, 21],
    ],
  );
  const table = await cli({ home }, 'server', 'list', '--site', 'My Site');
  assert.match(table.stdout, /Production +sftp\.example\.com +SFTP +\(\*\) +\( \)/);
});

test('server add explains what is missing, and refuses plain FTP without --allow-insecure', async () => {
  await addSite();
  const missing = await cli({ home }, 'server', 'add', '--site', 'My Site', '--name', 'Production');
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /Missing --host, --remote-root/);
  const ftp = ['server', 'add', '--site', 'My Site', '--name', 'Legacy', '--protocol', 'ftp', '--host', 'ftp.example.com', '--remote-root', '/'];
  const refused = await cli({ home }, ...ftp);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /clear text/);
  assert.equal((await cli({ home }, ...ftp, '--allow-insecure')).code, 0);
});

test('a site is resolved from --site, then SYNC_SERVERS_SITE, then the current folder', async () => {
  await addSite();
  await addSite('Sample App', makeFolder(temp.dir, 'sites', 'sample-app'));
  const inside = makeFolder(root, 'css', 'themes');
  const fromFolder = await cli({ home, cwd: inside }, 'site', 'show', '--json');
  assert.equal(json<{ site: { name: string } }>(fromFolder.stdout).site.name, 'My Site');
  const fromEnv = await cli({ home, cwd: inside, env: { SYNC_SERVERS_SITE: 'Sample App' } }, 'site', 'show', '--json');
  assert.equal(json<{ site: { name: string } }>(fromEnv.stdout).site.name, 'Sample App');
  const fromFlag = await cli({ home, cwd: inside, env: { SYNC_SERVERS_SITE: 'Sample App' } }, 'site', 'show', '--site', 'my site', '--json');
  assert.equal(json<{ site: { name: string } }>(fromFlag.stdout).site.name, 'My Site');
  const unknown = await cli({ home }, 'site', 'show', 'Northwind');
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /No site is named "Northwind"/);
});

test('with no site chosen, a terminal gets a picker and a script gets the list', async () => {
  await addSite();
  await addSite('Sample App', makeFolder(temp.dir, 'sites', 'sample-app'));
  const script = await cli({ home }, 'site', 'path');
  assert.equal(script.code, 2);
  assert.match(script.stderr, /Sites: My Site, Sample App/);
  const picked = await cli({ home, tty: true, input: '2\n' }, 'site', 'path');
  assert.equal(picked.code, 0, picked.stderr);
  assert.equal(picked.stdout, `${path.join(temp.dir, 'sites', 'sample-app')}\n`);
  assert.match(picked.stderr, /Which site\?\n {2}1\. My Site/);
});

test('site path writes the folder to --cd-file without a newline', async () => {
  await addSite();
  const cdFile = path.join(temp.dir, 'cd.txt');
  writeFileSync(cdFile, '');
  const result = await cli({ home }, 'site', 'path', 'My Site', '--cd-file', cdFile);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readFileSync(cdFile, 'utf8'), root);
  const failed = await cli({ home }, 'site', 'path', 'Northwind', '--cd-file', cdFile);
  assert.equal(failed.code, 2);
  assert.equal(readFileSync(cdFile, 'utf8'), root);
});

test('site edit renames and moves a site, and needs something to change', async () => {
  await addSite();
  const moved = makeFolder(temp.dir, 'sites', 'sample-app');
  const edited = await cli({ home }, 'site', 'edit', 'My Site', '--name', 'Sample App', '--local-root', moved, '--web-url', 'http://localhost:8080/', '--no-cache');
  assert.equal(edited.code, 0, edited.stderr);
  const shown = json<{ site: { name: string; localRoot: string; local: { webUrl: string; cache: boolean } } }>(
    (await cli({ home }, 'site', 'show', 'Sample App', '--json')).stdout,
  );
  assert.deepEqual([shown.site.name, shown.site.localRoot, shown.site.local.webUrl, shown.site.local.cache], ['Sample App', moved, 'http://localhost:8080/', false]);
  const nothing = await cli({ home }, 'site', 'edit', 'Sample App');
  assert.equal(nothing.code, 2);
  assert.match(nothing.stderr, /Nothing to change/);
});

test('cloak sorts paths from patterns, and uncloak removes them', async () => {
  await addSite();
  makeFolder(root, 'img', 'raw');
  const cloaked = await cli({ home, cwd: root }, 'cloak', '.psd archive*', 'node_modules/', path.join('img', 'raw'));
  assert.equal(cloaked.code, 0, cloaked.stderr);
  const listed = json<{ schema: string; enabled: boolean; patterns: string[]; paths: string[] }>(
    (await cli({ home, cwd: root }, 'cloak', '--list', '--json')).stdout,
  );
  assert.equal(listed.schema, 'sync-servers/cloaking@1');
  assert.equal(listed.enabled, true);
  assert.deepEqual(listed.patterns, ['.psd', 'archive*', 'node_modules/']);
  assert.deepEqual(listed.paths, ['img/raw']);
  const removed = await cli({ home, cwd: makeFolder(root, 'img') }, 'uncloak', 'raw', '.psd', 'nothing*');
  assert.match(removed.stdout, /Uncloaked path: img\/raw\nUncloaked pattern: \.psd\n/);
  assert.match(removed.stderr, /Not cloaked: nothing\*/);
  const off = await cli({ home, cwd: root }, 'cloak', '--disable');
  assert.match(off.stdout, /Cloaking is off/);
  const outside = await cli({ home, cwd: root }, 'cloak', '--path', temp.dir);
  assert.equal(outside.code, 2);
});

test('passwords go to the credential store only, never to a file', async () => {
  await addSite();
  await addProduction();
  const secret = `pw-${randomBytes(8).toString('hex')}`;
  const refused = await cli({ home, input: secret }, 'password', 'set', 'Production', '--site', 'My Site', '--stdin', '--debug');
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /turned off by SYNC_SERVERS_KEYRING.+never written to a file/);

  const store = new MemoryCredentialStore();
  const saved = await cli({ home, input: `${secret}\n`, credentialStore: store }, 'password', 'set', '--site', 'My Site', '--stdin', '--debug');
  assert.equal(saved.code, 0, saved.stderr);
  const site = json<{ site: { id: string; servers: { id: string; auth: { savePassword: boolean } }[] } }>(
    (await cli({ home }, 'site', 'show', 'My Site', '--json')).stdout,
  ).site;
  const server = site.servers[0];
  assert.equal(server?.auth.savePassword, true);
  assert.equal(await store.get({ siteId: site.id, serverId: server.id, kind: 'password' }), secret);
  assert.deepEqual(filesContaining(home, secret), []);
  assert.ok(!saved.stdout.includes(secret) && !saved.stderr.includes(secret));

  const forgot = await cli({ home, credentialStore: store }, 'password', 'forget', '--site', 'My Site');
  assert.match(forgot.stdout, /Removed the saved secret/);
  assert.equal(await store.get({ siteId: site.id, serverId: server.id, kind: 'password' }), undefined);
});

test('password set checks the sign-in method', async () => {
  await addSite();
  const store = new MemoryCredentialStore();
  const agent = await cli(
    { home, credentialStore: store },
    'server', 'add', '--site', 'My Site', '--name', 'Agent', '--host', 'sftp.example.com', '--auth', 'agent', '--remote-root', '/srv',
  );
  assert.equal(agent.code, 0, agent.stderr);
  const result = await cli({ home, input: 'x', credentialStore: store }, 'password', 'set', 'Agent', '--site', 'My Site', '--stdin');
  assert.equal(result.code, 2);
  assert.match(result.stderr, /SSH agent/);
});

test('server edit changes fields and forgets a pinned host key', async () => {
  const siteId = await addSite();
  await addProduction();
  const registry = await SiteRegistry.open({ paths: defaultPaths({}, { platform: process.platform, env: { SYNC_SERVERS_HOME: home }, homedir: home, cwd: home }) });
  const serverId = registry.get(siteId)?.servers[0]?.id ?? '';
  await registry.updateServer(siteId, serverId, (server) => {
    server.options.hostKey = { algorithm: 'ssh-ed25519', sha256: 'A'.repeat(43), pinnedAt: '2026-10-29T12:00:00Z' };
  });
  const edited = await cli({ home }, 'server', 'edit', 'Production', '--site', 'My Site', '--port', '2222', '--forget-host-key', '--json');
  assert.equal(edited.code, 0, edited.stderr);
  const server = json<{ server: { port: number; hostKeyPinned: boolean } }>(edited.stdout).server;
  assert.deepEqual([server.port, server.hostKeyPinned], [2222, false]);
  const badPort = await cli({ home }, 'server', 'edit', 'Production', '--site', 'My Site', '--port', '99999');
  assert.equal(badPort.code, 2);
});

test('removing needs --yes without a terminal, and forgets saved secrets', async () => {
  const siteId = await addSite();
  await addProduction();
  const store = new MemoryCredentialStore();
  await cli({ home, input: 'hunter2', credentialStore: store }, 'password', 'set', '--site', 'My Site', '--stdin');
  const refused = await cli({ home }, 'site', 'remove', 'My Site');
  assert.equal(refused.code, 2);
  const removed = await cli({ home, credentialStore: store }, 'site', 'remove', 'My Site', '--yes');
  assert.equal(removed.code, 0, removed.stderr);
  assert.match(removed.stdout, /were not touched/);
  assert.equal(json<{ sites: unknown[] }>((await cli({ home }, 'sites', '--json')).stdout).sites.length, 0);
  const server = (await SiteRegistry.open({ paths: defaultPaths({}, { platform: process.platform, env: { SYNC_SERVERS_HOME: home }, homedir: home, cwd: home }) })).get(siteId);
  assert.equal(server, undefined);
  assert.equal(filesContaining(home, 'hunter2').length, 0);
});

test('site remove in a terminal asks for the site name', async () => {
  await addSite();
  const wrong = await cli({ home, tty: true, input: 'Sample App\n' }, 'site', 'remove', 'My Site');
  assert.equal(wrong.code, 4);
  const right = await cli({ home, tty: true, input: 'my site\n' }, 'site', 'remove', 'My Site');
  assert.equal(right.code, 0, right.stderr);
});

test('site add in a terminal asks for the site, its first server and its password', async () => {
  const store = new MemoryCredentialStore();
  const answers = [
    'My Site', root, 'y',
    'Production', '1', 'sftp.example.com', '', 'demo-user', '1', '/var/www/my-site', '',
    'y', 'hunter2', 'hunter2',
  ];
  const result = await cli({ home, tty: true, input: `${answers.join('\n')}\n`, credentialStore: store }, 'site', 'add');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Added site "My Site"/);
  assert.match(result.stdout, /Added server Production \(SFTP sftp\.example\.com\) to "My Site"\. It is the Remote server\./);
  assert.match(result.stdout, /Saved the password in the memory\./);
  const site = json<{ site: { id: string; servers: { id: string; port?: number; username: string; auth: { method: string; savePassword: boolean } }[] } }>(
    (await cli({ home }, 'site', 'show', 'My Site', '--json')).stdout,
  ).site;
  const server = site.servers[0];
  assert.equal(server?.username, 'demo-user');
  assert.equal(server.port, undefined);
  assert.deepEqual(server.auth, { method: 'password', savePassword: true });
  assert.equal(await store.get({ siteId: site.id, serverId: server.id, kind: 'password' }), 'hunter2');
  assert.deepEqual(filesContaining(home, 'hunter2'), []);
  assert.ok(!result.stderr.includes('hunter2'));
});

test('config path and doctor report the folders and the checks', async () => {
  await addSite();
  const paths = json<{ schema: string; sitesFile: string }>((await cli({ home }, 'config', 'path', '--json')).stdout);
  assert.equal(paths.schema, 'sync-servers/config-paths@1');
  assert.equal(paths.sitesFile, path.join(home, 'sites.json'));
  const doctor = await cli({ home }, 'doctor', '--json');
  assert.equal(doctor.code, 0, doctor.stdout);
  const report = json<{ ok: boolean; checks: { status: string; subject: string }[] }>(doctor.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(
    report.checks.find((check) => check.subject === 'Credential store')?.status,
    'warn',
  );
  assert.ok(report.checks.some((check) => check.subject === 'Site "My Site"' && check.status === 'ok'));
});

test('doctor fails when a local root is gone', async () => {
  const gone = makeFolder(temp.dir, 'sites', 'gone');
  await addSite('Sample App', gone);
  rmSync(gone, { recursive: true });
  const doctor = await cli({ home }, 'doctor');
  assert.equal(doctor.code, 1);
  assert.match(doctor.stdout, /^fail {2}Site "Sample App": Folder not found/m);
});

test('errors in --json mode are one JSON document with a stable code', async () => {
  const result = await cli({ home }, 'site', 'show', 'Northwind', '--json');
  assert.equal(result.code, 2);
  assert.deepEqual(json<{ schema: string; error: { code: string } }>(result.stdout).error.code, 'E_SITE_NOT_FOUND');
});

test('unknown commands and arguments are usage errors', async () => {
  const unknown = await cli({ home }, 'site', 'frob');
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown command "site frob"/);
  const extra = await cli({ home }, 'site', 'path', 'a', 'b');
  assert.equal(extra.code, 2);
  assert.match(extra.stderr, /expected: sync-servers site path \[<site>\]/);
});

test('help works as a command and as an option', async () => {
  const viaCommand = await cli({ home }, 'help', 'server', 'add');
  const viaOption = await cli({ home }, 'server', 'add', '--help');
  assert.equal(viaCommand.stdout, viaOption.stdout);
  assert.match(viaOption.stdout, /^Usage:\n {2}sync-servers server add \[options\]/);
});
