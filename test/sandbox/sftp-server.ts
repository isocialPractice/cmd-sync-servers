// A minimal SFTP server for tests on ssh2's Server: one folder served as the
// server's "/", on 127.0.0.1, with a host key generated per run and faults on
// request.
import { createHash, timingSafeEqual } from 'node:crypto';
import { type Stats } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rmdir, stat, unlink, utimes, type FileHandle as FsHandle } from 'node:fs/promises';
import path from 'node:path';
import ssh2, { type Attributes, type AuthContext, type Connection, type FileEntry, type SFTPWrapper } from 'ssh2';
import { ed25519KeyPair } from './keys.ts';

const { Server, utils } = ssh2;
const STATUS = utils.sftp.STATUS_CODE;
const HOST = '127.0.0.1';

export interface SftpFaults {
  /** Cut the SSH connection after this many bytes of the next `dropTransfers` downloads. */
  dropAfterBytes?: number;
  dropTransfers?: number;
  /** Leave the next `stallTransfers` READ or WRITE requests unanswered. */
  stallTransfers?: number;
  /** Extra entries in the listing of `listingFolder` (default `/`), never on disk. */
  hostileNames?: string[];
  /** A symbolic link entry, pointing outside the root, in the same listing. */
  symlinkOutside?: string;
  listingFolder?: string;
}

export interface SftpSandboxOptions {
  readonly root: string;
  readonly user: string;
  readonly password?: string;
  /** An OpenSSH public key allowed to sign in. */
  readonly publicKey?: string;
  /** Offer only keyboard-interactive for passwords, as some servers do. */
  readonly keyboardInteractiveOnly?: boolean;
  /** An OpenSSH private host key; one is generated when absent. */
  readonly hostKey?: string;
  readonly port?: number;
  readonly faults?: SftpFaults;
  /** The folder relative paths start from, as a home folder does; default `/`. */
  readonly home?: string;
}

export interface SftpSandbox {
  readonly host: string;
  readonly port: number;
  /** The host key fingerprint, unpadded base64 SHA-256. */
  readonly hostKeySha256: string;
  readonly faults: SftpFaults;
  readonly connections: number;
  close(): Promise<void>;
}

interface FileHandle {
  readonly kind: 'file';
  readonly fd: FsHandle;
  readonly local: string;
  bytesRead: number;
}

interface DirHandle {
  readonly kind: 'dir';
  readonly entries: FileEntry[];
  sent: boolean;
}

function attrsOf(info: Stats): Attributes {
  return {
    mode: info.mode,
    uid: info.uid,
    gid: info.gid,
    size: info.size,
    atime: Math.floor(info.atimeMs / 1000),
    mtime: Math.floor(info.mtimeMs / 1000),
  };
}

function synthetic(name: string, mode: number, size: number): FileEntry {
  const now = Math.floor(Date.now() / 1000);
  return { filename: name, longname: name, attrs: { mode, uid: 0, gid: 0, size, atime: now, mtime: now } };
}

