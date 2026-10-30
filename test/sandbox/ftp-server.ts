// A minimal FTP and FTPS server for tests: it speaks the commands basic-ftp
// uses, over plain TCP, explicit TLS (AUTH TLS) or implicit TLS, serves one
// folder on 127.0.0.1, and injects faults on request.
import { createReadStream, createWriteStream, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, readdir, rename, rmdir, unlink, utimes } from 'node:fs/promises';
import net, { type Server, type Socket } from 'node:net';
import path from 'node:path';
import { finished, pipeline } from 'node:stream/promises';
import tls, { type SecureContext } from 'node:tls';
import type { TestCertificate } from './cert.ts';

export interface FtpFaults {
  /** Cut both connections after this many bytes of the next `dropTransfers` downloads. */
  dropAfterBytes?: number;
  dropTransfers?: number;
  /** Open the data connection, then never move data, for the next `stallTransfers` transfers. */
  stallTransfers?: number;
  /** Answer 553 to RNTO when the target exists. */
  refuseRenameOverExisting?: boolean;
  /** Answer 421 to a new connection while this many are open. */
  maxConnections?: number;
  /** Extra entries in the listing of `listingFolder` (default `/`), never on disk. */
  hostileNames?: string[];
  /** A symbolic link entry, pointing outside the root, in the same listing. */
  symlinkOutside?: string;
  listingFolder?: string;
}

export interface FtpSandboxOptions {
  readonly root: string;
  readonly user: string;
  readonly password: string;
  readonly tls: 'explicit' | 'implicit' | 'none';
  readonly certificate?: TestCertificate;
  /** A different certificate for data connections, as a machine in the middle would present. */
  readonly dataCertificate?: TestCertificate;
  /** The folder the account starts in after signing in; default `/`. */
  readonly home?: string;
  /** Offer MLSD (default true); without it, clients fall back to LIST. */
  readonly mlsd?: boolean;
  readonly port?: number;
  readonly faults?: FtpFaults;
}

export interface FtpSandbox {
  readonly host: string;
  readonly port: number;
  readonly faults: FtpFaults;
  /** Control connections accepted so far. */
  readonly connections: number;
  /** Every command received, with the PASS argument hidden. */
  readonly commands: readonly string[];
  close(): Promise<void>;
}

const HOST = '127.0.0.1';

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
}

