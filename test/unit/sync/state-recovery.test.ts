import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { isSyncError } from '../../../src/errors.ts';
import { toRemotePath } from '../../../src/sync/paths.ts';
import { Recovery } from '../../../src/sync/recovery.ts';
import { recordsFile, SyncRecords } from '../../../src/sync/state.ts';
import { tempDir } from '../../helpers/cli.ts';

let temp: ReturnType<typeof tempDir>;

beforeEach(() => {
  temp = tempDir();
});

afterEach(() => {
  temp.cleanup();
});

const record = { local: { size: 1, mtimeMs: 10 }, remote: { size: 1, mtimeMs: 20 }, syncedAt: 30 };

test('records are saved atomically, sorted, and read back', async () => {
  const records = await SyncRecords.load(temp.dir, 'site-1', 'server-1', true);
  records.set('b.html', record);
  records.set('a.html', { ...record, syncedAt: 40 });
  await records.save();
  const file = recordsFile(temp.dir, 'site-1', 'server-1');
  assert.equal(records.file, file);
  assert.deepEqual(Object.keys((JSON.parse(readFileSync(file, 'utf8')) as { records: object }).records), ['a.html', 'b.html']);
  const again = await SyncRecords.load(temp.dir, 'site-1', 'server-1', true);
  assert.deepEqual(again.get('b.html'), record);
  assert.equal(again.size, 2);
  assert.equal(again.lastSyncedAt(), 40);
  again.delete('a.html');
  again.delete('a.html');
  await again.save();
  assert.deepEqual((await SyncRecords.load(temp.dir, 'site-1', 'server-1', true)).paths(), ['b.html']);
});

test('a checkpoint saves after 50 changes', async () => {
  const records = await SyncRecords.load(temp.dir, 'site-1', 'server-1', true);
  for (let index = 0; index < 49; index += 1) {
    records.set(`f${String(index)}.txt`, record);
  }
  await records.checkpoint();
  assert.equal(readdirSync(temp.dir).includes('sites'), false);
  records.set('f49.txt', record);
  await records.checkpoint();
  assert.equal((await SyncRecords.load(temp.dir, 'site-1', 'server-1', true)).size, 50);
});

test('records that are switched off hold nothing and write nothing', async () => {
  const records = await SyncRecords.load(temp.dir, 'site-1', 'server-1', false);
  records.set('a.html', record);
  await records.save();
  assert.equal(records.size, 0);
  assert.equal(readdirSync(temp.dir).length, 0);
});

test('a broken records file is reported with the way out', async () => {
  const file = recordsFile(temp.dir, 'site-1', 'server-1');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '{ nope');
  await assert.rejects(SyncRecords.load(temp.dir, 'site-1', 'server-1', true), (error) => isSyncError(error, 'E_CONFIG_INVALID') && error.message.includes('state reset'));
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, records: { 'a.html': { local: { size: -1 } } } }));
  await assert.rejects(SyncRecords.load(temp.dir, 'site-1', 'server-1', true), (error) => isSyncError(error, 'E_CONFIG_INVALID'));
});

test('reset forgets every record and removes the file', async () => {
  const records = await SyncRecords.load(temp.dir, 'site-1', 'server-1', true);
  records.set('a.html', record);
  await records.save();
  await records.reset();
  assert.equal(records.size, 0);
  assert.equal((await SyncRecords.load(temp.dir, 'site-1', 'server-1', true)).size, 0);
});

test('recovery keeps a file and can put it back', async () => {
  const site = path.join(temp.dir, 'site');
  mkdirSync(path.join(site, 'css'), { recursive: true });
  const file = path.join(site, 'css', 'site.css');
  writeFileSync(file, 'old');
  const recovery = new Recovery(path.join(temp.dir, 'state'), 'site-1', { enabled: true, keepDays: 14, maxMegabytes: 1024 }, new Date('2026-10-29T12:00:00Z'));
  const kept = await recovery.keep(file, toRemotePath('css/site.css'));
  assert.equal(kept, path.join(temp.dir, 'state', 'recovery', 'site-1', '20261029-120000-000', 'css', 'site.css'));
  assert.equal(readFileSync(kept, 'utf8'), 'old');
  await recovery.restore(kept, file);
  assert.equal(readFileSync(file, 'utf8'), 'old');
});

