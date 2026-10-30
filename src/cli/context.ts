import { findServer, SiteRegistry } from '../config/registry.ts';
import { defaultPaths, type SyncServersPaths } from '../config/paths.ts';
import type { Server, Site } from '../config/schema.ts';
import type { CredentialStore } from '../credentials/types.ts';
import { SyncError } from '../errors.ts';
import { createLogger, runLogSink, textSink, type Logger, type LogSink } from '../log/logger.ts';
import { UsageError } from './errors.ts';
import type { CliIo } from './io.ts';
import { detectAscii, detectColor, jsonDocument } from './output.ts';
import { Prompter } from './prompt.ts';

/** Options every command accepts. */
export interface GlobalFlags {
  readonly site?: string | undefined;
  readonly server?: string | undefined;
  readonly configDir?: string | undefined;
  readonly stateDir?: string | undefined;
  readonly json: boolean;
  readonly plain: boolean;
  readonly ascii?: boolean | undefined;
  readonly color?: boolean | undefined;
  readonly debug: boolean;
  readonly cdFile?: string | undefined;
}

/** Turns off the OS credential store when set to `off`, `0`, `false` or `no`. */
export const KEYRING_ENV = 'SYNC_SERVERS_KEYRING';

export function keyringDisabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return ['off', '0', 'false', 'no'].includes((env[KEYRING_ENV] ?? '').trim().toLowerCase());
}

/** What a command works with: its I/O, the folders, the master list, prompts and output helpers. */
export class CommandContext {
  readonly io: CliIo;
  readonly flags: GlobalFlags;
  readonly paths: SyncServersPaths;
  readonly logger: Logger;
  readonly ascii: boolean;
  readonly color: boolean;
  /** True when a person can be asked: stdin is a terminal. Nothing ever prompts otherwise. */
  readonly interactive: boolean;
  /** The folder `--cd-file` receives when the command ends, set by commands that choose a site. */
  cdTarget: string | undefined;
  /** The site chosen in a plain-mode menu, ahead of `--site` for the commands it runs. */
  siteOverride: string | undefined;
  #registry: SiteRegistry | undefined;
  #prompter: Prompter | undefined;
  #store: Promise<CredentialStore | undefined> | undefined;

  constructor(io: CliIo, flags: GlobalFlags) {
    this.io = io;
    this.flags = flags;
    this.paths = defaultPaths(
      { configDir: flags.configDir, stateDir: flags.stateDir },
      { platform: io.platform, env: io.env, homedir: io.homedir, cwd: io.cwd },
    );
    const sinks: LogSink[] = [runLogSink(this.paths.logDir)];
    if (flags.debug) {
      sinks.push(textSink(io.stderr));
    }
    this.logger = createLogger({ level: flags.debug ? 'debug' : 'info', sinks });
    this.ascii = detectAscii(io, flags.ascii);
    this.color = detectColor(io, flags.color);
    this.interactive = io.stdin.isTTY === true;
  }

  out(text: string): void {
    this.io.stdout.write(text);
  }

  err(text: string): void {
    this.io.stderr.write(text);
  }

  /** Writes a `--json` document to stdout. */
  json(kind: string, data: Record<string, unknown>): void {
    this.out(jsonDocument(kind, data));
  }

  async registry(): Promise<SiteRegistry> {
    this.#registry ??= await SiteRegistry.open({ paths: this.paths, logger: this.logger });
    return this.#registry;
  }

  /** The prompter, for interactive commands only. */
  get prompter(): Prompter {
    if (!this.interactive) {
      throw new UsageError('This needs answers from a terminal. Pass the values as options instead.');
    }
    this.#prompter ??= new Prompter(this.io.stdin, this.io.stderr);
    return this.#prompter;
  }

  /** The OS credential store, or `undefined` when it is turned off or not installed. */
  credentialStore(): Promise<CredentialStore | undefined> {
    if (this.io.credentialStore !== undefined) {
      return Promise.resolve(this.io.credentialStore);
    }
    this.#store ??= keyringDisabled(this.io.env)
      ? Promise.resolve(undefined)
      : import('../credentials/keyring.ts').then((keyring) => keyring.openKeyringStore());
    return this.#store;
  }

  /** Why {@link credentialStore} has nothing, for messages. */
  credentialStoreProblem(): string {
    return keyringDisabled(this.io.env)
      ? `the OS credential store is turned off by ${KEYRING_ENV}`
      : 'the OS credential store package is not installed for this platform';
  }

  /**
   * The site a command means: `explicit` (a positional or `--site`), then
   * `SYNC_SERVERS_SITE`, then the site whose local root holds the current
   * folder, then the only site when there is one, then a picker in a
   * terminal. Otherwise a usage error listing the sites.
   */
  async chooseSite(explicit?: string): Promise<Site> {
    const registry = await this.registry();
    const named = explicit ?? this.siteOverride ?? this.flags.site ?? nonEmpty(this.io.env.SYNC_SERVERS_SITE);
    if (named !== undefined) {
      const site = registry.resolve({ nameOrId: named });
      if (site === undefined) {
        throw new SyncError('E_SITE_NOT_FOUND', `No site is named ${JSON.stringify(named)} or has that id. List them with "sync-servers sites".`);
      }
      return site;
    }
    const here = registry.resolve({ path: this.io.cwd });
    if (here !== undefined) {
      return here;
    }
    const sites = registry.list();
    const [only, ...others] = sites;
    if (only === undefined) {
      throw new UsageError('There are no sites yet. Add one with "sync-servers site add".');
    }
    if (others.length === 0) {
      return only;
    }
    if (this.interactive) {
      return this.prompter.choose(
        'Which site?',
        sites.map((site) => ({ label: `${site.name}  ${site.localRoot}`, value: site })),
      );
    }
    throw new UsageError(
      `No site was chosen. Pass --site <name>, set SYNC_SERVERS_SITE, or run inside a site's local root. Sites: ${sites
        .map((site) => site.name)
        .join(', ')}`,
    );
  }

  /** A server of `site`: `explicit` (a positional or `--server`), else the Remote server, else a picker in a terminal. */
  async chooseServer(site: Site, explicit?: string): Promise<Server> {
    const named = explicit ?? this.flags.server;
    if (named !== undefined) {
      const server = findServer(site, named);
      if (server === undefined) {
        throw new SyncError('E_SERVER_NOT_FOUND', `Site "${site.name}" has no server named ${JSON.stringify(named)}.`);
      }
      return server;
    }
    const remote = site.servers.find((server) => server.id === site.remoteServerId);
    if (remote !== undefined) {
      return remote;
    }
    if (site.servers.length === 0) {
      throw new UsageError(`Site "${site.name}" has no servers. Add one with "sync-servers server add".`);
    }
    if (this.interactive) {
      return this.prompter.choose(
        'Which server?',
        site.servers.map((server) => ({ label: server.name, value: server })),
      );
    }
    throw new UsageError(`Site "${site.name}" has no Remote server. Name a server, or set one with "sync-servers server set-remote".`);
  }

  close(): void {
    this.#prompter?.close();
    this.logger.close();
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}