function mlsxTime(date: Date): string {
  return date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function factLine(name: string, type: string, size: number, mtime: Date, mode: number): string {
  return `type=${type};size=${String(size)};modify=${mlsxTime(mtime)};unix.mode=0${(mode & 0o777).toString(8)}; ${name}`;
}

function listLine(name: string, isDir: boolean, size: number, mtime: Date): string {
  const month = mtime.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const day = String(mtime.getUTCDate()).padStart(2, ' ');
  const time = `${String(mtime.getUTCHours()).padStart(2, '0')}:${String(mtime.getUTCMinutes()).padStart(2, '0')}`;
  return `${isDir ? 'd' : '-'}rw-r--r--   1 owner    group ${String(size).padStart(10)} ${month} ${day} ${time} ${name}`;
}

interface Shared {
  readonly options: FtpSandboxOptions;
  readonly faults: FtpFaults;
  readonly context: SecureContext | undefined;
  readonly dataContext: SecureContext | undefined;
  readonly commands: string[];
  readonly sockets: Set<Socket>;
  readonly servers: Set<Server>;
}

class Session {
  readonly #shared: Shared;
  #socket: Socket;
  #secure: boolean;
  #buffer = '';
  #queue: Promise<void> = Promise.resolve();
  #user: string | undefined;
  #authed = false;
  #protectData = false;
  #cwd = '/';
  #renameFrom: string | undefined;
  #passive: Promise<Socket> | undefined;

  constructor(socket: Socket, shared: Shared) {
    this.#shared = shared;
    this.#cwd = shared.options.home ?? '/';
    this.#socket = socket;
    this.#secure = socket instanceof tls.TLSSocket;
    this.#attach(socket);
    this.#reply(220, 'sync-servers sandbox FTP ready.');
  }

  #attach(socket: Socket): void {
    this.#socket = socket;
    this.#shared.sockets.add(socket);
    socket.on('data', this.#onData);
    socket.on('error', () => undefined);
  }

  readonly #onData = (chunk: Buffer): void => {
    this.#buffer += chunk.toString('utf8');
    for (let end = this.#buffer.indexOf('\n'); end !== -1; end = this.#buffer.indexOf('\n')) {
      const line = this.#buffer.slice(0, end).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(end + 1);
      if (/^AUTH TLS$/i.test(line)) {
        // Stop reading plain text at once: the TLS handshake follows our reply.
        this.#socket.off('data', this.#onData);
        this.#queue = this.#queue.then(() => {
          this.#upgrade();
        });
        return;
      }
      this.#queue = this.#queue.then(() => this.#handle(line)).catch(() => undefined);
    }
  };

  #upgrade(): void {
    const { context } = this.#shared;
    this.#shared.commands.push('AUTH TLS');
    if (this.#shared.options.tls !== 'explicit' || context === undefined || this.#secure) {
      this.#reply(502, 'AUTH TLS is not available.');
      this.#socket.on('data', this.#onData);
      return;
    }
    this.#reply(234, 'AUTH TLS successful.');
    const secure = new tls.TLSSocket(this.#socket, { isServer: true, secureContext: context });
    this.#secure = true;
    this.#attach(secure);
  }

  #reply(code: number, text: string): void {
    this.#socket.write(`${String(code)} ${text}\r\n`);
  }

  #resolve(argument: string): { remote: string; local: string } {
    const remote = path.posix.resolve(this.#cwd, argument === '' ? '.' : argument);
    return { remote, local: path.join(this.#shared.options.root, ...remote.split('/').filter((part) => part !== '')) };
  }

  async #openPassive(): Promise<number> {
    const server = net.createServer();
    this.#shared.servers.add(server);
    const context = this.#shared.dataContext ?? this.#shared.context;
    const protect = this.#protectData && context !== undefined;
    const accepted = new Promise<Socket>((resolve, reject) => {
      server.once('connection', (raw: Socket) => {
        server.close();
        this.#shared.sockets.add(raw);
        raw.on('error', () => undefined);
        if (!protect) {
          resolve(raw);
          return;
        }
        const secure = new tls.TLSSocket(raw, { isServer: true, secureContext: context });
        this.#shared.sockets.add(secure);
        secure.on('error', reject);
        secure.once('secure', () => {
          resolve(secure);
        });
      });
      server.once('error', reject);
    });
    accepted.catch(() => undefined);
    this.#passive = accepted;
    return listen(server, 0);
  }

  async #takeData(): Promise<Socket | undefined> {
    const pending = this.#passive;
    this.#passive = undefined;
    if (pending === undefined) {
      this.#reply(425, 'Use EPSV or PASV first.');
      return undefined;
    }
    return pending;
  }

  #takeFault(name: 'dropTransfers' | 'stallTransfers'): boolean {
    const left = this.#shared.faults[name] ?? 0;
    if (left <= 0) {
      return false;
    }
    this.#shared.faults[name] = left - 1;
    return true;
  }

  async #statOf(local: string): Promise<Stats | undefined> {
    try {
      return await lstat(local);
    } catch {
      return undefined;
    }
  }

  async #handle(line: string): Promise<void> {
    const space = line.indexOf(' ');
    const verb = (space === -1 ? line : line.slice(0, space)).toUpperCase();
    const argument = space === -1 ? '' : line.slice(space + 1);
    this.#shared.commands.push(verb === 'PASS' ? 'PASS ***' : line);
    const { options } = this.#shared;
    const open = ['USER', 'PASS', 'PBSZ', 'PROT', 'FEAT', 'SYST', 'QUIT', 'OPTS', 'NOOP'];
    if (!this.#authed && !open.includes(verb)) {
      this.#reply(530, 'Please log in first.');
      return;
    }
    switch (verb) {
      case 'USER':
        if (options.tls === 'explicit' && !this.#secure) {
          this.#reply(530, 'TLS is required. Use AUTH TLS first.');
          return;
        }
        this.#user = argument;
        this.#reply(331, 'Password required.');
        return;
      case 'PASS':
        this.#authed = this.#user === options.user && argument === options.password;
        this.#reply(this.#authed ? 230 : 530, this.#authed ? 'Logged in.' : 'Login incorrect.');
        return;
      case 'PBSZ':
        this.#reply(200, 'PBSZ=0');
        return;
      case 'PROT':
        this.#protectData = argument.toUpperCase() === 'P';
        this.#reply(200, `Protection level set to ${argument}.`);
        return;
      case 'FEAT': {
        const features = [' EPSV', ' PASV', ' SIZE', ' MDTM', ' MFMT', ' UTF8'];
        if (options.mlsd !== false) {
          features.push(' MLST type*;size*;modify*;unix.mode*;');
        }
        if (options.tls !== 'none') {
          features.push(' AUTH TLS', ' PBSZ', ' PROT');
        }
        this.#socket.write(`211-Features:\r\n${features.join('\r\n')}\r\n211 End\r\n`);
        return;
      }
      case 'SYST':
        this.#reply(215, 'UNIX Type: L8');
        return;
      case 'OPTS':
      case 'TYPE':
      case 'STRU':
      case 'NOOP':
        this.#reply(200, 'OK.');
        return;
      case 'QUIT':
        this.#reply(221, 'Goodbye.');
        this.#socket.end();
        return;
      case 'PWD':
        this.#reply(257, `"${this.#cwd}" is the current directory.`);
        return;
      case 'CWD': {
        const target = this.#resolve(argument);
        if ((await this.#statOf(target.local))?.isDirectory() === true) {
          this.#cwd = target.remote;
          this.#reply(250, 'Directory changed.');
        } else {
          this.#reply(550, 'No such directory.');
        }
        return;
      }
      case 'CDUP':
        this.#cwd = path.posix.dirname(this.#cwd);
        this.#reply(250, 'Directory changed.');
        return;
      case 'EPSV': {
        const port = await this.#openPassive();
        this.#reply(229, `Entering Extended Passive Mode (|||${String(port)}|)`);
        return;
      }
      case 'PASV': {
        const port = await this.#openPassive();
        this.#reply(227, `Entering Passive Mode (127,0,0,1,${String(Math.floor(port / 256))},${String(port % 256)})`);
        return;
      }
      case 'MLSD':
      case 'LIST':
        await this.#list(verb, argument.replace(/^-a\s*/, ''));
        return;
      case 'RETR':
        await this.#retrieve(argument);
        return;
      case 'STOR':
        await this.#store(argument);
        return;
      case 'SIZE':
      case 'MDTM': {
        const info = await this.#statOf(this.#resolve(argument).local);
        if (info?.isFile() !== true) {
          this.#reply(550, 'Not a plain file.');
        } else {
          this.#reply(213, verb === 'SIZE' ? String(info.size) : mlsxTime(info.mtime));
        }
        return;
      }
      case 'MFMT': {
        const [time = '', ...rest] = argument.split(' ');
        const target = this.#resolve(rest.join(' '));
        const date = new Date(Date.UTC(+time.slice(0, 4), +time.slice(4, 6) - 1, +time.slice(6, 8), +time.slice(8, 10), +time.slice(10, 12), +time.slice(12, 14)));
        try {
          await utimes(target.local, date, date);
          this.#reply(213, `Modify=${time}; ${target.remote}`);
        } catch {
          this.#reply(550, 'Could not set the time.');
        }
        return;
      }
      case 'DELE':
        await this.#fsReply(() => unlink(this.#resolve(argument).local), 250, 'Deleted.');
        return;
      case 'RMD':
        await this.#fsReply(() => rmdir(this.#resolve(argument).local), 250, 'Directory removed.');
        return;
      case 'MKD': {
        const target = this.#resolve(argument);
        await this.#fsReply(() => mkdir(target.local), 257, `"${target.remote}" created.`);
        return;
      }
      case 'RNFR': {
        const target = this.#resolve(argument);
        if ((await this.#statOf(target.local)) === undefined) {
          this.#reply(550, 'No such file.');
        } else {
          this.#renameFrom = target.local;
          this.#reply(350, 'Ready for RNTO.');
        }
        return;
      }
      case 'RNTO': {
        const from = this.#renameFrom;
        this.#renameFrom = undefined;
        const target = this.#resolve(argument);
        if (from === undefined) {
          this.#reply(503, 'RNFR first.');
        } else if (this.#shared.faults.refuseRenameOverExisting === true && (await this.#statOf(target.local)) !== undefined) {
          this.#reply(553, 'Target exists.');
        } else {
          await this.#fsReply(() => rename(from, target.local), 250, 'Renamed.');
        }
        return;
      }
      case 'SITE': {
        const match = /^CHMOD\s+([0-7]{3,4})\s+(.+)$/i.exec(argument);
        if (match === null) {
          this.#reply(502, 'SITE command not implemented.');
        } else {
          await this.#fsReply(() => chmod(this.#resolve(match[2] ?? '').local, parseInt(match[1] ?? '644', 8)), 200, 'Mode changed.');
        }
        return;
      }
      default:
        this.#reply(502, 'Command not implemented.');
    }
  }

  async #fsReply(action: () => Promise<unknown>, code: number, text: string): Promise<void> {
    try {
      await action();
      this.#reply(code, text);
    } catch {
      this.#reply(550, 'Action not taken.');
    }
  }

  async #list(verb: 'MLSD' | 'LIST', argument: string): Promise<void> {
    if (verb === 'MLSD' && this.#shared.options.mlsd === false) {
      this.#reply(500, 'MLSD not understood.');
      return;
    }
    const target = this.#resolve(argument);
    if ((await this.#statOf(target.local))?.isDirectory() !== true) {
      this.#reply(550, 'No such directory.');
      return;
    }
    const data = await this.#takeData();
    if (data === undefined) {
      return;
    }
    this.#reply(150, 'Here comes the listing.');
    if (this.#takeFault('stallTransfers')) {
      return;
    }
    const lines: string[] = [];
    for (const name of await readdir(target.local)) {
      const info = await lstat(path.join(target.local, name));
      lines.push(
        verb === 'MLSD'
          ? factLine(name, info.isDirectory() ? 'dir' : 'file', info.size, info.mtime, info.mode)
          : listLine(name, info.isDirectory(), info.size, info.mtime),
      );
    }
    const faults = this.#shared.faults;
    if (target.remote === (faults.listingFolder ?? '/')) {
      for (const name of faults.hostileNames ?? []) {
        lines.push(verb === 'MLSD' ? factLine(name, 'file', 1, new Date(), 0o644) : listLine(name, false, 1, new Date()));
      }
      if (faults.symlinkOutside !== undefined) {
        lines.push(`type=OS.unix=slink:/etc/passwd;size=11;modify=${mlsxTime(new Date())}; ${faults.symlinkOutside}`);
      }
    }
    data.end(lines.length === 0 ? '' : `${lines.join('\r\n')}\r\n`);
    await finished(data).catch(() => undefined);
    this.#reply(226, 'Directory send OK.');
  }

  async #retrieve(argument: string): Promise<void> {
    const target = this.#resolve(argument);
    if ((await this.#statOf(target.local))?.isFile() !== true) {
      this.#reply(550, 'No such file.');
      return;
    }
    const data = await this.#takeData();
    if (data === undefined) {
      return;
    }
    this.#reply(150, 'Opening data connection.');
    if (this.#takeFault('stallTransfers')) {
      return;
    }
    const dropAfter = this.#shared.faults.dropAfterBytes;
    if (dropAfter !== undefined && this.#takeFault('dropTransfers')) {
      const stream = createReadStream(target.local, { start: 0, end: Math.max(0, dropAfter - 1) });
      for await (const chunk of stream) {
        data.write(chunk as Buffer);
      }
      setTimeout(() => {
        data.destroy();
        this.#socket.destroy();
      }, 20);
      return;
    }
    try {
      await pipeline(createReadStream(target.local), data);
      this.#reply(226, 'Transfer complete.');
    } catch {
      this.#reply(426, 'Transfer aborted.');
    }
  }

  async #store(argument: string): Promise<void> {
    const target = this.#resolve(argument);
    const data = await this.#takeData();
    if (data === undefined) {
      return;
    }
    this.#reply(150, 'Ok to send data.');
    if (this.#takeFault('stallTransfers')) {
      data.pause();
      return;
    }
    try {
      await pipeline(data, createWriteStream(target.local));
      this.#reply(226, 'Transfer complete.');
    } catch {
      this.#reply(451, 'Transfer failed.');
    }
  }
}

