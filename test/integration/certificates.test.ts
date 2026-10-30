import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { isSyncError } from '../../src/errors.ts';
import type { CertificateDecision, CertificateInfo } from '../../src/host.ts';
import { ROOT } from '../../src/sync/paths.ts';
import type { CertificateChange, NameResolver } from '../../src/transport/certificates.ts';
import type { Transport } from '../../src/transport/types.ts';
import { certificateAuthority, testCertificate, type TestCertificate } from '../sandbox/cert.ts';
import type { FtpSandbox } from '../sandbox/ftp-server.ts';
import { startRig, type Rig } from '../sandbox/rig.ts';
import { startSiteRig } from '../sandbox/site-rig.ts';

/** localhost is 127.0.0.1, and 127.0.0.1 resolves back to localhost. */
const resolver: NameResolver = {
  lookup: (host) => Promise.resolve(host === 'localhost' ? ['127.0.0.1'] : []),
  reverse: (address) => Promise.resolve(address === '127.0.0.1' ? ['localhost'] : []),
};

async function withTransport<T>(transport: Transport, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } finally {
    await transport.close();
  }
}

/** An FTPS sandbox whose certificate, issued by a test authority, names only `localhost`. */
async function mismatchRig(kind: 'ftps' | 'ftps-implicit' = 'ftps'): Promise<{ rig: Rig; ca: TestCertificate; certificate: TestCertificate }> {
  const ca = certificateAuthority();
  const certificate = testCertificate({ issuer: ca, dnsNames: ['localhost'], ipAddresses: [] });
  return { rig: await startRig(kind, { certificate, ca }), ca, certificate };
}

function signInCommands(rig: Rig): string[] {
  return (rig.sandbox as FtpSandbox).commands.filter((command) => /^(USER|PASS)\b/.test(command));
}

describe('a certificate that names another host', () => {
  test('unattended, it is refused before the user name is sent, with the covered name and the fixes', async () => {
    const { rig, certificate } = await mismatchRig();
    try {
      const transport = rig.transport({ tls: { caFile: rig.caFile }, resolver, serverName: 'Production' });
      await assert.rejects(withTransport(transport, () => transport.connect()), (error) => {
        assert.ok(isSyncError(error, 'E_TLS_CERT'));
        assert.match(error.message, /^The certificate of 127\.0\.0\.1:\d+ does not name 127\.0\.0\.1\.$/m);
        assert.match(error.message, /sync-servers server edit Production --host localhost/);
        assert.match(error.message, new RegExp(`--trust-certificate ${certificate.sha256}`));
        assert.equal(error.details?.certificate?.problem, 'name-mismatch');
        assert.deepEqual(error.details.certificate.coveredNames, ['localhost']);
        assert.equal(error.details.certificate.issuer, 'Example Trust CA');
        return true;
      });
      assert.deepEqual(signInCommands(rig), []);
      assert.equal(rig.secretRequests, 0);
    } finally {
      await rig.close();
    }
  });

  for (const kind of ['ftps', 'ftps-implicit'] as const) {
    test(`${kind}: choosing the covered name connects to it with full verification and saves the host`, async () => {
      const { rig } = await mismatchRig(kind);
      try {
        const asked: CertificateInfo[] = [];
        const changes: CertificateChange[] = [];
        const transport = rig.transport({
          tls: { caFile: rig.caFile },
          resolver,
          ipFamily: 4,
          confirmCertificate: (info) => {
            asked.push(info);
            assert.deepEqual(signInCommands(rig), [], 'nothing about the account is sent before the decision');
            return Promise.resolve({ action: 'use-host', host: 'localhost' });
          },
          certificateChanged: (change) => {
            changes.push(change);
            return Promise.resolve();
          },
        });
        await withTransport(transport, async () => {
          await transport.connect();
          await transport.list(ROOT);
        });
        assert.equal(asked.length, 1);
        assert.deepEqual(changes, [{ host: 'localhost' }]);
        assert.deepEqual(signInCommands(rig), ['USER demo-user', 'PASS ***']);
      } finally {
        await rig.close();
      }
    });
  }

  test('checking the certificate as the covered name keeps the host and saves the name to check', async () => {
    const { rig } = await mismatchRig();
    try {
      const changes: CertificateChange[] = [];
      const transport = rig.transport({
        tls: { caFile: rig.caFile },
        resolver,
        confirmCertificate: () => Promise.resolve({ action: 'check-as', servername: 'localhost' }),
        certificateChanged: (change) => {
          changes.push(change);
          return Promise.resolve();
        },
      });
      await withTransport(transport, () => transport.connect());
      assert.deepEqual(changes, [{ servername: 'localhost' }]);
      const again = rig.transport({ tls: { caFile: rig.caFile, servername: 'localhost' } });
      await withTransport(again, () => again.connect());
    } finally {
      await rig.close();
    }
  });

  test('a decision for a name the certificate does not cover is refused', async () => {
    const { rig } = await mismatchRig();
    try {
      const transport = rig.transport({
        tls: { caFile: rig.caFile },
        resolver,
        confirmCertificate: () => Promise.resolve({ action: 'use-host', host: 'ftp.example.org' }),
      });
      await assert.rejects(withTransport(transport, () => transport.connect()), (error) => isSyncError(error, 'E_TLS_CERT') && /not accepted/.test(error.message));
      assert.deepEqual(signInCommands(rig), []);
    } finally {
      await rig.close();
    }
  });
});

