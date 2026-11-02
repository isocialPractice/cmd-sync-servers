import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { defaultPaths } from '../../src/config/paths.ts';
import { SiteRegistry } from '../../src/config/registry.ts';
import { openSecret } from '../../src/credentials/binding.ts';
import { MemoryCredentialStore } from '../../src/credentials/memory.ts';
import { cli, filesContaining, makeFolder, tempDir } from '../helpers/cli.ts';
import { certificateAuthority, testCertificate } from '../sandbox/cert.ts';
import type { FtpSandbox } from '../sandbox/ftp-server.ts';
import { startRig, type Rig } from '../sandbox/rig.ts';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- a typed JSON.parse keeps the assertions readable
function json<T>(text: string): T {
  return JSON.parse(text) as T;
}

interface StoredServer {
  id: string;
  name: string;
  host?: string;
  port?: number;
  username?: string;
  remoteRoot: string;
  auth?: { method: string; savePassword?: boolean };
  options: { allowRootDeletes?: boolean; tls?: { servername?: string } };
}

interface Fixture {
  readonly rig: Rig;
  readonly temp: ReturnType<typeof tempDir>;
  readonly home: string;
  readonly root: string;
  readonly store: MemoryCredentialStore;
  readonly port: number;
  close(): Promise<void>;
}

/**
 * An FTPS sandbox whose certificate, issued by a test authority, names only
 * `localhost`, and whose account opens in its own folder and sees it as "/",
 * holding the site's folders. A local site folder holds one page.
 */
async function fixture(options: { readonly mismatch?: boolean } = {}): Promise<Fixture> {
  const ca = certificateAuthority();
  const rig =
    options.mismatch === false ? await startRig('ftps') : await startRig('ftps', { certificate: testCertificate({ issuer: ca, dnsNames: ['localhost'], ipAddresses: [] }), ca });
  const account = path.dirname(rig.siteDir);
  for (const name of ['css', 'images', 'js']) {
    makeFolder(account, name);
  }
  const temp = tempDir();
  const home = makeFolder(temp.dir, 'home');
  const root = makeFolder(temp.dir, 'sites', 'my-site');
  writeFileSync(path.join(root, 'index.html'), '<h1>My Site</h1>');
  return {
    rig,
    temp,
    home,
    root,
    store: new MemoryCredentialStore(),
    port: (rig.sandbox as FtpSandbox).port,
    close: async () => {
      temp.cleanup();
      await rig.close();
    },
  };
}

function servers(home: string): StoredServer[] {
  const file = path.join(home, 'sites.json');
  try {
    return json<{ sites: { servers: StoredServer[] }[] }>(readFileSync(file, 'utf8')).sites.flatMap((site) => site.servers);
  } catch {
    return [];
  }
}

function siteIds(home: string): string[] {
  try {
    return json<{ sites: { id: string }[] }>(readFileSync(path.join(home, 'sites.json'), 'utf8')).sites.map((site) => site.id);
  } catch {
    return [];
  }
}

async function saved(f: Fixture): Promise<string | undefined> {
  const registry = await SiteRegistry.open({ paths: defaultPaths({}, { platform: process.platform, env: { SYNC_SERVERS_HOME: f.home }, homedir: f.home, cwd: f.home }) });
  const site = registry.list()[0];
  const server = site?.servers[0];
  if (site === undefined || server === undefined) {
    return undefined;
  }
  const stored = await f.store.get({ siteId: site.id, serverId: server.id, kind: 'password' });
  return stored === undefined ? undefined : openSecret(stored, server);
}

/** The answers to a guided `site add` against the fixture, in the order they are asked. */
function siteAddAnswers(f: Fixture, password: string): string[] {
  return ['My Site', f.root, `127.0.0.1:${String(f.port)}`, f.rig.user, password, '1', '', 'y', ''];
}

function siteAdd(f: Fixture, answers: readonly string[]): ReturnType<typeof cli> {
  return cli(
    { home: f.home, cwd: f.temp.dir, tty: true, input: answers.length === 0 ? '' : `${answers.join('\n')}\n`, credentialStore: f.store },
    'site', 'add', '--protocol', 'ftps', '--ca-file', f.rig.caFile ?? '',
  );
}

