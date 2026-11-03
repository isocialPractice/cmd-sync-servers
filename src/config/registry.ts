import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { SyncError } from '../errors.ts';
import { silentLogger, type Logger } from '../log/logger.ts';
import { isInside } from '../sync/paths.ts';
import { hasErrorCode, writeFileAtomic } from './files.ts';
import { withFileLock } from './lock.ts';
import { migrateSitesFile } from './migrate.ts';
import { defaultPaths, ensurePrivateDir, type PathsOptions, type SyncServersPaths } from './paths.ts';
import {
  describeSitesFileIssues,
  formatIssues,
  SCHEMA_VERSION,
  serverSchema,
  SITES_SCHEMA_URL,
  sitesFileSchema,
  type GlobalCloaking,
  type Server,
  type ServerInput,
  type Site,
  type SiteInput,
  type SitesFile,
} from './schema.ts';

/** Options of {@link SiteRegistry.open}. */
export interface SiteRegistryOptions extends PathsOptions {
  /** Use these folders instead of the defaults for this user and platform. */
  readonly paths?: SyncServersPaths;
  /** Where additions, changes and removals are recorded. */
  readonly logger?: Logger;
  /** How long a write waits for another process's lock. Default 5 seconds. */
  readonly lockTimeoutMs?: number;
}

/** A site to add. `id` is generated when absent; `localRoot` is made absolute. */
export type NewSite = Omit<SiteInput, 'id' | 'servers'> & { readonly id?: string; readonly servers?: readonly NewServer[] };

/** A server to add. `id` is generated when absent. */
export type NewServer = Omit<ServerInput, 'id'> & { readonly id?: string };

/** How to find a site: by id, by name (ignoring case), or by a path inside its local root. */
export interface SiteQuery {
  readonly id?: string;
  readonly name?: string;
  /** Matches an id first, then a name. */
  readonly nameOrId?: string;
  readonly path?: string;
}

function emptyFile(): SitesFile {
  return { schemaVersion: SCHEMA_VERSION, sites: [] };
}

function sameName(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
}

function realOrResolved(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

/** The verdict of {@link checkSitesFile}: the file, or the problems found, one per line. */
export type SitesFileCheck =
  | { readonly ok: true; readonly file: SitesFile; readonly migrated: boolean }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Checks the text of `sites.json`, migrating older versions, and names each
 * problem by site, server, field and value. `source` names the file.
 */
export function checkSitesFile(text: string, source: string): SitesFileCheck {
  let raw: unknown;
  try {
    // A byte order mark, as some Windows editors write, is not part of the JSON.
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, problems: [`The file is not valid JSON: ${reason}`] };
  }
  let migrated: { file: unknown; migrated: boolean };
  try {
    migrated = migrateSitesFile(raw, source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, problems: [message.startsWith(`${source}: `) ? message.slice(source.length + 2) : message] };
  }
  const result = sitesFileSchema.safeParse(migrated.file);
  if (!result.success) {
    return { ok: false, problems: describeSitesFileIssues(result.error.issues, migrated.file) };
  }
  return { ok: true, file: result.data, migrated: migrated.migrated };
}

/** Parses the text of `sites.json`, migrating older versions. `source` names the file in errors. */
export function parseSitesFile(text: string, source: string): { file: SitesFile; migrated: boolean } {
  const checked = checkSitesFile(text, source);
  if (!checked.ok) {
    throw new SyncError(
      'E_CONFIG_INVALID',
      [`${source} is not valid:`, ...checked.problems.map((line) => `  ${line}`), 'Fix it with "sync-servers config edit".'].join('\n'),
    );
  }
  return { file: checked.file, migrated: checked.migrated };
}

/**
 * Replaces the whole of `sites.json` with `file`, under the same lock and
 * with the same backup as every other write. For repairing a file that does
 * not load, so it does not read the file first.
 *
 * @throws {@link SyncError} `E_CONFIG_INVALID` when `file` is not valid.
 */
