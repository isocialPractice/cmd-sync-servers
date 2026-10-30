import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { isSyncError } from '../../../src/errors.ts';
import type { HostKeyInfo } from '../../../src/host.ts';
import { describeHostKey, normalizeFingerprint, verifyHostKey } from '../../../src/transport/hostkeys.ts';

function blob(algorithm: string, body: string): Buffer {
  const name = Buffer.from(algorithm, 'latin1');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(name.length);
  return Buffer.concat([length, name, Buffer.from(body)]);
}

const key = blob('ssh-ed25519', 'public-key-bytes');
const info = describeHostKey(key, 'sftp.example.com', 22);

test('describeHostKey reads the algorithm and an unpadded SHA-256 fingerprint', () => {
  const expected = createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
  assert.deepEqual(info, { host: 'sftp.example.com', port: 22, algorithm: 'ssh-ed25519', sha256: expected, fingerprint: `SHA256:${expected}` });
  assert.equal(describeHostKey(Buffer.from([0, 0]), 'h', 22).algorithm, 'unknown');
  assert.equal(describeHostKey(Buffer.from([0, 0, 0, 99, 1]), 'h', 22).algorithm, 'unknown');
});

test('normalizeFingerprint accepts the forms people paste', () => {
  assert.equal(normalizeFingerprint(' SHA256:abc= '), 'abc');
  assert.equal(normalizeFingerprint('sha256:abc'), 'abc');
  assert.equal(normalizeFingerprint('abc'), 'abc');
});

test('a matching pin connects without asking', async () => {
  await verifyHostKey(info, {
    pinned: { algorithm: 'ssh-ed25519', sha256: info.sha256 },
    confirm: () => Promise.reject(new Error('must not ask')),
  });
});

test('a different pin is a mismatch naming both keys, never confirmed', async () => {
  let asked = false;
  await assert.rejects(
    verifyHostKey(info, {
      pinned: { algorithm: 'ssh-ed25519', sha256: 'B'.repeat(43) },
      confirm: () => {
        asked = true;
        return Promise.resolve('accept-and-pin');
      },
    }),
    (error) => isSyncError(error, 'E_HOST_KEY_MISMATCH') && error.message.includes('B'.repeat(43)) && error.message.includes(info.fingerprint),
  );
  assert.equal(asked, false);
});

test('an expected fingerprint accepts the key it names and refuses others', async () => {
  await verifyHostKey(info, { pinned: undefined, expected: info.fingerprint });
  await verifyHostKey(info, { pinned: undefined, expected: `${info.sha256}=` });
  await assert.rejects(verifyHostKey(info, { pinned: undefined, expected: 'SHA256:other' }), (error) => isSyncError(error, 'E_HOST_KEY_MISMATCH'));
});

test('an unknown key with nobody to ask is refused, with the fingerprint to check', async () => {
  await assert.rejects(
    verifyHostKey(info, { pinned: undefined }),
    (error) => isSyncError(error, 'E_HOST_KEY_MISMATCH') && error.message.includes(`--host-key ${info.fingerprint}`),
  );
});

test('the decision decides: pin, once, or reject', async () => {
  const pinned: HostKeyInfo[] = [];
  const pin = (value: HostKeyInfo): Promise<void> => {
    pinned.push(value);
    return Promise.resolve();
  };
  await verifyHostKey(info, { pinned: undefined, confirm: () => Promise.resolve('accept-and-pin'), pin });
  await verifyHostKey(info, { pinned: undefined, confirm: () => Promise.resolve('accept-once'), pin });
  await assert.rejects(verifyHostKey(info, { pinned: undefined, confirm: () => Promise.resolve('reject'), pin }), (error) => isSyncError(error, 'E_HOST_KEY_MISMATCH'));
  assert.deepEqual(pinned, [info]);
});