test('site add sets up a site and its server in one command: connects, decides on the certificate, picks the root, saves the password', async () => {
  const f = await fixture();
  try {
    const result = await siteAdd(f, siteAddAnswers(f, f.rig.password));
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /Local site folder \[.+\]: Host: User: Password: \n/);
    assert.match(result.stderr, new RegExp(`^Connecting to 127\\.0\\.0\\.1:${String(f.port)}\\.\\.\\.$`, 'm'));
    assert.match(result.stderr, /does not name 127\.0\.0\.1/);
    assert.match(result.stderr, /1\. Connect to localhost instead \(recommended\)/);
    assert.match(result.stderr, /Signed in as demo-user\. The account opens in "\/", which holds:\n {2}1\. css\/\n {2}2\. images\/\n {2}3\. js\/\n {2}4\. site\//);
    assert.match(result.stderr, /Site root on the server: Enter for "\/", a number to open a folder, or a path \[\/\]: /);
    assert.match(result.stderr, /"\/" is the top of what this account can see\. Let synchronizing delete files there\?\nEvery delete is listed in the preview first\. \(y\/N\)/);
    assert.match(result.stderr, /Save the password in the memory\? \(Y\/n\)/);
    assert.match(result.stdout, /^Added site "My Site" with the server localhost \(FTPS\)\. It is the Remote server\.$/m);
    assert.match(result.stdout, /^Next: cd ".+my-site", then "sync-servers sync --put" to preview what would be put\.$/m);
    assert.match(result.stdout, /^Saved the password in the memory\.$/m);
    const [server] = servers(f.home);
    assert.deepEqual(
      [server?.name, server?.host, server?.port, server?.username, server?.remoteRoot, server?.options.allowRootDeletes, server?.auth?.savePassword],
      ['localhost', 'localhost', f.port, 'demo-user', '/', true, true],
    );
    assert.equal(await saved(f), f.rig.password);

    const preview = await cli({ home: f.home, cwd: f.root, credentialStore: f.store }, 'sync', '--put', '--dry-run');
    assert.equal(preview.code, 0, preview.stderr);
    assert.match(preview.stdout, /index\.html/);
    for (const output of [result.stdout, result.stderr, preview.stdout, preview.stderr]) {
      assert.ok(!output.includes(f.rig.password));
    }
    assert.deepEqual(filesContaining(f.home, f.rig.password), []);
  } finally {
    await f.close();
  }
});

test('site add lists every folder of a crowded account, dot-folders last, and opens the last one by number', async () => {
  const f = await fixture();
  try {
    const account = path.dirname(f.rig.siteDir);
    for (let index = 1; index <= 26; index += 1) {
      makeFolder(account, `folder-${String(index).padStart(2, '0')}`);
    }
    for (const name of ['.trash', '.cache', '.ssh', '.config', '.local']) {
      makeFolder(account, name);
    }
    const [name, root, host, user, password, certificate] = siteAddAnswers(f, f.rig.password);
    const result = await siteAdd(f, [name ?? '', root ?? '', host ?? '', user ?? '', password ?? '', certificate ?? '', '35', '', '']);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /more; type a name/);
    assert.match(result.stderr, /holds:\n {2}1\. css\/\n {2}2\. folder-01\/\n/);
    assert.match(result.stderr, /\n {2}30\. site\/\n {2}31\. \.cache\/\n {2}32\. \.config\/\n {2}33\. \.local\/\n {2}34\. \.ssh\/\n {2}35\. \.trash\/\n/);
    assert.match(result.stderr, /"\/\.trash" is empty\./);
    assert.equal(servers(f.home)[0]?.remoteRoot, '/.trash');
  } finally {
    await f.close();
  }
});

test('cancelling at any question of site add saves nothing', async () => {
  const f = await fixture();
  try {
    const answers = siteAddAnswers(f, f.rig.password);
    for (let given = 0; given < answers.length; given += 1) {
      const result = await siteAdd(f, answers.slice(0, given));
      assert.equal(result.code, 4, `after ${String(given)} answers: ${result.stderr}`);
      assert.deepEqual(siteIds(f.home), [], `after ${String(given)} answers a site was saved`);
      assert.equal(await f.store.get({ siteId: 'x', serverId: 'x', kind: 'password' }), undefined);
    }
    const menu = await siteAdd(f, ['My Site', f.root, 'no-such-host.invalid', f.rig.user, f.rig.password, '3']);
    assert.equal(menu.code, 4);
    assert.match(menu.stderr, /The host no-such-host\.invalid was not found\./);
    assert.match(menu.stderr, /What now\?\n {2}1\. Change the host\n {2}2\. Save without testing\n {2}3\. Cancel/);
    assert.deepEqual(siteIds(f.home), []);
  } finally {
    await f.close();
  }
});

