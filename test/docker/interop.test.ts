// Runs the transport contract against real OpenSSH and vsftpd containers
// (sandbox/compose.yaml). Skipped unless SANDBOX_DOCKER=1; the CI interop
// job starts the containers and sets the variables this reads.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ROOT, toRemotePath } from '../../src/sync/paths.ts';
import { FtpTransport } from '../../src/transport/ftp.ts';
import { SftpTransport } from '../../src/transport/sftp.ts';
import type { Transport } from '../../src/transport/types.ts';
import { collector } from '../helpers/streams.ts';

const enabled = process.env.SANDBOX_DOCKER === '1';
const user = process.env.SANDBOX_USER ?? 'demo-user';
const password = process.env.SANDBOX_PASSWORD ?? '';
const caFile = path.resolve(process.env.SANDBOX_CA_FILE ?? 'sandbox/run/tls/cert.pem');

async function waitForPort(port: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        resolve(false);
      });
    });
    if (open) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`Port ${String(port)} did not open within 60 s.`);
    }
    await delay(1000);
  }
}

/** Each real server, and whether it can set a file's time: vsftpd has no MFMT. */
const servers: { name: string; port: number; canSetMtime: boolean; make: () => Transport }[] = [
  {
    name: 'OpenSSH (SFTP)',
    port: 2222,
    canSetMtime: true,
    make: () =>
      new SftpTransport({
        host: '127.0.0.1',
        port: 2222,
        username: user,
        auth: { method: 'password' },
        remoteRoot: `/home/${user}/site`,
        timeoutMs: 20_000,
        hostKeys: { pinned: undefined, confirm: () => Promise.resolve('accept-once') },
        secret: () => Promise.resolve(password),
      }),
  },
  {
    name: 'vsftpd (FTPS, TLS session reuse required)',
    port: 2121,
    canSetMtime: false,
    make: () =>
      new FtpTransport({
        protocol: 'ftps',
        host: '127.0.0.1',
        port: 2121,
        username: user,
        remoteRoot: '/site',
        timeoutMs: 20_000,
        tls: { caFile, servername: 'localhost', minVersion: 'TLSv1.2' },
        secret: () => Promise.resolve(password),
      }),
  },
];

for (const server of servers) {
  describe(server.name, { skip: enabled ? false : 'set SANDBOX_DOCKER=1 and start sandbox/compose.yaml' }, () => {
    test('runs the transport contract', async () => {
      await waitForPort(server.port);
      const transport = server.make();
      try {
        const capabilities = await transport.connect();
        assert.equal(capabilities.canSetMtime, server.canSetMtime);
        await transport.mkdir(toRemotePath('css'));
        const content = Buffer.concat([randomBytes(200_000), Buffer.from('\r\n')]);
        await transport.put(Readable.from([content]), toRemotePath('css/site.part'));
        await transport.put(Readable.from([Buffer.from('old')]), toRemotePath('css/site.css'));
        await transport.rename(toRemotePath('css/site.part'), toRemotePath('css/site.css'), true);
        const sink = collector();
        await transport.get(toRemotePath('css/site.css'), sink.stream);
        assert.deepEqual(sink.data(), content);
        assert.equal((await transport.stat(toRemotePath('css/site.css')))?.size, content.length);
        if (capabilities.canSetMtime) {
          const when = Date.UTC(2026, 0, 15, 9, 30, 12);
          await transport.setMtime?.(toRemotePath('css/site.css'), when);
          assert.equal((await transport.stat(toRemotePath('css/site.css')))?.mtimeMs, when);
        }
        assert.deepEqual((await transport.list(toRemotePath('css'))).map((item) => item.name), ['site.css']);
        assert.ok((await transport.list(ROOT)).some((item) => item.name === 'css' && item.type === 'dir'));
        await transport.remove(toRemotePath('css/site.css'));
        await transport.remove(toRemotePath('css'));
        assert.equal(await transport.stat(toRemotePath('css')), undefined);
      } finally {
        await transport.close();
      }
    });
  });
}
