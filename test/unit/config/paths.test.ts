import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultPaths, type PathsEnvironment } from '../../../src/config/paths.ts';

const windows: PathsEnvironment = {
  platform: 'win32',
  env: { APPDATA: 'C:\\Users\\demo-user\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\demo-user\\AppData\\Local' },
  homedir: 'C:\\Users\\demo-user',
  cwd: 'C:\\Users\\demo-user',
};

const mac: PathsEnvironment = { platform: 'darwin', env: {}, homedir: '/Users/demo-user', cwd: '/Users/demo-user' };

const linux: PathsEnvironment = { platform: 'linux', env: {}, homedir: '/home/demo-user', cwd: '/home/demo-user' };

test('Windows keeps settings in APPDATA and state in LOCALAPPDATA', () => {
  assert.deepEqual(defaultPaths({}, windows), {
    configDir: 'C:\\Users\\demo-user\\AppData\\Roaming\\sync-servers',
    stateDir: 'C:\\Users\\demo-user\\AppData\\Local\\sync-servers',
    logDir: 'C:\\Users\\demo-user\\AppData\\Local\\sync-servers\\logs',
    sitesFile: 'C:\\Users\\demo-user\\AppData\\Roaming\\sync-servers\\sites.json',
  });
});

test('Windows falls back to the profile folders when APPDATA is unset', () => {
  const paths = defaultPaths({}, { ...windows, env: {} });
  assert.equal(paths.configDir, 'C:\\Users\\demo-user\\AppData\\Roaming\\sync-servers');
  assert.equal(paths.stateDir, 'C:\\Users\\demo-user\\AppData\\Local\\sync-servers');
});

test('macOS uses Application Support, with logs in Library/Logs', () => {
  assert.deepEqual(defaultPaths({}, mac), {
    configDir: '/Users/demo-user/Library/Application Support/sync-servers',
    stateDir: '/Users/demo-user/Library/Application Support/sync-servers/state',
    logDir: '/Users/demo-user/Library/Logs/sync-servers',
    sitesFile: '/Users/demo-user/Library/Application Support/sync-servers/sites.json',
  });
});

test('Linux defaults to ~/.config and ~/.local/state', () => {
  assert.deepEqual(defaultPaths({}, linux), {
    configDir: '/home/demo-user/.config/sync-servers',
    stateDir: '/home/demo-user/.local/state/sync-servers',
    logDir: '/home/demo-user/.local/state/sync-servers/logs',
    sitesFile: '/home/demo-user/.config/sync-servers/sites.json',
  });
});

test('Linux honours absolute XDG folders and ignores relative ones', () => {
  const absolute = defaultPaths({}, { ...linux, env: { XDG_CONFIG_HOME: '/srv/config', XDG_STATE_HOME: '/srv/state' } });
  assert.equal(absolute.configDir, '/srv/config/sync-servers');
  assert.equal(absolute.stateDir, '/srv/state/sync-servers');
  const relative = defaultPaths({}, { ...linux, env: { XDG_CONFIG_HOME: 'config', XDG_STATE_HOME: '' } });
  assert.equal(relative.configDir, '/home/demo-user/.config/sync-servers');
  assert.equal(relative.stateDir, '/home/demo-user/.local/state/sync-servers');
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
  const paths = defaultPaths({}, { ...linux, env: { SYNC_SERVERS_HOME: 'acme' }, cwd: '/home/demo-user/work' });
  assert.equal(paths.configDir, '/home/demo-user/work/acme');
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
