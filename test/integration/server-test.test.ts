import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { MemoryCredentialStore } from '../../src/credentials/memory.ts';
import { cli, filesContaining, makeFolder, tempDir } from '../helpers/cli.ts';
import { certificateAuthority, testCertificate, type TestCertificate } from '../sandbox/cert.ts';
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
    assert.match(asked.stderr, /^Password for demo-user on 127\.0\.0\.1 \(My Site: Production\): /m);
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

interface SitesFileShape {
  sites: { servers: { host?: string; auth?: { savePassword?: boolean }; options: { tls?: { servername?: string; trustedCertificate?: { sha256: string } } } }[] }[];
}

function firstServer(home: string): SitesFileShape['sites'][number]['servers'][number] | undefined {
  return json<SitesFileShape>(readFileSync(path.join(home, 'sites.json'), 'utf8')).sites[0]?.servers[0];
}

/** An FTPS sandbox whose certificate, issued by a test authority, names only `localhost`; the site connects to 127.0.0.1. */
async function mismatchSite(home: string): Promise<{ rig: Awaited<ReturnType<typeof startRig>>; certificate: TestCertificate }> {
  const ca = certificateAuthority();
  const certificate = testCertificate({ issuer: ca, dnsNames: ['localhost'], ipAddresses: [] });
  const rig = await startRig('ftps', { certificate, ca });
  const sandbox = rig.sandbox as FtpSandbox;
  await siteWith(
    home,
    '--protocol', 'ftps', '--host', sandbox.host, '--port', String(sandbox.port), '--user', rig.user, '--remote-root', '/site', '--ca-file', rig.caFile ?? '',
  );
  return { rig, certificate };
}

test('server test in a terminal reaches a server whose certificate names another host by choosing the covered name', async () => {
  const temp = tempDir();
  const home = makeFolder(temp.dir, 'home');
  const { rig, certificate } = await mismatchSite(home);
  try {
    const env = { SYNC_SERVERS_PASSWORD: rig.password };
    const unattended = await cli({ home, env }, 'server', 'test', '--site', 'My Site');
    assert.equal(unattended.code, 1);
    assert.match(unattended.stderr, /does not name 127\.0\.0\.1/);
    assert.match(unattended.stderr, /sync-servers server edit Production --host localhost/);
    assert.match(unattended.stderr, new RegExp(`--trust-certificate ${certificate.sha256}`));

    const chosen = await cli({ home, env, tty: true, input: '1\n' }, 'server', 'test', '--site', 'My Site');
    assert.equal(chosen.code, 0, chosen.stderr);
    assert.match(chosen.stderr, /127\.0\.0\.1 is localhost, which this certificate covers\./);
    assert.match(chosen.stderr, /1\. Connect to localhost instead \(recommended\)/);
    assert.match(chosen.stdout, /^Connected to Production \(FTPS localhost:\d+\)/m);
    assert.equal(firstServer(home)?.host, 'localhost');

    const later = await cli({ home, env }, 'server', 'test', '--site', 'My Site');
    assert.equal(later.code, 0, later.stderr);
  } finally {
    temp.cleanup();
    await rig.close();
  }
});

test('server test in a terminal can keep the host and check the certificate as the covered name, or trust it', async () => {
  for (const [choice, check] of [
    ['2', (home: string) => firstServer(home)?.options.tls?.servername === 'localhost'],
    ['3', (home: string) => firstServer(home)?.options.tls?.trustedCertificate !== undefined],
  ] as const) {
    const temp = tempDir();
    const home = makeFolder(temp.dir, 'home');
    const { rig, certificate } = await mismatchSite(home);
    try {
      const env = { SYNC_SERVERS_PASSWORD: rig.password };
      const chosen = await cli({ home, env, tty: true, input: `${choice}\n` }, 'server', 'test', '--site', 'My Site');
      assert.equal(chosen.code, 0, chosen.stderr);
      assert.equal(firstServer(home)?.host, '127.0.0.1');
      assert.ok(check(home), `choice ${choice} was saved`);
      if (choice === '3') {
        assert.equal(firstServer(home)?.options.tls?.trustedCertificate?.sha256, certificate.sha256);
      }
      const later = await cli({ home, env }, 'server', 'test', '--site', 'My Site');
      assert.equal(later.code, 0, later.stderr);
      if (choice === '3') {
        const forgotten = await cli({ home }, 'server', 'edit', 'Production', '--site', 'My Site', '--forget-certificate');
        assert.equal(forgotten.code, 0, forgotten.stderr);
        assert.match(forgotten.stdout, /verified again on the next connection/);
        assert.equal(firstServer(home)?.options.tls?.trustedCertificate, undefined);
        const refused = await cli({ home, env }, 'server', 'test', '--site', 'My Site');
        assert.equal(refused.code, 1);
        const given = await cli({ home, env }, 'server', 'test', '--site', 'My Site', '--trust-certificate', certificate.sha256.replaceAll(':', ''), '--json');
        assert.equal(given.code, 0, given.stderr);
      }
    } finally {
      temp.cleanup();
      await rig.close();
    }
  }
});

test('server test shows where the account starts, and offers to save a typed password once it is accepted', async () => {
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
    const credentialStore = new MemoryCredentialStore();
    const wrong = await cli({ home, tty: true, input: 'not-the-password\n', credentialStore }, 'server', 'test', '--site', 'My Site');
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /did not accept the user name or password \(530\)\. Check the user name: many hosts name FTP accounts in full, as user@domain\./);
    assert.doesNotMatch(wrong.stderr, /Save the password/);

    const asked = await cli({ home, tty: true, input: `${rig.password}\n\n`, credentialStore }, 'server', 'test', '--site', 'My Site');
    assert.equal(asked.code, 0, asked.stderr);
    assert.match(asked.stderr, /Save the password in the memory\? \(Y\/n\)/);
    assert.match(asked.stdout, /^Start +\/, where the account opens$/m);
    assert.equal(firstServer(home)?.auth?.savePassword, true);

    const saved = await cli({ home, credentialStore }, 'server', 'test', '--site', 'My Site', '--json');
    assert.equal(saved.code, 0, saved.stderr);
    assert.equal(json<{ startingFolder: string }>(saved.stdout).startingFolder, '/');
    assert.deepEqual(filesContaining(home, rig.password), []);
  } finally {
    temp.cleanup();
    await rig.close();
  }
});

test('a missing remote root names the folder the account opens in and what it holds', async () => {
  const rig = await startRig('ftps', { home: '/site' });
  const sandbox = rig.sandbox as FtpSandbox;
  const temp = tempDir();
  try {
    for (const name of ['css', 'images', 'js']) {
      makeFolder(rig.siteDir, name);
    }
    const home = makeFolder(temp.dir, 'home');
    await siteWith(
      home,
      '--protocol', 'ftps', '--host', sandbox.host, '--port', String(sandbox.port), '--user', rig.user,
      '--remote-root', '/home/<user>/example.com/my-site', '--ca-file', rig.caFile ?? '', '--tls-servername', 'localhost',
    );
    const result = await cli({ home, env: { SYNC_SERVERS_PASSWORD: rig.password } }, 'server', 'test', '--site', 'My Site');
    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /The remote root \/home\/<user>\/example\.com\/my-site was not found on 127\.0\.0\.1\. This account opens in "\/site", which holds css\/, images\/ and js\/\. Choose the root with "sync-servers server edit Production", or pass --remote-root\./,
    );
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
