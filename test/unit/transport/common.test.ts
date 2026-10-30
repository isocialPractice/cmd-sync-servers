import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { test } from 'node:test';
import basicFtp from 'basic-ftp';
import { isSyncError, SyncError } from '../../../src/errors.ts';
import { ROOT, toRemotePath } from '../../../src/sync/paths.ts';
import { checkListingLimit, makeEntry, networkError, withTimeout } from '../../../src/transport/common.ts';
import { ftpError, mfmtTime } from '../../../src/transport/ftp.ts';
import { StallGuard } from '../../../src/transport/stall.ts';
import { selfSignedCertificate } from '../../sandbox/cert.ts';

function nodeError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code });
}

test('network errors: resets are transient, certificates are E_TLS_CERT', () => {
  assert.equal(networkError(nodeError('ECONNRESET'), 'x').transient, true);
  assert.equal(networkError(nodeError('ENOTFOUND'), 'x').transient, false);
  const cert = networkError(nodeError('DEPTH_ZERO_SELF_SIGNED_CERT'), 'Connecting');
  assert.equal(cert.code, 'E_TLS_CERT');
  assert.match(cert.message, /^Connecting: the server's certificate was not accepted/);
  assert.equal(networkError(nodeError('ERR_TLS_CERT_ALTNAME_INVALID'), 'x').code, 'E_TLS_CERT');
  assert.equal(networkError(new Error('No response from server'), 'x').transient, true);
  const existing = new SyncError('E_AUTH', 'no');
  assert.equal(networkError(existing, 'x'), existing);
});

test('FTP replies: 421, 425, 426, 450 and 451 are transient; 530 is E_AUTH; 550 is permanent', () => {
  const reply = (code: number) => new basicFtp.FTPError({ code, message: `${String(code)} reply` });
  for (const code of [421, 425, 426, 450, 451]) {
    const error = ftpError(reply(code), 'x');
    assert.deepEqual([error.code, error.transient, error.serverCode], ['E_REMOTE', true, code]);
  }
  assert.equal(ftpError(reply(530), 'x').code, 'E_AUTH');
  assert.deepEqual([ftpError(reply(550), 'x').transient, ftpError(reply(553), 'x').serverCode], [false, 553]);
  assert.equal(ftpError(new Error('Timeout (data socket)'), 'x').code, 'E_TIMEOUT');
  assert.equal(ftpError(new Error('Server sent FIN packet unexpectedly, closing connection.'), 'x').transient, true);
});

test('mfmtTime is UTC, to the second', () => {
  assert.equal(mfmtTime(Date.UTC(2026, 9, 29, 7, 5, 9, 999)), '20261029070509');
});

test('makeEntry validates names', () => {
  assert.deepEqual(makeEntry(toRemotePath('css'), 'site.css', 'file', 10, 5, 'linux'), {
    name: 'site.css',
    path: 'css/site.css',
    unsafe: undefined,
    type: 'file',
    size: 10,
    mtimeMs: 5,
  });
  assert.equal(makeEntry(ROOT, '..', 'dir', 0, undefined, 'linux').unsafe, '".." is not a file name');
  assert.deepEqual(makeEntry(ROOT, '../x', 'file', 1, undefined, 'linux').path, undefined);
});

test('checkListingLimit allows the limit and refuses one more', () => {
  checkListingLimit(3, 3, '/www');
  assert.throws(() => {
    checkListingLimit(4, 3, '/www');
  }, (error) => isSyncError(error, 'E_LISTING_LIMIT'));
});

test('withTimeout rejects with a transient E_TIMEOUT and calls the cleanup', async () => {
  let cleaned = false;
  await assert.rejects(
    withTimeout(new Promise(() => undefined), 10, 'Waiting', () => {
      cleaned = true;
    }),
    (error) => isSyncError(error, 'E_TIMEOUT') && error.transient,
  );
  assert.equal(cleaned, true);
  assert.equal(await withTimeout(Promise.resolve(7), 1000, 'x'), 7);
});

test('StallGuard passes data through and fails a stream that stops moving', async () => {
  const chunks: Buffer[] = [];
  const sink = new PassThrough();
  sink.on('data', (chunk: Buffer) => chunks.push(chunk));
  await pipeline(Readable.from([Buffer.from('a'), Buffer.from('b')]), new StallGuard(1000, 'Copying'), sink);
  assert.equal(Buffer.concat(chunks).toString(), 'ab');
  const silent = new PassThrough();
  await assert.rejects(pipeline(silent, new StallGuard(20, 'Copying'), new PassThrough()), (error) => isSyncError(error, 'E_TIMEOUT') && error.transient);
});

test('the sandbox certificate is valid X.509 for localhost and 127.0.0.1', () => {
  for (const keyType of ['ec', 'rsa'] as const) {
    const { cert } = selfSignedCertificate({ keyType });
    const parsed = new X509Certificate(cert);
    assert.equal(parsed.checkHost('localhost'), 'localhost');
    assert.equal(parsed.checkIP('127.0.0.1'), '127.0.0.1');
    assert.equal(parsed.verify(parsed.publicKey), true);
    assert.equal(parsed.ca, true);
  }
});