describe('trusting a certificate', () => {
  test('trusting and remembering pins its fingerprint, and the pin connects later without asking', async () => {
    const rig = await startRig('ftps');
    try {
      const changes: CertificateChange[] = [];
      const first = rig.transport({
        trustCertificate: false,
        confirmCertificate: (info) => {
          assert.equal(info.problem, 'self-signed');
          return Promise.resolve({ action: 'accept-and-pin' });
        },
        certificateChanged: (change) => {
          changes.push(change);
          return Promise.resolve();
        },
      });
      await withTransport(first, async () => {
        await first.connect();
        writeFileSync(path.join(rig.siteDir, 'index.html'), 'home');
        assert.equal((await first.list(ROOT)).length, 1, 'data connections work under the pin');
      });
      const pin = changes[0];
      assert.ok(pin !== undefined && 'trustedCertificate' in pin);
      assert.equal(pin.trustedCertificate.sha256, rig.certificate?.sha256);
      const later = rig.transport({
        tls: { trustedCertificate: pin.trustedCertificate },
        confirmCertificate: () => assert.fail('a pinned certificate is not asked about'),
      });
      await withTransport(later, () => later.connect());
    } finally {
      await rig.close();
    }
  });

  test('trusting it once is not stored, and the next connection asks again', async () => {
    const rig = await startRig('ftps');
    try {
      const decisions: CertificateDecision[] = [];
      let changed = 0;
      const transport = (): Transport =>
        rig.transport({
          trustCertificate: false,
          confirmCertificate: () => {
            decisions.push({ action: 'accept-once' });
            return Promise.resolve({ action: 'accept-once' });
          },
          certificateChanged: () => {
            changed += 1;
            return Promise.resolve();
          },
        });
      const first = transport();
      await withTransport(first, () => first.connect());
      const second = transport();
      await withTransport(second, () => second.connect());
      assert.equal(decisions.length, 2);
      assert.equal(changed, 0);
    } finally {
      await rig.close();
    }
  });

  test('a fingerprint given for an unattended run is accepted, and another one is refused', async () => {
    const rig = await startRig('ftps');
    try {
      const sha = rig.certificate?.sha256 ?? '';
      const accepted = rig.transport({ trustCertificate: false, expectedCertificate: sha.replaceAll(':', '').toLowerCase() });
      await withTransport(accepted, () => accepted.connect());
      const other = rig.transport({ trustCertificate: false, expectedCertificate: Array.from({ length: 32 }, () => 'AB').join(':') });
      await assert.rejects(withTransport(other, () => other.connect()), (error) => isSyncError(error, 'E_TLS_CERT') && /--trust-certificate/.test(error.message));
    } finally {
      await rig.close();
    }
  });
});

