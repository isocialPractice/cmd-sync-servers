import type { CredentialStore, SecretRequest } from './credentials/types.ts';
import type { Logger } from './log/logger.ts';

/** An SSH host key offered by a server, as shown to a person. */
export interface HostKeyInfo {
  readonly host: string;
  readonly port: number;
  /** The key algorithm, such as `ssh-ed25519`. */
  readonly algorithm: string;
  /** The unpadded base64 SHA-256 fingerprint, as OpenSSH prints it after `SHA256:`. */
  readonly sha256: string;
  /** `SHA256:<base64>`. */
  readonly fingerprint: string;
}

export type HostKeyDecision = 'accept-and-pin' | 'accept-once' | 'reject';

/**
 * What the engine needs from the program it runs in: where secrets are kept,
 * how a new SSH host key is confirmed, and how a person is asked for a secret.
 * The CLI and the VS Code extension each supply one.
 */
export interface HostAdapter {
  readonly credentials: CredentialStore;
  /** False when nobody can answer a question, as in an unattended run: new host keys are then refused. */
  readonly interactive?: boolean;
  /** Asks whether to trust a host key seen for the first time. */
  confirmHostKey(info: HostKeyInfo): Promise<HostKeyDecision>;
  /** Asks for a secret; resolves `undefined` when nobody can be asked or the person cancels. */
  promptSecret(request: SecretRequest): Promise<string | undefined>;
  readonly logger?: Logger;
}
