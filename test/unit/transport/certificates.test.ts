import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PeerCertificate } from 'node:tls';
import basicFtp from 'basic-ftp';
import type { CertificateInfo } from '../../../src/host.ts';
import {
  certificateMessage,
  certificateNames,
  certificateProblem,
  certificateQuestion,
  describeCertificate,
  findCoveredNames,
  normalizeCertificateFingerprint,
  type NameResolver,
} from '../../../src/transport/certificates.ts';
import { folderList, networkError, remoteRootError } from '../../../src/transport/common.ts';
import { bannerLine, ftpError } from '../../../src/transport/ftp.ts';

const SHA = Array.from({ length: 32 }, (_, index) => (index * 7 + 16).toString(16).toUpperCase().padStart(2, '0')).join(':');
const OTHER = Array.from({ length: 32 }, () => 'AB').join(':');

function peer(overrides: Partial<PeerCertificate> = {}): PeerCertificate {
  return {
    subject: { CN: 'hosting.example.net' },
    issuer: { CN: 'Example Trust CA', O: 'Example Trust' },
    subjectaltname: 'DNS:*.hosting.example.net, DNS:hosting.example.net',
    valid_from: 'Mar  1 00:00:00 2026 GMT',
    valid_to: 'Mar 31 00:00:00 2027 GMT',
    fingerprint256: SHA,
    ...overrides,
  } as PeerCertificate;
}

function info(overrides: Partial<CertificateInfo> = {}): CertificateInfo {
  return { ...describeCertificate(peer(), '203.0.113.10', 21, 'name-mismatch'), ...overrides };
}

/** server1.hosting.example.net is 203.0.113.10, and the address resolves back to it. */
const resolver: NameResolver = {
  lookup: (host) =>
    Promise.resolve(
      ({ 'server1.hosting.example.net': ['203.0.113.10'], 'hosting.example.net': ['192.0.2.20'], 'example.com': ['203.0.113.10'] } as Record<string, string[]>)[host] ??
        [],
    ),
  reverse: (address) => Promise.resolve(address === '203.0.113.10' ? ['server1.hosting.example.net.'] : []),
};

test('fingerprints are written as colon-separated upper-case hex, from any common form', () => {
  const bare = SHA.replaceAll(':', '').toLowerCase();
  assert.equal(normalizeCertificateFingerprint(bare), SHA);
  assert.equal(normalizeCertificateFingerprint(`SHA256:${SHA}`), SHA);
  assert.equal(normalizeCertificateFingerprint(` ${SHA.toLowerCase()} `), SHA);
  assert.equal(normalizeCertificateFingerprint('3A:91:5C'), undefined);
  assert.equal(normalizeCertificateFingerprint('not a fingerprint'), undefined);
});

test('a certificate names its DNS and IP alternative names, or its CN when it has none', () => {
  assert.deepEqual(certificateNames(peer()), ['*.hosting.example.net', 'hosting.example.net']);
  assert.deepEqual(certificateNames(peer({ subjectaltname: 'DNS:localhost, IP Address:127.0.0.1' })), ['localhost', '127.0.0.1']);
  assert.deepEqual(certificateNames(peer({ subjectaltname: 'DNS:"odd,name.example.com"' })), ['odd,name.example.com']);
  assert.deepEqual(certificateNames(peer({ subjectaltname: undefined as unknown as string })), ['hosting.example.net']);
});

