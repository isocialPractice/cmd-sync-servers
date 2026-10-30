import { readFile } from 'node:fs/promises';
import type { Readable, Writable } from 'node:stream';
import { rootCertificates, TLSSocket, type ConnectionOptions } from 'node:tls';
import basicFtp, { type FileInfo } from 'basic-ftp';
import type { SecretKind } from '../credentials/types.ts';
import { SyncError } from '../errors.ts';
import type { CertificateDecision, CertificateInfo } from '../host.ts';
import { silentLogger, type Logger } from '../log/logger.ts';
import { baseName, joinRemote, parentPath, ROOT, type RemotePath } from '../sync/paths.ts';
import { safeLine, safeText } from '../terminal-text.ts';
import {
  certificateMessage,
  certificateProblem,
  certificateSummary,
  describeCertificate,
  findCoveredNames,
  normalizeCertificateFingerprint,
  type CertificateChange,
  type NameResolver,
  type TrustedCertificate,
} from './certificates.ts';
import {
  checkListingLimit,
  errorMessage,
  isCertificateError,
  makeEntry,
  networkError,
  remoteRootError,
  throwIfAborted,
  type ConnectionTarget,
} from './common.ts';
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
  /** Extra certificate authorities, the name to verify, the lowest TLS version, and a certificate a person chose to trust. */
  readonly tls?:
    | {
        readonly caFile?: string | undefined;
        readonly servername?: string | undefined;
        readonly minVersion?: 'TLSv1.2' | 'TLSv1.3';
        readonly trustedCertificate?: TrustedCertificate | undefined;
      }
    | undefined;
  /** A certificate fingerprint to accept when verification fails, for unattended runs (`--trust-certificate`). */
  readonly expectedCertificate?: string | undefined;
  /** Asks what to do about a certificate that did not verify; absent when nobody can be asked, and the certificate is then refused. */
  readonly confirmCertificate?: ((info: CertificateInfo) => Promise<CertificateDecision>) | undefined;
  /** Saves what a certificate decision changed: the host, the name to check the certificate as, or the trusted certificate. */
  readonly certificateChanged?: ((change: CertificateChange) => Promise<void>) | undefined;
  /** Looks names up to suggest one the certificate covers. Default: the system resolver. */
  readonly resolver?: NameResolver | undefined;
  /** Supplies the password once the TLS certificate has been verified. */
  readonly secret: (kind: SecretKind) => Promise<string>;
  /** Called once the server has accepted the sign-in. */
  readonly signedIn?: (() => Promise<void>) | undefined;
  /** The server's name, for messages that suggest a command. */
  readonly serverName?: string | undefined;
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

/**
 * Turns a basic-ftp or socket error into a {@link SyncError}, with transient
 * replies and timeouts marked. With a target, a refused sign-in, a host that
 * does not exist and a refused connection name the host and what to check.
 */
export function ftpError(error: unknown, what: string, target?: ConnectionTarget): SyncError {
  if (error instanceof SyncError) {
    return error;
  }
  const code = replyCode(error);
  if (code !== undefined) {
    if (code === 530) {
      const who = target === undefined ? `${what}: the server` : safeText(target.host);
      return new SyncError(
        'E_AUTH',
        `${who} did not accept the user name or password (${String(code)}). Check the user name: many hosts name FTP accounts in full, as user@domain.`,
        { cause: error, serverCode: code, details: { reason: 'rejected' } },
      );
    }
    return new SyncError('E_REMOTE', `${what}: ${errorMessage(error)}`, { cause: error, serverCode: code, transient: TRANSIENT_REPLIES.has(code) });
  }
  const message = errorMessage(error);
  if (/^Timeout/i.test(message)) {
    return new SyncError('E_TIMEOUT', `${what}: ${message}`, { cause: error, transient: true });
  }
  if (/closed|FIN packet|ECONNRESET|socket/i.test(message) && !isCertificateError(error) && !/ENOTFOUND|EAI_NONAME|ECONNREFUSED/.test(message)) {
    return new SyncError('E_CONNECTION', `${what}: ${message}`, { cause: error, transient: true });
  }
  return networkError(error, what, target);
}

