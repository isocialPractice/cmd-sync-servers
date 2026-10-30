import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { isSyncError } from '../../../src/errors.ts';
import { siteCloak } from '../../../src/sync/cloak.ts';
import { childPath, ROOT, type RemotePath } from '../../../src/sync/paths.ts';
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
