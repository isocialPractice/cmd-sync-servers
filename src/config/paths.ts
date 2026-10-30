import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** The folders the engine reads and writes. */
export interface SyncServersPaths {
  /** Settings that roam with the user profile: the master list of sites. */
  readonly configDir: string;
  /** Per-machine state: sync records, scan cache, recovery folder. */
  readonly stateDir: string;
  /** Run logs. */
  readonly logDir: string;
  /** The master list, `sites.json` in the settings folder. */
  readonly sitesFile: string;
}

/** The parts of the process that decide the default folders. Injected in tests. */
export interface PathsEnvironment {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir: string;
  readonly cwd: string;
}

/** Folders chosen by the caller instead of the platform defaults. */
export interface PathsOptions {
  /** Overrides the settings folder (`--config-dir`). */
  readonly configDir?: string | undefined;
  /** Overrides the state folder (`--state-dir`). */
  readonly stateDir?: string | undefined;
}

const APP = 'sync-servers';

function processEnvironment(): PathsEnvironment {
  return { platform: process.platform, env: process.env, homedir: homedir(), cwd: process.cwd() };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/**
 * The settings and state folders for this user and platform.
 *
 * | Platform | Settings | State |
 * | --- | --- | --- |
 * | Windows | `%APPDATA%\sync-servers` | `%LOCALAPPDATA%\sync-servers` |
 * | macOS | `~/Library/Application Support/sync-servers` | `.../sync-servers/state`, logs in `~/Library/Logs/sync-servers` |
 * | Linux and other POSIX | `$XDG_CONFIG_HOME/sync-servers` | `$XDG_STATE_HOME/sync-servers` |
 *
 * `SYNC_SERVERS_HOME` moves both: settings to the folder itself and state to
 * its `state` subfolder. `options` override either folder and win over the
 * environment.
 */
export function defaultPaths(options: PathsOptions = {}, environment: PathsEnvironment = processEnvironment()): SyncServersPaths {
  const p = environment.platform === 'win32' ? path.win32 : path.posix;
  const { env, homedir: home } = environment;
  const absolute = (value: string): string => p.resolve(environment.cwd, value);

  let configDir: string;
  let stateDir: string;
  let logDir: string | undefined;

  const appHome = nonEmpty(env.SYNC_SERVERS_HOME);
  if (appHome !== undefined) {
    configDir = absolute(appHome);
    stateDir = p.join(configDir, 'state');
  } else if (environment.platform === 'win32') {
    configDir = p.join(nonEmpty(env.APPDATA) ?? p.join(home, 'AppData', 'Roaming'), APP);
    stateDir = p.join(nonEmpty(env.LOCALAPPDATA) ?? p.join(home, 'AppData', 'Local'), APP);
  } else if (environment.platform === 'darwin') {
    configDir = p.join(home, 'Library', 'Application Support', APP);
    stateDir = p.join(configDir, 'state');
    logDir = p.join(home, 'Library', 'Logs', APP);
  } else {
    // The XDG specification says relative values are invalid and must be ignored.
    const xdgConfig = nonEmpty(env.XDG_CONFIG_HOME);
    const xdgState = nonEmpty(env.XDG_STATE_HOME);
    configDir = p.join(xdgConfig !== undefined && p.isAbsolute(xdgConfig) ? xdgConfig : p.join(home, '.config'), APP);
    stateDir = p.join(xdgState !== undefined && p.isAbsolute(xdgState) ? xdgState : p.join(home, '.local', 'state'), APP);
  }

  if (options.configDir !== undefined) {
    configDir = absolute(options.configDir);
  }
  if (options.stateDir !== undefined) {
    // Logs follow a moved state folder.
    stateDir = absolute(options.stateDir);
    logDir = undefined;
  }

  return {
    configDir,
    stateDir,
    logDir: logDir ?? p.join(stateDir, 'logs'),
    sitesFile: p.join(configDir, 'sites.json'),
  };
}

/** Creates a folder and its parents, private to the user on POSIX (`0700`). */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}
