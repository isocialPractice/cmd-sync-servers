import { copyFile, mkdir, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { hasErrorCode } from '../config/files.ts';
import type { RemotePath } from './paths.ts';

export interface RecoverySettings {
  readonly enabled: boolean;
  readonly keepDays: number;
  readonly maxMegabytes: number;
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '-').slice(0, 19);
}

async function sizeOf(target: string): Promise<number> {
  const info = await stat(target);
  if (!info.isDirectory()) {
    return info.size;
  }
  let total = 0;
  for (const name of await readdir(target)) {
    total += await sizeOf(path.join(target, name));
  }
  return total;
}

/**
 * Keeps local files that a run deletes or overwrites, in
 * `<state>/recovery/<siteId>/<run>/<path>`, so a mistake can be undone.
 * Old runs are removed after `keepDays`, and the oldest first while the
 * folder holds more than `maxMegabytes`.
 */
export class Recovery {
  readonly siteDir: string;
  readonly runDir: string;
  readonly #settings: RecoverySettings;

  constructor(stateDir: string, siteId: string, settings: RecoverySettings, now: Date = new Date()) {
    this.siteDir = path.join(stateDir, 'recovery', siteId);
    this.runDir = path.join(this.siteDir, stamp(now));
    this.#settings = settings;
  }

  get enabled(): boolean {
    return this.#settings.enabled;
  }

  /**
   * Moves `file` out of the site into this run's folder and returns where it
   * went, or deletes it when recovery is off and returns `undefined`.
   */
  async keep(file: string, target: RemotePath): Promise<string | undefined> {
    if (!this.#settings.enabled) {
      await unlink(file);
      return undefined;
    }
    const destination = path.join(this.runDir, ...target.split('/'));
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    try {
      await rename(file, destination);
    } catch (error) {
      if (!hasErrorCode(error, 'EXDEV')) {
        throw error;
      }
      await copyFile(file, destination);
      await unlink(file);
    }
    return destination;
  }

  /**
   * Removes the symbolic link `link`, never what it points to, and returns
   * where a copy of what it points to was kept in this run's folder, or
   * `undefined` when recovery is off. The copy holds the content, not the
   * link, so it still opens after the link is gone.
   */
  async keepLink(link: string, target: RemotePath): Promise<string | undefined> {
    if (!this.#settings.enabled) {
      await unlink(link);
      return undefined;
    }
    const destination = path.join(this.runDir, ...target.split('/'));
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(link, destination);
    await unlink(link);
    return destination;
  }

  /** Puts a kept file back, when a step after keeping it failed. */
  async restore(kept: string, file: string): Promise<void> {
    try {
      await rename(kept, file);
    } catch (error) {
      if (!hasErrorCode(error, 'EXDEV')) {
        throw error;
      }
      await copyFile(kept, file);
      await unlink(kept);
    }
  }

  /**
   * Removes runs older than `keepDays`, then the oldest runs while the total
   * is over `maxMegabytes`. The files of this run are never removed, however
   * old or large: they are what a mistake in this run would need. Resolves
   * `true` when this run alone holds more than `maxMegabytes`.
   */
  async prune(now: Date = new Date()): Promise<boolean> {
    let runs: string[];
    try {
      runs = (await readdir(this.siteDir)).sort();
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return false;
      }
      throw error;
    }
    const current = path.basename(this.runDir);
    const cutoff = stamp(new Date(now.getTime() - this.#settings.keepDays * 86_400_000));
    const kept: { name: string; size: number }[] = [];
    let currentSize = 0;
    for (const name of runs) {
      const full = path.join(this.siteDir, name);
      if (name === current) {
        currentSize = await sizeOf(full);
      } else if (name < cutoff) {
        await rm(full, { recursive: true, force: true });
      } else {
        kept.push({ name, size: await sizeOf(full) });
      }
    }
    let total = kept.reduce((sum, run) => sum + run.size, currentSize);
    const limit = this.#settings.maxMegabytes * 1024 * 1024;
    for (const run of kept) {
      if (total <= limit) {
        break;
      }
      await rm(path.join(this.siteDir, run.name), { recursive: true, force: true });
      total -= run.size;
    }
    return currentSize > limit;
  }
}
