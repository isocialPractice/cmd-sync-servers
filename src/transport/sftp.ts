import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ssh2, {
  type Algorithms,
  type AnyAuthMethod,
  type AuthHandlerMiddleware,
  type ConnectConfig,
  type FileEntryWithStats,
  type NegotiatedAlgorithms,
  type NextAuthHandler,
  type SFTPWrapper,
  type Stats,
} from 'ssh2';
import type { SecretKind } from '../credentials/types.ts';
import { SyncError } from '../errors.ts';
import type { HostKeyInfo } from '../host.ts';
import { silentLogger, type Logger } from '../log/logger.ts';
import { baseName, joinRemote, parentPath, ROOT, type RemotePath } from '../sync/paths.ts';
import { checkListingLimit, errorMessage, makeEntry, networkError, throwIfAborted, withTimeout } from './common.ts';
import { describeHostKey, verifyHostKey, type HostKeyPolicy } from './hostkeys.ts';
import { StallGuard, watchUpload } from './stall.ts';
import { DEFAULT_LISTING_LIMIT, type Capabilities, type EntryType, type RemoteEntry, type Transport } from './types.ts';

const { Client, utils } = ssh2;

/** The algorithms of section 8.4: modern key exchange, host keys, ciphers and encrypt-then-MAC. */
export const MODERN_ALGORITHMS: Algorithms = {
  kex: ['curve25519-sha256', 'curve25519-sha256@libssh.org', 'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521'],
  serverHostKey: ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'rsa-sha2-512', 'rsa-sha2-256'],
  cipher: ['aes256-gcm@openssh.com', 'aes128-gcm@openssh.com', 'chacha20-poly1305@openssh.com', 'aes256-ctr', 'aes192-ctr', 'aes128-ctr'],
  hmac: ['hmac-sha2-512-etm@openssh.com', 'hmac-sha2-256-etm@openssh.com'],
  compress: ['none'],
};

/** Added only for a server with `legacyAlgorithms`, which warns on every connection. */
export const LEGACY_ALGORITHMS: Algorithms = {
  kex: [...(MODERN_ALGORITHMS.kex as string[]), 'diffie-hellman-group16-sha512', 'diffie-hellman-group14-sha256', 'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group14-sha1'],
  serverHostKey: [...(MODERN_ALGORITHMS.serverHostKey as string[]), 'ssh-rsa'],
  cipher: MODERN_ALGORITHMS.cipher,
  hmac: [...(MODERN_ALGORITHMS.hmac as string[]), 'hmac-sha2-512', 'hmac-sha2-256', 'hmac-sha1'],
  compress: ['none'],
} as Algorithms;

export interface SftpTransportOptions {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly auth: { readonly method: 'password' | 'key' | 'agent'; readonly keyPath?: string | undefined };
  readonly remoteRoot: string;
  readonly timeoutMs: number;
  readonly ipFamily?: 4 | 6 | undefined;
  readonly legacyAlgorithms?: boolean | undefined;
  readonly hostKeys: HostKeyPolicy;
  /** Supplies the password or key passphrase, only once the host key has been verified. */
  readonly secret: (kind: SecretKind) => Promise<string>;
  /** The SSH agent: a socket path, a Windows pipe, or `pageant`. Default: `SSH_AUTH_SOCK`, then the Windows OpenSSH agent. */
  readonly agent?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly logger?: Logger;
  readonly listingLimit?: number;
  readonly platform?: NodeJS.Platform;
}

/** The SFTP version 3 status codes this transport tells apart. */
const STATUS = { EOF: 1, NO_SUCH_FILE: 2, NO_CONNECTION: 6, CONNECTION_LOST: 7 } as const;
const S_IFMT = 0o170000;

function typeOf(mode: number): EntryType {
  switch (mode & S_IFMT) {
    case 0o100000:
      return 'file';
    case 0o040000:
      return 'dir';
    case 0o120000:
      return 'symlink';
    default:
      return 'other';
  }
}

function statusCode(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number' ? error.code : undefined;
}

function sftpError(error: unknown, what: string): SyncError {
  if (error instanceof SyncError) {
    return error;
  }
  const code = statusCode(error);
  if (code === undefined) {
    return networkError(error, what);
  }
  const transient = code === STATUS.NO_CONNECTION || code === STATUS.CONNECTION_LOST;
  return new SyncError(transient ? 'E_CONNECTION' : 'E_REMOTE', `${what}: ${errorMessage(error)}`, {
    cause: error,
    transient,
    serverCode: code,
  });
}

function call<T>(run: (callback: (error: Error | null | undefined, value: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    run((error, value) => {
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    });
  });
}

