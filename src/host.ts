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

/** Trust a new host key and pin it in the server's settings, trust it for this connection only, or refuse it. */
export type HostKeyDecision = 'accept-and-pin' | 'accept-once' | 'reject';

/**
 * Why a TLS certificate did not verify: it names another host, its issuer
 * is not trusted, it signed itself, it is out of its validity dates, it is
 * not the certificate trusted before, or something else.
 */
export type CertificateProblem = 'name-mismatch' | 'untrusted-issuer' | 'self-signed' | 'expired' | 'not-yet-valid' | 'changed' | 'other';

/**
 * A TLS certificate that did not verify, as shown to a person. Every string
 * comes from the server and is escaped before it is shown.
 */
export interface CertificateInfo {
  readonly host: string;
  readonly port: number;
  /** DNS and IP names from the subject alternative names, then the subject CN when there are none. */
  readonly names: readonly string[];
  /** Who issued it, such as the name of a certificate authority. */
  readonly issuer: string;
  /** ISO 8601. */
  readonly validFrom: string;
  /** ISO 8601. */
  readonly validTo: string;
  /** Colon-separated upper-case hex, as Node's fingerprint256 and most clients show it. */
  readonly sha256: string;
  readonly problem: CertificateProblem;
  /** Host names that resolve to this server and that the certificate covers, best first. */
  readonly coveredNames: readonly string[];
  /** For `changed`: the fingerprint that was trusted before. */
  readonly previousSha256?: string | undefined;
}

/**
 * What to do about a certificate that did not verify: connect to a host name
 * it covers, keep the host and check the certificate as that name, trust it
 * and remember it for this server, trust it for this connection only, or
 * refuse it.
 */
export type CertificateDecision =
  | { readonly action: 'use-host'; readonly host: string }
  | { readonly action: 'check-as'; readonly servername: string }
  | { readonly action: 'accept-and-pin' }
  | { readonly action: 'accept-once' }
  | { readonly action: 'reject' };

/**
 * What the engine needs from the program it runs in: where secrets are kept,
 * how a new SSH host key or an unverified certificate is decided on, and how
 * a person is asked for a secret. The CLI and the VS Code extension each
 * supply one.
 */
export interface HostAdapter {
  /** Where saved passwords and key passphrases are read, and new ones kept. */
  readonly credentials: CredentialStore;
  /** False when nobody can answer a question, as in an unattended run: new host keys are then refused. */
  readonly interactive?: boolean;
  /** Asks whether to trust a host key seen for the first time. */
  confirmHostKey(info: HostKeyInfo): Promise<HostKeyDecision>;
  /** Asks what to do about a certificate that did not verify. Absent: refused, as before. */
  confirmCertificate?(info: CertificateInfo): Promise<CertificateDecision>;
  /** Asks for a secret; resolves `undefined` when nobody can be asked or the person cancels. */
  promptSecret(request: SecretRequest): Promise<string | undefined>;
  /** Called once after a sign-in succeeds with a secret a person typed; may offer to save it. */
  secretAccepted?(request: SecretRequest, secret: string): Promise<void>;
  /** Where the engine logs, with secrets redacted. */
  readonly logger?: Logger;
}
