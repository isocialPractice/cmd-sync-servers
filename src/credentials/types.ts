/** What a secret unlocks: a server password, or the passphrase of a private key. */
export type SecretKind = 'password' | 'passphrase';

/** Addresses one secret. Secrets are never part of `sites.json`. */
export interface SecretRef {
  readonly siteId: string;
  readonly serverId: string;
  readonly kind: SecretKind;
}

/** Context shown to a person asked for a secret. Never contains the secret. */
export interface SecretRequest {
  readonly ref: SecretRef;
  readonly siteName: string;
  readonly serverName: string;
  readonly host?: string | undefined;
  readonly username?: string | undefined;
}

/** Somewhere a secret can be read from. */
export interface SecretSource {
  /** The secret for `ref`, or `undefined` when this source has none. */
  get(ref: SecretRef): Promise<string | undefined>;
}

/** Somewhere secrets are kept: the OS credential store, VS Code SecretStorage, or memory. */
export interface CredentialStore extends SecretSource {
  /** A name for messages, such as "Windows Credential Manager". */
  readonly name: string;
  /** Keeps `secret` for `ref`, replacing any secret kept before. */
  set(ref: SecretRef, secret: string): Promise<void>;
  /** Resolves `true` when a secret was deleted, `false` when there was none. */
  delete(ref: SecretRef): Promise<boolean>;
}

/** The service name secrets are stored under. */
export const CREDENTIAL_SERVICE = 'sync-servers';

/** The account name of a secret in a credential store: `<siteId>/<serverId>/<kind>`. */
export function secretAccount(ref: SecretRef): string {
  return `${ref.siteId}/${ref.serverId}/${ref.kind}`;
}
