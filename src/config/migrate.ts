import { SyncError } from '../errors.ts';
import { SCHEMA_VERSION } from './schema.ts';

type RawFile = Record<string, unknown>;

/**
 * Steps that each move a parsed `sites.json` from one `schemaVersion` to the
 * next: the step at key `n` turns version `n` into version `n + 1`. Each step
 * has a test that loads a file of version `n`.
 */
const MIGRATIONS: Readonly<Record<number, (file: RawFile) => RawFile>> = {};

export interface MigrationResult {
  readonly file: RawFile;
  /** The version the file was written in. */
  readonly fromVersion: number;
  /** True when at least one step ran, so the file should be written back. */
  readonly migrated: boolean;
}

/** Brings a parsed `sites.json` up to {@link SCHEMA_VERSION}. `source` names the file in errors. */
export function migrateSitesFile(
  raw: unknown,
  source: string,
  migrations: Readonly<Record<number, (file: RawFile) => RawFile>> = MIGRATIONS,
  targetVersion: number = SCHEMA_VERSION,
): MigrationResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SyncError('E_CONFIG_INVALID', `${source}: (top level): Expected a JSON object.`);
  }
  let file = raw as RawFile;
  const version = file.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new SyncError('E_CONFIG_INVALID', `${source}: schemaVersion: Expected a positive whole number.`);
  }
  if (version > targetVersion) {
    throw new SyncError(
      'E_CONFIG_INVALID',
      `${source}: schemaVersion: Version ${String(version)} was written by a newer sync-servers. Update sync-servers to read it.`,
    );
  }
  for (let current = version; current < targetVersion; current += 1) {
    const step = migrations[current];
    if (step === undefined) {
      throw new SyncError('E_CONFIG_INVALID', `${source}: schemaVersion: No migration from version ${String(current)}.`);
    }
    file = { ...step(file), schemaVersion: current + 1 };
  }
  return { file, fromVersion: version, migrated: version !== targetVersion };
}
