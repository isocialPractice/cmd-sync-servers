import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';
import ssh2 from 'ssh2';
import { isSyncError } from '../../src/errors.ts';
import type { HostKeyDecision, HostKeyInfo } from '../../src/host.ts';
import { createLogger, memorySink } from '../../src/log/logger.ts';
import { caseCollisions, checkPath, ROOT, toRemotePath } from '../../src/sync/paths.ts';
import { TransportPool } from '../../src/transport/pool.ts';
import type { Transport } from '../../src/transport/types.ts';
import type { FtpSandbox } from '../sandbox/ftp-server.ts';
import { collector } from '../helpers/streams.ts';
import { startRig, type Kind } from '../sandbox/rig.ts';
import type { SftpSandbox } from '../sandbox/sftp-server.ts';

const HOSTILE = ['../escape', '/etc/passwd', 'a\\b.txt', 'CON.txt', 'Index.html', 'bad\u0000name', 'x'.repeat(4096)];
const NETWORK: readonly Kind[] = ['sftp', 'ftps', 'ftps-implicit', 'ftp'];

async function withTransport<T>(transport: Transport, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } finally {
    await transport.close();
  }
}

describe('hostile names from a server', () => {
  for (const kind of NETWORK) {
    test(`${kind}: never become usable paths`, async () => {
      const rig = await startRig(kind, { faults: { hostileNames: HOSTILE, symlinkOutside: 'link-out', listingFolder: '/site' } });
      writeFileSync(path.join(rig.siteDir, 'index.html'), 'home');
      const transport = rig.transport();
      try {
        await transport.connect();
        const entries = await transport.list(ROOT);
        for (const entry of entries) {
          if (entry.path === undefined) {
            assert.ok(entry.unsafe !== undefined, `${JSON.stringify(entry.name)} has neither a path nor a reason`);
          } else {
            assert.equal(checkPath(entry.path).ok, true, `${JSON.stringify(entry.name)} was accepted`);
            assert.ok(!entry.path.split('/').includes('..'));
            assert.ok(!entry.path.startsWith('/'));
          }
        }
        const byName = new Map(entries.map((entry) => [entry.name, entry]));
        for (const name of ['bad\u0000name', 'x'.repeat(4096)]) {
          assert.equal(byName.get(name)?.path, undefined, `${JSON.stringify(name).slice(0, 20)} should be unsafe`);
        }
        for (const name of ['../escape', '/etc/passwd']) {
          assert.equal(byName.get(name)?.path, undefined, `${name} should be dropped or unsafe`);
        }
        if (process.platform === 'win32') {
          assert.equal(byName.get('a\\b.txt')?.unsafe, 'contains a backslash');
          assert.equal(byName.get('CON.txt')?.unsafe, 'reserved device name');
        }
        const link = byName.get('link-out');
        assert.equal(link?.type, 'symlink');
        assert.deepEqual(
          [...caseCollisions(entries.map((entry) => entry.name))].sort(),
          ['Index.html', 'index.html'],
        );
      } finally {
        await transport.close();
        await rig.close();
      }
    });
  }
});

