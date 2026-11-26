import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { isSyncError } from '../../../src/errors.ts';
import { siteCloak } from '../../../src/sync/cloak.ts';
import { childPath, ROOT, toRemotePath, type RemotePath } from '../../../src/sync/paths.ts';
import { MAX_REMOTE_DEPTH, scanRemote } from '../../../src/sync/scan-remote.ts';
import { remoteRootIsTop } from '../../../src/sync/session.ts';
import type { TransportPool } from '../../../src/transport/pool.ts';
import type { RemoteEntry, Transport } from '../../../src/transport/types.ts';

function entry(dir: RemotePath, name: string, type: RemoteEntry['type']): RemoteEntry {
  const checked = childPath(dir, name);
  return { name, path: checked.ok ? checked.path : undefined, unsafe: checked.ok ? undefined : checked.reason, type, size: 1, mtimeMs: 0 };
}

/** A pool whose server answers every listing with `list`. */
function pool(list: (dir: RemotePath) => RemoteEntry[]): TransportPool {
  const transport = { list: (dir: RemotePath) => Promise.resolve(list(dir)), stat: () => Promise.resolve(undefined) } as unknown as Transport;
  return { runWithRetry: <T>(operation: (t: Transport) => Promise<T>) => operation(transport) } as unknown as TransportPool;
}

const cloak = siteCloak({ cloaking: { enabled: true, patterns: [], paths: [] } });

test('a server that nests folders without end stops the scan at the depth limit', async () => {
  const endless = pool((dir) => [entry(dir, 'a', 'dir')]);
  await assert.rejects(
    scanRemote({ pool: endless, cloak, scopes: [ROOT], concurrency: 4 }),
    (error) => isSyncError(error, 'E_LISTING_LIMIT') && error.message.includes(`deeper than ${String(MAX_REMOTE_DEPTH)} levels`),
  );
});

test('partial copies left on the server are never listed as files', async () => {
  const leftovers = pool((dir) => (dir === ROOT ? [entry(dir, 'index.html', 'file'), entry(dir, '.index.html.sync-servers-0a1b2c3d.part', 'file')] : []));
  const result = await scanRemote({ pool: leftovers, cloak, scopes: [ROOT], concurrency: 4 });
  assert.deepEqual([...result.files.keys()], ['index.html']);
});

test("a copy of Dreamweaver's records on the server is never listed, whatever the case of its name", async () => {
  const listing = (dir: RemotePath): RemoteEntry[] => {
    if (dir === ROOT) {
      return [entry(dir, 'index.html', 'file'), entry(dir, '_notes', 'dir'), entry(dir, 'img', 'dir'), entry(dir, 'dwsync.xml', 'file')];
    }
    if (dir === '_notes') {
      return [entry(dir, 'dwsync.xml', 'file'), entry(dir, 'index.html.mno', 'file')];
    }
    return dir === 'img' ? [entry(dir, '_Notes', 'dir')] : [entry(dir, 'DwSync.XML', 'file')];
  };
  const result = await scanRemote({ pool: pool(listing), cloak, scopes: [ROOT], concurrency: 4 });
  assert.deepEqual([...result.files.keys()].sort(), ['_notes/index.html.mno', 'dwsync.xml', 'index.html']);
  assert.deepEqual([...result.dirs].sort(), ['_notes', 'img', 'img/_Notes']);

  const answering = { list: () => Promise.resolve([]), stat: (target: RemotePath) => Promise.resolve(entry(ROOT, target, 'file')) } as unknown as Transport;
  const stats = { runWithRetry: <T>(operation: (t: Transport) => Promise<T>) => operation(answering) } as unknown as TransportPool;
  const scoped = await scanRemote({ pool: stats, cloak, scopes: [toRemotePath('_notes/dwsync.xml'), toRemotePath('index.html')], concurrency: 4 });
  assert.deepEqual([...scoped.files.keys()], ['index.html']);
});