test('a refused password is asked for again and never saved; the one the server accepts is', async () => {
  const f = await fixture();
  try {
    const wrong = ['wrong-one', 'wrong-two', 'wrong-three'];
    const refused = await siteAdd(f, ['My Site', f.root, `127.0.0.1:${String(f.port)}`, f.rig.user, wrong[0] ?? '', '1', '', wrong[1] ?? '', '', wrong[2] ?? '', '3']);
    assert.equal(refused.code, 4, refused.stderr);
    assert.match(refused.stderr, /did not accept the user name or password \(530\)\. Check the user name: many hosts name FTP accounts in full, as user@domain\./);
    assert.match(refused.stderr, /What now\?\n {2}1\. Try again\n {2}2\. Save without testing\n {2}3\. Cancel/);
    assert.deepEqual(siteIds(f.home), []);

    const corrected = await siteAdd(f, ['My Site', f.root, `127.0.0.1:${String(f.port)}`, f.rig.user, 'wrong-one', '1', '', f.rig.password, '', 'y', '']);
    assert.equal(corrected.code, 0, corrected.stderr);
    assert.equal(await saved(f), f.rig.password);
    for (const secret of [...wrong, f.rig.password]) {
      assert.deepEqual(filesContaining(f.home, secret), []);
      assert.ok(!corrected.stderr.includes(secret) && !corrected.stdout.includes(secret));
    }
  } finally {
    await f.close();
  }
});

test('saving without testing asks for the root and saves no password', async () => {
  const f = await fixture();
  try {
    const result = await siteAdd(f, ['My Site', f.root, 'no-such-host.invalid', f.rig.user, f.rig.password, '2', '/site']);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /It is the Remote server\. The connection was not tested\./);
    const [server] = servers(f.home);
    assert.deepEqual([server?.host, server?.remoteRoot, server?.auth?.savePassword], ['no-such-host.invalid', '/site', undefined]);
    assert.equal(await saved(f), undefined);
  } finally {
    await f.close();
  }
});

/** A site whose one server reaches the plain sandbox, its certificate checked as localhost. */
async function savedServer(f: Fixture, ...overrides: string[]): Promise<void> {
  const added = await cli(
    { home: f.home },
    'site', 'add', '--name', 'My Site', '--local-root', f.root, '--server-name', 'Production',
    '--protocol', 'ftps', '--host', '127.0.0.1', '--port', String(f.port), '--user', f.rig.user,
    '--remote-root', '/site', '--ca-file', f.rig.caFile ?? '', '--tls-servername', 'localhost', ...overrides,
  );
  assert.equal(added.code, 0, added.stderr);
}

test('server edit in a terminal asks again with the current values, and changes only what is answered', async () => {
  const f = await fixture({ mismatch: false });
  try {
    await savedServer(f);
    const before = servers(f.home)[0];
    const renamed = await cli({ home: f.home, tty: true, input: '\n\nStaging\n\n\n', credentialStore: f.store }, 'server', 'edit', 'Production');
    assert.equal(renamed.code, 0, renamed.stderr);
    assert.match(renamed.stderr, new RegExp(`Host \\[127\\.0\\.0\\.1:${String(f.port)}\\]: `));
    assert.match(renamed.stderr, /Server name \[Production\]: /);
    assert.match(renamed.stderr, /Root directory on the server \[\/site\]: /);
    assert.doesNotMatch(renamed.stderr, /Connecting/);
    assert.deepEqual(servers(f.home)[0], { ...before, name: 'Staging' });

    const user = await cli({ home: f.home, tty: true, input: `\n\n\nnobody\n${f.rig.password}\n${f.rig.user}\n${f.rig.password}\n\n\n`, credentialStore: f.store }, 'server', 'edit', 'Staging');
    assert.equal(user.code, 0, user.stderr);
    assert.match(user.stderr, /Connecting to 127\.0\.0\.1:/);
    assert.match(user.stderr, /User \[nobody\]: /);
    assert.equal(servers(f.home)[0]?.username, f.rig.user);
    assert.equal(servers(f.home)[0]?.remoteRoot, '/site');
    assert.equal(await saved(f), f.rig.password);
  } finally {
    await f.close();
  }
});