describe('SSH host keys', () => {
  test('a new key is confirmed and pinned; a pinned key connects without asking', async () => {
    const rig = await startRig('sftp');
    const sandbox = rig.sandbox as SftpSandbox;
    const asked: HostKeyInfo[] = [];
    const pinned: HostKeyInfo[] = [];
    const first = rig.transport({
      hostKeys: {
        pinned: undefined,
        confirm: (info) => {
          asked.push(info);
          return Promise.resolve('accept-and-pin');
        },
        pin: (info) => {
          pinned.push(info);
          return Promise.resolve();
        },
      },
    });
    try {
      const capabilities = await withTransport(first, () => first.connect());
      assert.equal(asked.length, 1);
      assert.equal(asked[0]?.algorithm, 'ssh-ed25519');
      assert.equal(asked[0].sha256, sandbox.hostKeySha256);
      assert.equal(asked[0].fingerprint, `SHA256:${sandbox.hostKeySha256}`);
      assert.deepEqual(pinned, asked);
      assert.equal(capabilities.hostKey?.sha256, sandbox.hostKeySha256);

      const second = rig.transport({
        hostKeys: {
          pinned: { algorithm: 'ssh-ed25519', sha256: sandbox.hostKeySha256 },
          confirm: () => Promise.reject(new Error('must not ask')),
        },
      });
      await withTransport(second, () => second.connect());
    } finally {
      await rig.close();
    }
  });

  test('a changed key is refused with both fingerprints, before any password is sent', async () => {
    const original = await startRig('sftp');
    const rotated = await startRig('sftp');
    const pinnedKey = (original.sandbox as SftpSandbox).hostKeySha256;
    try {
      const transport = rotated.transport({ hostKeys: { pinned: { algorithm: 'ssh-ed25519', sha256: pinnedKey } } });
      await assert.rejects(
        withTransport(transport, () => transport.connect()),
        (error) =>
          isSyncError(error, 'E_HOST_KEY_MISMATCH') &&
          error.message.includes(`SHA256:${pinnedKey}`) &&
          error.message.includes(`SHA256:${(rotated.sandbox as SftpSandbox).hostKeySha256}`) &&
          error.message.includes('machine-in-the-middle'),
      );
      assert.equal(rotated.secretRequests, 0);
    } finally {
      await original.close();
      await rotated.close();
    }
  });

  test('an unattended run refuses an unknown key unless the expected fingerprint matches', async () => {
    const rig = await startRig('sftp');
    try {
      const unknown = rig.transport({ hostKeys: { pinned: undefined } });
      await assert.rejects(withTransport(unknown, () => unknown.connect()), (error) => isSyncError(error, 'E_HOST_KEY_MISMATCH') && error.message.includes('--host-key SHA256:'));
      const wrong = rig.transport({ hostKeys: { pinned: undefined, expected: `SHA256:${'A'.repeat(43)}` } });
      await assert.rejects(withTransport(wrong, () => wrong.connect()), (error) => isSyncError(error, 'E_HOST_KEY_MISMATCH'));
      const right = rig.transport({ hostKeys: { pinned: undefined, expected: `SHA256:${(rig.sandbox as SftpSandbox).hostKeySha256}` } });
      await withTransport(right, () => right.connect());
    } finally {
      await rig.close();
    }
  });

  for (const decision of ['reject', 'accept-once'] as HostKeyDecision[]) {
    test(`deciding ${decision} ${decision === 'reject' ? 'closes the connection' : 'connects without pinning'}`, async () => {
      const rig = await startRig('sftp');
      const pinned: HostKeyInfo[] = [];
      const transport = rig.transport({
        hostKeys: {
          pinned: undefined,
          confirm: () => Promise.resolve(decision),
          pin: (info) => {
            pinned.push(info);
            return Promise.resolve();
          },
        },
      });
      try {
        if (decision === 'reject') {
          await assert.rejects(withTransport(transport, () => transport.connect()), (error) => isSyncError(error, 'E_HOST_KEY_MISMATCH'));
          assert.equal(rig.secretRequests, 0);
        } else {
          await withTransport(transport, () => transport.connect());
        }
        assert.deepEqual(pinned, []);
      } finally {
        await rig.close();
      }
    });
  }

  test('legacy algorithms are allowed only on request, with a warning', async () => {
    const rig = await startRig('sftp');
    const sink = memorySink();
    const transport = rig.transport({ legacyAlgorithms: true, logger: createLogger({ sinks: [sink] }) });
    try {
      await withTransport(transport, () => transport.connect());
      assert.ok(sink.records.some((record) => record.level === 'warn' && record.message.includes('Legacy SSH algorithms')));
    } finally {
      await rig.close();
    }
  });
});