// Single paths of a site on a server that answers the later lookups of a batch first:
//   index.html, about.html, css/site.css, scripts/app.js, img/ (a folder holding hero.svg and icon.svg),
//   current (a symbolic link), drafts/notes.md (cloaked), and missing.html, which is not on the server.
function lookupServer(): { pool: TransportPool; running: () => number; most: () => number; listed: RemotePath[] } {
  const kinds: Readonly<Record<string, RemoteEntry['type']>> = {
    'index.html': 'file',
    'about.html': 'file',
    'css/site.css': 'file',
    'scripts/app.js': 'file',
    img: 'dir',
    current: 'symlink',
    'drafts/notes.md': 'file',
  };
  const listed: RemotePath[] = [];
  let running = 0;
  let most = 0;
  let asked = 0;
  const transport = {
    list: (dir: RemotePath) => {
      listed.push(dir);
      return Promise.resolve(dir === 'img' ? [entry(dir, 'hero.svg', 'file'), entry(dir, 'icon.svg', 'file')] : []);
    },
    stat: async (target: RemotePath): Promise<RemoteEntry | undefined> => {
      running += 1;
      most = Math.max(most, running);
      asked += 1;
      // Each lookup answers sooner than the one asked before it.
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, 40 - asked * 4)));
      running -= 1;
      const type = kinds[target];
      return type === undefined ? undefined : { ...entry(ROOT, 'x', type), name: target.split('/').at(-1) ?? target, path: target };
    },
  } as unknown as Transport;
  return {
    pool: { runWithRetry: <T>(operation: (t: Transport) => Promise<T>) => operation(transport) } as unknown as TransportPool,
    running: () => running,
    most: () => most,
    listed,
  };
}

const LOOKUPS = ['index.html', 'missing.html', 'img', 'about.html', 'current', 'drafts/notes.md', 'css/site.css', 'scripts/app.js'].map((scope) => toRemotePath(scope));
const draftsCloak = siteCloak({ cloaking: { enabled: true, patterns: ['/drafts/'], paths: [] } });

test('single paths are looked up as many at a time as the concurrency allows, and never more', async () => {
  for (const concurrency of [1, 3, 4, 16]) {
    const server = lookupServer();
    await scanRemote({ pool: server.pool, cloak: draftsCloak, scopes: LOOKUPS, concurrency });
    // Seven paths reach the server: the cloaked one is never asked about.
    assert.equal(server.most(), Math.min(concurrency, 7), `concurrency ${String(concurrency)}`);
    assert.equal(server.running(), 0);
  }
});

test('single paths give the same files, folders and problems whatever the concurrency', async () => {
  const scan = async (concurrency: number) => {
    const server = lookupServer();
    const progress: [number, number][] = [];
    const result = await scanRemote({
      pool: server.pool,
      cloak: draftsCloak,
      scopes: LOOKUPS,
      concurrency,
      onProgress: (files, folders) => {
        progress.push([files, folders]);
      },
    });
    return { found: { files: [...result.files.entries()], dirs: [...result.dirs], problems: result.problems, cloaked: result.cloaked, listed: server.listed }, progress };
  };
  const one = await scan(1);
  assert.deepEqual(
    one.found.files.map(([target]) => target),
    ['index.html', 'about.html', 'css/site.css', 'scripts/app.js', 'img/hero.svg', 'img/icon.svg'],
    'in the order of the paths, then what the folder among them holds',
  );
  assert.deepEqual(one.found.dirs, ['img']);
  assert.deepEqual(one.found.listed, ['img'], 'a folder among the paths is listed, and nothing else is');
  assert.deepEqual(one.found.problems, [{ path: 'current', side: 'remote', kind: 'symlink', status: 'Symbolic link skipped.' }]);
  assert.equal(one.found.cloaked, 1);
  for (const concurrency of [2, 4, 16]) {
    assert.deepEqual((await scan(concurrency)).found, one.found, `concurrency ${String(concurrency)}`);
  }
  // Progress is reported after each batch of lookups, then after each batch of listings.
  assert.equal(one.progress.length, 7 + 1);
  assert.deepEqual((await scan(4)).progress, [[2, 1], [4, 1], [6, 1]]);
});

test('single paths are not looked up once the scan is cancelled', async () => {
  const server = lookupServer();
  const controller = new AbortController();
  const result = await scanRemote({
    pool: server.pool,
    cloak: draftsCloak,
    scopes: LOOKUPS,
    concurrency: 2,
    signal: controller.signal,
    onProgress: () => {
      controller.abort();
    },
  });
  assert.deepEqual([...result.files.keys()], ['index.html']);
  assert.deepEqual(server.listed, []);
});

test('the top of a server is /, a Windows drive, or the root of a local drive', () => {
  for (const remoteRoot of ['/', '/C:', '/c:/', '//']) {
    assert.equal(remoteRootIsTop({ protocol: 'sftp', remoteRoot }), true, remoteRoot);
  }
  for (const remoteRoot of ['/var/www', '/C:/sites', '/CD']) {
    assert.equal(remoteRootIsTop({ protocol: 'ftps', remoteRoot }), false, remoteRoot);
  }
  assert.equal(remoteRootIsTop({ protocol: 'local', remoteRoot: path.parse(process.cwd()).root }), true);
  assert.equal(remoteRootIsTop({ protocol: 'local', remoteRoot: process.cwd() }), false);
});