export async function replaceSitesFile(paths: SyncServersPaths, file: SitesFile, options: { readonly lockTimeoutMs?: number } = {}): Promise<void> {
  const checked = sitesFileSchema.safeParse(file);
  if (!checked.success) {
    throw new SyncError('E_CONFIG_INVALID', ['The file is not valid:', ...describeSitesFileIssues(checked.error.issues, file).map((line) => `  ${line}`)].join('\n'));
  }
  await ensurePrivateDir(paths.configDir);
  await withFileLock(
    `${paths.sitesFile}.lock`,
    () => writeFileAtomic(paths.sitesFile, serializeSitesFile(checked.data), { backup: `${paths.sitesFile}.bak` }),
    options.lockTimeoutMs === undefined ? {} : { timeoutMs: options.lockTimeoutMs },
  );
}

/** A site as written: `useGlobalPatterns` only when it is false, since absent means true. */
function writtenSite(site: Site): Site {
  if (site.cloaking.useGlobalPatterns !== true) {
    return site;
  }
  const cloaking = { ...site.cloaking };
  delete cloaking.useGlobalPatterns;
  return { ...site, cloaking };
}

/**
 * The text written to `sites.json`: the schema reference first, then the
 * data. The global cloaking is written only while it holds a pattern, so a
 * file that never uses it reads the same as before it existed.
 */
export function serializeSitesFile(file: SitesFile): string {
  const output: Record<string, unknown> = { $schema: SITES_SCHEMA_URL };
  for (const [key, value] of Object.entries(file)) {
    if (key === '$schema' || (key === 'cloaking' && (file.cloaking?.patterns.length ?? 0) === 0)) {
      continue;
    }
    output[key] = key === 'sites' ? file.sites.map(writtenSite) : value;
  }
  return `${JSON.stringify(output, null, 2)}\n`;
}

/**
 * The master list of sites in `sites.json`, shared by the CLI and the VS Code
 * extension. Every write takes the lock file, re-reads the file so another
 * process's change is never lost, validates the result, keeps the previous
 * version as `sites.json.bak`, and replaces the file atomically. A file that
 * fails validation is never rewritten.
 */
export class SiteRegistry {
  readonly paths: SyncServersPaths;
  readonly #logger: Logger;
  readonly #lockTimeoutMs: number | undefined;
  #file: SitesFile = emptyFile();

  private constructor(paths: SyncServersPaths, logger: Logger, lockTimeoutMs: number | undefined) {
    this.paths = paths;
    this.#logger = logger;
    this.#lockTimeoutMs = lockTimeoutMs;
  }

  /** Reads the master list, creating it on first use. */
  static async open(options: SiteRegistryOptions = {}): Promise<SiteRegistry> {
    const paths = options.paths ?? defaultPaths(options);
    const registry = new SiteRegistry(paths, options.logger ?? silentLogger, options.lockTimeoutMs);
    await ensurePrivateDir(paths.configDir);
    await registry.reload();
    return registry;
  }

  /** Reads `sites.json` again, for example after another process changed it. */
  async reload(): Promise<void> {
    const loaded = await this.#read();
    if (loaded === undefined || loaded.migrated) {
      await this.#mutate(() => undefined);
      return;
    }
    this.#file = loaded.file;
  }

