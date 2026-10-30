import path from 'node:path';
import type { Server, Site } from '../config/schema.ts';
import { SyncError } from '../errors.ts';
import type { HostAdapter } from '../host.ts';
import type { Logger } from '../log/logger.ts';
import { isInside, ROOT, toRemotePath, type RemotePath } from '../sync/paths.ts';
import type { NameResolver } from './certificates.ts';
import { createTransport } from './index.ts';
import type { Capabilities, Transport } from './types.ts';

/**
 * Options of {@link ServerProbe.open}.
 *
 * @experimental
 */
export interface ServerProbeOptions {
  /** The site the server belongs to, or will: its id and name, for the secret lookup and messages. */
  readonly site: Pick<Site, 'id' | 'name'>;
  /**
   * The settings to try, saved or not. Give a new server its final id up
   * front, so a password typed now can be saved under it. Its remote root
   * is not entered: the probe connects at the top of what the account sees.
   */
  readonly server: Server;
  /** Credentials, host key and certificate decisions, and prompts. */
  readonly host: HostAdapter;
  /** Told about each change a decision made, such as a pinned host key or another host the certificate covers. */
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
  /** Stops connecting; the call then rejects with `E_CANCELLED`. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * One folder as a {@link ServerProbe} lists it.
 *
 * @experimental
 */
export interface FolderListing {
  /** The absolute folder listed. */
  readonly path: string;
  /** The names of the folders in it, and of links that may be folders, sorted. */
  readonly folders: readonly string[];
  /** How many files it holds. */
  readonly files: number;
}

/**
 * A connection made with settings that may not be saved yet, for setup:
 * it signs in, goes through the host key and certificate decisions, and
 * then lists folders by absolute path, so the remote root can be picked
 * from what the server shows. Nothing is written on the server.
 *
 * @experimental
 */
export class ServerProbe {
  readonly #transport: Transport;
  readonly #working: Server;
  readonly #remoteRoot: string;
  readonly #top: string;
  /** What the server offered. */
  readonly capabilities: Capabilities;

  private constructor(transport: Transport, working: Server, remoteRoot: string, top: string, capabilities: Capabilities) {
    this.#transport = transport;
    this.#working = working;
    this.#remoteRoot = remoteRoot;
    this.#top = top;
    this.capabilities = capabilities;
  }

  /**
   * Connects and signs in with `options.server`. Host key and certificate
   * decisions are asked through `options.host`.
   *
   * @throws {@link SyncError} as a connection would: `E_AUTH`, `E_TLS_CERT`, `E_HOST_KEY_MISMATCH`, `E_CONNECTION` and others.
   */
  static async open(options: ServerProbeOptions): Promise<ServerProbe> {
    const remoteRoot = options.server.remoteRoot;
    const top = options.server.protocol === 'local' ? path.parse(path.resolve(remoteRoot)).root : '/';
    const working: Server = { ...structuredClone(options.server), remoteRoot: top };
    const transport = createTransport({
      site: options.site,
      server: working,
      host: options.host,
      updateServer: options.updateServer,
      expectedHostKey: options.expectedHostKey,
      expectedCertificate: options.expectedCertificate,
      resolver: options.resolver,
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    try {
      const capabilities = await transport.connect(options.signal);
      return new ServerProbe(transport, working, remoteRoot, top, capabilities);
    } catch (error) {
      await transport.close();
      throw error;
    }
  }

  /** The settings as connected: the ones given, with every change a decision made. */
  get server(): Server {
    return { ...structuredClone(this.#working), remoteRoot: this.#remoteRoot };
  }

  /** The absolute folder the account opens in after signing in; absent for `local`. */
  get startingFolder(): string | undefined {
    return this.capabilities.startingFolder;
  }

  #relative(folder: string): RemotePath {
    if (this.#working.protocol === 'local') {
      const resolved = path.resolve(folder);
      if (!path.isAbsolute(folder) || !isInside(this.#top, resolved)) {
        throw new SyncError('E_PATH_UNSAFE', `${JSON.stringify(folder)} is not an absolute path on this drive.`);
      }
      const relative = path.relative(this.#top, resolved).split(path.sep).join('/');
      return relative === '' ? ROOT : toRemotePath(relative);
    }
    if (!folder.startsWith('/')) {
      throw new SyncError('E_PATH_UNSAFE', `${JSON.stringify(folder)} is not an absolute path that starts with "/".`);
    }
    const normalized = path.posix.normalize(folder).replace(/\/+$/, '');
    return normalized === '' ? ROOT : toRemotePath(normalized.slice(1), 'linux');
  }

  #absolute(target: RemotePath): string {
    if (this.#working.protocol === 'local') {
      return target === ROOT ? this.#top : path.join(this.#top, ...target.split('/'));
    }
    return `/${target}`;
  }

  /** The folders and the number of files in an absolute folder. */
  async folders(folder: string): Promise<FolderListing> {
    const target = this.#relative(folder);
    const entries = await this.#transport.list(target);
    return {
      path: this.#absolute(target),
      folders: entries
        .filter((entry) => (entry.type === 'dir' || entry.type === 'symlink') && entry.path !== undefined)
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b)),
      files: entries.filter((entry) => entry.type === 'file').length,
    };
  }

  /** True when an absolute folder exists and can be listed. */
  async exists(folder: string): Promise<boolean> {
    let target: RemotePath;
    try {
      target = this.#relative(folder);
    } catch {
      return false;
    }
    try {
      await this.#transport.list(target);
      return true;
    } catch {
      return false;
    }
  }

  /** Closes the connection. Safe to call more than once. */
  close(): Promise<void> {
    return this.#transport.close();
  }
}
