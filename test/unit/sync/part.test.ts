import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { test } from 'node:test';
import { isSyncError } from '../../../src/errors.ts';
import { cappedFile, isPartName, partName, partPath } from '../../../src/sync/part.ts';
import { toRemotePath } from '../../../src/sync/paths.ts';
import { tempDir } from '../../helpers/cli.ts';

test('partial copies are named beside their target and recognized by name', () => {
  const name = partName(toRemotePath('css/site.css'));
  assert.match(name, /^\.site\.css\.sync-servers-[0-9a-f]{8}\.part$/);
  assert.ok(isPartName(name));
  assert.match(partPath(toRemotePath('css/site.css')), /^css\/\.site\.css\.sync-servers-[0-9a-f]{8}\.part$/);
  assert.match(partName(toRemotePath(`${'x'.repeat(250)}.html`)), /^\.sync-servers-[0-9a-f]{8}\.part$/);
  assert.ok(isPartName('.sync-servers-0123abcd.part'));
  for (const other of ['site.css', 'sync-servers-0123abcd.part', '.site.css.part', '.a.sync-servers-xyz.part']) {
    assert.equal(isPartName(other), false, other);
  }
});

test('a capped file takes up to its size, and fails as soon as a server sends more', async () => {
  const temp = tempDir();
  try {
    const exact = path.join(temp.dir, 'exact.bin');
    await pipeline(Readable.from([Buffer.from('hello'), Buffer.from(' world')]), cappedFile(exact, { flags: 'wx', maxBytes: 11, what: 'Downloading a.bin' }));
    assert.equal(readFileSync(exact, 'utf8'), 'hello world');

    const endless = path.join(temp.dir, 'endless.bin');
    const chunks = (function* () {
      for (;;) {
        yield Buffer.alloc(1024);
      }
    })();
    await assert.rejects(
      pipeline(Readable.from(chunks), cappedFile(endless, { flags: 'wx', maxBytes: 10, what: 'Downloading b.bin' })),
      (error) => isSyncError(error, 'E_REMOTE') && error.message.includes('more than the 10 bytes it listed'),
    );

    await assert.rejects(pipeline(Readable.from([Buffer.from('x')]), cappedFile(exact, { flags: 'wx', maxBytes: 10, what: 'Downloading a.bin' })), { code: 'EEXIST' });
    assert.ok(existsSync(exact));
  } finally {
    temp.cleanup();
  }
});
