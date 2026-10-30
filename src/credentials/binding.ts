import { createHash } from 'node:crypto';
import { defaultPort, type Server } from '../config/schema.ts';

/** The fields of a server a saved secret is tied to. */
export type BoundServer = Pick<Server, 'protocol' | 'host' | 'port' | 'username'>;

/**
 * A digest of the protocol, host, port and user a secret was saved for. A
 * saved secret is sent only while the server still matches it, so a change
 * to the address, a switch to plain FTP, or another account in the settings
 * asks for the password again instead of sending the saved one elsewhere.
 */
export function secretBinding(server: BoundServer): string {
  const port = server.port ?? (server.protocol === 'local' ? 0 : defaultPort(server.protocol));
  return createHash('sha256')
    .update(JSON.stringify([server.protocol, (server.host ?? '').toLowerCase(), port, server.username ?? '']))
    .digest('hex');
}

function prefix(binding: string): string {
  return `sync-servers:1:${binding}:`;
}

/** The value to keep in a credential store for `secret`, tied to `server`. */
export function sealSecret(secret: string, server: BoundServer): string {
  return prefix(secretBinding(server)) + secret;
}

/** The secret in a stored value when it was saved for `server` as it is now; `undefined` otherwise. */
export function openSecret(stored: string, server: BoundServer | string): string | undefined {
  const expected = prefix(typeof server === 'string' ? server : secretBinding(server));
  return stored.startsWith(expected) ? stored.slice(expected.length) : undefined;
}
