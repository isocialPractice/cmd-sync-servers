import { SyncError } from '../errors.ts';
import type { Redactor } from '../log/logger.ts';
import type { SecretPrompt } from './prompt.ts';
import type { CredentialStore, SecretRequest, SecretSource } from './types.ts';

/** Where {@link lookupSecret} may find a secret, in the order it tries them. */
export interface SecretLookupOptions {
  /** The saved-secret store, read only when the server saves its password. */
  readonly store?: CredentialStore | undefined;
  /** Read only when `savePassword` is on. */
  readonly savePassword: boolean;
  /** Environment variables for unattended runs. */
  readonly env?: SecretSource | undefined;
  /** Asks a person; absent when nobody can be asked. */
  readonly prompt?: SecretPrompt | undefined;
  /** Registers the secret so no log or error can show it. */
  readonly redactor?: Redactor | undefined;
}

/**
 * Finds a secret in this order: the saved-secret store (when the server saves
 * its password), the environment, then a prompt. Fails with `E_AUTH` when
 * none has it. There is no plaintext fallback.
 */
export async function lookupSecret(request: SecretRequest, options: SecretLookupOptions): Promise<string> {
  const sources: (() => Promise<string | undefined>)[] = [];
  const { store, env, prompt } = options;
  if (options.savePassword && store !== undefined) {
    sources.push(() => store.get(request.ref));
  }
  if (env !== undefined) {
    sources.push(() => env.get(request.ref));
  }
  if (prompt !== undefined) {
    sources.push(() => prompt(request));
  }
  for (const source of sources) {
    const secret = await source();
    if (secret !== undefined && secret !== '') {
      options.redactor?.addSecret(secret);
      return secret;
    }
  }
  const what = request.ref.kind === 'password' ? 'password' : 'key passphrase';
  throw new SyncError(
    'E_AUTH',
    `No ${what} for "${request.siteName}: ${request.serverName}". Save one with "sync-servers password set", set ${
      request.ref.kind === 'password' ? 'SYNC_SERVERS_PASSWORD' : 'SYNC_SERVERS_KEY_PASSPHRASE'
    }, or run in a terminal to be asked.`,
  );
}
