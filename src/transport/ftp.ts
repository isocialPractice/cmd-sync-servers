import { readFile } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';
import type { ConnectionOptions, TLSSocket } from 'node:tls';
import basicFtp, { type FileInfo } from 'basic-ftp';
import type { SecretKind } from '../credentials/types.ts';
import { SyncError } from '../errors.ts';
import { silentLogger, type Logger } from '../log/logger.ts';
import { baseName, joinRemote, parentPath, ROOT, type RemotePath } from '../sync/paths.ts';
import { checkListingLimit, errorMessage, isCertificateError, makeEntry, networkError, throwIfAborted } from './common.ts';
import { DEFAULT_LISTING_LIMIT, type Capabilities, type EntryType, type RemoteEntry, type Transport } from './types.ts';

const { Client, FileType, FTPError } = basicFtp;

/**
 * Options of {@link FtpTransport}.
 *
 * @experimental
 */
export interface FtpTransportOptions {
  /** FTPS with explicit TLS, FTPS with implicit TLS, or plain FTP. */
  readonly protocol: 'ftps' | 'ftps-implicit' | 'ftp';
  /** The server's host name or address. */
  readonly host: string;
  /** The control port: usually 21, or 990 for implicit TLS. */
  readonly port: number;
  /** The account to sign in as. Default: `anonymous`. */
  readonly username?: string | undefined;
  /** The site root on the server, an absolute path. */
  readonly remoteRoot: string;
  /** How long a connection or an operation may wait, in milliseconds. */
  readonly timeoutMs: number;
  /** Connect over IPv4 or IPv6 only. */
  readonly ipFamily?: 4 | 6 | undefined;
  /** Required for plain FTP, which sends the password in clear text. */
  readonly allowInsecure?: boolean | undefined;
  /** Extra certificate authorities, the name to verify, and the lowest TLS version. */
  readonly tls?: { readonly caFile?: string | undefined; readonly servername?: string | undefined; readonly minVersion?: 'TLSv1.2' | 'TLSv1.3' } | undefined;
  /** Supplies the password once the TLS certificate has been verified. */
  readonly secret: (kind: SecretKind) => Promise<string>;
  /** Where protocol traces and warnings go. */
  readonly logger?: Logger;
  /** The most entries one folder listing may hold. */
  readonly listingLimit?: number;
  /** The platform whose name rules apply to listed names. Default: this one. */
  readonly platform?: NodeJS.Platform;
}

/** FTP replies after which a fresh connection may succeed. */
const TRANSIENT_REPLIES = new Set([421, 425, 426, 450, 451]);

function typeOf(info: FileInfo): EntryType {
  switch (info.type) {
    case FileType.File:
      return 'file';
    case FileType.Directory:
      return 'dir';
    case FileType.SymbolicLink:
      return 'symlink';
    default:
      return 'other';
  }
}

function replyCode(error: unknown): number | undefined {
  return error instanceof FTPError ? error.code : undefined;
}

/** Turns a basic-ftp or socket error into a {@link SyncError}, with transient replies and timeouts marked. */
export function ftpError(error: unknown, what: string): SyncError {
  if (error instanceof SyncError) {
    return error;
  }
  const code = replyCode(error);
  if (code !== undefined) {
    if (code === 530) {
      return new SyncError('E_AUTH', `${what}: the server did not accept the sign-in (${String(code)}).`, { cause: error, serverCode: code });
    }
    return new SyncError('E_REMOTE', `${what}: ${errorMessage(error)}`, { cause: error, serverCode: code, transient: TRANSIENT_REPLIES.has(code) });
  }
  const message = errorMessage(error);
  if (/^Timeout/i.test(message)) {
    return new SyncError('E_TIMEOUT', `${what}: ${message}`, { cause: error, transient: true });
  }
  if (/closed|FIN packet|ECONNRESET|socket/i.test(message) && !isCertificateError(error)) {
    return new SyncError('E_CONNECTION', `${what}: ${message}`, { cause: error, transient: true });
  }
  return networkError(error, what);
}

