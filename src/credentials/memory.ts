import { secretAccount, type CredentialStore, type SecretRef } from './types.ts';

/** Keeps secrets in memory for the life of the process; for tests and one-off sessions. */
export class MemoryCredentialStore implements CredentialStore {
  readonly name = 'memory';
  readonly #secrets = new Map<string, string>();

  /** The secret kept for `ref`, if any. */
  get(ref: SecretRef): Promise<string | undefined> {
    return Promise.resolve(this.#secrets.get(secretAccount(ref)));
  }

  /** Keeps `secret` for `ref` until the process ends. */
  set(ref: SecretRef, secret: string): Promise<void> {
    this.#secrets.set(secretAccount(ref), secret);
    return Promise.resolve();
  }

  /** Forgets the secret for `ref`; `true` when there was one. */
  delete(ref: SecretRef): Promise<boolean> {
    return Promise.resolve(this.#secrets.delete(secretAccount(ref)));
  }
}
