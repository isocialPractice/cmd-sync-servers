import { lstat, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { findServer, type SiteRegistry } from '../config/registry.ts';
import type { Server, Site } from '../config/schema.ts';
import { SyncError } from '../errors.ts';
import type { CertificateDecision, CertificateInfo, HostAdapter, HostKeyDecision, HostKeyInfo } from '../host.ts';
import { silentLogger, type Logger } from '../log/logger.ts';
import { transportFactory } from '../transport/index.ts';
import { TransportPool } from '../transport/pool.ts';
import type { RetryOptions } from '../transport/retry.ts';
import type { Capabilities } from '../transport/types.ts';
import type { SyncState } from './classify.ts';
import { siteCloak, type Cloak } from './cloak.ts';
import { executePlan, type ExecuteOptions, type SyncResult } from './execute.ts';
import { siteGuard } from './guard.ts';
import { cappedFile } from './part.ts';
import { baseName, isCaseSensitive, joinRemote, resolveLocalTarget, ROOT, toRemotePath, type RemotePath } from './paths.ts';
import { SyncPlan } from './plan.ts';
import { Recovery } from './recovery.ts';
import { HashCache, scanLocal, underCloak, type ScanResult } from './scan-local.ts';
import { scanRemote } from './scan-remote.ts';
import { SyncRecords, type SyncRecord } from './state.ts';
import type { Direction, ProgressEvent, ScanProblem, Scope } from './types.ts';

/** Options of {@link SyncSession.open}. */
export interface SyncSessionOptions {
  /** The master list the site is read from, and where a pinned host key is saved. */
  readonly registry: SiteRegistry;
  /** The site to synchronize. */
  readonly siteId: string;
  /** The server to use; the site's Remote server when absent. */
  readonly serverId?: string | undefined;
  /** Credentials, host key confirmation and prompts, from the program in charge. */
  readonly host: HostAdapter;
  /** Where the session logs. Default: the host's logger. */
  readonly logger?: Logger | undefined;
  /** Where `SYNC_SERVERS_PASSWORD` and `SSH_AUTH_SOCK` are read. Default: the process environment. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  /** A host key fingerprint to accept when none is pinned (`--host-key`). */
  readonly expectedHostKey?: string | undefined;
  /** A certificate fingerprint to accept when the certificate does not verify (`--trust-certificate`). */
  readonly expectedCertificate?: string | undefined;
  /** Waits before retries after transient failures. Default 1, 2 and 4 seconds. */
  readonly retryDelaysMs?: readonly number[] | undefined;
}

/** Options of {@link SyncSession.plan}. */
export interface PlanOptions {
  /** Put newer local files, get newer remote files, or both. */
  readonly direction: Direction;
  /** The whole site, or some paths of it. Default: the whole site. */
  readonly scope?: Scope | undefined;
  /** The delete option of the sync dialog. */
  readonly deleteOrphans?: boolean | undefined;
  /** Stops the scan; the call then rejects with `E_CANCELLED`. */
  readonly signal?: AbortSignal | undefined;
  /** Receives `scan-local`, `scan-remote` and `compare` events. */
  readonly onProgress?: ((event: ProgressEvent) => void) | undefined;
}

/** One changed path of a {@link StatusReport}. */
export interface StatusEntry {
  /** The site-relative path. */
  readonly path: string;
  /** How it changed. */
  readonly state: SyncState;
}

/** What changed on each side since the last sync. */
export interface StatusReport {
  readonly lastSyncedAt: number | undefined;
  readonly local: readonly StatusEntry[];
  readonly remote: readonly StatusEntry[];
  readonly conflicts: readonly StatusEntry[];
  readonly problems: readonly ScanProblem[];
  readonly inSync: number;
}

/** The outcome of a single-file Put or Get: run at once, or a plan that needs a preview first. */
export interface SingleTransfer {
  readonly plan: SyncPlan;
  /** `undefined` when the plan needs a preview: a decision, a guarded file or a problem. */
  readonly result: SyncResult | undefined;
}

/** One copy of a compared file. */
export interface ComparedSide {
  /** A file to read: the local file itself, or a private temp copy of the remote one. */
  readonly file: string;
  /** Its size in bytes. */
  readonly size: number;
  /** Its modification time in milliseconds, when known. */
  readonly mtimeMs: number | undefined;
}

/** Both copies of a file for a diff; the remote one is a private temp copy removed by `dispose`. */
export interface Comparison {
  /** The site-relative path compared. */
  readonly path: RemotePath;
  /** The local copy, or `undefined` when there is none. */
  readonly local: ComparedSide | undefined;
  /** The remote copy, or `undefined` when there is none. */
  readonly remote: ComparedSide | undefined;
  /** Removes the temp copy. Call it when done reading. */
  dispose(): Promise<void>;
}

/**
 * True when a server's root directory is the top of the server: `/`, a drive
 * as a Windows server shows it (`/C:` or `/C:/`), or the root of a local or
 * network drive. Deletes there are refused unless the server allows them.
 */
export function remoteRootIsTop(server: Pick<Server, 'protocol' | 'remoteRoot'>): boolean {
  if (server.protocol === 'local') {
    const resolved = path.resolve(server.remoteRoot);
    return path.parse(resolved).root === resolved;
  }
  return /^\/(?:[A-Za-z]:\/?)?$/.test(joinRemote(server.remoteRoot, ROOT));
}

const LOCAL_STATES: ReadonlySet<SyncState> = new Set(['local-changed', 'local-only', 'local-deleted', 'first-sync-local-newer']);
const REMOTE_STATES: ReadonlySet<SyncState> = new Set(['remote-changed', 'remote-only', 'remote-deleted', 'first-sync-remote-newer']);

function inside(target: string, scopes: readonly RemotePath[]): boolean {
  return scopes.some((scope) => scope === ROOT || target === scope || target.startsWith(`${scope}/`));
}

/**
 * One site and one of its servers, ready to plan and run synchronizations.
 * Connections open on first use and close with {@link close}.
 */
export class SyncSession {
  /** The site, as it was when the session opened. */
  readonly site: Site;
  /** The server in use. */
  readonly server: Server;
  readonly #registry: SiteRegistry;
  readonly #host: HostAdapter;
  readonly #logger: Logger;
  readonly #records: SyncRecords;
  readonly #retry: RetryOptions;
  readonly #options: SyncSessionOptions;
  #pool: TransportPool | undefined;
  #caseSensitive: boolean | undefined;
  readonly #acceptedOnce = new Set<string>();

  private constructor(options: SyncSessionOptions, site: Site, server: Server, records: SyncRecords) {
    this.site = site;
    this.server = server;
    this.#registry = options.registry;
    this.#host = options.host;
    this.#logger = options.logger ?? options.host.logger ?? silentLogger;
    this.#records = records;
    this.#retry = options.retryDelaysMs === undefined ? {} : { delaysMs: options.retryDelaysMs };
    this.#options = options;
  }

  /**
   * Opens a session for a site and a server, the Remote server by default,
   * and loads its sync records. Nothing connects until the first call that
   * needs the server.
   *
   * @throws {@link SyncError} `E_SITE_NOT_FOUND` or `E_SERVER_NOT_FOUND`.
   */
  static async open(options: SyncSessionOptions): Promise<SyncSession> {
    const site = options.registry.get(options.siteId);
    if (site === undefined) {
      throw new SyncError('E_SITE_NOT_FOUND', `No site has the id ${options.siteId}.`);
    }
    const server =
      options.serverId === undefined ? site.servers.find((candidate) => candidate.id === site.remoteServerId) : findServer(site, options.serverId);
    if (server === undefined) {
      throw new SyncError(
        'E_SERVER_NOT_FOUND',
        options.serverId === undefined ? `Site "${site.name}" has no Remote server.` : `Site "${site.name}" has no server ${JSON.stringify(options.serverId)}.`,
      );
    }
    const records = await SyncRecords.load(options.registry.paths.stateDir, site.id, server.id, site.sync.maintainInfo);
    return new SyncSession(options, site, server, records);
  }

  /** The records of this site and server, for inspection. */
  record(target: string): SyncRecord | undefined {
    return this.#records.get(target);
  }

  #hostAdapter(): HostAdapter {
    const host = this.#host;
    const confirmCertificate = host.confirmCertificate?.bind(host);
    return {
      ...host,
      // A key accepted once is not asked about again by later connections of this session.
      confirmHostKey: async (info: HostKeyInfo): Promise<HostKeyDecision> => {
        if (this.#acceptedOnce.has(info.sha256)) {
          return 'accept-once';
        }
        const decision = await host.confirmHostKey(info);
        if (decision === 'accept-once') {
          this.#acceptedOnce.add(info.sha256);
        }
        return decision;
      },
      ...(confirmCertificate === undefined
        ? {}
        : {
            // So is a certificate.
            confirmCertificate: async (info: CertificateInfo): Promise<CertificateDecision> => {
              if (this.#acceptedOnce.has(info.sha256)) {
                return { action: 'accept-once' };
              }
              const decision = await confirmCertificate(info);
              if (decision.action === 'accept-once') {
                this.#acceptedOnce.add(info.sha256);
              }
              return decision;
            },
          }),
    };
  }

  #getPool(): TransportPool {
    if (this.#pool === undefined) {
      const { site, server } = this;
      const factory = transportFactory({
        site,
        server,
        host: this.#hostAdapter(),
        logger: this.#logger,
        expectedHostKey: this.#options.expectedHostKey,
        expectedCertificate: this.#options.expectedCertificate,
        ...(this.#options.env === undefined ? {} : { env: this.#options.env }),
        // Later connections of this session see a change at once: the factory applies it to `server`.
        updateServer: async (change) => {
          await this.#registry.updateServer(site.id, server.id, change);
        },
      });
      this.#pool = new TransportPool(factory, {
        size: site.sync.concurrency,
        shared: server.protocol === 'sftp' || server.protocol === 'local',
        logger: this.#logger,
      });
    }
    return this.#pool;
  }

  /** Connects, signs in and checks the remote root. */
  async testConnection(signal?: AbortSignal): Promise<Capabilities & { readonly rootEntries: number }> {
    const pool = this.#getPool();
    const capabilities = await pool.capabilities(signal);
    const entries = await pool.run((transport) => transport.list(ROOT), signal);
    return { ...capabilities, rootEntries: entries.length };
  }

  #remoteRootIsTop(): boolean {
    return remoteRootIsTop(this.server);
  }

  #scopes(scope: Scope): RemotePath[] {
    if (scope.kind === 'site') {
      return [ROOT];
    }
    const paths = scope.paths.map((item) => toRemotePath(item.replace(/^\/+|\/+$/g, '')));
    return paths.includes(ROOT) ? [ROOT] : [...new Set(paths)];
  }

  async #caseInsensitive(root: string): Promise<boolean> {
    if (this.site.local.caseSensitive !== undefined) {
      return !this.site.local.caseSensitive;
    }
    this.#caseSensitive ??= await isCaseSensitive(root);
    return !this.#caseSensitive;
  }

  async #localRoot(): Promise<string> {
    const root = this.site.localRoot;
    const info = await stat(root).catch(() => undefined);
    if (info?.isDirectory() !== true) {
      throw new SyncError('E_EMPTY_ROOT', `The local root ${root} of "${this.site.name}" does not exist.`);
    }
    return root;
  }

  async #scan(scope: Scope, signal: AbortSignal | undefined, onProgress: PlanOptions['onProgress']): Promise<{
    local: ScanResult;
    remote: ScanResult;
    records: Map<string, SyncRecord>;
    cloak: Cloak;
    localRoot: string;
  }> {
    const { site } = this;
    const localRoot = await this.#localRoot();
    const scopes = this.#scopes(scope);
    const cloak = siteCloak(site, process.platform, this.#registry.globalCloaking.patterns);
    const checksum = site.sync.compare === 'checksum';
    const cache = checksum ? await HashCache.open(site.local.cache ? path.join(this.#registry.paths.stateDir, 'sites', site.id, 'hashes.json') : undefined) : undefined;
    const local = await scanLocal({
      root: localRoot,
      cloak,
      symlinks: site.sync.symlinks,
      checksum,
      scopes,
      cache,
      signal,
      onProgress: (files) => onProgress?.({ type: 'scan-local', files }),
    });
    await cache?.save();
    const remote = await scanRemote({
      pool: this.#getPool(),
      cloak,
      scopes,
      concurrency: site.sync.concurrency,
      retry: this.#retry,
      signal,
      onProgress: (files, folders) => onProgress?.({ type: 'scan-remote', files, folders }),
    });
    if (signal?.aborted === true) {
      throw new SyncError('E_CANCELLED', 'Cancelled.');
    }
    const records = new Map<string, SyncRecord>();
    for (const target of this.#records.paths()) {
      const record = this.#records.get(target);
      if (record !== undefined && inside(target, scopes) && !underCloak(cloak, target as RemotePath, false)) {
        records.set(target, record);
      }
    }
    return { local, remote, records, cloak, localRoot };
  }

  async #buildPlan(options: PlanOptions, explicit: boolean): Promise<SyncPlan> {
    const scope = options.scope ?? { kind: 'site' };
    const { local, remote, records, localRoot } = await this.#scan(scope, options.signal, options.onProgress);
    const plan = new SyncPlan({
      siteId: this.site.id,
      serverId: this.server.id,
      direction: options.direction,
      deleteOrphans: options.deleteOrphans === true,
      scope,
      local,
      remote,
      records,
      compare: { toleranceMs: this.site.sync.mtimeToleranceSeconds * 1000, checksum: this.site.sync.compare === 'checksum' },
      guard: siteGuard(this.site),
      caseInsensitive: await this.#caseInsensitive(localRoot),
      explicit,
    });
    options.onProgress?.({ type: 'compare', files: plan.items.length + plan.unlisted });
    return plan;
  }

  /** Scans both sides and returns what a synchronization would do. Transfers nothing. */
  plan(options: PlanOptions): Promise<SyncPlan> {
    return this.#buildPlan(options, false);
  }

  /** Runs the checked rows of `plan`. */
  async execute(plan: SyncPlan, options: ExecuteOptions = {}): Promise<SyncResult> {
    if (plan.siteId !== this.site.id || plan.serverId !== this.server.id) {
      throw new SyncError('E_PLAN_INVALID', 'The plan belongs to another site or server.');
    }
    const pool = this.#getPool();
    return executePlan(
      plan,
      {
        site: this.site,
        server: this.server,
        localRoot: await this.#localRoot(),
        pool,
        capabilities: () => pool.capabilities(options.signal),
        records: this.#records,
        recovery: new Recovery(this.#registry.paths.stateDir, this.site.id, this.site.sync.recovery),
        logger: this.#logger,
        retry: this.#retry,
        remoteRootIsTop: this.#remoteRootIsTop(),
        symlinks: this.site.sync.symlinks,
      },
      options,
    );
  }

  /** What changed on each side since the last sync, without planning a transfer. */
  async status(options: Omit<PlanOptions, 'direction' | 'deleteOrphans'> = {}): Promise<StatusReport> {
    const plan = await this.plan({ ...options, direction: 'both', deleteOrphans: false });
    const local: StatusEntry[] = [];
    const remote: StatusEntry[] = [];
    const conflicts: StatusEntry[] = [];
    const problems: ScanProblem[] = [];
    for (const item of plan.items) {
      if (item.state === 'problem') {
        problems.push({ path: item.path, side: 'local', kind: item.problem ?? 'other', status: item.status });
      } else if (LOCAL_STATES.has(item.state)) {
        local.push({ path: item.path, state: item.state });
      } else if (REMOTE_STATES.has(item.state)) {
        remote.push({ path: item.path, state: item.state });
      } else {
        conflicts.push({ path: item.path, state: item.state });
      }
    }
    return { lastSyncedAt: this.#records.lastSyncedAt(), local, remote, conflicts, problems, inSync: plan.unlisted };
  }

  async #single(direction: 'put' | 'get', paths: readonly string[], options: ExecuteOptions & Pick<PlanOptions, 'onProgress'>): Promise<SingleTransfer> {
    const plan = await this.#buildPlan({ direction, scope: { kind: 'paths', paths }, signal: options.signal, onProgress: options.onProgress }, true);
    const needsPreview = plan.items.some(
      (item) => item.state === 'problem' || item.action === 'resolve' || item.guarded !== undefined || item.action.startsWith('delete'),
    );
    if (needsPreview) {
      return { plan, result: undefined };
    }
    return { plan, result: await this.execute(plan, options) };
  }

  /** Dreamweaver's Put: uploads these paths through the same plan and guards, with a preview only when one is needed. */
  put(paths: readonly string[], options: ExecuteOptions = {}): Promise<SingleTransfer> {
    return this.#single('put', paths, options);
  }

  /** Dreamweaver's Get: downloads these paths through the same plan and guards, with a preview only when one is needed. */
  get(paths: readonly string[], options: ExecuteOptions = {}): Promise<SingleTransfer> {
    return this.#single('get', paths, options);
  }

  /** Fetches the remote copy of a file to a private temp folder for a diff. Call `dispose` when done. */
  async compare(target: string, signal?: AbortSignal): Promise<Comparison> {
    const remotePath = toRemotePath(target);
    const localRoot = await this.#localRoot();
    const localFile = (await resolveLocalTarget(localRoot, remotePath, this.site.sync.symlinks)).file;
    const localInfo = await lstat(localFile).catch(() => undefined);
    const pool = this.#getPool();
    const remoteEntry = await pool.runWithRetry((transport) => transport.stat(remotePath), { ...this.#retry, signal });
    const dir = await mkdtemp(path.join(tmpdir(), 'sync-servers-compare-'));
    const dispose = (): Promise<void> => rm(dir, { recursive: true, force: true });
    try {
      let remote: ComparedSide | undefined;
      if (remoteEntry?.type === 'file') {
        // Named after the site path, which a diff shows, not after the file a link reaches.
        const file = path.join(dir, baseName(remotePath));
        const size = remoteEntry.size;
        await pool.runWithRetry((transport) => transport.get(remotePath, cappedFile(file, { flags: 'w', maxBytes: size, what: `Comparing ${remotePath}` }), signal), { ...this.#retry, signal });
        remote = { file, size: remoteEntry.size, mtimeMs: remoteEntry.mtimeMs };
      }
      return {
        path: remotePath,
        local: localInfo?.isFile() === true ? { file: localFile, size: localInfo.size, mtimeMs: localInfo.mtimeMs } : undefined,
        remote,
        dispose,
      };
    } catch (error) {
      await dispose();
      throw error;
    }
  }

  /** Records files as in sync without transferring them; folders mark every file in them that both sides have. */
  async markSynchronized(paths: readonly string[], signal?: AbortSignal): Promise<number> {
    const { local, remote } = await this.#scan({ kind: 'paths', paths }, signal, undefined);
    let marked = 0;
    for (const [target, localObservation] of local.files) {
      const remoteObservation = remote.files.get(target);
      if (remoteObservation !== undefined) {
        this.#records.set(target, { local: localObservation, remote: remoteObservation, syncedAt: Date.now() });
        marked += 1;
      }
    }
    await this.#records.save();
    return marked;
  }

  /** Forgets every sync record of this site and server; the next sync is a first sync. */
  async resetState(): Promise<void> {
    await this.#records.reset();
    await rm(path.join(this.#registry.paths.stateDir, 'sites', this.site.id, 'hashes.json'), { force: true });
  }

  /** Saves the sync records and closes every connection. Safe to call more than once. */
  async close(): Promise<void> {
    await this.#records.save();
    await this.#pool?.close();
    this.#pool = undefined;
  }
}
