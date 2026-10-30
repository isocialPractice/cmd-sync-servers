import type { Readable, Writable } from 'node:stream';
import type { Protocol } from '../config/schema.ts';
import type { HostKeyInfo } from '../host.ts';
import type { RemotePath } from '../sync/paths.ts';

/** What a listed entry is: a file, a folder, a symbolic link, or anything else such as a device. */
export type EntryType = 'file' | 'dir' | 'symlink' | 'other';

/** One entry of a folder listing or a stat. */
export interface RemoteEntry {
  /** The name exactly as the server returned it. */
  readonly name: string;
  /** The validated path, or `undefined` when the name is not safe on this system. */
  readonly path: RemotePath | undefined;
  /** Why the name is not safe, when it is not. */
  readonly unsafe: string | undefined;
  readonly type: EntryType;
  readonly size: number;
  /** Modification time in milliseconds, when the server reports one in the listing. */
  readonly mtimeMs: number | undefined;
}

/** What a connected server offers. */
export interface Capabilities {
  readonly protocol: Protocol;
  /** How precise the times in listings and stats are, in milliseconds; `undefined` when listings carry none. */
  readonly mtimePrecisionMs: number | undefined;
  readonly canSetMtime: boolean;
  readonly canChmod: boolean;
  /** True when a rename replaces an existing file in one step. */
  readonly atomicReplace: boolean;
  /** The server's own description, such as an SSH version string or an FTP greeting. */
  readonly software: string | undefined;
  /** The TLS version and cipher, for FTPS. */
  readonly tls: string | undefined;
  /** The host key, for SFTP. */
  readonly hostKey: HostKeyInfo | undefined;
  /** Protocol extensions in use, such as `MLSD` or `posix-rename@openssh.com`. */
  readonly features: readonly string[];
  /** The absolute folder the server puts the account in after signing in, read before changing to the remote root; absent for `local`. */
  readonly startingFolder?: string | undefined;
}

/**
 * One connection to a server's remote root. Every path is a validated
 * {@link RemotePath} relative to that root. Files move as streams; nothing
 * reads a whole file into memory.
 */
export interface Transport {
  /** Connects, signs in and checks the remote root, then reports what the server offers. */
  connect(signal?: AbortSignal): Promise<Capabilities>;
  /** The entries of one folder. */
  list(dir: RemotePath, signal?: AbortSignal): Promise<RemoteEntry[]>;
  /** The entry at `path`, without following a symbolic link; `undefined` when nothing is there. */
  stat(path: RemotePath, signal?: AbortSignal): Promise<RemoteEntry | undefined>;
  /** Streams the file at `path` into `to`. */
  get(path: RemotePath, to: Writable, signal?: AbortSignal): Promise<void>;
  /** Streams `from` into a file at `path`, replacing any file there. */
  put(from: Readable, path: RemotePath, signal?: AbortSignal): Promise<void>;
  /** Renames `from` to `to`; with `overwrite`, replaces an existing `to`. */
  rename(from: RemotePath, to: RemotePath, overwrite: boolean): Promise<void>;
  /** Removes a file, or an empty folder. */
  remove(path: RemotePath): Promise<void>;
  /** Creates a folder; succeeds when it already exists. */
  mkdir(path: RemotePath): Promise<void>;
  /** Sets a file's modification time, when the protocol can. */
  setMtime?(path: RemotePath, mtimeMs: number): Promise<void>;
  /** Sets a file's permission bits, when the protocol can. */
  chmod?(path: RemotePath, mode: number): Promise<void>;
  /** Closes the connection. Safe to call more than once. */
  close(): Promise<void>;
}

/** The most entries one folder listing may hold before it is refused. */
export const DEFAULT_LISTING_LIMIT = 100_000;
