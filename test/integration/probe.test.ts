import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { serverSchema, type Server } from '../../src/config/schema.ts';
import { MemoryCredentialStore } from '../../src/credentials/memory.ts';
import { isSyncError } from '../../src/errors.ts';
import type { HostAdapter } from '../../src/host.ts';
import { ServerProbe } from '../../src/transport/probe.ts';
import { KINDS, startRig, type Rig } from '../sandbox/rig.ts';
import type { SftpSandbox } from '../sandbox/sftp-server.ts';

const site = { id: randomUUID(), name: 'My Site' };

function host(): HostAdapter {
  return {
    credentials: new MemoryCredentialStore(),
    interactive: false,
    confirmHostKey: () => Promise.resolve('reject'),
    promptSecret: () => Promise.resolve(undefined),
  };
}

/** An unsaved server for the rig, with its own id. */
function unsaved(rig: Rig, remoteRoot: string): Server {
  if (rig.kind === 'local') {
    return serverSchema.parse({ id: randomUUID(), name: 'Folder', protocol: 'local', remoteRoot });
  }
  const sandbox = rig.sandbox;
  return serverSchema.parse({
    id: randomUUID(),
    name: 'Production',
    protocol: rig.kind,
    host: sandbox?.host,
    port: sandbox?.port,
    username: rig.user,
    remoteRoot,
    options: {
      ...(rig.kind === 'ftp' ? { allowInsecure: true } : {}),
      ...(rig.kind === 'ftps' || rig.kind === 'ftps-implicit' ? { tls: { caFile: rig.caFile, servername: 'localhost' } } : {}),
    },
  });
}

for (const kind of KINDS) {
  test(`${kind}: a probe connects with unsaved settings, starts where the account opens, and lists folders by absolute path`, async () => {
    const rig = await startRig(kind);
    try {
      mkdirSync(path.join(rig.siteDir, 'css'));
      mkdirSync(path.join(rig.siteDir, 'images'));
      writeFileSync(path.join(rig.siteDir, 'index.html'), 'home');
      const local = kind === 'local';
      const top = local ? path.parse(rig.siteDir).root : '/';
      const siteFolder = local ? rig.siteDir : '/site';
      const server = unsaved(rig, local ? rig.siteDir : '/var/www/my-site');
      const probe = await ServerProbe.open({
        site,
        server,
        host: host(),
        env: { SYNC_SERVERS_PASSWORD: rig.password },
        ...(kind === 'sftp' ? { expectedHostKey: `SHA256:${(rig.sandbox as SftpSandbox).hostKeySha256}` } : {}),
      });
      try {
        assert.equal(probe.capabilities.protocol, kind);
        assert.equal(probe.startingFolder, local ? undefined : '/');
        assert.equal(probe.server.remoteRoot, server.remoteRoot, 'the remote root given is kept, not entered');
        assert.equal(probe.server.id, server.id);
        if (!local) {
          assert.ok((await probe.folders(top)).folders.includes('site'));
        }
        const listing = await probe.folders(siteFolder);
        assert.deepEqual(listing.folders, ['css', 'images']);
        assert.equal(listing.files, 1);
        assert.equal(listing.path, siteFolder);
        assert.equal(await probe.exists(siteFolder), true);
        assert.equal(await probe.exists(local ? path.join(rig.siteDir, 'nope') : '/nope'), false);
        assert.equal(await probe.exists('relative/path'), false);
        await assert.rejects(probe.folders('relative/path'), (error) => isSyncError(error, 'E_PATH_UNSAFE'));
      } finally {
        await probe.close();
      }
    } finally {
      await rig.close();
    }
  });
}

for (const kind of ['sftp', 'ftps'] as const) {
  test(`${kind}: an account that opens in its own folder reports it, and a missing root names it`, async () => {
    const rig = await startRig(kind, { home: '/site' });
    try {
      mkdirSync(path.join(rig.siteDir, 'css'));
      mkdirSync(path.join(rig.siteDir, 'js'));
      const transport = rig.transport({ remoteRoot: '/site', serverName: 'Production' });
      try {
        assert.equal((await transport.connect()).startingFolder, '/site');
      } finally {
        await transport.close();
      }
      const missing = rig.transport({ remoteRoot: '/home/<user>/example.com/my-site', serverName: 'Production' });
      await assert.rejects(
        missing.connect().finally(() => missing.close()),
        (error) =>
          isSyncError(error, 'E_REMOTE_ROOT') &&
          error.details?.startingFolder === '/site' &&
          error.message.includes('This account opens in "/site", which holds css/ and js/.') &&
          error.message.includes('sync-servers server edit Production'),
      );
    } finally {
      await rig.close();
    }
  });
}

test('a refused connection and a host that does not exist say what to check', async () => {
  const rig = await startRig('ftps');
  const port = rig.sandbox?.port ?? 0;
  await rig.close();
  const server = serverSchema.parse({ id: randomUUID(), name: 'Production', protocol: 'ftps', host: '127.0.0.1', port, username: 'demo-user', remoteRoot: '/' });
  await assert.rejects(
    ServerProbe.open({ site, server, host: host(), env: { SYNC_SERVERS_PASSWORD: 'unused' } }),
    (error) => isSyncError(error, 'E_CONNECTION') && error.message === `127.0.0.1 refused the connection on port ${String(port)}. Check the protocol and port: SFTP usually uses 22, FTPS 21, implicit FTPS 990.`,
  );
  const nowhere = serverSchema.parse({ ...server, host: 'no-such-host.invalid' });
  await assert.rejects(
    ServerProbe.open({ site, server: nowhere, host: host(), env: { SYNC_SERVERS_PASSWORD: 'unused' } }),
    (error) => isSyncError(error, 'E_CONNECTION') && error.message.startsWith('The host no-such-host.invalid was not found.'),
  );
});
