import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { cli, filesContaining, makeFolder, tempDir } from '../helpers/cli.ts';
import type { FtpSandbox } from '../sandbox/ftp-server.ts';
import { startRig } from '../sandbox/rig.ts';
import type { SftpSandbox } from '../sandbox/sftp-server.ts';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- a typed JSON.parse keeps the assertions readable
function json<T>(text: string): T {
  return JSON.parse(text) as T;
}

async function siteWith(home: string, ...serverArgs: string[]): Promise<void> {
  const root = makeFolder(home, '..', 'sites', 'my-site');
  assert.equal((await cli({ home }, 'site', 'add', '--name', 'My Site', '--local-root', root)).code, 0);
  const added = await cli({ home }, 'server', 'add', '--site', 'My Site', '--name', 'Production', ...serverArgs);
  assert.equal(added.code, 0, added.stderr);
}

test('server test checks a local folder server', async () => {
  const temp = tempDir();
  try {
    const home = makeFolder(temp.dir, 'home');
    const share = makeFolder(temp.dir, 'share');
    writeFileSync(path.join(share, 'index.html'), 'home');
    await siteWith(home, '--protocol', 'local', '--remote-root', share);
    const result = await cli({ home }, 'server', 'test', '--site', 'My Site', '--json');
    assert.equal(result.code, 0, result.stderr);
    const report = json<{ schema: string; protocol: string; entries: number; hostKey: null }>(result.stdout);
    assert.deepEqual([report.schema, report.protocol, report.entries, report.hostKey], ['sync-servers/server-test@1', 'local', 1, null]);
  } finally {
    temp.cleanup();
  }
});

test('server test over SFTP: unknown keys are refused unattended, confirmed and pinned in a terminal', async () => {
  const rig = await startRig('sftp');
  const sandbox = rig.sandbox as SftpSandbox;
  const temp = tempDir();
  try {
    const home = makeFolder(temp.dir, 'home');
    await siteWith(home, '--host', sandbox.host, '--port', String(sandbox.port), '--user', rig.user, '--remote-root', '/site');
    const env = { SYNC_SERVERS_PASSWORD: rig.password };

    const refused = await cli({ home, env }, 'server', 'test', '--site', 'My Site');
    assert.equal(refused.code, 5);
    assert.match(refused.stderr, new RegExp(`--host-key SHA256:${sandbox.hostKeySha256.replace(/[+/]/g, '\\$&')}`));

    const once = await cli({ home, env }, 'server', 'test', '--site', 'My Site', '--host-key', `SHA256:${sandbox.hostKeySha256}`, '--json');
    assert.equal(once.code, 0, once.stderr);
    assert.equal(json<{ hostKey: { state: string } }>(once.stdout).hostKey.state, 'accepted for this connection only');

    const pinned = await cli({ home, env, tty: true, input: '1\n' }, 'server', 'test', '--site', 'My Site');
    assert.equal(pinned.code, 0, pinned.stderr);
    assert.match(pinned.stderr, /Trust this host key\?/);
    assert.match(pinned.stdout, /^Host key +ssh-ed25519 SHA256:.+ \(pinned\)$/m);
    const sites = readFileSync(path.join(home, 'sites.json'), 'utf8');
    assert.ok(sites.includes(sandbox.hostKeySha256));

    const later = await cli({ home, env }, 'server', 'test', '--site', 'My Site');
    assert.equal(later.code, 0, later.stderr);
    assert.deepEqual(filesContaining(home, rig.password), []);
  } finally {
    temp.cleanup();
    await rig.close();
  }
});

test('server test asks for the password in a terminal and reports a wrong one without showing it', async () => {
  const rig = await startRig('ftps');
  const sandbox = rig.sandbox as FtpSandbox;
  const temp = tempDir();
  try {
    const home = makeFolder(temp.dir, 'home');
    await siteWith(
      home,
      '--protocol', 'ftps', '--host', sandbox.host, '--port', String(sandbox.port), '--user', rig.user,
      '--remote-root', '/site', '--ca-file', rig.caFile ?? '', '--tls-servername', 'localhost',
    );
    const asked = await cli({ home, tty: true, input: `${rig.password}\n` }, 'server', 'test', '--site', 'My Site');
    assert.equal(asked.code, 0, asked.stderr);
    assert.match(asked.stderr, /^Password for demo-user@127\.0\.0\.1 \(My Site: Production\): /m);
    assert.match(asked.stdout, /^TLS +TLSv1\.[23], /m);

    const wrong = `wrong-${randomBytes(6).toString('hex')}`;
    const refused = await cli({ home, env: { SYNC_SERVERS_PASSWORD: wrong }, input: '' }, 'server', 'test', '--site', 'My Site', '--json', '--debug');
    assert.equal(refused.code, 1);
    assert.equal(json<{ error: { code: string } }>(refused.stdout).error.code, 'E_AUTH');
    assert.ok(!refused.stdout.includes(wrong) && !refused.stderr.includes(wrong));
    assert.deepEqual(filesContaining(home, wrong), []);
  } finally {
    temp.cleanup();
    await rig.close();
  }
});

test('server test with no password anywhere and no terminal is E_AUTH, naming the ways to give one', async () => {
  const rig = await startRig('ftps');
  const sandbox = rig.sandbox as FtpSandbox;
  const temp = tempDir();
  try {
    const home = makeFolder(temp.dir, 'home');
    await siteWith(home, '--protocol', 'ftps', '--host', sandbox.host, '--port', String(sandbox.port), '--user', rig.user, '--remote-root', '/site', '--ca-file', rig.caFile ?? '');
    const result = await cli({ home }, 'server', 'test', '--site', 'My Site');
    assert.equal(result.code, 1);
    assert.match(result.stderr, /SYNC_SERVERS_PASSWORD/);
  } finally {
    temp.cleanup();
    await rig.close();
  }
});