describe('SFTP sign-in', () => {
  test('a wrong password is E_AUTH and never appears in the error', async () => {
    const rig = await startRig('sftp');
    const wrong = `wrong-${randomBytes(6).toString('hex')}`;
    const transport = rig.transport({ password: wrong });
    try {
      await assert.rejects(
        withTransport(transport, () => transport.connect()),
        (error) => isSyncError(error, 'E_AUTH') && !error.message.includes(wrong),
      );
    } finally {
      await rig.close();
    }
  });

  test('a server that only offers keyboard-interactive gets the password there', async () => {
    const rig = await startRig('sftp', { keyboardInteractiveOnly: true });
    const transport = rig.transport();
    try {
      await withTransport(transport, () => transport.connect());
    } finally {
      await rig.close();
    }
  });

  test('a private key with a passphrase signs in, and a wrong passphrase is E_AUTH', async () => {
    const passphrase = `pass-${randomBytes(6).toString('hex')}`;
    const keys = ssh2.utils.generateKeyPairSync('ed25519', { passphrase, cipher: 'aes256-ctr', rounds: 16 });
    const rig = await startRig('sftp', { publicKey: keys.public });
    const keyPath = path.join(rig.siteDir, '..', 'id_test');
    writeFileSync(keyPath, keys.private);
    try {
      const good = rig.transport({ auth: { method: 'key', keyPath }, secret: (kind) => Promise.resolve(kind === 'passphrase' ? passphrase : '') });
      await withTransport(good, () => good.connect());
      const bad = rig.transport({ auth: { method: 'key', keyPath }, secret: () => Promise.resolve('not-it') });
      await assert.rejects(withTransport(bad, () => bad.connect()), (error) => isSyncError(error, 'E_AUTH') && !error.message.includes(passphrase));
    } finally {
      await rig.close();
    }
  });
});

describe('TLS', () => {
  for (const kind of ['ftps', 'ftps-implicit'] as const) {
    test(`${kind}: a self-signed certificate is refused before the password is sent`, async () => {
      const rig = await startRig(kind);
      const transport = rig.transport({ trustCertificate: false });
      try {
        await assert.rejects(withTransport(transport, () => transport.connect()), (error) => isSyncError(error, 'E_TLS_CERT'));
        assert.equal(rig.secretRequests, 0);
        assert.ok(!(rig.sandbox as FtpSandbox).commands.some((command) => command.startsWith('PASS')));
      } finally {
        await rig.close();
      }
    });

    test(`${kind}: a private CA is trusted through caFile, and TLS 1.3 can be required`, async () => {
      const rig = await startRig(kind);
      const transport = rig.transport({ minVersion: 'TLSv1.3' });
      try {
        const capabilities = await withTransport(transport, () => transport.connect());
        assert.match(capabilities.tls ?? '', /^TLSv1\.3/);
      } finally {
        await rig.close();
      }
    });
  }

  test('plain FTP is refused without allowInsecure, before any connection', async () => {
    const rig = await startRig('ftp');
    const transport = rig.transport({ allowInsecure: false });
    try {
      await assert.rejects(withTransport(transport, () => transport.connect()), (error) => isSyncError(error, 'E_INSECURE_PROTOCOL'));
      assert.equal((rig.sandbox as FtpSandbox).connections, 0);
    } finally {
      await rig.close();
    }
  });

  test('plain FTP with allowInsecure connects and warns', async () => {
    const rig = await startRig('ftp');
    const transport = rig.transport({ allowInsecure: true });
    try {
      await withTransport(transport, () => transport.connect());
      assert.ok(rig.records.some((record) => record.level === 'warn' && record.message.includes('Plain FTP')));
    } finally {
      await rig.close();
    }
  });
});

