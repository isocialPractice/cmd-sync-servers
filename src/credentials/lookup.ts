import { SyncError } from '../errors.ts';
import type { Redactor } from '../log/logger.ts';
import { openSecret } from './binding.ts';
import type { SecretPrompt } from './prompt.ts';
import type { CredentialStore, SecretRequest, SecretSource } from './types.ts';

/** Where {@link lookupSecret} may find a secret, in the order it tries them. */
export interface SecretLookupOptions {
  /** The saved-secret store, read only when the server saves its password. */
  readonly store?: CredentialStore | undefined;
  /** Read only when `savePassword` is on. */
  readonly savePassword: boolean;
  /**
   * The {@link secretBinding} of the server as it is now. A saved secret is
   * used only when it was saved for this binding; without one, a saved
   * secret is used as stored.
   */
  readonly binding?: string | undefined;
  /** Environment variables for unattended runs. */
  readonly env?: SecretSource | undefined;
  /** Asks a person; absent when nobody can be asked. */
  readonly prompt?: SecretPrompt | undefined;
  /** Registers the secret so no log or error can show it. */
  readonly redactor?: Redactor | undefined;
}

/**
 * Finds a secret in this order: the saved-secret store (when the server saves
 * its password, and only when it was saved for the server's current address),
 * the environment, then a prompt. Fails with `E_AUTH` when none has it. There
 * is no plaintext fallback.
 */
export async function lookupSecret(request: SecretRequest, options: SecretLookupOptions): Promise<string> {
  const sources: (() => Promise<string | undefined>)[] = [];
  const { store, env, prompt, binding } = options;
  const saved = { forElsewhere: false };
  if (options.savePassword && store !== undefined) {
    sources.push(async () => {
      const stored = await store.get(request.ref);
      if (stored === undefined || binding === undefined) {
        return stored;
      }
      const secret = openSecret(stored, binding);
      saved.forElsewhere = secret === undefined;
      return secret;
    });
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
  const variable = request.ref.kind === 'password' ? 'SYNC_SERVERS_PASSWORD' : 'SYNC_SERVERS_KEY_PASSPHRASE';
  throw new SyncError(
    'E_AUTH',
    saved.forElsewhere
      ? `The saved ${what} for "${request.siteName}: ${request.serverName}" was saved for another protocol, address or user, so it was not sent. Save it again with "sync-servers password set", set ${variable}, or run in a terminal to be asked.`
      : `No ${what} for "${request.siteName}: ${request.serverName}". Save one with "sync-servers password set", set ${variable}, or run in a terminal to be asked.`,
  );
}