function equalText(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

function serve(sftp: SFTPWrapper, options: SftpSandboxOptions, faults: SftpFaults, connection: Connection): void {
  const handles = new Map<number, FileHandle | DirHandle>();
  let next = 0;
  // Once a drop fault fires, nothing more is answered on this connection.
  let dropped = false;
  const home = options.home ?? '/';
  const local = (remote: string): string =>
    path.join(options.root, ...path.posix.resolve(home, remote).split('/').filter((part) => part !== ''));
  const newHandle = (value: FileHandle | DirHandle): Buffer => {
    next += 1;
    handles.set(next, value);
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(next);
    return buffer;
  };
  const lookup = (handle: Buffer): FileHandle | DirHandle | undefined => (handle.length === 4 ? handles.get(handle.readUInt32BE(0)) : undefined);
  const fail = (reqId: number, error: unknown): void => {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    sftp.status(reqId, code === 'ENOENT' ? STATUS.NO_SUCH_FILE : code === 'EACCES' || code === 'EPERM' ? STATUS.PERMISSION_DENIED : STATUS.FAILURE);
  };
  const takeFault = (name: 'dropTransfers' | 'stallTransfers'): boolean => {
    const left = faults[name] ?? 0;
    if (left <= 0) {
      return false;
    }
    faults[name] = left - 1;
    return true;
  };
  const run = (reqId: number, action: () => Promise<void>): void => {
    action().catch((error: unknown) => {
      fail(reqId, error);
    });
  };

  sftp.on('OPEN', (reqId, filename, flags) => {
    run(reqId, async () => {
      const mode = utils.sftp.flagsToString(flags) ?? 'r';
      const fd = await open(local(filename), mode);
      sftp.handle(reqId, newHandle({ kind: 'file', fd, local: local(filename), bytesRead: 0 }));
    });
  });
  sftp.on('READ', (reqId, handle, offset, length) => {
    const entry = lookup(handle);
    if (dropped) {
      return;
    }
    if (entry?.kind !== 'file') {
      sftp.status(reqId, STATUS.FAILURE);
      return;
    }
    if (takeFault('stallTransfers')) {
      return;
    }
    run(reqId, async () => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await entry.fd.read(buffer, 0, length, offset);
      if (dropped) {
        return;
      }
      if (bytesRead === 0) {
        sftp.status(reqId, STATUS.EOF);
        return;
      }
      entry.bytesRead += bytesRead;
      const dropAfter = faults.dropAfterBytes;
      if (dropAfter !== undefined && entry.bytesRead >= dropAfter && takeFault('dropTransfers')) {
        dropped = true;
        setImmediate(() => {
          connection.end();
        });
        return;
      }
      sftp.data(reqId, buffer.subarray(0, bytesRead));
    });
  });
  sftp.on('WRITE', (reqId, handle, offset, data) => {
    const entry = lookup(handle);
    if (entry?.kind !== 'file') {
      sftp.status(reqId, STATUS.FAILURE);
      return;
    }
    if (takeFault('stallTransfers')) {
      return;
    }
    run(reqId, async () => {
      await entry.fd.write(data, 0, data.length, offset);
      sftp.status(reqId, STATUS.OK);
    });
  });
  sftp.on('FSTAT', (reqId, handle) => {
    const entry = lookup(handle);
    if (entry?.kind !== 'file') {
      sftp.status(reqId, STATUS.FAILURE);
      return;
    }
    run(reqId, async () => {
      sftp.attrs(reqId, attrsOf(await entry.fd.stat()));
    });
  });
  sftp.on('CLOSE', (reqId, handle) => {
    const entry = lookup(handle);
    handles.delete(handle.readUInt32BE(0));
    run(reqId, async () => {
      if (entry?.kind === 'file') {
        await entry.fd.close();
      }
      sftp.status(reqId, STATUS.OK);
    });
  });
  sftp.on('OPENDIR', (reqId, remote) => {
    run(reqId, async () => {
      const folder = local(remote);
      const entries: FileEntry[] = [];
      for (const name of await readdir(folder)) {
        const info = await lstat(path.join(folder, name));
        entries.push({ filename: name, longname: name, attrs: attrsOf(info) });
      }
      if (path.posix.resolve('/', remote) === (faults.listingFolder ?? '/')) {
        for (const name of faults.hostileNames ?? []) {
          entries.push(synthetic(name, 0o100644, 1));
        }
        if (faults.symlinkOutside !== undefined) {
          entries.push(synthetic(faults.symlinkOutside, 0o120777, 11));
        }
      }
      sftp.handle(reqId, newHandle({ kind: 'dir', entries, sent: false }));
    });
  });
  sftp.on('READDIR', (reqId, handle) => {
    const entry = lookup(handle);
    if (entry?.kind !== 'dir' || entry.sent) {
      sftp.status(reqId, entry === undefined ? STATUS.FAILURE : STATUS.EOF);
      return;
    }
    entry.sent = true;
    sftp.name(reqId, entry.entries);
  });
  const statHandler = (follow: boolean) => (reqId: number, remote: string) => {
    run(reqId, async () => {
      sftp.attrs(reqId, attrsOf(await (follow ? stat : lstat)(local(remote))));
    });
  };
  sftp.on('STAT', statHandler(true));
  sftp.on('LSTAT', statHandler(false));
  const setAttributes = async (target: string, attrs: Partial<Attributes>): Promise<void> => {
    if (typeof attrs.mtime === 'number') {
      await utimes(target, attrs.atime ?? attrs.mtime, attrs.mtime);
    }
    if (typeof attrs.mode === 'number') {
      await chmod(target, attrs.mode & 0o7777);
    }
  };
  sftp.on('SETSTAT', (reqId, remote, attrs) => {
    run(reqId, async () => {
      await setAttributes(local(remote), attrs);
      sftp.status(reqId, STATUS.OK);
    });
  });
  sftp.on('FSETSTAT', (reqId, handle, attrs) => {
    const entry = lookup(handle);
    run(reqId, async () => {
      if (entry?.kind !== 'file') {
        throw new Error('bad handle');
      }
      await setAttributes(entry.local, attrs);
      sftp.status(reqId, STATUS.OK);
    });
  });
  sftp.on('MKDIR', (reqId, remote) => {
    run(reqId, async () => {
      await mkdir(local(remote));
      sftp.status(reqId, STATUS.OK);
    });
  });
  sftp.on('RMDIR', (reqId, remote) => {
    run(reqId, async () => {
      await rmdir(local(remote));
      sftp.status(reqId, STATUS.OK);
    });
  });
  sftp.on('REMOVE', (reqId, remote) => {
    run(reqId, async () => {
      await unlink(local(remote));
      sftp.status(reqId, STATUS.OK);
    });
  });
  sftp.on('RENAME', (reqId, from, to) => {
    run(reqId, async () => {
      // SFTP version 3: a rename never replaces an existing target.
      const exists = await lstat(local(to)).then(
        () => true,
        () => false,
      );
      if (exists) {
        sftp.status(reqId, STATUS.FAILURE, 'Target exists.');
        return;
      }
      await rename(local(from), local(to));
      sftp.status(reqId, STATUS.OK);
    });
  });
  sftp.on('REALPATH', (reqId, remote) => {
    const resolved = path.posix.resolve(home, remote);
    sftp.name(reqId, [{ filename: resolved, longname: resolved, attrs: {} as Attributes }]);
  });
  sftp.on('EXTENDED', (reqId) => {
    sftp.status(reqId, STATUS.OP_UNSUPPORTED);
  });
}