test('the problem comes from the dates first, then the verification error', () => {
  const now = Date.parse('2026-10-30T12:00:00Z');
  assert.equal(certificateProblem('ERR_TLS_CERT_ALTNAME_INVALID', peer(), now), 'name-mismatch');
  assert.equal(certificateProblem('DEPTH_ZERO_SELF_SIGNED_CERT', peer(), now), 'self-signed');
  assert.equal(certificateProblem('UNABLE_TO_VERIFY_LEAF_SIGNATURE', peer(), now), 'untrusted-issuer');
  assert.equal(certificateProblem('SELF_SIGNED_CERT_IN_CHAIN', peer(), now), 'untrusted-issuer');
  assert.equal(certificateProblem('SOMETHING_ELSE', peer(), now), 'other');
  assert.equal(certificateProblem(undefined, peer(), now), 'other');
  assert.equal(certificateProblem('DEPTH_ZERO_SELF_SIGNED_CERT', peer(), Date.parse('2027-06-01T00:00:00Z')), 'expired');
  assert.equal(certificateProblem('ERR_TLS_CERT_ALTNAME_INVALID', peer(), Date.parse('2026-01-01T00:00:00Z')), 'not-yet-valid');
  assert.equal(certificateProblem(new Error('CERT_HAS_EXPIRED'), peer({ valid_to: 'garbage' }), now), 'expired');
});

test('a description escapes what the server wrote and keeps ISO dates', () => {
  const described = describeCertificate(peer({ issuer: { ...peer().issuer, CN: 'Evil\u001b[31m CA' } }), '203.0.113.10', 21, 'untrusted-issuer');
  assert.ok(!described.issuer.includes('\u001b'));
  assert.equal(described.validFrom, '2026-03-01T00:00:00.000Z');
  assert.equal(described.validTo, '2027-03-31T00:00:00.000Z');
  assert.equal(described.sha256, SHA);
  assert.deepEqual(described.coveredNames, []);
});

test('a covered name is one the certificate covers that resolves back to the same machine', async () => {
  assert.deepEqual(await findCoveredNames('203.0.113.10', peer(), resolver), ['server1.hosting.example.net']);
  assert.deepEqual(await findCoveredNames('example.com', peer(), resolver), ['server1.hosting.example.net']);
  // hosting.example.net is covered, but it is another machine.
  assert.ok(!(await findCoveredNames('203.0.113.10', peer(), resolver)).includes('hosting.example.net'));
  const silent: NameResolver = { lookup: () => Promise.reject(new Error('no DNS')), reverse: () => Promise.reject(new Error('no DNS')) };
  assert.deepEqual(await findCoveredNames('example.com', peer(), silent), []);
});

test('lookups that hang give up within the time budget', async () => {
  const hanging: NameResolver = { lookup: () => new Promise(() => undefined), reverse: () => new Promise(() => undefined) };
  const started = Date.now();
  assert.deepEqual(await findCoveredNames('example.com', peer(), hanging), []);
  assert.ok(Date.now() - started < 3000);
});

test('the choices put a covered name first, and default to cancel without one', () => {
  const covered = certificateQuestion(info({ coveredNames: ['server1.hosting.example.net'] }));
  assert.equal(covered.question, '203.0.113.10 is server1.hosting.example.net, which this certificate covers.');
  assert.deepEqual(
    covered.choices.map((choice) => choice.value),
    [
      { action: 'use-host', host: 'server1.hosting.example.net' },
      { action: 'check-as', servername: 'server1.hosting.example.net' },
      { action: 'accept-and-pin' },
      { action: 'reject' },
    ],
  );
  assert.equal(covered.initial, 0);
  const plain = certificateQuestion(info({ problem: 'self-signed' }));
  assert.deepEqual(plain.choices.map((choice) => choice.value.action), ['accept-and-pin', 'reject']);
  assert.equal(plain.initial, 1);
  assert.match(certificateQuestion(info({ problem: 'changed', previousSha256: OTHER })).choices[0]?.label ?? '', /new certificate/);
});

