import type { Server, Site } from '../config/schema.ts';
import { defaultPort } from '../config/schema.ts';
import { secretBinding } from '../credentials/binding.ts';
import { EnvSecretSource } from '../credentials/env.ts';
import { lookupSecret } from '../credentials/lookup.ts';
import type { SecretKind } from '../credentials/types.ts';
import type { HostAdapter, HostKeyInfo } from '../host.ts';
import { silentLogger, type Logger } from '../log/logger.ts';
import { FtpTransport } from './ftp.ts';
import type { HostKeyPolicy } from './hostkeys.ts';
import { LocalTransport } from './local.ts';
import { SftpTransport } from './sftp.ts';
import type { Transport } from './types.ts';

/**
 * What a transport for one server needs: the site and server, the host that
 * answers for secrets and host keys, and the environment.
 *
 * @experimental The transport layer may change before 1.0.0; most programs
 * use {@link SyncSession} instead.
 */
export interface TransportContext {
  /** The site the server belongs to, for secret lookups and messages. */
  readonly site: Site;
  /** The server to connect to. */
  readonly server: Server;
  /** Credentials, host key confirmation and prompts. */
  readonly host: HostAdapter;
  /** Stores a host key the person chose to pin, usually in the server's settings. */
  readonly pinHostKey?: ((info: HostKeyInfo) => Promise<void>) | undefined;
  /** A host key fingerprint given for unattended runs (`--host-key`). */
  readonly expectedHostKey?: string | undefined;
  /** Where `SYNC_SERVERS_PASSWORD` and `SSH_AUTH_SOCK` are read. Default: the process environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Where protocol traces and warnings go. Default: the host's logger. */
  readonly logger?: Logger;
  /** The most entries one folder listing may hold. Default: {@link DEFAULT_LISTING_LIMIT}. */
  readonly listingLimit?: number;
}

/**
 * Supplies a server's password or key passphrase: from the credential store
 * when the server saves it, then the environment, then a prompt. Each secret
 * is looked up once and shared by every connection of the run.
 *
 * @experimental
 */
export function secretSupplier(context: TransportContext): (kind: SecretKind) => Promise<string> {
  const { site, server, host } = context;
  const logger = context.logger ?? host.logger ?? silentLogger;
  const env = new EnvSecretSource(context.env ?? process.env);
  const found = new Map<SecretKind, Promise<string>>();
  return (kind) => {
    let pending = found.get(kind);
    if (pending === undefined) {
      pending = lookupSecret(
        {
          ref: { siteId: site.id, serverId: server.id, kind },
          siteName: site.name,
          serverName: server.name,
          host: server.host,
          username: server.username,
        },
        {
          store: host.credentials,
          savePassword: server.auth?.savePassword ?? false,
          binding: secretBinding(server),
          env,
          prompt: (request) => host.promptSecret(request),
          redactor: logger.redactor,
        },
      );
      found.set(kind, pending);
      pending.catch(() => found.delete(kind));
    }
    return pending;
  };
}

/**
 * Returns a function that creates unconnected transports for a server, sharing one secret lookup.
 *
 * @experimental
 */
export function transportFactory(context: TransportContext): () => Transport {
  const { server, host } = context;
  const logger = context.logger ?? host.logger ?? silentLogger;
  const secret = secretSupplier(context);
  const timeoutMs = server.options.timeoutSeconds * 1000;
  const common = { logger, ...(context.listingLimit === undefined ? {} : { listingLimit: context.listingLimit }) };
  return () => {
    switch (server.protocol) {
      case 'local':
        return new LocalTransport({ root: server.remoteRoot, ...common });
      case 'sftp': {
        const hostKeys: HostKeyPolicy = {
          pinned: server.options.hostKey,
          expected: context.expectedHostKey,
          confirm: host.interactive === false ? undefined : (info) => host.confirmHostKey(info),
          pin: context.pinHostKey,
        };
        return new SftpTransport({
          host: server.host ?? '',
          port: server.port ?? defaultPort('sftp'),
          username: server.username ?? '',
          auth: server.auth ?? { method: 'password' },
          remoteRoot: server.remoteRoot,
          timeoutMs,
          ipFamily: server.options.ipFamily,
          legacyAlgorithms: server.options.legacyAlgorithms,
          hostKeys,
          secret,
          ...(context.env === undefined ? {} : { env: context.env }),
          ...common,
        });
      }
      case 'ftps':
      case 'ftps-implicit':
      case 'ftp':
        return new FtpTransport({
          protocol: server.protocol,
          host: server.host ?? '',
          port: server.port ?? defaultPort(server.protocol),
          username: server.username,
          remoteRoot: server.remoteRoot,
          timeoutMs,
          ipFamily: server.options.ipFamily,
          allowInsecure: server.options.allowInsecure,
          tls: server.options.tls,
          secret,
          ...common,
        });
    }
  };
}

/**
 * An unconnected transport for a server.
 *
 * @experimental
 */
export function createTransport(context: TransportContext): Transport {
  return transportFactory(context)();
}

export type { Capabilities, EntryType, RemoteEntry, Transport } from './types.ts';
