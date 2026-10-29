import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EnvSecretSource } from '../../../src/credentials/env.ts';
import { createKeyringStore, keyringName, openKeyringStore, type KeyringEntry } from '../../../src/credentials/keyring.ts';
import { lookupSecret } from '../../../src/credentials/lookup.ts';
import { MemoryCredentialStore } from '../../../src/credentials/memory.ts';
import { secretQuestion } from '../../../src/credentials/prompt.ts';
import { secretAccount, type SecretRef, type SecretRequest } from '../../../src/credentials/types.ts';
import { isSyncError } from '../../../src/errors.ts';
import { Redactor, REDACTED } from '../../../src/log/logger.ts';

const ref: SecretRef = { siteId: 'site-1', serverId: 'server-1', kind: 'password' };
const request: SecretRequest = { ref, siteName: 'My Site', serverName: 'Production', host: 'sftp.example.com', username: 'demo-user' };

test('secrets are addressed as <siteId>/<serverId>/<kind>', () => {
  assert.equal(secretAccount(ref), 'site-1/server-1/password');
});

test('the memory store keeps, returns and deletes secrets', async () => {
  const store = new MemoryCredentialStore();
  await store.set(ref, 'hunter2');
  assert.equal(await store.get(ref), 'hunter2');
  assert.equal(await store.get({ ...ref, kind: 'passphrase' }), undefined);
  assert.equal(await store.delete(ref), true);
  assert.equal(await store.delete(ref), false);
});

test('the environment supplies the password and the passphrase of the server in use', async () => {
  const env = new EnvSecretSource({ SYNC_SERVERS_PASSWORD: 'from-env', SYNC_SERVERS_KEY_PASSPHRASE: '' });
  assert.equal(await env.get(ref), 'from-env');
  assert.equal(await env.get({ ...ref, kind: 'passphrase' }), undefined);
});

test('the keyring store uses the sync-servers service and wraps failures', async () => {
  const saved = new Map<string, string>();
  const calls: string[] = [];
  class FakeEntry implements KeyringEntry {
    readonly #key: string;
    constructor(service: string, account: string) {
      calls.push(`${service} ${account}`);
      this.#key = account;
    }
    getPassword(): Promise<string | null> {
      return Promise.resolve(saved.get(this.#key) ?? null);
    }
    setPassword(password: string): Promise<void> {
      if (password === 'fail') {
        return Promise.reject(new Error('locked'));
      }
      saved.set(this.#key, password);
      return Promise.resolve();
    }
    deleteCredential(): Promise<boolean> {
      return Promise.resolve(saved.delete(this.#key));
    }
  }
  const store = createKeyringStore({ AsyncEntry: FakeEntry }, 'Test Keychain');
  await store.set(ref, 'hunter2');
  assert.equal(await store.get(ref), 'hunter2');
  assert.equal(await store.delete(ref), true);
  assert.equal(await store.get(ref), undefined);
  assert.equal(calls[0], 'sync-servers site-1/server-1/password');
  await assert.rejects(
    store.set(ref, 'fail'),
    (error) => isSyncError(error, 'E_CREDENTIAL_STORE') && error.message === 'The Test Keychain could not save the secret: locked',
  );
});

test('the optional keyring package loads where it is installed, without touching any secret', async () => {
  const store = await openKeyringStore();
  if (store === undefined) {
    return;
  }
  assert.equal(store.name, keyringName());
  assert.equal(typeof store.get, 'function');
});

test('lookup reads the saved store only when the server saves its password', async () => {
  const store = new MemoryCredentialStore();
  await store.set(ref, 'saved');
  const env = new EnvSecretSource({ SYNC_SERVERS_PASSWORD: 'from-env' });
  assert.equal(await lookupSecret(request, { store, env, savePassword: true }), 'saved');
  assert.equal(await lookupSecret(request, { store, env, savePassword: false }), 'from-env');
});

test('lookup asks last, and registers what it finds with the redactor', async () => {
  const redactor = new Redactor();
  const asked: SecretRequest[] = [];
  const secret = await lookupSecret(request, {
    savePassword: false,
    env: new EnvSecretSource({}),
    prompt: (question) => {
      asked.push(question);
      return Promise.resolve('typed');
    },
    redactor,
  });
  assert.equal(secret, 'typed');
  assert.equal(asked.length, 1);
  assert.equal(redactor.redact('typed'), REDACTED);
});

test('lookup fails with E_AUTH and never shows a secret when nothing has one', async () => {
  await assert.rejects(
    lookupSecret(request, { savePassword: true, store: new MemoryCredentialStore(), env: new EnvSecretSource({}) }),
    (error) => isSyncError(error, 'E_AUTH') && error.message.includes('SYNC_SERVERS_PASSWORD'),
  );
});

test('the question names the account and the site', () => {
  assert.equal(secretQuestion(request), 'Password for demo-user@sftp.example.com (My Site: Production): ');
  assert.equal(
    secretQuestion({ ...request, ref: { ...ref, kind: 'passphrase' }, username: undefined }),
    'Key passphrase for sftp.example.com (My Site: Production): ',
  );
});
