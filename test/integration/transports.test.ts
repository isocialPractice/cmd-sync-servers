import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { isSyncError } from '../../src/errors.ts';
import { ROOT, toRemotePath } from '../../src/sync/paths.ts';
import type { Transport } from '../../src/transport/types.ts';
import { collector } from '../helpers/streams.ts';
import { KINDS, startRig, type Rig } from '../sandbox/rig.ts';

async function download(transport: Transport, target: string): Promise<Buffer> {
  const sink = collector();
  await transport.get(toRemotePath(target), sink.stream);
  return sink.data();
}

for (const kind of KINDS) {
  describe(`${kind} transport`, () => {
    let rig: Rig;
    let transport: Transport;

    before(async () => {
      rig = await startRig(kind);
      transport = rig.transport();
      const capabilities = await transport.connect();
      assert.equal(capabilities.protocol, kind);
    });

    after(async () => {
      await transport.close();
      await rig.close();
    });

    test('creates folders, and creating one twice succeeds', async () => {
      await transport.mkdir(toRemotePath('css'));
      await transport.mkdir(toRemotePath('css'));
      assert.equal((await transport.stat(toRemotePath('css')))?.type, 'dir');
    });

    test('uploads, lists, stats and downloads a file', async () => {
      const content = Buffer.from('body { color: #1f2328; }\n');
      await transport.put(Readable.from([content]), toRemotePath('css/site.css'));
      const entry = await transport.stat(toRemotePath('css/site.css'));
      assert.equal(entry?.type, 'file');
      assert.equal(entry.size, content.length);
      assert.equal(entry.path, 'css/site.css');
      const listed = await transport.list(toRemotePath('css'));
      assert.deepEqual(listed.map((item) => [item.name, item.path, item.type]), [['site.css', 'css/site.css', 'file']]);
      const root = await transport.list(ROOT);
      assert.ok(root.some((item) => item.name === 'css' && item.type === 'dir'));
      assert.deepEqual(await download(transport, 'css/site.css'), content);
      assert.deepEqual(readFileSync(path.join(rig.siteDir, 'css', 'site.css')), content);
    });

    test('moves binary content unchanged, line endings included', async () => {
      const content = Buffer.concat([randomBytes(300_000), Buffer.from('\r\n\n\r\u0000ÿ')]);
      await transport.put(Readable.from([content]), toRemotePath('blob.bin'));
      assert.deepEqual(await download(transport, 'blob.bin'), content);
    });

    test('renames, refuses to replace without overwrite, and replaces with it', async () => {
      await transport.put(Readable.from([Buffer.from('new')]), toRemotePath('index.part'));
      await transport.put(Readable.from([Buffer.from('old')]), toRemotePath('index.html'));
      await assert.rejects(transport.rename(toRemotePath('index.part'), toRemotePath('index.html'), false), (error) => isSyncError(error));
      await transport.rename(toRemotePath('index.part'), toRemotePath('index.html'), true);
      assert.equal((await download(transport, 'index.html')).toString(), 'new');
      assert.equal(await transport.stat(toRemotePath('index.part')), undefined);
      await transport.rename(toRemotePath('index.html'), toRemotePath('home.html'), false);
      assert.equal((await download(transport, 'home.html')).toString(), 'new');
    });

    test('sets the modification time', async () => {
      const when = Date.UTC(2026, 0, 15, 9, 30, 12);
      await transport.setMtime?.(toRemotePath('home.html'), when);
      const entry = await transport.stat(toRemotePath('home.html'));
      assert.equal(entry?.mtimeMs, when);
    });

    test('removes files and empty folders', async () => {
      await transport.remove(toRemotePath('css/site.css'));
      await transport.remove(toRemotePath('css'));
      assert.equal(await transport.stat(toRemotePath('css')), undefined);
      assert.equal(await transport.stat(toRemotePath('css/site.css')), undefined);
      assert.equal(await transport.stat(toRemotePath('missing.txt')), undefined);
    });

    test('refuses a listing longer than the limit', async () => {
      mkdirSync(path.join(rig.siteDir, 'many'));
      for (let index = 0; index < 5; index += 1) {
        writeFileSync(path.join(rig.siteDir, 'many', `file-${String(index)}.txt`), 'x');
      }
      const limited = rig.transport({ listingLimit: 3 });
      await limited.connect();
      try {
        await assert.rejects(limited.list(toRemotePath('many')), (error) => isSyncError(error, 'E_LISTING_LIMIT'));
      } finally {
        await limited.close();
      }
    });

    test('a missing remote root is E_REMOTE_ROOT', async () => {
      const missing = rig.transport({ remoteRoot: kind === 'local' ? path.join(rig.siteDir, 'nope') : '/nope' });
      await assert.rejects(missing.connect(), (error) => isSyncError(error, 'E_REMOTE_ROOT'));
      await missing.close();
    });

    test('debug logs carry protocol traces, never the password', () => {
      if (kind !== 'local') {
        assert.ok(rig.records.some((record) => record.level === 'debug'));
      }
      assert.ok(!JSON.stringify(rig.records).includes(rig.password));
    });
  });
}

test('an FTP server without MLSD is listed with LIST, without times', async () => {
  const rig = await startRig('ftps', { mlsd: false });
  const transport = rig.transport();
  try {
    const capabilities = await transport.connect();
    assert.equal(capabilities.mtimePrecisionMs, undefined);
    writeFileSync(path.join(rig.siteDir, 'about.html'), 'about');
    mkdirSync(path.join(rig.siteDir, 'img'));
    const listed = await transport.list(ROOT);
    assert.deepEqual(
      listed.map((entry) => [entry.name, entry.type, entry.mtimeMs]).sort(),
      [
        ['about.html', 'file', undefined],
        ['img', 'dir', undefined],
      ],
    );
    assert.ok((await transport.stat(toRemotePath('about.html')))?.mtimeMs !== undefined);
  } finally {
    await transport.close();
    await rig.close();
  }
});