describe('a certificate that changed', () => {
  const previous = Array.from({ length: 32 }, () => 'AB').join(':');
  const pinned = { sha256: previous, validTo: '2027-01-01T00:00:00.000Z', pinnedAt: '2026-10-01T12:00:00.000Z' };

  test('is refused unattended with both fingerprints and the --trust-certificate form', async () => {
    const rig = await startRig('ftps');
    try {
      const transport = rig.transport({ tls: { trustedCertificate: pinned } });
      await assert.rejects(withTransport(transport, () => transport.connect()), (error) => {
        assert.ok(isSyncError(error, 'E_TLS_CERT'));
        assert.match(error.message, new RegExp(`Trusted {4}${previous}`));
        assert.match(error.message, new RegExp(`Offered {4}${rig.certificate?.sha256 ?? ''}`));
        assert.match(error.message, /--trust-certificate/);
        return true;
      });
      assert.deepEqual(signInCommands(rig), []);
    } finally {
      await rig.close();
    }
  });

  test('is asked about in a terminal, with the fingerprint trusted before', async () => {
    const rig = await startRig('ftps');
    try {
      const asked: CertificateInfo[] = [];
      const transport = rig.transport({
        tls: { trustedCertificate: pinned },
        confirmCertificate: (info) => {
          asked.push(info);
          return Promise.resolve({ action: 'reject' });
        },
      });
      await assert.rejects(withTransport(transport, () => transport.connect()), (error) => isSyncError(error, 'E_TLS_CERT'));
      assert.equal(asked[0]?.problem, 'changed');
      assert.equal(asked[0].previousSha256, previous);
    } finally {
      await rig.close();
    }
  });
});

describe('certificates that are never trusted', () => {
  for (const [name, options] of [
    ['expired', { notBefore: new Date(Date.now() - 3 * 86_400_000), notAfter: new Date(Date.now() - 86_400_000) }],
    ['not yet valid', { notBefore: new Date(Date.now() + 86_400_000), notAfter: new Date(Date.now() + 3 * 86_400_000) }],
  ] as const) {
    test(`an ${name} certificate is refused even when pinned, and nobody is asked`, async () => {
      const certificate = testCertificate(options);
      const rig = await startRig('ftps', { certificate });
      try {
        const transport = rig.transport({
          tls: { caFile: rig.caFile, servername: 'localhost', trustedCertificate: { sha256: certificate.sha256, validTo: options.notAfter.toISOString(), pinnedAt: new Date().toISOString() } },
          expectedCertificate: certificate.sha256,
          confirmCertificate: () => assert.fail('an untrustable certificate is not offered'),
        });
        await assert.rejects(withTransport(transport, () => transport.connect()), (error) => {
          assert.ok(isSyncError(error, 'E_TLS_CERT'));
          assert.match(error.message, /never trusted/);
          return true;
        });
        assert.deepEqual(signInCommands(rig), []);
      } finally {
        await rig.close();
      }
    });
  }
});

describe('a sync session', () => {
  for (const action of ['accept-and-pin', 'accept-once'] as const) {
    test(`${action}: asks once for all of its connections${action === 'accept-and-pin' ? ', and saves the pin in sites.json' : ''}`, async () => {
      const certificate = testCertificate();
      const siteRig = await startSiteRig('ftps', { certificate, ca: certificateAuthority() });
      try {
        for (let index = 0; index < 8; index += 1) {
          siteRig.write('remote', `page-${String(index)}.html`, `page ${String(index)}`);
        }
        let asked = 0;
        const session = await siteRig.open({
          interactive: true,
          confirmCertificate: (info) => {
            asked += 1;
            assert.equal(info.problem, 'self-signed');
            return Promise.resolve({ action });
          },
        });
        try {
          const plan = await session.plan({ direction: 'get' });
          await session.execute(plan);
        } finally {
          await session.close();
        }
        assert.equal(asked, 1);
        assert.equal(siteRig.read('local', 'page-7.html'), 'page 7');
        await siteRig.registry.reload();
        const pinned = siteRig.registry.get(siteRig.site.id)?.servers[0]?.options.tls?.trustedCertificate;
        assert.equal(pinned?.sha256, action === 'accept-and-pin' ? certificate.sha256 : undefined);
      } finally {
        await siteRig.close();
      }
    });
  }
});

describe('data connections', () => {
  for (const kind of ['ftps', 'ftps-implicit'] as const) {
    test(`${kind}: a data connection that presents another certificate is closed before data moves`, async () => {
      const rig = await startRig(kind, { dataCertificate: testCertificate() });
      try {
        writeFileSync(path.join(rig.siteDir, 'index.html'), 'home');
        const transport = rig.transport();
        await withTransport(transport, async () => {
          await transport.connect();
          await assert.rejects(transport.list(ROOT), (error) => isSyncError(error, 'E_TLS_CERT') && /another certificate/.test(error.message));
        });
      } finally {
        await rig.close();
      }
    });
  }
});
