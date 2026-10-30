/** What one side reports about a file. */
export interface Observation {
  readonly size: number;
  /** Milliseconds; `undefined` when the server does not report times. */
  readonly mtimeMs?: number | undefined;
  /** SHA-256 in hex, in checksum mode, local side only. */
  readonly sha256?: string | undefined;
}

/** `put` uploads newer local files, `get` downloads newer remote files, `both` does each. */
export type Direction = 'put' | 'get' | 'both';

/** Dreamweaver's names for the directions. */
export const DIRECTION_TITLES: Readonly<Record<Direction, string>> = {
  put: 'Put newer files to remote',
  get: 'Get newer files from remote',
  both: 'Get and put newer files',
};

/** The whole site, or some files and folders of it. */
export type Scope = { readonly kind: 'site' } | { readonly kind: 'paths'; readonly paths: readonly string[] };

export type Action = 'put' | 'get' | 'resolve' | 'delete-remote' | 'delete-local' | 'skip' | 'synced';

export type ProblemKind = 'unsafe' | 'case' | 'symlink' | 'other';

/** A name a scan could not use, on either side. */
export interface ScanProblem {
  /** The site-relative path for display; may hold characters no file system accepts. */
  readonly path: string;
  readonly side: 'local' | 'remote';
  readonly kind: ProblemKind;
  readonly status: string;
}

/** Typed progress events. They carry counts and bytes, never file contents. */
export type ProgressEvent =
  | { readonly type: 'scan-local'; readonly files: number }
  | { readonly type: 'scan-remote'; readonly files: number; readonly folders: number }
  | { readonly type: 'compare'; readonly files: number }
  | {
      readonly type: 'transfer';
      readonly path: string;
      readonly action: Action;
      readonly outcome: 'done' | 'failed' | 'stale';
      readonly completed: number;
      readonly total: number;
      readonly bytes: number;
    }
  | { readonly type: 'done'; readonly completed: number; readonly failed: number };