test('recovery off deletes the file instead', async () => {
  const file = path.join(temp.dir, 'a.txt');
  writeFileSync(file, 'x');
  const recovery = new Recovery(temp.dir, 'site-1', { enabled: false, keepDays: 14, maxMegabytes: 1024 });
  assert.equal(recovery.enabled, false);
  assert.equal(await recovery.keep(file, toRemotePath('a.txt')), undefined);
  assert.deepEqual(readdirSync(temp.dir), []);
});

test('a link is removed with a copy of what it points to kept, and what it points to stays', async (t) => {
  const site = path.join(temp.dir, 'site');
  mkdirSync(path.join(site, 'css'), { recursive: true });
  mkdirSync(path.join(site, 'shared'));
  const real = path.join(site, 'shared', 'site.css');
  writeFileSync(real, 'body {}');
  const links = [path.join(site, 'css', 'site.css'), path.join(site, 'css', 'copy.css')];
  try {
    for (const link of links) {
      symlinkSync(path.join('..', 'shared', 'site.css'), link, 'file');
    }
  } catch {
    t.skip('creating file links is not permitted here');
    return;
  }
  const kept = await new Recovery(path.join(temp.dir, 'state'), 'site-1', { enabled: true, keepDays: 14, maxMegabytes: 1024 }, new Date('2026-10-29T12:00:00Z')).keepLink(
    links[0] ?? '',
    toRemotePath('css/site.css'),
  );
  assert.equal(kept, path.join(temp.dir, 'state', 'recovery', 'site-1', '20261029-120000-000', 'css', 'site.css'));
  assert.equal(lstatSync(kept).isFile(), true);
  assert.equal(readFileSync(kept, 'utf8'), 'body {}');
  assert.equal(existsSync(links[0] ?? ''), false);
  assert.equal(readFileSync(real, 'utf8'), 'body {}');

  const off = new Recovery(path.join(temp.dir, 'state'), 'site-1', { enabled: false, keepDays: 14, maxMegabytes: 1024 });
  assert.equal(await off.keepLink(links[1] ?? '', toRemotePath('css/copy.css')), undefined);
  assert.deepEqual(readdirSync(path.join(site, 'css')), []);
  assert.equal(readFileSync(real, 'utf8'), 'body {}');
});

test('pruning removes runs past keepDays, then the oldest while over the size limit', async () => {
  const state = path.join(temp.dir, 'state');
  const runs = path.join(state, 'recovery', 'site-1');
  for (const [name, bytes] of [
    ['20261001-000000-000', 10],
    ['20261027-000000-000', 600_000],
    ['20261028-000000-000', 600_000],
  ] as const) {
    mkdirSync(path.join(runs, name), { recursive: true });
    writeFileSync(path.join(runs, name, 'f.bin'), Buffer.alloc(bytes));
  }
  assert.equal(await new Recovery(state, 'site-1', { enabled: true, keepDays: 14, maxMegabytes: 1 }).prune(new Date('2026-10-29T00:00:00Z')), false);
  assert.deepEqual(readdirSync(runs), ['20261028-000000-000']);
  assert.equal(await new Recovery(path.join(temp.dir, 'none'), 'site-1', { enabled: true, keepDays: 1, maxMegabytes: 1 }).prune(), false);
});

test('pruning never removes the files kept by this run, however large or old the limits make them', async () => {
  const state = path.join(temp.dir, 'state');
  const now = new Date('2026-10-29T12:00:00Z');
  const recovery = new Recovery(state, 'site-1', { enabled: true, keepDays: 0, maxMegabytes: 1 }, now);
  const older = path.join(state, 'recovery', 'site-1', '20261028-000000-000');
  mkdirSync(older, { recursive: true });
  writeFileSync(path.join(older, 'old.bin'), Buffer.alloc(10));
  const big = path.join(temp.dir, 'big.bin');
  writeFileSync(big, Buffer.alloc(1_200_000));
  const kept = await recovery.keep(big, toRemotePath('big.bin'));
  assert.ok(kept !== undefined);
  assert.equal(await recovery.prune(now), true, 'this run alone is over the limit');
  assert.equal(readFileSync(kept).length, 1_200_000);
  assert.deepEqual(readdirSync(path.join(state, 'recovery', 'site-1')), [path.basename(recovery.runDir)]);
});
