// A site with one server of a given kind, backed by a sandbox, for the
// scenario suite: a temp master list, a local folder, and a session opener.
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defaultPaths } from '../../src/config/paths.ts';
import { SiteRegistry, type NewServer } from '../../src/config/registry.ts';
import type { Site, SiteInput } from '../../src/config/schema.ts';
import { sealSecret } from '../../src/credentials/binding.ts';
import { MemoryCredentialStore } from '../../src/credentials/memory.ts';
import type { HostAdapter, HostKeyDecision, HostKeyInfo } from '../../src/host.ts';
import { createLogger, memorySink, type LogRecord } from '../../src/log/logger.ts';
import { SyncSession } from '../../src/sync/session.ts';
import { makeFolder } from '../helpers/cli.ts';
import type { FtpFaults } from './ftp-server.ts';
import { startRig, type Kind, type Rig } from './rig.ts';
import type { SftpFaults, SftpSandbox } from './sftp-server.ts';

export interface SiteRigOptions {
  readonly faults?: FtpFaults & SftpFaults;
  /** Changes to the site before it is added. */
  readonly site?: Partial<Pick<SiteInput, 'cloaking' | 'sync' | 'local'>>;
  /** Leave the SFTP host key unpinned. */
  readonly unpinned?: boolean;
}

export interface SessionOptions {
  readonly interactive?: boolean;
  readonly confirmHostKey?: (info: HostKeyInfo) => Promise<HostKeyDecision>;
  readonly expectedHostKey?: string;
}

export interface SiteRig {
  readonly kind: Kind;
  readonly rig: Rig;
  readonly registry: SiteRegistry;
  readonly site: Site;
  readonly home: string;
  readonly localDir: string;
  readonly remoteDir: string;
  readonly records: LogRecord[];
  open(options?: SessionOptions): Promise<SyncSession>;
  write(side: 'local' | 'remote', relative: string, content: string, mtimeMs?: number): void;
  read(side: 'local' | 'remote', relative: string): string | undefined;
  remove(side: 'local' | 'remote', relative: string): void;
  close(): Promise<void>;
}

export const BASE_TIME = Date.UTC(2026, 9, 1, 12, 0, 0);

export async function startSiteRig(kind: Kind, options: SiteRigOptions = {}): Promise<SiteRig> {
  const rig = await startRig(kind, options.faults === undefined ? {} : { faults: options.faults });
  const home = makeFolder(rig.siteDir, '..', '..', 'home');
  const localDir = makeFolder(rig.siteDir, '..', '..', 'local');
  const registry = await SiteRegistry.open({ paths: defaultPaths({}, { platform: process.platform, env: { SYNC_SERVERS_HOME: home }, homedir: home, cwd: home }) });
  const sandbox = rig.sandbox;
  let server: NewServer;
  if (kind === 'local') {
    server = { name: 'Folder', protocol: 'local', remoteRoot: rig.siteDir };
  } else if (kind === 'sftp') {
    const sftp = sandbox as SftpSandbox;
    server = {
      name: 'Production',
      protocol: 'sftp',
      host: sftp.host,
      port: sftp.port,
      username: rig.user,
      auth: { method: 'password', savePassword: true },
      remoteRoot: '/site',
      options: options.unpinned === true ? {} : { hostKey: { algorithm: 'ssh-ed25519', sha256: sftp.hostKeySha256, pinnedAt: '2026-10-01T12:00:00Z' } },
    };
  } else {
    server = {
      name: 'Production',
      protocol: kind,
      host: sandbox?.host ?? '',
      port: sandbox?.port ?? 0,
      username: rig.user,
      auth: { method: 'password', savePassword: true },
      remoteRoot: '/site',
      options: { tls: { caFile: rig.caFile, servername: 'localhost' }, ...(kind === 'ftp' ? { allowInsecure: true } : {}) },
    };
  }
  const added = await registry.add({ name: 'My Site', localRoot: localDir, servers: [server], ...options.site });
  const sink = memorySink();
  const sidePath = (side: 'local' | 'remote', relative: string): string => path.join(side === 'local' ? localDir : rig.siteDir, ...relative.split('/'));

  return {
    kind,
    rig,
    registry,
    site: added,
    home,
    localDir,
    remoteDir: rig.siteDir,
    records: sink.records,
    open: async (sessionOptions = {}) => {
      const credentials = new MemoryCredentialStore();
      const site = registry.get(added.id) ?? added;
      const server = site.servers[0];
      const serverId = server?.id ?? '';
      await credentials.set({ siteId: site.id, serverId, kind: 'password' }, server === undefined ? rig.password : sealSecret(rig.password, server));
      const logger = createLogger({ level: 'debug', sinks: [sink] });
      const host: HostAdapter = {
        credentials,
        interactive: sessionOptions.interactive ?? false,
        logger,
        confirmHostKey: sessionOptions.confirmHostKey ?? (() => Promise.resolve('reject')),
        promptSecret: () => Promise.resolve(undefined),
      };
      return SyncSession.open({ registry, siteId: site.id, host, logger, retryDelaysMs: [10, 10, 10], expectedHostKey: sessionOptions.expectedHostKey });
    },
    write: (side, relative, content, mtimeMs = BASE_TIME) => {
      const file = sidePath(side, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
      utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
    },
    read: (side, relative) => {
      const file = sidePath(side, relative);
      return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    },
    remove: (side, relative) => {
      rmSync(sidePath(side, relative), { recursive: true, force: true });
    },
    close: () => rig.close(),
  };
}
