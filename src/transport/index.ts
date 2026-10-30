import type { Server, Site } from '../config/schema.ts';
import { defaultPort } from '../config/schema.ts';
import { secretBinding } from '../credentials/binding.ts';
import { EnvSecretSource } from '../credentials/env.ts';
import { lookupSecret } from '../credentials/lookup.ts';
import type { SecretKind, SecretRequest } from '../credentials/types.ts';
import type { HostAdapter, HostKeyInfo } from '../host.ts';
import { silentLogger, type Logger } from '../log/logger.ts';
import type { CertificateChange, NameResolver } from './certificates.ts';
import { errorMessage } from './common.ts';
import { FtpTransport } from './ftp.ts';
import type { HostKeyPolicy } from './hostkeys.ts';
import { LocalTransport } from './local.ts';
import { SftpTransport } from './sftp.ts';
import type { Transport } from './types.ts';

/**
 * What a transport for one server needs: the site and server, the host that
 * answers for secrets, host keys and certificates, and the environment.
 *
 * @experimental The transport layer may change before 1.0.0; most programs
 * use {@link SyncSession} instead.
 */
export interface TransportContext {
  /** The site the server belongs to, for secret lookups and messages. */
  readonly site: Pick<Site, 'id' | 'name'>;
  /**
   * The server to connect to. A decision made while connecting, such as a
   * pinned host key or another host name the certificate covers, is applied
   * to this object, so later connections and the saved-password check see it.
   */
  readonly server: Server;
  /** Credentials, host key and certificate decisions, and prompts. */
  readonly host: HostAdapter;
  /** Stores a host key the person chose to pin, usually in the server's settings. Default: through `updateServer`. */
  readonly pinHostKey?: ((info: HostKeyInfo) => Promise<void>) | undefined;
  /**
   * Saves a change a decision made to the server, usually in `sites.json`:
   * a pinned host key, a trusted certificate, another host or the name the
   * certificate is checked as. The change is already applied to `server`.
   */
  readonly updateServer?: ((change: (server: Server) => void) => Promise<void>) | undefined;
  /** A host key fingerprint given for unattended runs (`--host-key`). */
  readonly expectedHostKey?: string | undefined;
  /** A certificate fingerprint given for unattended runs (`--trust-certificate`). */
  readonly expectedCertificate?: string | undefined;
  /** Looks names up to suggest one a certificate covers. Default: the system resolver. */
  readonly resolver?: NameResolver | undefined;
  /** Where `SYNC_SERVERS_PASSWORD` and `SSH_AUTH_SOCK` are read. Default: the process environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Where protocol traces and warnings go. Default: the host's logger. */
  readonly logger?: Logger;
  /** The most entries one folder listing may hold. Default: {@link DEFAULT_LISTING_LIMIT}. */
  readonly listingLimit?: number;
}

/**
 * Supplies a server's secrets, and is told when the server accepted them.
 *
 * @experimental
 */
export interface SecretSupplier {
  /** The password or key passphrase, looked up once and shared by every connection of the run. */
  (kind: SecretKind): Promise<string>;
  /** The server accepted the sign-in: a secret a person typed is offered for saving, once. */
  accepted(): Promise<void>;
}

/**
 * Supplies a server's password or key passphrase: from the credential store
 * when the server saves it, then the environment, then a prompt. Each secret
 * is looked up once and shared by every connection of the run. Once the
 * server accepts a typed secret, the host may offer to save it.
 *
 * @experimental
 */
export function secretSupplier(context: TransportContext): SecretSupplier {
  const { site, server, host } = context;
  const logger = context.logger ?? host.logger ?? silentLogger;
  const env = new EnvSecretSource(context.env ?? process.env);
  const found = new Map<SecretKind, Promise<string>>();
  const typed = new Map<SecretKind, SecretRequest>();
  const offered = new Set<SecretKind>();
  const supply = (kind: SecretKind): Promise<string> => {
    let pending = found.get(kind);
    if (pending === undefined) {
      // Read now, not when the supplier was made: a decision may have changed the host since.
      const request: SecretRequest = {
        ref: { siteId: site.id, serverId: server.id, kind },
        siteName: site.name,
        serverName: server.name,
        host: server.host,
        username: server.username,
      };
      pending = lookupSecret(request, {
        store: host.credentials,
        savePassword: server.auth?.savePassword ?? false,
        binding: secretBinding(server),
        env,
        prompt: (question) => host.promptSecret(question),
        redactor: logger.redactor,
        found: (origin) => {
          if (origin === 'prompt') {
            typed.set(kind, request);
          }
        },
      });
      found.set(kind, pending);
      pending.catch(() => {
        found.delete(kind);
        typed.delete(kind);
      });
    }
    return pending;
  };
  const accepted = async (): Promise<void> => {
    if (host.secretAccepted === undefined) {
      return;
    }
    for (const [kind, request] of typed) {
      if (offered.has(kind)) {
        continue;
      }
      offered.add(kind);
      const secret = await found.get(kind);
      if (secret !== undefined) {
        await host.secretAccepted(request, secret);
      }
    }
  };
  return Object.assign(supply, { accepted });
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
  const signedIn = (): Promise<void> => secret.accepted();
  const timeoutMs = server.options.timeoutSeconds * 1000;
  const common = { logger, ...(context.listingLimit === undefined ? {} : { listingLimit: context.listingLimit }) };
  const update = async (change: (target: Server) => void): Promise<void> => {
    change(server);
    try {
      await context.updateServer?.(change);
    } catch (error) {
      logger.warn('The change to the server could not be saved; it holds for this run.', { error: errorMessage(error) });
    }
  };
  const certificateChanged = (change: CertificateChange): Promise<void> =>
    update((target) => {
      if ('host' in change) {
        target.host = change.host;
      } else {
        const tls = (target.options.tls ??= { minVersion: 'TLSv1.2' });
        if ('servername' in change) {
          tls.servername = change.servername;
        } else {
          tls.trustedCertificate = change.trustedCertificate;
        }
      }
    });
  const pinHostKey =
    context.pinHostKey ??
    ((info: HostKeyInfo): Promise<void> =>
      update((target) => {
        target.options.hostKey = { algorithm: info.algorithm, sha256: info.sha256, pinnedAt: new Date().toISOString() };
      }));
  return () => {
    switch (server.protocol) {
      case 'local':
        return new LocalTransport({ root: server.remoteRoot, ...common });
      case 'sftp': {
        const hostKeys: HostKeyPolicy = {
          pinned: server.options.hostKey,
          expected: context.expectedHostKey,
          confirm: host.interactive === false ? undefined : (info) => host.confirmHostKey(info),
          pin: pinHostKey,
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
          signedIn,
          serverName: server.name,
          ...(context.env === undefined ? {} : { env: context.env }),
          ...common,
        });
      }
      case 'ftps':
      case 'ftps-implicit':
      case 'ftp': {
        const confirm = host.confirmCertificate?.bind(host);
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
          expectedCertificate: context.expectedCertificate,
          confirmCertificate: host.interactive === false ? undefined : confirm,
          certificateChanged,
          resolver: context.resolver,
          secret,
          signedIn,
          serverName: server.name,
          ...common,
        });
      }
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