test('the message for an unattended run names the certificate and the fixes', () => {
  const withName = certificateMessage(info({ coveredNames: ['server1.hosting.example.net'] }), 'Production');
  assert.match(withName, /^The certificate of 203\.0\.113\.10:21 does not name 203\.0\.113\.10\.$/m);
  assert.match(withName, /^ {2}Issued to {2}\*\.hosting\.example\.net, hosting\.example\.net$/m);
  assert.match(withName, /^ {2}Issued by {2}Example Trust CA$/m);
  assert.match(withName, new RegExp(`^ {2}SHA-256 {4}${SHA}$`, 'm'));
  assert.match(withName, /^Connect to a host it covers: {2}sync-servers server edit Production --host server1\.hosting\.example\.net$/m);
  assert.match(withName, new RegExp(`--trust-certificate ${SHA} after checking it with the host`));
  const withoutName = certificateMessage(info(), 'My Server');
  assert.match(withoutName, /^Connect to a host name the certificate lists, or run "sync-servers server test"/m);
  const changed = certificateMessage(info({ problem: 'changed', previousSha256: OTHER }), 'Production');
  assert.match(changed, new RegExp(`Trusted {4}${OTHER}`));
  assert.match(changed, new RegExp(`Offered {4}${SHA}`));
  const expired = certificateMessage(info({ problem: 'expired' }), 'Production');
  assert.match(expired, /expired on 2027-03-31/);
  assert.match(expired, /never trusted/);
  assert.doesNotMatch(expired, /--trust-certificate/);
});

test('network failures say what to check, and a refused sign-in suggests the full user name', () => {
  const notFound = Object.assign(new Error('getaddrinfo ENOTFOUND ftp.example.org (control socket)'), { code: 'ENOTFOUND' });
  const lost = ftpError(notFound, 'Connecting to ftp.example.org:21', { host: 'ftp.example.org', port: 21 });
  assert.equal(lost.code, 'E_CONNECTION');
  assert.equal(lost.transient, false);
  assert.equal(lost.message, 'The host ftp.example.org was not found. Check the spelling against the FTP or SFTP host your hosting panel shows.');
  const refused = networkError(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), 'Connecting', {
    host: 'server1.hosting.example.net',
    port: 21,
  });
  assert.match(refused.message, /^server1\.hosting\.example\.net refused the connection on port 21\. Check the protocol and port: SFTP usually uses 22/);
  const signIn = ftpError(new basicFtp.FTPError({ code: 530, message: '530 Login incorrect.' }), 'Connecting', {
    host: 'server1.hosting.example.net',
    port: 21,
  });
  assert.equal(signIn.code, 'E_AUTH');
  assert.equal(signIn.details?.reason, 'rejected');
  assert.equal(
    signIn.message,
    'server1.hosting.example.net did not accept the user name or password (530). Check the user name: many hosts name FTP accounts in full, as user@domain.',
  );
});

test('a missing remote root names the starting folder and what it holds', () => {
  const error = remoteRootError('/home/<user>/example.com/my-site', 'server1.hosting.example.net', { startingFolder: '/', folders: ['css', 'images', 'js'] }, 'Production');
  assert.equal(
    error.message,
    'The remote root /home/<user>/example.com/my-site was not found on server1.hosting.example.net. This account opens in "/", which holds css/, images/ and js/. Choose the root with "sync-servers server edit Production", or pass --remote-root.',
  );
  assert.deepEqual(error.details, { startingFolder: '/', folders: ['css', 'images', 'js'] });
  assert.equal(folderList(['a', 'b', 'c', 'd', 'e', 'f', 'g']), 'a/, b/, c/, d/, e/ and 2 more');
  assert.equal(folderList(['css']), 'css/');
  assert.match(remoteRootError('/x', 'h', {}, 'My Server').message, /server edit "My Server"/);
  assert.match(remoteRootError('/x', 'h', { startingFolder: '/' }, undefined).message, /which holds no folders/);
});

test('a welcome banner shows its first line', () => {
  assert.equal(bannerLine('220-sync-servers sandbox FTP ready.\n220-Local time is now 10:00.\n220 Bye.'), 'sync-servers sandbox FTP ready.');
  assert.equal(bannerLine('220 Ready'), 'Ready');
  assert.equal(bannerLine(''), '');
});
