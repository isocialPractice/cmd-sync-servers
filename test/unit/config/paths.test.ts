import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultPaths, type PathsEnvironment } from '../../../src/config/paths.ts';

const windows: PathsEnvironment = {
  platform: 'win32',
  env: { APPDATA: 'C:\\Users\\<user>\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\<user>\\AppData\\Local' },
  homedir: 'C:\\Users\\<user>',
  cwd: 'C:\\Users\\<user>',
};

const mac: PathsEnvironment = { platform: 'darwin', env: {}, homedir: '/Users/<user>', cwd: '/Users/<user>' };

const linux: PathsEnvironment = { platform: 'linux', env: {}, homedir: '/home/<user>', cwd: '/home/<user>' };

test('Windows keeps settings in APPDATA and state in LOCALAPPDATA', () => {
  assert.deepEqual(defaultPaths({}, windows), {
    configDir: 'C:\\Users\\<user>\\AppData\\Roaming\\sync-servers',
    stateDir: 'C:\\Users\\<user>\\AppData\\Local\\sync-servers',
    logDir: 'C:\\Users\\<user>\\AppData\\Local\\sync-servers\\logs',
    sitesFile: 'C:\\Users\\<user>\\AppData\\Roaming\\sync-servers\\sites.json',
  });
});

test('Windows falls back to the profile folders when APPDATA is unset', () => {
  const paths = defaultPaths({}, { ...windows, env: {} });
  assert.equal(paths.configDir, 'C:\\Users\\<user>\\AppData\\Roaming\\sync-servers');
  assert.equal(paths.stateDir, 'C:\\Users\\<user>\\AppData\\Local\\sync-servers');
});

test('macOS uses Application Support, with logs in Library/Logs', () => {
  assert.deepEqual(defaultPaths({}, mac), {
    configDir: '/Users/<user>/Library/Application Support/sync-servers',
    stateDir: '/Users/<user>/Library/Application Support/sync-servers/state',
    logDir: '/Users/<user>/Library/Logs/sync-servers',
    sitesFile: '/Users/<user>/Library/Application Support/sync-servers/sites.json',
  });
});

test('Linux defaults to ~/.config and ~/.local/state', () => {
  assert.deepEqual(defaultPaths({}, linux), {
    configDir: '/home/<user>/.config/sync-servers',
    stateDir: '/home/<user>/.local/state/sync-servers',
    logDir: '/home/<user>/.local/state/sync-servers/logs',
    sitesFile: '/home/<user>/.config/sync-servers/sites.json',
  });
});

test('Linux honours absolute XDG folders and ignores relative ones', () => {
  const absolute = defaultPaths({}, { ...linux, env: { XDG_CONFIG_HOME: '/srv/config', XDG_STATE_HOME: '/srv/state' } });
  assert.equal(absolute.configDir, '/srv/config/sync-servers');
  assert.equal(absolute.stateDir, '/srv/state/sync-servers');
  const relative = defaultPaths({}, { ...linux, env: { XDG_CONFIG_HOME: 'config', XDG_STATE_HOME: '' } });
  assert.equal(relative.configDir, '/home/<user>/.config/sync-servers');
  assert.equal(relative.stateDir, '/home/<user>/.local/state/sync-servers');
});

test('SYNC_SERVERS_HOME moves settings and state on every platform', () => {
  const posix = defaultPaths({}, { ...mac, env: { SYNC_SERVERS_HOME: '/tmp/acme' } });
  assert.deepEqual(posix, {
    configDir: '/tmp/acme',
    stateDir: '/tmp/acme/state',
    logDir: '/tmp/acme/state/logs',
    sitesFile: '/tmp/acme/sites.json',
  });
  const win = defaultPaths({}, { ...windows, env: { ...windows.env, SYNC_SERVERS_HOME: 'D:\\acme' } });
  assert.equal(win.configDir, 'D:\\acme');
  assert.equal(win.stateDir, 'D:\\acme\\state');
});

test('a relative SYNC_SERVERS_HOME resolves against the current folder', () => {
  const paths = defaultPaths({}, { ...linux, env: { SYNC_SERVERS_HOME: 'acme' }, cwd: '/home/<user>/work' });
  assert.equal(paths.configDir, '/home/<user>/work/acme');
});

test('--config-dir and --state-dir win over the environment, and logs follow state', () => {
  const paths = defaultPaths(
    { configDir: '/opt/acme/config', stateDir: '/opt/acme/state' },
    { ...mac, env: { SYNC_SERVERS_HOME: '/tmp/acme' } },
  );
  assert.deepEqual(paths, {
    configDir: '/opt/acme/config',
    stateDir: '/opt/acme/state',
    logDir: '/opt/acme/state/logs',
    sitesFile: '/opt/acme/config/sites.json',
  });
});