  /** Every site, in the order they were added. */
  list(): Site[] {
    return structuredClone(this.#file.sites);
  }

  /** The site with this id, as a copy that can be changed freely. */
  get(siteId: string): Site | undefined {
    const site = this.#file.sites.find((candidate) => candidate.id === siteId);
    return site === undefined ? undefined : structuredClone(site);
  }

  /** The cloaking patterns every site uses before its own, unless the site turns them off. */
  get globalCloaking(): GlobalCloaking {
    return { patterns: [...(this.#file.cloaking?.patterns ?? [])] };
  }

  /**
   * Changes the global cloaking patterns. Removing the last one removes the
   * global cloaking from the file.
   *
   * @throws {@link SyncError} `E_CONFIG_INVALID` when a pattern is not valid.
   */
  async updateGlobalCloaking(change: (cloaking: GlobalCloaking) => void): Promise<GlobalCloaking> {
    await this.#mutate((file) => {
      const cloaking = { patterns: [...(file.cloaking?.patterns ?? [])] };
      change(cloaking);
      if (cloaking.patterns.length === 0) {
        delete file.cloaking;
      } else {
        file.cloaking = cloaking;
      }
    });
    const updated = this.globalCloaking;
    this.#logger.info('Global cloaking updated', { patterns: updated.patterns.length });
    return updated;
  }

  /** The site last chosen in either front end, when it still exists. */
  get lastSelectedSiteId(): string | undefined {
    const id = this.#file.lastSelectedSiteId;
    return id !== undefined && this.#file.sites.some((site) => site.id === id) ? id : undefined;
  }

  /**
   * Finds a site by id, by name ignoring case, or by a path inside its local
   * root, where the deepest local root wins.
   */
  resolve(query: SiteQuery): Site | undefined {
    const sites = this.#file.sites;
    let found: Site | undefined;
    if (query.id !== undefined) {
      found = sites.find((site) => site.id === query.id);
    } else if (query.name !== undefined) {
      const name = query.name;
      found = sites.find((site) => sameName(site.name, name));
    } else if (query.nameOrId !== undefined) {
      const text = query.nameOrId;
      found = sites.find((site) => site.id === text) ?? sites.find((site) => sameName(site.name, text));
    } else if (query.path !== undefined) {
      const target = realOrResolved(query.path);
      found = sites
        .filter((site) => isInside(realOrResolved(site.localRoot), target))
        .sort((a, b) => realOrResolved(b.localRoot).length - realOrResolved(a.localRoot).length)[0];
    }
    return found === undefined ? undefined : structuredClone(found);
  }

  /**
   * Adds a site and returns it as stored. Its first server becomes the Remote
   * server unless `remoteServerId` says otherwise.
   *
   * @throws {@link SyncError} `E_CONFIG_INVALID` when the site is not valid or its name is taken.
   */
  async add(input: NewSite): Promise<Site> {
    const id = input.id ?? randomUUID();
    const servers = (input.servers ?? []).map((server) => ({ ...server, id: server.id ?? randomUUID() }));
    await this.#mutate((file) => {
      const raw: SiteInput = {
        ...input,
        id,
        servers,
        localRoot: path.resolve(input.localRoot),
        remoteServerId: input.remoteServerId ?? servers[0]?.id,
      };
      file.sites.push(raw as Site);
    });
    this.#logger.info('Site added', { siteId: id });
    return this.#require(id);
  }

