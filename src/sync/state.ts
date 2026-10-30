import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod';
import { hasErrorCode, writeFileAtomic } from '../config/files.ts';
import { withFileLock } from '../config/lock.ts';
import { ensurePrivateDir } from '../config/paths.ts';
import { formatIssues } from '../config/schema.ts';
import { SyncError } from '../errors.ts';
import type { Observation } from './types.ts';

/** Both sides as they were at the last synchronization of one file. */
export interface SyncRecord {
  readonly local: Observation;
  readonly remote: Observation;
  readonly syncedAt: number;
}

const observationSchema = z.strictObject({
  size: z.number().int().min(0),
  mtimeMs: z.number().optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

const recordsFileSchema = z.strictObject({
  schemaVersion: z.literal(1),
  records: z.record(z.string(), z.strictObject({ local: observationSchema, remote: observationSchema, syncedAt: z.number() })),
});

const CHECKPOINT_ITEMS = 50;
const CHECKPOINT_MS = 5000;

/** Where the records of one site and server live: `<state>/sites/<siteId>/<serverId>.json`. */
export function recordsFile(stateDir: string, siteId: string, serverId: string): string {
  return path.join(stateDir, 'sites', siteId, `${serverId}.json`);
}

/**
 * The sync records of one site and server, which let the engine tell a file
 * changed on one side from one changed on both. Kept per machine in the state
 * folder, written atomically, and checkpointed during a run so an
 * interrupted sync keeps what it finished. Disabled records (`maintainInfo`
 * off) hold nothing and are never written.
 */
export class SyncRecords {
  readonly file: string;
  readonly enabled: boolean;
  readonly #records = new Map<string, SyncRecord>();
  #changes = 0;
  #savedAt = Date.now();

  private constructor(file: string, enabled: boolean) {
    this.file = file;
    this.enabled = enabled;
  }

  static async load(stateDir: string, siteId: string, serverId: string, enabled: boolean): Promise<SyncRecords> {
    const records = new SyncRecords(recordsFile(stateDir, siteId, serverId), enabled);
    if (!enabled) {
      return records;
    }
    let text: string;
    try {
      text = await readFile(records.file, 'utf8');
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return records;
      }
      throw error;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new SyncError('E_CONFIG_INVALID', `${records.file} is not valid JSON. Remove it with "sync-servers state reset".`);
    }
    const parsed = recordsFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new SyncError(
        'E_CONFIG_INVALID',
        [`${records.file} is not valid. Remove it with "sync-servers state reset".`, ...formatIssues(parsed.error.issues).map((line) => `  ${line}`)].join('\n'),
      );
    }
    for (const [key, value] of Object.entries(parsed.data.records)) {
      records.#records.set(key, value);
    }
    return records;
  }

  get size(): number {
    return this.#records.size;
  }

  get(target: string): SyncRecord | undefined {
    return this.#records.get(target);
  }

  paths(): string[] {
    return [...this.#records.keys()];
  }

  /** The most recent sync time of any file, or `undefined`. */
  lastSyncedAt(): number | undefined {
    let latest: number | undefined;
    for (const record of this.#records.values()) {
      latest = latest === undefined ? record.syncedAt : Math.max(latest, record.syncedAt);
    }
    return latest;
  }

  set(target: string, record: SyncRecord): void {
    if (!this.enabled) {
      return;
    }
    this.#records.set(target, record);
    this.#changes += 1;
  }

  delete(target: string): void {
    if (this.#records.delete(target)) {
      this.#changes += 1;
    }
  }

  /** Saves when 50 changes or 5 seconds have gone by since the last save. */
  async checkpoint(): Promise<void> {
    if (this.#changes >= CHECKPOINT_ITEMS || (this.#changes > 0 && Date.now() - this.#savedAt >= CHECKPOINT_MS)) {
      await this.save();
    }
  }

  async save(): Promise<void> {
    if (!this.enabled || this.#changes === 0) {
      return;
    }
    this.#changes = 0;
    this.#savedAt = Date.now();
    await ensurePrivateDir(path.dirname(this.file));
    const sorted = Object.fromEntries([...this.#records.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    const text = `${JSON.stringify({ schemaVersion: 1, records: sorted })}\n`;
    await withFileLock(`${this.file}.lock`, () => writeFileAtomic(this.file, text));
  }

  /** Forgets every record and removes the file. */
  async reset(): Promise<void> {
    this.#records.clear();
    this.#changes = 0;
    await rm(this.file, { force: true });
  }
}