/** Starts an FTP sandbox serving `options.root` on 127.0.0.1. */
export async function startFtpSandbox(options: FtpSandboxOptions): Promise<FtpSandbox> {
  if (options.tls !== 'none' && options.certificate === undefined) {
    throw new Error('An FTPS sandbox needs a certificate.');
  }
  const certificate = options.certificate;
  const shared: Shared = {
    options,
    faults: options.faults ?? {},
    context: certificate === undefined ? undefined : tls.createSecureContext({ key: certificate.key, cert: certificate.cert, minVersion: 'TLSv1.2' }),
    dataContext:
      options.dataCertificate === undefined
        ? undefined
        : tls.createSecureContext({ key: options.dataCertificate.key, cert: options.dataCertificate.cert, minVersion: 'TLSv1.2' }),
    commands: [],
    sockets: new Set(),
    servers: new Set(),
  };
  let open = 0;
  let total = 0;
  const onConnection = (socket: Socket): void => {
    total += 1;
    shared.sockets.add(socket);
    socket.on('error', () => undefined);
    const max = shared.faults.maxConnections;
    if (max !== undefined && open >= max) {
      socket.end('421 Too many connections.\r\n');
      return;
    }
    open += 1;
    socket.once('close', () => {
      open -= 1;
    });
    new Session(socket, shared);
  };
  const server: Server =
    options.tls === 'implicit' && certificate !== undefined
      ? tls.createServer({ key: certificate.key, cert: certificate.cert, minVersion: 'TLSv1.2' }, onConnection)
      : net.createServer(onConnection);
  const port = await listen(server, options.port ?? 0);
  return {
    host: HOST,
    port,
    faults: shared.faults,
    get connections() {
      return total;
    },
    commands: shared.commands,
    close: async () => {
      for (const socket of shared.sockets) {
        socket.destroy();
      }
      for (const other of shared.servers) {
        other.close();
      }
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
