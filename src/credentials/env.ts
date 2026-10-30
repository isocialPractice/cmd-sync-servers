import type { SecretRef, SecretSource } from './types.ts';

/** Holds the password of the server in use, for unattended runs such as CI. */
export const PASSWORD_ENV = 'SYNC_SERVERS_PASSWORD';
/** Holds the private key passphrase of the server in use. */
export const PASSPHRASE_ENV = 'SYNC_SERVERS_KEY_PASSPHRASE';

/** Reads the secret of the server in use from the environment. Read-only. */
export class EnvSecretSource implements SecretSource {
  readonly #env: Readonly<Record<string, string | undefined>>;

  constructor(env: Readonly<Record<string, string | undefined>> = process.env) {
    this.#env = env;
  }

  /** {@link PASSWORD_ENV} for a password, {@link PASSPHRASE_ENV} for a key passphrase; an empty value counts as none. */
  get(ref: SecretRef): Promise<string | undefined> {
    const value = this.#env[ref.kind === 'password' ? PASSWORD_ENV : PASSPHRASE_ENV];
    return Promise.resolve(value === '' ? undefined : value);
  }
}