function callVoid(run: (callback: (error?: Error | null) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    run((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Starts an atomic replacing rename through `posix-rename@openssh.com`, or
 * returns `undefined` when the server does not offer it (ssh2 throws at once).
 */
function tryPosixRename(sftp: SFTPWrapper, from: string, to: string): Promise<void> | undefined {
  let settle: ((error?: Error | null) => void) | undefined;
  const done = new Promise<void>((resolve, reject) => {
    settle = (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
  });
  try {
    sftp.ext_openssh_rename(from, to, (error) => {
      settle?.(error);
    });
  } catch {
    return undefined;
  }
  return done;
}

/** SFTP over SSH, through `ssh2`'s pure JavaScript path. */
export class SftpTransport implements Transport {
  readonly #options: SftpTransportOptions;
  readonly #logger: Logger;
  readonly #platform: NodeJS.Platform;
  readonly #limit: number;
  #client: InstanceType<typeof Client> | undefined;
  #sftp: SFTPWrapper | undefined;
  #root = '/';

  constructor(options: SftpTransportOptions) {
    this.#options = options;
    this.#logger = options.logger ?? silentLogger;
    this.#platform = options.platform ?? process.platform;
    this.#limit = options.listingLimit ?? DEFAULT_LISTING_LIMIT;
  }

  #agentPath(): string | undefined {
    const env = this.#options.env ?? process.env;
    return this.#options.agent ?? env.SSH_AUTH_SOCK ?? (this.#platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
  }

  /** The sign-in attempts, in order, tried only after the host key is accepted. */
  #authHandler(): AuthHandlerMiddleware {
    const { username, auth } = this.#options;
    const attempts: (() => Promise<AnyAuthMethod>)[] = [];
    if (auth.method === 'password') {
      attempts.push(async () => ({ type: 'password', username, password: await this.#options.secret('password') }));
      // Servers that only offer keyboard-interactive get the same password for each prompt.
      attempts.push(async () => {
        const password = await this.#options.secret('password');
        return {
          type: 'keyboard-interactive',
          username,
          prompt: (_name, _instructions, _lang, prompts, finish) => {
            finish(prompts.map(() => password));
          },
        };
      });
    } else if (auth.method === 'key') {
      attempts.push(async () => {
        const keyPath = auth.keyPath ?? '';
        const key = await readFile(keyPath).catch((error: unknown) => {
          throw new SyncError('E_AUTH', `The private key ${keyPath} could not be read: ${errorMessage(error)}`);
        });
        let parsed = utils.parseKey(key);
        let passphrase: string | undefined;
        if (parsed instanceof Error && /passphrase|encrypted/i.test(parsed.message)) {
          passphrase = await this.#options.secret('passphrase');
          parsed = utils.parseKey(key, passphrase);
        }
        if (parsed instanceof Error) {
          throw new SyncError('E_AUTH', `The private key ${path.basename(keyPath)} could not be used: ${parsed.message}`);
        }
        return { type: 'publickey', username, key: parsed };
      });
    } else {
      const agent = this.#agentPath();
      if (agent === undefined) {
        attempts.push(() => Promise.reject(new SyncError('E_AUTH', 'No SSH agent was found. Start one, or set SSH_AUTH_SOCK.')));
      } else {
        attempts.push(() => Promise.resolve({ type: 'agent', username, agent }));
      }
    }
    // ssh2 ends authentication when the handler passes `false`, which its types leave out.
    const stop = (next: NextAuthHandler): void => {
      (next as unknown as (value: false) => void)(false);
    };
    return (_methodsLeft, _partial, next) => {
      const attempt = attempts.shift();
      if (attempt === undefined) {
        stop(next);
        return;
      }
      attempt().then(next, (error: unknown) => {
        this.#authError = error instanceof SyncError ? error : new SyncError('E_AUTH', errorMessage(error));
        stop(next);
      });
    };
  }

  #authError: SyncError | undefined;

  async connect(signal?: AbortSignal): Promise<Capabilities> {
    throwIfAborted(signal);
    const { host, port, timeoutMs } = this.#options;
    this.#root = this.#options.remoteRoot;
    joinRemote(this.#root, ROOT);
    if (this.#options.legacyAlgorithms === true) {
      this.#logger.warn('Legacy SSH algorithms are allowed for this server. Ask its administrator to support modern ones.', { host });
    }
    const client = new Client();
    this.#client = client;
    let hostKeyError: Error | undefined;
    let hostKey: HostKeyInfo | undefined;
    let negotiated: NegotiatedAlgorithms | undefined;
    client.on('handshake', (algorithms) => {
      negotiated = algorithms;
    });
    const config: ConnectConfig = {
      host,
      port,
      username: this.#options.username,
      readyTimeout: timeoutMs,
      keepaliveInterval: 15_000,
      // Protocol traces go to the redacting logger, at debug level only.
      debug: (message: string) => {
        this.#logger.debug(message);
      },
      algorithms: this.#options.legacyAlgorithms === true ? LEGACY_ALGORITHMS : MODERN_ALGORITHMS,
      authHandler: this.#authHandler(),
      hostVerifier: (key: Buffer, verify: (valid: boolean) => void) => {
        hostKey = describeHostKey(key, host, port);
        verifyHostKey(hostKey, this.#options.hostKeys).then(
          () => {
            verify(true);
          },
          (error: unknown) => {
            hostKeyError = error instanceof Error ? error : new SyncError('E_HOST_KEY_MISMATCH', errorMessage(error));
            verify(false);
          },
        );
      },
      ...(this.#options.ipFamily === undefined ? {} : { forceIPv4: this.#options.ipFamily === 4, forceIPv6: this.#options.ipFamily === 6 }),
    };
    const onAbort = (): void => {
      client.end();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        client.once('ready', resolve);
        client.once('error', (error: Error & { level?: string }) => {
          if (hostKeyError !== undefined) {
            reject(hostKeyError);
          } else if (this.#authError !== undefined) {
            reject(this.#authError);
          } else if (error.level === 'client-authentication') {
            reject(new SyncError('E_AUTH', `${host} did not accept the sign-in for "${this.#options.username}".`, { cause: error }));
          } else if (error.level === 'client-timeout') {
            reject(new SyncError('E_TIMEOUT', `${host} did not complete the SSH handshake in time.`, { cause: error, transient: true }));
          } else {
            reject(networkError(error, `Connecting to ${host}:${String(port)}`));
          }
        });
        client.connect(config);
      });
      throwIfAborted(signal);
      this.#sftp = await withTimeout(
        call<SFTPWrapper>((callback) => {
          client.sftp(callback);
        }),
        timeoutMs,
        'Opening the SFTP channel',
      );
      const rootInfo = await this.#stat(this.#root).catch((error: unknown) => {
        throw new SyncError('E_REMOTE_ROOT', `The remote root ${this.#root} was not found on ${host}: ${errorMessage(error)}`, { cause: error });
      });
      if (!rootInfo.isDirectory()) {
        throw new SyncError('E_REMOTE_ROOT', `The remote root ${this.#root} on ${host} is not a folder.`);
      }
    } catch (error) {
      client.end();
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    return {
      protocol: 'sftp',
      mtimePrecisionMs: 1000,
      canSetMtime: true,
      canChmod: true,
      atomicReplace: false,
      software: undefined,
      tls: undefined,
      hostKey,
      features: negotiated === undefined ? [] : [`kex ${negotiated.kex}`, `cipher ${negotiated.cs.cipher}`, `host key ${negotiated.serverHostKey}`],
    };
  }

  #channel(): SFTPWrapper {
    if (this.#sftp === undefined) {
      throw new SyncError('E_CONNECTION', 'Not connected.', { transient: true });
    }
    return this.#sftp;
  }

  #full(target: RemotePath): string {
    return joinRemote(this.#root, target);
  }

  #stat(full: string): Promise<Stats> {
    return withTimeout(
      call<Stats>((callback) => {
        this.#channel().lstat(full, callback);
      }),
      this.#options.timeoutMs,
      `Reading ${full}`,
    );
  }

  async list(dir: RemotePath): Promise<RemoteEntry[]> {
    const full = this.#full(dir);
    const sftp = this.#channel();
    const timeout = this.#options.timeoutMs;
    const entries: RemoteEntry[] = [];
    try {
      const handle = await withTimeout(call<Buffer>((callback) => { sftp.opendir(full, callback); }), timeout, `Listing ${full}`);
      try {
        for (;;) {
          const batch = await withTimeout(
            new Promise<FileEntryWithStats[] | false>((resolve, reject) => {
              sftp.readdir(handle, (error, list) => {
                if (error && statusCode(error) === STATUS.EOF) {
                  resolve(false);
                } else if (error) {
                  reject(error);
                } else {
                  resolve(list);
                }
              });
            }),
            timeout,
            `Listing ${full}`,
          );
          if (batch === false) {
            break;
          }
          for (const item of batch) {
            if (item.filename === '.' || item.filename === '..') {
              continue;
            }
            checkListingLimit(entries.length + 1, this.#limit, full);
            entries.push(makeEntry(dir, item.filename, typeOf(item.attrs.mode), item.attrs.size, item.attrs.mtime * 1000, this.#platform));
          }
        }
      } finally {
        await callVoid((callback) => { sftp.close(handle, callback); }).catch(() => undefined);
      }
    } catch (error) {
      throw sftpError(error, `Listing ${full}`);
    }
    return entries;
  }

  async stat(target: RemotePath): Promise<RemoteEntry | undefined> {
    const full = this.#full(target);
    try {
      const info = await this.#stat(full);
      return makeEntry(parentPath(target) ?? ROOT, target === ROOT ? '' : baseName(target), typeOf(info.mode), info.size, info.mtime * 1000, this.#platform);
    } catch (error) {
      if (statusCode(error) === STATUS.NO_SUCH_FILE) {
        return undefined;
      }
      throw sftpError(error, `Reading ${full}`);
    }
  }

  async get(target: RemotePath, to: Writable, signal?: AbortSignal): Promise<void> {
    const full = this.#full(target);
    try {
      await pipeline(this.#channel().createReadStream(full), new StallGuard(this.#options.timeoutMs, `Downloading ${full}`), to, { signal });
    } catch (error) {
      throw sftpError(error, `Downloading ${full}`);
    }
  }

  async put(from: Readable, target: RemotePath, signal?: AbortSignal): Promise<void> {
    const full = this.#full(target);
    try {
      const destination = this.#channel().createWriteStream(full);
      watchUpload(destination, this.#options.timeoutMs, `Uploading ${full}`);
      await pipeline(from, destination, { signal });
    } catch (error) {
      throw sftpError(error, `Uploading ${full}`);
    }
  }

  async rename(from: RemotePath, to: RemotePath, overwrite: boolean): Promise<void> {
    const source = this.#full(from);
    const destination = this.#full(to);
    const sftp = this.#channel();
    const timeout = this.#options.timeoutMs;
    try {
      if (overwrite) {
        const posixRename = tryPosixRename(sftp, source, destination);
        if (posixRename !== undefined) {
          await withTimeout(posixRename, timeout, `Renaming ${source}`);
          return;
        }
        if ((await this.stat(to)) !== undefined) {
          this.#logger.warn('The server cannot replace a file in one step; it is removed, then the new one is renamed into place.', { path: to });
          await this.remove(to);
        }
      }
      await withTimeout(callVoid((callback) => { sftp.rename(source, destination, callback); }), timeout, `Renaming ${source}`);
    } catch (error) {
      throw sftpError(error, `Renaming ${source} to ${destination}`);
    }
  }

  async remove(target: RemotePath): Promise<void> {
    const full = this.#full(target);
    const sftp = this.#channel();
    try {
      const info = await this.#stat(full);
      await withTimeout(
        callVoid((callback) => {
          if (info.isDirectory()) {
            sftp.rmdir(full, callback);
          } else {
            sftp.unlink(full, callback);
          }
        }),
        this.#options.timeoutMs,
        `Removing ${full}`,
      );
    } catch (error) {
      throw sftpError(error, `Removing ${full}`);
    }
  }

  async mkdir(target: RemotePath): Promise<void> {
    const full = this.#full(target);
    const sftp = this.#channel();
    try {
      await withTimeout(callVoid((callback) => { sftp.mkdir(full, callback); }), this.#options.timeoutMs, `Creating ${full}`);
    } catch (error) {
      const existing = await this.#stat(full).catch(() => undefined);
      if (existing?.isDirectory() === true) {
        return;
      }
      throw sftpError(error, `Creating ${full}`);
    }
  }

  async setMtime(target: RemotePath, mtimeMs: number): Promise<void> {
    const full = this.#full(target);
    const seconds = Math.floor(mtimeMs / 1000);
    try {
      await withTimeout(callVoid((callback) => { this.#channel().utimes(full, seconds, seconds, callback); }), this.#options.timeoutMs, `Setting the time of ${full}`);
    } catch (error) {
      throw sftpError(error, `Setting the time of ${full}`);
    }
  }

  async chmod(target: RemotePath, mode: number): Promise<void> {
    const full = this.#full(target);
    try {
      await withTimeout(callVoid((callback) => { this.#channel().chmod(full, mode, callback); }), this.#options.timeoutMs, `Changing the permissions of ${full}`);
    } catch (error) {
      throw sftpError(error, `Changing the permissions of ${full}`);
    }
  }

  close(): Promise<void> {
    this.#sftp = undefined;
    this.#client?.end();
    this.#client = undefined;
    return Promise.resolve();
  }
}