function authenticate(context: AuthContext, options: SftpSandboxOptions): void {
  if (context.username !== options.user) {
    context.reject();
    return;
  }
  const methods: ('password' | 'publickey' | 'keyboard-interactive')[] = [];
  if (options.password !== undefined) {
    methods.push(options.keyboardInteractiveOnly === true ? 'keyboard-interactive' : 'password');
  }
  if (options.publicKey !== undefined) {
    methods.push('publickey');
  }
  switch (context.method) {
    case 'password':
      if (options.keyboardInteractiveOnly !== true && options.password !== undefined && equalText(context.password, options.password)) {
        context.accept();
      } else {
        context.reject(methods);
      }
      return;
    case 'keyboard-interactive':
      if (options.password === undefined) {
        context.reject(methods);
        return;
      }
      context.prompt([{ prompt: 'Password: ', echo: false }], (answers) => {
        if (equalText(answers[0] ?? '', options.password ?? '')) {
          context.accept();
        } else {
          context.reject(methods);
        }
      });
      return;
    case 'publickey': {
      const allowed = options.publicKey === undefined ? undefined : utils.parseKey(options.publicKey);
      if (allowed === undefined || allowed instanceof Error || context.key.algo !== allowed.type || !allowed.getPublicSSH().equals(context.key.data)) {
        context.reject(methods);
        return;
      }
      if (context.signature === undefined || context.blob === undefined) {
        context.accept();
        return;
      }
      if (allowed.verify(context.blob, context.signature, context.hashAlgo)) {
        context.accept();
      } else {
        context.reject(methods);
      }
      return;
    }
    default:
      context.reject(methods);
  }
}

/** Starts an SFTP sandbox serving `options.root` as `/` on 127.0.0.1. */
export async function startSftpSandbox(options: SftpSandboxOptions): Promise<SftpSandbox> {
  const hostKey = options.hostKey ?? ed25519KeyPair().private;
  const parsed = utils.parseKey(hostKey);
  if (parsed instanceof Error) {
    throw parsed;
  }
  const hostKeySha256 = createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '');
  const faults = options.faults ?? {};
  const connections = new Set<Connection>();
  let total = 0;
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    total += 1;
    connections.add(client);
    client.on('close', () => connections.delete(client));
    client.on('error', () => undefined);
    client.on('authentication', (context) => {
      authenticate(context, options);
    });
    client.on('ready', () => {
      client.on('session', (acceptSession) => {
        const session = acceptSession();
        session.on('sftp', (acceptSftp) => {
          serve(acceptSftp(), options, faults, client);
        });
      });
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, HOST, () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
  return {
    host: HOST,
    port,
    hostKeySha256,
    faults,
    get connections() {
      return total;
    },
    close: async () => {
      for (const client of connections) {
        client.end();
      }
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