/** `YYYYMMDDHHMMSS` in UTC, as MFMT expects. */
export function mfmtTime(mtimeMs: number): string {
  return new Date(Math.floor(mtimeMs / 1000) * 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/**
 * FTP, FTPS with explicit TLS (AUTH TLS) and FTPS with implicit TLS, through
 * basic-ftp. Passive mode only; binary transfers only.
 *
 * @experimental
 */
export class FtpTransport implements Transport {
  readonly #options: FtpTransportOptions;
  readonly #logger: Logger;
  readonly #platform: NodeJS.Platform;
  readonly #limit: number;
  #client: InstanceType<typeof Client> | undefined;
  #root = '/';
  #features = new Map<string, string>();

  constructor(options: FtpTransportOptions) {
    this.#options = options;
    this.#logger = options.logger ?? silentLogger;
    this.#platform = options.platform ?? process.platform;
    this.#limit = options.listingLimit ?? DEFAULT_LISTING_LIMIT;
  }

  async connect(signal?: AbortSignal): Promise<Capabilities> {
    throwIfAborted(signal);
    const { protocol, host, port, timeoutMs } = this.#options;
    if (protocol === 'ftp') {
      if (this.#options.allowInsecure !== true) {
        throw new SyncError(
          'E_INSECURE_PROTOCOL',
          `Plain FTP sends the password to ${host} in clear text. Set allowInsecure on this server to use it anyway, or use SFTP or FTPS.`,
        );
      }
      this.#logger.warn('Plain FTP: the password and every file travel unencrypted.', { host });
    }
    this.#root = this.#options.remoteRoot;
    joinRemote(this.#root, ROOT);

    const client = new Client(timeoutMs);
    this.#client = client;
    if (this.#options.ipFamily !== undefined) {
      client.ftp.ipFamily = this.#options.ipFamily;
    }
    // Protocol traces go to the redacting logger at debug level; basic-ftp already masks PASS.
    client.ftp.log = (message: string) => {
      this.#logger.debug(message);
    };
    const tls = this.#options.tls;
    const secureOptions: ConnectionOptions = {
      rejectUnauthorized: true,
      minVersion: tls?.minVersion ?? 'TLSv1.2',
      host,
      ...(tls?.servername === undefined ? {} : { servername: tls.servername }),
      ...(tls?.caFile === undefined ? {} : { ca: await readFile(tls.caFile) }),
    };
    const onAbort = (): void => {
      client.close();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    let welcome: string;
    try {
      welcome =
        protocol === 'ftps-implicit'
          ? (await client.connectImplicitTLS(host, port, secureOptions)).message
          : (await client.connect(host, port)).message;
      if (protocol === 'ftps') {
        await client.useTLS(secureOptions);
      }
      await client.sendIgnoringError('OPTS UTF8 ON');
      const password = await this.#options.secret('password');
      await client.login(this.#options.username ?? 'anonymous', password);
      await client.useDefaultSettings();
      this.#features = await client.features();
      try {
        await client.cd(this.#root);
      } catch (error) {
        throw new SyncError('E_REMOTE_ROOT', `The remote root ${this.#root} was not found on ${host}: ${errorMessage(error)}`, { cause: error });
      }
    } catch (error) {
      client.close();
      throw ftpError(error, `Connecting to ${host}:${String(port)}`);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    const socket = client.ftp.socket as Partial<TLSSocket>;
    const cipher = typeof socket.getCipher === 'function' ? socket.getCipher() : undefined;
    const protocolName = typeof socket.getProtocol === 'function' ? socket.getProtocol() : undefined;
    return {
      protocol,
      mtimePrecisionMs: this.#features.has('MLST') ? 1000 : undefined,
      canSetMtime: this.#features.has('MFMT'),
      canChmod: true,
      atomicReplace: false,
      software: welcome.replace(/^\d{3}[ -]/, '').trim(),
      tls: protocolName === undefined || protocolName === null ? undefined : `${protocolName}${cipher === undefined ? '' : `, ${cipher.name}`}`,
      hostKey: undefined,
      features: [...this.#features.keys()].sort(),
    };
  }

  #ftp(): InstanceType<typeof Client> {
    if (this.#client === undefined || this.#client.closed) {
      throw new SyncError('E_CONNECTION', 'Not connected.', { transient: true });
    }
    return this.#client;
  }

  #full(target: RemotePath): string {
    return joinRemote(this.#root, target);
  }

  async list(dir: RemotePath): Promise<RemoteEntry[]> {
    const full = this.#full(dir);
    let listing: FileInfo[];
    try {
      listing = await this.#ftp().list(full);
    } catch (error) {
      throw ftpError(error, `Listing ${full}`);
    }
    checkListingLimit(listing.length, this.#limit, full);
    return listing.map((info) => makeEntry(dir, info.name, typeOf(info), info.size, info.modifiedAt?.getTime(), this.#platform));
  }

  async stat(target: RemotePath): Promise<RemoteEntry | undefined> {
    const full = this.#full(target);
    const client = this.#ftp();
    const dir = parentPath(target) ?? ROOT;
    const name = target === ROOT ? '' : baseName(target);
    try {
      const size = await client.size(full);
      const mtimeMs = this.#features.has('MDTM') ? (await client.lastMod(full)).getTime() : undefined;
      return makeEntry(dir, name, 'file', size, mtimeMs, this.#platform);
    } catch (error) {
      if (replyCode(error) !== 550) {
        throw ftpError(error, `Reading ${full}`);
      }
    }
    try {
      await client.cd(full);
      await client.cd(this.#root);
      return makeEntry(dir, name, 'dir', 0, undefined, this.#platform);
    } catch (error) {
      if (replyCode(error) === 550) {
        return undefined;
      }
      throw ftpError(error, `Reading ${full}`);
    }
  }

  async #transfer(what: string, signal: AbortSignal | undefined, run: (client: InstanceType<typeof Client>) => Promise<unknown>): Promise<void> {
    const client = this.#ftp();
    const onAbort = (): void => {
      client.close();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await run(client);
    } catch (error) {
      throwIfAborted(signal);
      throw ftpError(error, what);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  get(target: RemotePath, to: Writable, signal?: AbortSignal): Promise<void> {
    const full = this.#full(target);
    return this.#transfer(`Downloading ${full}`, signal, (client) => client.downloadTo(to, full));
  }

  put(from: Readable, target: RemotePath, signal?: AbortSignal): Promise<void> {
    const full = this.#full(target);
    return this.#transfer(`Uploading ${full}`, signal, (client) => client.uploadFrom(from, full));
  }

  async rename(from: RemotePath, to: RemotePath, overwrite: boolean): Promise<void> {
    const source = this.#full(from);
    const destination = this.#full(to);
    const client = this.#ftp();
    if (!overwrite && (await this.stat(to)) !== undefined) {
      throw new SyncError('E_REMOTE', `Renaming ${source}: ${destination} already exists.`);
    }
    try {
      await client.rename(source, destination);
      return;
    } catch (error) {
      const code = replyCode(error);
      if (!overwrite || (code !== 550 && code !== 553) || (await this.stat(to)) === undefined) {
        throw ftpError(error, `Renaming ${source} to ${destination}`);
      }
    }
    this.#logger.warn('The server cannot replace a file in one step; it is removed, then the new one is renamed into place.', { path: to });
    try {
      await this.remove(to);
      await client.rename(source, destination);
    } catch (error) {
      throw ftpError(error, `Renaming ${source} to ${destination}`);
    }
  }

  async remove(target: RemotePath): Promise<void> {
    const full = this.#full(target);
    const entry = await this.stat(target);
    try {
      if (entry?.type === 'dir') {
        await this.#ftp().removeEmptyDir(full);
      } else {
        await this.#ftp().remove(full);
      }
    } catch (error) {
      throw ftpError(error, `Removing ${full}`);
    }
  }

  async mkdir(target: RemotePath): Promise<void> {
    const full = this.#full(target);
    try {
      await this.#ftp().send(`MKD ${full}`);
    } catch (error) {
      if ((await this.stat(target).catch(() => undefined))?.type === 'dir') {
        return;
      }
      throw ftpError(error, `Creating ${full}`);
    }
  }

  async setMtime(target: RemotePath, mtimeMs: number): Promise<void> {
    const full = this.#full(target);
    if (!this.#features.has('MFMT')) {
      throw new SyncError('E_REMOTE', `Setting the time of ${full}: the server does not support MFMT.`);
    }
    try {
      await this.#ftp().send(`MFMT ${mfmtTime(mtimeMs)} ${full}`);
    } catch (error) {
      throw ftpError(error, `Setting the time of ${full}`);
    }
  }

  async chmod(target: RemotePath, mode: number): Promise<void> {
    const full = this.#full(target);
    try {
      await this.#ftp().send(`SITE CHMOD ${mode.toString(8)} ${full}`);
    } catch (error) {
      throw ftpError(error, `Changing the permissions of ${full}`);
    }
  }

  close(): Promise<void> {
    this.#client?.close();
    this.#client = undefined;
    return Promise.resolve();
  }
}
