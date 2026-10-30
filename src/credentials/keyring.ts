import { SyncError } from '../errors.ts';
import { CREDENTIAL_SERVICE, secretAccount, type CredentialStore, type SecretRef } from './types.ts';

/** The part of a `@napi-rs/keyring` entry this store uses. */
export interface KeyringEntry {
  /** The stored secret, or `null` when there is none. */
  getPassword(): Promise<string | null>;
  /** Stores a secret, replacing any stored before. */
  setPassword(password: string): Promise<void>;
  /** Deletes the stored secret; `true` when there was one. */
  deleteCredential(): Promise<boolean>;
}

/** The part of the `@napi-rs/keyring` module this store uses, so tests can pass a fake. */
export interface KeyringModule {
  /** Creates an entry for a service and an account. */
  AsyncEntry: new (service: string, account: string) => KeyringEntry;
}

/** The name of the operating system's credential store, for messages. */
export function keyringName(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case 'win32':
      return 'Windows Credential Manager';
    case 'darwin':
      return 'macOS Keychain';
    default:
      return 'Secret Service keyring';
  }
}

function failure(name: string, action: string, error: unknown): SyncError {
  const reason = error instanceof Error ? error.message : String(error);
  return new SyncError('E_CREDENTIAL_STORE', `The ${name} could not ${action}: ${reason}`, { cause: error });
}

/**
 * A {@link CredentialStore} backed by the operating system's credential store,
 * under the service `sync-servers` and the account `<siteId>/<serverId>/<kind>`.
 */
export function createKeyringStore(keyring: KeyringModule, name: string = keyringName()): CredentialStore {
  const entry = (ref: SecretRef): KeyringEntry => new keyring.AsyncEntry(CREDENTIAL_SERVICE, secretAccount(ref));
  return {
    name,
    async get(ref) {
      try {
        return (await entry(ref).getPassword()) ?? undefined;
      } catch (error) {
        throw failure(name, 'read a saved secret', error);
      }
    },
    async set(ref, secret) {
      try {
        await entry(ref).setPassword(secret);
      } catch (error) {
        throw failure(name, 'save the secret', error);
      }
    },
    async delete(ref) {
      try {
        return await entry(ref).deleteCredential();
      } catch (error) {
        throw failure(name, 'delete a saved secret', error);
      }
    },
  };
}

/**
 * Loads the optional `@napi-rs/keyring` package and returns a store backed by
 * it, or `undefined` when the package or its native binary for this platform
 * is not installed.
 */
export async function openKeyringStore(): Promise<CredentialStore | undefined> {
  let loaded: Partial<KeyringModule> & { default?: Partial<KeyringModule> };
  try {
    loaded = await import('@napi-rs/keyring');
  } catch {
    return undefined;
  }
  const AsyncEntry = loaded.AsyncEntry ?? loaded.default?.AsyncEntry;
  return AsyncEntry === undefined ? undefined : createKeyringStore({ AsyncEntry });
}
