import type { SyncRecord } from './state.ts';
import type { Observation } from './types.ts';

export interface CompareOptions {
  /** Times this close count as equal; FAT, FTP MDTM and SFTP v3 keep times to 1 or 2 seconds. */
  readonly toleranceMs: number;
  /** Compare SHA-256 hashes where both are known. */
  readonly checksum: boolean;
}

/** The state of one path (section 7.3). `refresh-record` and `drop-record` are applied silently. */
export type SyncState =
  | 'in-sync'
  | 'local-changed'
  | 'remote-changed'
  | 'both-changed'
  | 'local-only'
  | 'remote-only'
  | 'first-sync-local-newer'
  | 'first-sync-remote-newer'
  | 'first-sync-conflict'
  | 'remote-deleted'
  | 'local-deleted'
  | 'changed-locally-deleted-remotely'
  | 'deleted-locally-changed-remotely'
  | 'refresh-record'
  | 'drop-record';

/** Milliseconds `a` is newer than `b`, or `undefined` when either time is unknown. */
function timeDifference(a: Observation, b: Observation): number | undefined {
  return a.mtimeMs === undefined || b.mtimeMs === undefined ? undefined : a.mtimeMs - b.mtimeMs;
}

function bothHashed(a: Observation, b: Observation, options: CompareOptions): boolean {
  return options.checksum && a.sha256 !== undefined && b.sha256 !== undefined;
}

/**
 * True when a side differs from its own earlier observation (section 7.2).
 * Without a time on either observation, as with an FTP server that reports
 * none, the size and any hashes decide.
 */
export function hasChanged(now: Observation, recorded: Observation, options: CompareOptions): boolean {
  if (now.size !== recorded.size || (bothHashed(now, recorded, options) && now.sha256 !== recorded.sha256)) {
    return true;
  }
  const difference = timeDifference(now, recorded);
  return difference !== undefined && Math.abs(difference) > options.toleranceMs;
}

/**
 * True when the local and the remote copy are the same file: equal size and
 * equal hashes where both are known, otherwise times within the tolerance.
 * Unknown times never count as a match.
 */
export function copiesMatch(local: Observation, remote: Observation, options: CompareOptions): boolean {
  if (local.size !== remote.size) {
    return false;
  }
  if (bothHashed(local, remote, options)) {
    return local.sha256 === remote.sha256;
  }
  const difference = timeDifference(local, remote);
  return difference !== undefined && Math.abs(difference) <= options.toleranceMs;
}

function firstSync(local: Observation, remote: Observation, options: CompareOptions): SyncState {
  if (copiesMatch(local, remote, options)) {
    return 'refresh-record';
  }
  const difference = timeDifference(local, remote);
  if (difference === undefined || Math.abs(difference) <= options.toleranceMs) {
    // Equal times with different contents, or times unknown: only a person can tell.
    return 'first-sync-conflict';
  }
  return difference > 0 ? 'first-sync-local-newer' : 'first-sync-remote-newer';
}

function withRecord(local: Observation | undefined, remote: Observation | undefined, record: SyncRecord, options: CompareOptions): SyncState {
  if (local === undefined) {
    if (remote === undefined) {
      return 'drop-record';
    }
    return hasChanged(remote, record.remote, options) ? 'deleted-locally-changed-remotely' : 'local-deleted';
  }
  const localChanged = hasChanged(local, record.local, options);
  if (remote === undefined) {
    return localChanged ? 'changed-locally-deleted-remotely' : 'remote-deleted';
  }
  const remoteChanged = hasChanged(remote, record.remote, options);
  if (localChanged && remoteChanged) {
    return copiesMatch(local, remote, options) ? 'refresh-record' : 'both-changed';
  }
  if (localChanged) {
    return 'local-changed';
  }
  return remoteChanged ? 'remote-changed' : 'in-sync';
}

/**
 * The state of one path from what each side reports now and its record
 * (section 7.3). Each side is compared only with its own record, so the two
 * clocks never have to agree; only a first sync compares across them.
 * Returns `undefined` when neither side nor a record has the path.
 */
export function classify(
  local: Observation | undefined,
  remote: Observation | undefined,
  record: SyncRecord | undefined,
  options: CompareOptions,
): SyncState | undefined {
  if (record !== undefined) {
    return withRecord(local, remote, record, options);
  }
  if (local !== undefined && remote !== undefined) {
    return firstSync(local, remote, options);
  }
  if (local !== undefined) {
    return 'local-only';
  }
  return remote === undefined ? undefined : 'remote-only';
}
