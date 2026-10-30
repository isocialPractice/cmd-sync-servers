import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openSecret, sealSecret, secretBinding } from '../../../src/credentials/binding.ts';
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

test('a saved secret is sent only to the protocol, address and user it was saved for', async () => {
  const server = { protocol: 'sftp', host: 'sftp.example.com', port: undefined, username: 'demo-user' } as const;
  const store = new MemoryCredentialStore();
  await store.set(ref, sealSecret('saved', server));
  const binding = secretBinding(server);
  assert.equal(await lookupSecret(request, { store, savePassword: true, binding }), 'saved');
  assert.equal(secretBinding({ ...server, port: 22, host: 'SFTP.example.com' }), binding, 'the default port and the case of the host do not matter');
  for (const changed of [
    { ...server, host: 'sftp.example.org' },
    { ...server, port: 2222 },
    { ...server, username: 'jane.doe' },
    { ...server, protocol: 'ftp' as const },
  ]) {
    await assert.rejects(
      lookupSecret(request, { store, savePassword: true, binding: secretBinding(changed), env: new EnvSecretSource({}) }),
      (error) => isSyncError(error, 'E_AUTH') && error.message.includes('saved for another protocol, address or user'),
    );
  }
  const env = new EnvSecretSource({ SYNC_SERVERS_PASSWORD: 'from-env' });
  assert.equal(await lookupSecret(request, { store, env, savePassword: true, binding: secretBinding({ ...server, port: 2222 }) }), 'from-env');
  assert.equal(openSecret('saved', server), undefined, 'an unsealed value is never sent');
  assert.equal(secretBinding({ protocol: 'local', host: undefined, port: undefined, username: undefined }).length, 64);
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

test('a saved secret skipped for another address says why before the question, and the error carries the reason', async () => {
  const server = { protocol: 'sftp', host: 'sftp.example.com', port: undefined, username: 'demo-user' } as const;
  const store = new MemoryCredentialStore();
  await store.set(ref, sealSecret('saved', server));
  const binding = secretBinding({ ...server, host: 'sftp.example.org' });
  const asked: SecretRequest[] = [];
  const origins: string[] = [];
  const typed = await lookupSecret(request, {
    store,
    savePassword: true,
    binding,
    prompt: (question) => {
      asked.push(question);
      return Promise.resolve('typed');
    },
    found: (origin) => origins.push(origin),
  });
  assert.equal(typed, 'typed');
  assert.deepEqual(origins, ['prompt']);
  assert.equal(asked[0]?.note, 'The saved password is for another host or user, so it was not sent.');
  await assert.rejects(
    lookupSecret(request, { store, savePassword: true, binding }),
    (error) => isSyncError(error, 'E_AUTH') && error.details?.reason === 'saved-for-elsewhere',
  );
  await assert.rejects(
    lookupSecret(request, { savePassword: false }),
    (error) => isSyncError(error, 'E_AUTH') && error.details?.reason === 'missing',
  );
  const fromStore: string[] = [];
  await lookupSecret(request, { store, savePassword: true, binding: secretBinding(server), found: (origin) => fromStore.push(origin) });
  assert.deepEqual(fromStore, ['store']);
});

test('the question names the account and the site', () => {
  assert.equal(secretQuestion(request), 'Password for demo-user on sftp.example.com (My Site: Production): ');
  assert.equal(
    secretQuestion({ ...request, username: 'demo-user@example.com', host: 'server1.hosting.example.net' }),
    'Password for demo-user@example.com on server1.hosting.example.net (My Site: Production): ',
  );
  assert.equal(
    secretQuestion({ ...request, ref: { ...ref, kind: 'passphrase' }, username: undefined }),
    'Key passphrase for sftp.example.com (My Site: Production): ',
  );
});
