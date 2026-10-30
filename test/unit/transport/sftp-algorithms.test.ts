import assert from 'node:assert/strict';
import { getCiphers } from 'node:crypto';
import { test } from 'node:test';
import { MODERN_ALGORITHMS, modernCiphers } from '../../../src/transport/sftp.ts';

test('ChaCha20-Poly1305 is offered only where the runtime has ChaCha20, which the Electron inside VS Code lacks', () => {
  assert.deepEqual(modernCiphers(['aes-256-gcm', 'aes-128-gcm', 'aes-256-ctr', 'aes-192-ctr', 'aes-128-ctr']), [
    'aes256-gcm@openssh.com',
    'aes128-gcm@openssh.com',
    'aes256-ctr',
    'aes192-ctr',
    'aes128-ctr',
  ]);
  assert.deepEqual(modernCiphers(['chacha20']).slice(0, 3), ['aes256-gcm@openssh.com', 'aes128-gcm@openssh.com', 'chacha20-poly1305@openssh.com']);
  assert.deepEqual(MODERN_ALGORITHMS.cipher, modernCiphers(getCiphers()));
});
