import assert from 'node:assert/strict';
import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { defaultPaths, type SyncServersPaths } from '../../../src/config/paths.ts';
import { SiteRegistry } from '../../../src/config/registry.ts';
import { isSyncError } from '../../../src/errors.ts';
import { makeFolder, tempDir } from '../../helpers/cli.ts';

let temp: ReturnType<typeof tempDir>;
let paths: SyncServersPaths;
let siteRoot: string;

beforeEach(() => {
  temp = tempDir();
  paths = defaultPaths({ configDir: path.join(temp.dir, 'config'), stateDir: path.join(temp.dir, 'state') });
  siteRoot = makeFolder(temp.dir, 'sites', 'my-site');
});

afterEach(() => {
  temp.cleanup();
});

const production = {
  name: 'Production',
  protocol: 'sftp' as const,
  host: 'sftp.example.com',
  username: 'demo-user',
  remoteRoot: '/var/www/my-site',
};

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

test('opening creates sites.json with the schema reference first', async () => {
  await SiteRegistry.open({ paths });
  const text = readFileSync(paths.sitesFile, 'utf8');
  assert.match(text, /^\{\n {2}"\$schema": "https:\/\/isocialpractice\.github\.io\//);
  assert.deepEqual(readJson(paths.sitesFile).sites, []);
  assert.equal(readJson(paths.sitesFile).schemaVersion, 1);
});

test('the master list is private to the user on POSIX', { skip: process.platform === 'win32' }, async () => {
  const registry = await SiteRegistry.open({ paths });
  await registry.add({ name: 'My Site', localRoot: siteRoot });
  assert.equal(statSync(paths.sitesFile).mode & 0o777, 0o600);
  assert.equal(statSync(paths.configDir).mode & 0o777, 0o700);
});

test('sites are added, listed, found and removed', async () => {
  const registry = await SiteRegistry.open({ paths });
  const site = await registry.add({ name: 'My Site', localRoot: siteRoot });
  assert.equal(site.localRoot, siteRoot);
  assert.deepEqual(registry.list().map((item) => item.name), ['My Site']);
  assert.equal(registry.resolve({ name: 'my site' })?.id, site.id);
  assert.equal(registry.resolve({ id: site.id })?.name, 'My Site');
  assert.equal(registry.resolve({ nameOrId: site.id })?.name, 'My Site');
  assert.equal(registry.resolve({ nameOrId: 'MY SITE' })?.id, site.id);
  assert.equal(registry.resolve({ name: 'Sample App' }), undefined);
  await registry.remove(site.id);
  assert.deepEqual(registry.list(), []);
  assert.deepEqual(readJson(paths.sitesFile).sites, []);
});

test('a path resolves to the deepest site that contains it', async () => {
  const registry = await SiteRegistry.open({ paths });
  const outer = await registry.add({ name: 'My Site', localRoot: siteRoot });
  const innerRoot = makeFolder(siteRoot, 'blog');
  const inner = await registry.add({ name: 'Sample App', localRoot: innerRoot });
  assert.equal(registry.resolve({ path: makeFolder(siteRoot, 'css') })?.id, outer.id);
  assert.equal(registry.resolve({ path: makeFolder(innerRoot, 'posts') })?.id, inner.id);
  assert.equal(registry.resolve({ path: siteRoot })?.id, outer.id);
  assert.equal(registry.resolve({ path: makeFolder(temp.dir, 'sites', 'my-site-copy') }), undefined);
  assert.equal(registry.resolve({ path: temp.dir }), undefined);
});

test('the first server becomes the Remote server, and removing a server clears its roles', async () => {
  const registry = await SiteRegistry.open({ paths });
  const site = await registry.add({ name: 'My Site', localRoot: siteRoot });
  const first = await registry.addServer(site.id, production);
  const second = await registry.addServer(site.id, { ...production, name: 'Staging', host: 'staging.example.com' });
  await registry.update(site.id, (draft) => {
    draft.testingServerId = second.id;
  });
  assert.equal(registry.get(site.id)?.remoteServerId, first.id);
  await registry.removeServer(site.id, second.id);
  assert.equal(registry.get(site.id)?.testingServerId, undefined);
  await registry.removeServer(site.id, first.id);
  assert.equal(registry.get(site.id)?.remoteServerId, undefined);
});

test('every write keeps the previous version as sites.json.bak', async () => {
  const registry = await SiteRegistry.open({ paths });
  const site = await registry.add({ name: 'My Site', localRoot: siteRoot });
  await registry.update(site.id, (draft) => {
    draft.name = 'Sample App';
  });
  const backup = readJson(`${paths.sitesFile}.bak`) as { sites: { name: string }[] };
  assert.equal(backup.sites[0]?.name, 'My Site');
  assert.equal((readJson(paths.sitesFile) as { sites: { name: string }[] }).sites[0]?.name, 'Sample App');
});

test('an invalid change is refused and the file is left as it was', async () => {
  const registry = await SiteRegistry.open({ paths });
  const site = await registry.add({ name: 'My Site', localRoot: siteRoot });
  const before = readFileSync(paths.sitesFile, 'utf8');
  await assert.rejects(
    registry.update(site.id, (draft) => {
      draft.sync.concurrency = 99;
    }),
    (error) => isSyncError(error, 'E_CONFIG_INVALID') && error.message.includes('Site "My Site", sync.concurrency 99: '),
  );
  assert.equal(readFileSync(paths.sitesFile, 'utf8'), before);
  await assert.rejects(registry.add({ name: 'MY SITE', localRoot: siteRoot }), (error) => isSyncError(error, 'E_CONFIG_INVALID'));
});

test('a file with an unknown key is never rewritten, and the error names the file and the key', async () => {
  const registry = await SiteRegistry.open({ paths });
  await registry.add({ name: 'My Site', localRoot: siteRoot });
  const broken = readFileSync(paths.sitesFile, 'utf8').replace('"name": "My Site"', '"name": "My Site", "colour": "blue"');
  writeFileSync(paths.sitesFile, broken);
  await assert.rejects(
    SiteRegistry.open({ paths }),
    (error) => isSyncError(error, 'E_CONFIG_INVALID') && error.message.includes(paths.sitesFile) && error.message.includes('colour'),
  );
  await assert.rejects(registry.add({ name: 'Sample App', localRoot: siteRoot }), (error) => isSyncError(error, 'E_CONFIG_INVALID'));
  assert.equal(readFileSync(paths.sitesFile, 'utf8'), broken);
});

test('a file that is not JSON is reported, not replaced', async () => {
  await SiteRegistry.open({ paths });
  writeFileSync(paths.sitesFile, '{ "schemaVersion": 1, ');
  await assert.rejects(SiteRegistry.open({ paths }), (error) => isSyncError(error, 'E_CONFIG_INVALID') && error.message.includes('not valid JSON'));
  assert.equal(readFileSync(paths.sitesFile, 'utf8'), '{ "schemaVersion": 1, ');
});

test('two registries writing at once lose nothing', async () => {
  const a = await SiteRegistry.open({ paths });
  const b = await SiteRegistry.open({ paths });
  const names = Array.from({ length: 12 }, (_, index) => `Site ${String(index)}`);
  await Promise.all(names.map((name, index) => (index % 2 === 0 ? a : b).add({ name, localRoot: siteRoot })));
  await a.reload();
  assert.deepEqual(a.list().map((site) => site.name).sort(), [...names].sort());
});

test('a held lock makes a write wait, then fail with E_LOCKED', async () => {
  const registry = await SiteRegistry.open({ paths, lockTimeoutMs: 150 });
  writeFileSync(`${paths.sitesFile}.lock`, JSON.stringify({ pid: process.pid, host: 'other-host', createdAt: new Date().toISOString() }));
  await assert.rejects(registry.add({ name: 'My Site', localRoot: siteRoot }), (error) => isSyncError(error, 'E_LOCKED'));
});

test('a stale lock is taken over', async () => {
  const registry = await SiteRegistry.open({ paths, lockTimeoutMs: 150 });
  const lock = `${paths.sitesFile}.lock`;
  writeFileSync(lock, JSON.stringify({ pid: 1, host: 'other-host', createdAt: '2026-01-01T00:00:00Z' }));
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  const site = await registry.add({ name: 'My Site', localRoot: siteRoot });
  assert.equal(site.name, 'My Site');
});

test('removing the last selected site clears the selection', async () => {
  const registry = await SiteRegistry.open({ paths });
  const site = await registry.add({ name: 'My Site', localRoot: siteRoot });
  await registry.setLastSelected(site.id);
  assert.equal(registry.lastSelectedSiteId, site.id);
  await registry.remove(site.id);
  assert.equal(registry.lastSelectedSiteId, undefined);
  assert.equal('lastSelectedSiteId' in readJson(paths.sitesFile), false);
});

test('a missing site is E_SITE_NOT_FOUND', async () => {
  const registry = await SiteRegistry.open({ paths });
  await assert.rejects(registry.remove('00000000-0000-4000-8000-000000000000'), (error) => isSyncError(error, 'E_SITE_NOT_FOUND'));
});

test('global cloaking is written only while it holds a pattern, and useGlobalPatterns only when it is false', async () => {
  const registry = await SiteRegistry.open({ paths });
  const site = await registry.add({ name: 'My Site', localRoot: siteRoot });
  const before = readFileSync(paths.sitesFile, 'utf8');
  assert.doesNotMatch(before, /useGlobalPatterns/);
  assert.equal(readJson(paths.sitesFile).cloaking, undefined);
  assert.deepEqual(registry.globalCloaking, { patterns: [] });

  const updated = await registry.updateGlobalCloaking((cloaking) => {
    cloaking.patterns.push('.git/', 'node_modules/');
  });
  assert.deepEqual(updated, { patterns: ['.git/', 'node_modules/'] });
  assert.deepEqual(Object.keys(readJson(paths.sitesFile)), ['$schema', 'schemaVersion', 'cloaking', 'sites']);
  assert.deepEqual(readJson(paths.sitesFile).cloaking, { patterns: ['.git/', 'node_modules/'] });
  assert.deepEqual((await SiteRegistry.open({ paths })).globalCloaking.patterns, ['.git/', 'node_modules/'], 'another process reads them');

  await registry.update(site.id, (draft) => {
    draft.cloaking.useGlobalPatterns = true;
  });
  assert.doesNotMatch(readFileSync(paths.sitesFile, 'utf8'), /useGlobalPatterns/, 'true is the default and is not written');
  await registry.update(site.id, (draft) => {
    draft.cloaking.useGlobalPatterns = false;
  });
  assert.match(readFileSync(paths.sitesFile, 'utf8'), /"enabled": true,\n {8}"useGlobalPatterns": false,/);

  await assert.rejects(
    registry.updateGlobalCloaking((cloaking) => {
      cloaking.patterns.push('  ');
    }),
    (error) => isSyncError(error, 'E_CONFIG_INVALID'),
  );
  await registry.update(site.id, (draft) => {
    delete draft.cloaking.useGlobalPatterns;
  });
  await registry.updateGlobalCloaking((cloaking) => {
    cloaking.patterns = [];
  });
  assert.equal(readFileSync(paths.sitesFile, 'utf8'), before, 'without global cloaking the file reads as before');

  writeFileSync(paths.sitesFile, before.replace('"schemaVersion": 1,', '"schemaVersion": 1,\n  "cloaking": { "patterns": [], "extra": true },'));
  await assert.rejects(SiteRegistry.open({ paths }), (error) => isSyncError(error, 'E_CONFIG_INVALID') && error.message.includes('extra'));
});