describe('faults', () => {
  for (const kind of ['sftp', 'ftps'] as const) {
    test(`${kind}: a dropped connection is transient, and a retry on a fresh connection completes`, async () => {
      const rig = await startRig(kind, { faults: { dropAfterBytes: 65_536, dropTransfers: 1 } });
      const content = randomBytes(400_000);
      writeFileSync(path.join(rig.siteDir, 'big.bin'), content);
      const pool = new TransportPool(() => rig.transport(), { size: 1, shared: kind === 'sftp' });
      try {
        const retries: string[] = [];
        const data = await pool.runWithRetry(
          async (transport) => {
            const sink = collector();
            await transport.get(toRemotePath('big.bin'), sink.stream);
            return sink.data();
          },
          {
            delaysMs: [10, 10],
            onRetry: (error) => {
              retries.push(error.code);
            },
          },
        );
        assert.deepEqual(data, content);
        assert.equal(retries.length, 1);
        assert.ok((rig.sandbox as FtpSandbox | SftpSandbox).connections >= 2);
      } finally {
        await pool.close();
        await rig.close();
      }
    });

    test(`${kind}: a stalled download fails with a transient timeout`, async () => {
      const rig = await startRig(kind, { faults: { stallTransfers: 1 } });
      writeFileSync(path.join(rig.siteDir, 'slow.bin'), randomBytes(10_000));
      const transport = rig.transport({ timeoutMs: 1000 });
      try {
        await transport.connect();
        const started = Date.now();
        await assert.rejects(transport.get(toRemotePath('slow.bin'), collector().stream), (error) => isSyncError(error) && error.transient);
        assert.ok(Date.now() - started < 8000);
      } finally {
        await transport.close();
        await rig.close();
      }
    });

    test(`${kind}: a stalled upload fails with a transient timeout`, async () => {
      const rig = await startRig(kind, { faults: { stallTransfers: 1 } });
      const transport = rig.transport({ timeoutMs: 1000 });
      try {
        await transport.connect();
        await assert.rejects(transport.put(Readable.from([randomBytes(5000)]), toRemotePath('up.bin')), (error) => isSyncError(error) && error.transient);
      } finally {
        await transport.close();
        await rig.close();
      }
    });
  }

  test('ftps: a server that refuses replacing renames gets remove then rename', async () => {
    const rig = await startRig('ftps', { faults: { refuseRenameOverExisting: true } });
    const transport = rig.transport();
    try {
      await transport.connect();
      await transport.put(Readable.from([Buffer.from('new')]), toRemotePath('page.part'));
      await transport.put(Readable.from([Buffer.from('old')]), toRemotePath('page.html'));
      await transport.rename(toRemotePath('page.part'), toRemotePath('page.html'), true);
      const sink = collector();
      await transport.get(toRemotePath('page.html'), sink.stream);
      assert.equal(sink.data().toString(), 'new');
      assert.ok(rig.records.some((record) => record.level === 'warn' && record.message.includes('cannot replace a file in one step')));
    } finally {
      await transport.close();
      await rig.close();
    }
  });

  test('ftps: a server answering 421 shrinks the pool, and every operation still completes', async () => {
    const rig = await startRig('ftps', { faults: { maxConnections: 1 } });
    writeFileSync(path.join(rig.siteDir, 'a.txt'), 'a');
    const pool = new TransportPool(() => rig.transport(), { size: 3, shared: false });
    try {
      const results = await Promise.all(
        [1, 2, 3, 4].map(() =>
          pool.runWithRetry((transport) => transport.list(ROOT), { delaysMs: [20, 20, 20, 20, 20, 20] }),
        ),
      );
      assert.equal(results.length, 4);
      assert.ok(results.every((entries) => entries.some((entry) => entry.name === 'a.txt')));
      assert.equal(pool.limit, 1);
    } finally {
      await pool.close();
      await rig.close();
    }
  });

  test('ftps: a wrong password is E_AUTH and never appears in logs', async () => {
    const rig = await startRig('ftps');
    const wrong = `wrong-${randomBytes(6).toString('hex')}`;
    const transport = rig.transport({ password: wrong });
    try {
      await assert.rejects(withTransport(transport, () => transport.connect()), (error) => isSyncError(error, 'E_AUTH') && !error.message.includes(wrong));
      assert.ok(!JSON.stringify(rig.records).includes(wrong));
      assert.ok(rig.records.some((record) => record.message.includes('PASS')));
    } finally {
      await rig.close();
    }
  });
});