  /** Changes a site in place. `change` may edit any field except `id`. */
  async update(siteId: string, change: (site: Site) => void): Promise<Site> {
    await this.#mutate((file) => {
      const site = SiteRegistry.#find(file, siteId);
      change(site);
      site.id = siteId;
      site.localRoot = path.resolve(site.localRoot);
    });
    this.#logger.info('Site updated', { siteId });
    return this.#require(siteId);
  }

  /** Replaces a site with `next`, as edited in an editor. The id cannot change. */
  async replace(siteId: string, next: unknown): Promise<Site> {
    await this.#mutate((file) => {
      const index = file.sites.findIndex((site) => site.id === siteId);
      if (index === -1) {
        throw new SyncError('E_SITE_NOT_FOUND', `No site has the id ${siteId}.`);
      }
      file.sites[index] = { ...(next as Site), id: siteId };
    });
    this.#logger.info('Site replaced', { siteId });
    return this.#require(siteId);
  }

  /**
   * Removes a site from the list and returns it. Its local folder, its
   * servers' files, its saved secrets and its sync records are not touched.
   */
  async remove(siteId: string): Promise<Site> {
    const removed = await this.#mutate((file) => {
      const site = SiteRegistry.#find(file, siteId);
      file.sites = file.sites.filter((candidate) => candidate.id !== siteId);
      if (file.lastSelectedSiteId === siteId) {
        delete file.lastSelectedSiteId;
      }
      return site;
    });
    this.#logger.info('Site removed', { siteId });
    return structuredClone(removed);
  }

  /** Records the site last chosen, so either front end can open on it; `undefined` clears it. */
  async setLastSelected(siteId: string | undefined): Promise<void> {
    await this.#mutate((file) => {
      if (siteId === undefined) {
        delete file.lastSelectedSiteId;
      } else {
        SiteRegistry.#find(file, siteId);
        file.lastSelectedSiteId = siteId;
      }
    });
  }

  /** Adds a server to a site. The first server of a site becomes its Remote server. */
  async addServer(siteId: string, input: NewServer): Promise<Server> {
    const serverId = input.id ?? randomUUID();
    const parsed = serverSchema.safeParse({ ...input, id: serverId });
    if (!parsed.success) {
      throw new SyncError('E_CONFIG_INVALID', ['The server is not valid:', ...formatIssues(parsed.error.issues).map((line) => `  ${line}`)].join('\n'));
    }
    await this.#mutate((file) => {
      const site = SiteRegistry.#find(file, siteId);
      site.servers.push(parsed.data);
      site.remoteServerId ??= serverId;
    });
    this.#logger.info('Server added', { siteId, serverId });
    return this.#requireServer(siteId, serverId);
  }

  /** Changes a server in place. `change` may edit any field except `id`. */
  async updateServer(siteId: string, serverId: string, change: (server: Server) => void): Promise<Server> {
    await this.#mutate((file) => {
      const server = SiteRegistry.#findServer(SiteRegistry.#find(file, siteId), serverId);
      change(server);
      server.id = serverId;
    });
    this.#logger.info('Server updated', { siteId, serverId });
    return this.#requireServer(siteId, serverId);
  }

  /** Replaces a server with `next`, as edited in an editor. The id cannot change. */
  async replaceServer(siteId: string, serverId: string, next: unknown): Promise<Server> {
    await this.#mutate((file) => {
      const site = SiteRegistry.#find(file, siteId);
      SiteRegistry.#findServer(site, serverId);
      site.servers = site.servers.map((server) => (server.id === serverId ? { ...(next as Server), id: serverId } : server));
    });
    this.#logger.info('Server replaced', { siteId, serverId });
    return this.#requireServer(siteId, serverId);
  }

  /** Removes a server and clears any role it held. */
  async removeServer(siteId: string, serverId: string): Promise<Server> {
    const removed = await this.#mutate((file) => {
      const site = SiteRegistry.#find(file, siteId);
      const server = SiteRegistry.#findServer(site, serverId);
      site.servers = site.servers.filter((candidate) => candidate.id !== serverId);
      if (site.remoteServerId === serverId) {
        delete site.remoteServerId;
      }
      if (site.testingServerId === serverId) {
        delete site.testingServerId;
      }
      return server;
    });
    this.#logger.info('Server removed', { siteId, serverId });
    return structuredClone(removed);
  }

  static #find(file: SitesFile, siteId: string): Site {
    const site = file.sites.find((candidate) => candidate.id === siteId);
    if (site === undefined) {
      throw new SyncError('E_SITE_NOT_FOUND', `No site has the id ${siteId}.`);
    }
    return site;
  }

  static #findServer(site: Site, serverId: string): Server {
    const server = site.servers.find((candidate) => candidate.id === serverId);
    if (server === undefined) {
      throw new SyncError('E_SERVER_NOT_FOUND', `Site "${site.name}" has no server with the id ${serverId}.`);
    }
    return server;
  }

  #require(siteId: string): Site {
    const site = this.get(siteId);
    if (site === undefined) {
      throw new SyncError('E_SITE_NOT_FOUND', `No site has the id ${siteId}.`);
    }
    return site;
  }

  #requireServer(siteId: string, serverId: string): Server {
    return structuredClone(SiteRegistry.#findServer(this.#require(siteId), serverId));
  }

  async #read(): Promise<{ file: SitesFile; migrated: boolean } | undefined> {
    let text: string;
    try {
      text = await readFile(this.paths.sitesFile, 'utf8');
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return undefined;
      }
      throw error;
    }
    return parseSitesFile(text, this.paths.sitesFile);
  }

  async #mutate<T>(change: (file: SitesFile) => T): Promise<T> {
    const lockOptions = this.#lockTimeoutMs === undefined ? {} : { timeoutMs: this.#lockTimeoutMs };
    return withFileLock(
      `${this.paths.sitesFile}.lock`,
      async () => {
        const draft = structuredClone((await this.#read())?.file ?? emptyFile());
        const result = change(draft);
        const checked = sitesFileSchema.safeParse(draft);
        if (!checked.success) {
          throw new SyncError(
            'E_CONFIG_INVALID',
            ['The change is not valid:', ...describeSitesFileIssues(checked.error.issues, draft).map((line) => `  ${line}`)].join('\n'),
          );
        }
        await writeFileAtomic(this.paths.sitesFile, serializeSitesFile(checked.data), {
          backup: `${this.paths.sitesFile}.bak`,
        });
        this.#file = checked.data;
        return result;
      },
      lockOptions,
    );
  }
}

/** Finds a server of a site by id, or by name ignoring case. */
export function findServer(site: Site, nameOrId: string): Server | undefined {
  return site.servers.find((server) => server.id === nameOrId) ?? site.servers.find((server) => sameName(server.name, nameOrId));
}
