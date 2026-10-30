import { createHash } from 'node:crypto';
import { SyncError } from '../errors.ts';
import type { HostKeyDecision, HostKeyInfo } from '../host.ts';

/** A host key pinned in a server's settings. */
export interface PinnedHostKey {
  readonly algorithm: string;
  readonly sha256: string;
}

/**
 * How a connection decides whether to trust the host key it is offered.
 *
 * @experimental
 */
export interface HostKeyPolicy {
  /** The key pinned for this server, if any. */
  readonly pinned: PinnedHostKey | undefined;
  /** A fingerprint given for unattended runs (`--host-key SHA256:...`). */
  readonly expected?: string | undefined;
  /** Asks a person about a new key; absent when nobody can be asked. */
  readonly confirm?: ((info: HostKeyInfo) => Promise<HostKeyDecision>) | undefined;
  /** Stores a key the person chose to pin. */
  readonly pin?: ((info: HostKeyInfo) => Promise<void>) | undefined;
}

/** Algorithm and SHA-256 fingerprint of an SSH public key blob. */
export function describeHostKey(blob: Buffer, host: string, port: number): HostKeyInfo {
  const length = blob.length >= 4 ? blob.readUInt32BE(0) : 0;
  const algorithm = length > 0 && length + 4 <= blob.length ? blob.subarray(4, 4 + length).toString('latin1') : 'unknown';
  const sha256 = createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
  return { host, port, algorithm, sha256, fingerprint: `SHA256:${sha256}` };
}

/** Accepts `SHA256:abc`, `abc` or `abc=` and returns the bare unpadded fingerprint. */
export function normalizeFingerprint(text: string): string {
  return text.trim().replace(/^SHA256:/i, '').replace(/=+$/, '');
}

/**
 * Decides whether to trust `info`: a pinned key must
 * match exactly; a new key is accepted when it matches `expected`, or when a
 * person accepts it, and is pinned when they choose to. Anything else is
 * `E_HOST_KEY_MISMATCH`, never accepted silently.
 */
export async function verifyHostKey(info: HostKeyInfo, policy: HostKeyPolicy): Promise<void> {
  const { pinned } = policy;
  if (pinned !== undefined) {
    if (pinned.sha256 === info.sha256) {
      return;
    }
    throw new SyncError(
      'E_HOST_KEY_MISMATCH',
      [
        `The host key of ${info.host}:${String(info.port)} has changed.`,
        `  Pinned:  ${pinned.algorithm} SHA256:${pinned.sha256}`,
        `  Offered: ${info.algorithm} ${info.fingerprint}`,
        'This is what a machine-in-the-middle attack looks like. Check the new fingerprint with the host by another channel;',
        'only then remove the pin with "sync-servers server edit <server> --forget-host-key".',
      ].join('\n'),
    );
  }
  if (policy.expected !== undefined) {
    if (normalizeFingerprint(policy.expected) === info.sha256) {
      return;
    }
    throw new SyncError(
      'E_HOST_KEY_MISMATCH',
      `The host key of ${info.host}:${String(info.port)} is ${info.algorithm} ${info.fingerprint}, not the expected SHA256:${normalizeFingerprint(policy.expected)}.`,
    );
  }
  if (policy.confirm === undefined) {
    throw new SyncError(
      'E_HOST_KEY_MISMATCH',
      `The host key of ${info.host}:${String(info.port)} is not known yet: ${info.algorithm} ${info.fingerprint}. Confirm it by connecting from a terminal, or pass --host-key ${info.fingerprint} after checking it with the host.`,
    );
  }
  const decision = await policy.confirm(info);
  if (decision === 'reject') {
    throw new SyncError('E_HOST_KEY_MISMATCH', `The host key of ${info.host}:${String(info.port)} was not accepted.`);
  }
  if (decision === 'accept-and-pin') {
    await policy.pin?.(info);
  }
}