test('server test in a terminal fixes the user name, the remote root and the host, and saves each fix', async () => {
  const f = await fixture({ mismatch: false });
  try {
    await savedServer(f, '--user', 'demo');
    const user = await cli({ home: f.home, tty: true, input: `${f.rig.password}\n${f.rig.user}\n${f.rig.password}\n\n`, credentialStore: f.store }, 'server', 'test');
    assert.equal(user.code, 0, user.stderr);
    assert.match(user.stderr, /User \[demo\]: /);
    assert.equal(servers(f.home)[0]?.username, f.rig.user);
    assert.equal(await saved(f), f.rig.password);

    await cli({ home: f.home }, 'server', 'edit', 'Production', '--remote-root', '/home/<user>/example.com/my-site');
    const root = await cli({ home: f.home, tty: true, input: 'site\n', credentialStore: f.store }, 'server', 'test');
    assert.equal(root.code, 0, root.stderr);
    assert.match(root.stderr, /This account opens in "\/", which holds css\/, images\/, js\/ and site\/\./);
    assert.equal(servers(f.home)[0]?.remoteRoot, '/site');

    await cli({ home: f.home }, 'server', 'edit', 'Production', '--host', 'no-such-host.invalid');
    const host = await cli({ home: f.home, tty: true, input: `127.0.0.1:${String(f.port)}\n${f.rig.password}\n\n`, credentialStore: f.store }, 'server', 'test');
    assert.equal(host.code, 0, host.stderr);
    assert.match(host.stderr, new RegExp(`Host \\[no-such-host\\.invalid:${String(f.port)}\\]: `));
    assert.equal(servers(f.home)[0]?.host, '127.0.0.1');

    const unattended = await cli({ home: f.home, input: '' }, 'server', 'edit', 'Production', '--host', 'no-such-host.invalid');
    assert.equal(unattended.code, 0);
    const script = await cli({ home: f.home, credentialStore: f.store }, 'server', 'test');
    assert.equal(script.code, 1);
    assert.match(script.stderr, /The host no-such-host\.invalid was not found\./);
  } finally {
    await f.close();
  }
});

test('config edit repairs a sites.json that does not load, showing its problems first', async () => {
  const f = await fixture({ mismatch: false });
  try {
    await savedServer(f);
    const file = path.join(f.home, 'sites.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"remoteRoot": "/site"', '"remoteRoot": "site"'));
    assert.equal((await cli({ home: f.home }, 'sites')).code, 1);
    const seen = path.join(f.temp.dir, 'seen.txt');
    const editor = path.join(f.temp.dir, 'fix-editor.mjs');
    writeFileSync(
      editor,
      [
        "import { readFileSync, writeFileSync } from 'node:fs';",
        'const file = process.argv.at(-1);',
        "const text = readFileSync(file, 'utf8');",
        `writeFileSync(${JSON.stringify(seen)}, text);`,
        "writeFileSync(file, text.replace('\"remoteRoot\": \"site\"', '\"remoteRoot\": \"/site\"'));",
      ].join('\n'),
    );
    const env = { SYNC_SERVERS_EDITOR: `"${process.execPath}" "${editor}"` };
    const repaired = await cli({ home: f.home, tty: true, env }, 'config', 'edit');
    assert.equal(repaired.code, 0, repaired.stderr);
    assert.match(readFileSync(seen, 'utf8'), /^\/\/ {3}Site "My Site", server "Production", remoteRoot "site": Must be an absolute path that starts with "\/"\.$/m);
    assert.match(repaired.stdout, /Saved .+sites\.json\. The file it replaced is kept as sites\.json\.bak\./);
    assert.equal((await cli({ home: f.home }, 'sites')).code, 0);
    assert.match(readFileSync(`${file}.bak`, 'utf8'), /"remoteRoot": "site"/);
  } finally {
    await f.close();
  }
});