/** The first line of a welcome banner, without its reply codes: usually the server software. */
export function bannerLine(welcome: string): string {
  const lines = welcome
    .split(/\r?\n/)
    .map((line) => line.replace(/^\d{3}[ -]?/, '').trim())
    .filter((line) => line !== '');
  return safeLine(lines[0] ?? '');
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
  #host: string;
  #servername: string | undefined;
  #trusted: TrustedCertificate | undefined;
  /** Fingerprints a person accepted for this connection only. */
  readonly #acceptedOnce = new Set<string>();
  /** The fingerprint of the verified control connection's certificate; data connections must match it. */
  #leaf: string | undefined;

  constructor(options: FtpTransportOptions) {
    this.#options = options;
    this.#logger = options.logger ?? silentLogger;
    this.#platform = options.platform ?? process.platform;
    this.#limit = options.listingLimit ?? DEFAULT_LISTING_LIMIT;
    this.#host = options.host;
    this.#servername = options.tls?.servername;
    this.#trusted = options.tls?.trustedCertificate;
  }

  async connect(signal?: AbortSignal): Promise<Capabilities> {
    throwIfAborted(signal);
    const { protocol, port } = this.#options;
    if (protocol === 'ftp') {
      if (this.#options.allowInsecure !== true) {
        throw new SyncError(
          'E_INSECURE_PROTOCOL',
          `Plain FTP sends the password to ${this.#host} in clear text. Set allowInsecure on this server to use it anyway, or use SFTP or FTPS.`,
        );
      }
      this.#logger.warn('Plain FTP: the password and every file travel unencrypted.', { host: this.#host });
    }
    this.#root = this.#options.remoteRoot;
    joinRemote(this.#root, ROOT);
    const caFile = this.#options.tls?.caFile;
    // Node replaces its trusted authorities with `ca`, so the extra one is added to them.
    const ca = caFile === undefined ? undefined : [...rootCertificates, (await readFile(caFile)).toString('utf8')];

    let opened: { readonly client: InstanceType<typeof Client>; readonly welcome: string } | undefined;
    for (let attempt = 1; opened === undefined; attempt += 1) {
      const result = await this.#open(signal, ca);
      if ('info' in result) {
        await this.#decide(result.info, attempt);
      } else {
        opened = result;
      }
    }
    const { client, welcome } = opened;
    this.#client = client;
    const host = this.#host;
    const onAbort = (): void => {
      client.close();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    let startingFolder: string | undefined;
    try {
      await client.sendIgnoringError('OPTS UTF8 ON');
      const password = await this.#options.secret('password');
      await client.login(this.#options.username ?? 'anonymous', password);
      await this.#signedIn();
      await client.useDefaultSettings();
      this.#features = await client.features();
      const pwd = await client.pwd().catch(() => undefined);
      startingFolder = pwd?.startsWith('/') === true ? pwd : undefined;
      try {
        await client.cd(this.#root);
      } catch (error) {
        if (replyCode(error) === undefined) {
          throw error;
        }
        const folders = await this.#folderNames(client, startingFolder);
        throw remoteRootError(this.#root, host, { startingFolder, folders }, this.#options.serverName, { cause: error });
      }
    } catch (error) {
      client.close();
      this.#logger.debug('Connecting failed', { host, error: errorMessage(error) });
      throw ftpError(error, `Connecting to ${host}:${String(port)}`, { host, port });
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
      // The banner and the feature names are the server's own text.
      software: bannerLine(welcome),
      tls: protocolName === undefined || protocolName === null ? undefined : `${protocolName}${cipher === undefined ? '' : `, ${cipher.name}`}`,
      hostKey: undefined,
      features: [...this.#features.keys()].map(safeLine).sort(),
      startingFolder,
    };
  }

  /**
   * Opens the control connection and, for FTPS, checks the certificate before
   * any command is sent. Resolves with the connection, or with the
   * certificate a person must decide on once the connection is closed.
   */
  async #open(
    signal: AbortSignal | undefined,
    ca: string[] | undefined,
  ): Promise<{ readonly client: InstanceType<typeof Client>; readonly welcome: string } | { readonly info: CertificateInfo }> {
    const { protocol, port, timeoutMs } = this.#options;
    const host = this.#host;
    const client = new Client(timeoutMs);
    if (this.#options.ipFamily !== undefined) {
      client.ftp.ipFamily = this.#options.ipFamily;
    }
    // Protocol traces go to the redacting logger at debug level; basic-ftp already masks PASS.
    client.ftp.log = (message: string) => {
      this.#logger.debug(safeText(message));
    };
    const secureOptions: ConnectionOptions = {
      // Node verifies the chain and the name on every connection; #verify reads the result before
      // anything is sent, so a certificate that fails can be shown to a person instead of only refused.
      rejectUnauthorized: false,
      minVersion: this.#options.tls?.minVersion ?? 'TLSv1.2',
      host,
      ...(this.#servername === undefined ? {} : { servername: this.#servername }),
      ...(ca === undefined ? {} : { ca }),
    };
    const onAbort = (): void => {
      client.close();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const welcome =
        protocol === 'ftps-implicit' ? (await client.connectImplicitTLS(host, port, secureOptions)).message : (await client.connect(host, port)).message;
      if (protocol === 'ftps') {
        await client.useTLS(secureOptions);
      }
      if (protocol !== 'ftp') {
        const socket = client.ftp.socket;
        if (!(socket instanceof TLSSocket)) {
          throw new SyncError('E_TLS_CERT', `The connection to ${host}:${String(port)} is not encrypted.`);
        }
        const info = await this.#verify(socket);
        if (info !== undefined) {
          client.close();
          return { info };
        }
        this.#guardDataConnections(client);
      }
      return { client, welcome };
    } catch (error) {
      client.close();
      throwIfAborted(signal);
      this.#logger.debug('Connecting failed', { host, error: errorMessage(error) });
      throw ftpError(error, `Connecting to ${host}:${String(port)}`, { host, port });
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Accepts a certificate that verified, the trusted one, one accepted for
   * this connection, or the one given for an unattended run. Resolves with
   * the certificate a person must decide on otherwise. Expired and
   * not-yet-valid certificates are refused here, always.
   */
  async #verify(socket: TLSSocket): Promise<CertificateInfo | undefined> {
    const host = this.#host;
    const { port } = this.#options;
    if (socket.authorized) {
      this.#leaf = socket.getPeerCertificate().fingerprint256;
      return undefined;
    }
    const cert = socket.getPeerCertificate(true);
    if (typeof cert.fingerprint256 !== 'string' || cert.fingerprint256 === '') {
      throw new SyncError('E_TLS_CERT', `${host}:${String(port)} presented no certificate.`);
    }
    const sha256 = cert.fingerprint256;
    const problem = certificateProblem(socket.authorizationError, cert, Date.now());
    if (problem === 'expired' || problem === 'not-yet-valid') {
      const info = describeCertificate(cert, host, port, problem);
      throw new SyncError('E_TLS_CERT', certificateMessage(info, this.#options.serverName), { details: { certificate: info } });
    }
    if (this.#trusted?.sha256 === sha256 || this.#acceptedOnce.has(sha256)) {
      this.#leaf = sha256;
      return undefined;
    }
    const expected = this.#options.expectedCertificate;
    if (expected !== undefined) {
      const wanted = normalizeCertificateFingerprint(expected);
      if (wanted === sha256) {
        this.#leaf = sha256;
        return undefined;
      }
      const info = describeCertificate(cert, host, port, problem);
      throw new SyncError(
        'E_TLS_CERT',
        `${certificateSummary(info)}\nIt is not the certificate given with --trust-certificate (${wanted ?? safeLine(expected)}).`,
        { details: { certificate: info } },
      );
    }
    const coveredNames = problem === 'name-mismatch' ? await findCoveredNames(host, cert, this.#options.resolver, socket.remoteAddress) : [];
    return describeCertificate(cert, host, port, this.#trusted === undefined ? problem : 'changed', {
      coveredNames,
      previousSha256: this.#trusted?.sha256,
    });
  }

  /** Asks a person about a certificate and applies the decision; refuses it when nobody can be asked. */
  async #decide(info: CertificateInfo, attempt: number): Promise<void> {
    const confirm = this.#options.confirmCertificate;
    if (confirm === undefined) {
      throw new SyncError('E_TLS_CERT', certificateMessage(info, this.#options.serverName), { details: { certificate: info } });
    }
    if (attempt > 3) {
      throw new SyncError('E_TLS_CERT', `${certificateSummary(info)}\nThe certificate still did not verify.`, { details: { certificate: info } });
    }
    const decision = await confirm(info);
    const covered = (name: string): boolean => info.coveredNames.some((candidate) => candidate.toLowerCase() === name.toLowerCase());
    switch (decision.action) {
      case 'accept-once':
        this.#acceptedOnce.add(info.sha256);
        return;
      case 'accept-and-pin': {
        const pin: TrustedCertificate = { sha256: info.sha256, validTo: info.validTo, pinnedAt: new Date().toISOString() };
        this.#trusted = pin;
        await this.#options.certificateChanged?.({ trustedCertificate: pin });
        return;
      }
      case 'use-host':
        if (!covered(decision.host)) {
          break;
        }
        this.#host = decision.host;
        await this.#options.certificateChanged?.({ host: decision.host });
        return;
      case 'check-as':
        if (!covered(decision.servername)) {
          break;
        }
        this.#servername = decision.servername;
        await this.#options.certificateChanged?.({ servername: decision.servername });
        return;
      case 'reject':
        break;
    }
    throw new SyncError('E_TLS_CERT', `The certificate of ${info.host}:${String(info.port)} was not accepted.`, { details: { certificate: info } });
  }

  /**
   * Accepts a data connection only when it resumes the control connection's
   * TLS session or presents the same certificate as the verified control
   * connection. Anything else is closed before data moves.
   */
  #guardDataConnections(client: InstanceType<typeof Client>): void {
    const ftp = client.ftp;
    const accessor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ftp) as object, 'dataSocket');
    const get = accessor?.get?.bind(ftp);
    const set = accessor?.set?.bind(ftp);
    if (get === undefined || set === undefined) {
      throw new SyncError('E_TLS_CERT', 'Data connections cannot be checked with this version of basic-ftp.');
    }
    const leaf = this.#leaf;
    const host = this.#host;
    Object.defineProperty(ftp, 'dataSocket', {
      configurable: true,
      get: () => get() as unknown,
      set: (socket: unknown) => {
        if (socket instanceof TLSSocket) {
          socket.once('secureConnect', () => {
            const offered = socket.getPeerCertificate().fingerprint256;
            if (!socket.isSessionReused() && offered !== leaf) {
              socket.destroy(
                new SyncError(
                  'E_TLS_CERT',
                  `A data connection to ${host} presented another certificate (${offered}) than the control connection, so it was closed.`,
                ),
              );
            }
          });
        }
        set(socket);
      },
    });
  }

  async #signedIn(): Promise<void> {
    try {
      await this.#options.signedIn?.();
    } catch (error) {
      this.#logger.warn('Saving the password failed.', { error: errorMessage(error) });
    }
  }

  /** Up to 50 folder names in `folder`, for a message; none when it cannot be listed. */
  async #folderNames(client: InstanceType<typeof Client>, folder: string | undefined): Promise<string[]> {
    if (folder === undefined) {
      return [];
    }
    try {
      return (await client.list(folder))
        .filter((info) => info.type === FileType.Directory && info.name !== '.' && info.name !== '..' && !/[/\\]/.test(info.name) && !info.name.includes('\0'))
        .map((info) => info.name)
        .sort()
        .slice(0, 50);
    } catch {
      return [];
    }
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
