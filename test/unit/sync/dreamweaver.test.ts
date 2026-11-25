import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { siteCloak } from '../../../src/sync/cloak.ts';
import {
  DreamweaverClock,
  findDreamweaverServers,
  hasDreamweaverRecords,
  learnClock,
  MAX_DWSYNC_BYTES,
  readDwsyncFile,
  removeDreamweaverEntries,
  removeLeftoverNotes,
} from '../../../src/sync/dreamweaver.ts';
import { filetimeToMs } from '../../../src/sync/dwsync.ts';
import { tempDir } from '../../helpers/cli.ts';
import { dwsyncText, writeDwsync, type FixtureEntry } from '../../helpers/dwsync.ts';

const FTP = '203.0.113.10//public_html/';
const FOLDER = 'D:/Sites/my-site-testing/';

function entry(name: string, server: string): FixtureEntry {
  return { name, server, local: 134129604153427891n, remote: 134129604600000000n };
}

// A site Dreamweaver synchronized with an FTP server and a folder:
//   index.html, about.html, css/site.css, img/hero.svg, drafts/notes.md
//   _notes, css/_notes, drafts/_notes: records
//   img/_notes: a file that is not a dwsync document
//   scripts: no _notes
describe('the Dreamweaver records of a local folder', () => {
  let temp: ReturnType<typeof tempDir>;
  let site: string;
  let plain: string;

  before(() => {
    temp = tempDir();
    site = path.join(temp.dir, 'my-site');
    plain = path.join(temp.dir, 'plain');
    for (const folder of ['css', 'img', 'drafts', 'scripts']) {
      mkdirSync(path.join(site, folder), { recursive: true });
    }
    mkdirSync(plain);
    writeFileSync(path.join(plain, 'index.html'), '<h1>Home</h1>');
    writeFileSync(path.join(site, 'index.html'), '<h1>Home</h1>');
    writeDwsync(site, [entry('index.html', FTP), entry('index.html', FOLDER), entry('about.html', FTP)]);
    writeDwsync(path.join(site, 'css'), [entry('site.css', FTP.toUpperCase()), entry('site.css', 'D:/Sites/my-site-testing')]);
    writeDwsync(path.join(site, 'drafts'), [entry('notes.md', 'sftp.example.com//var/www/my-site/')]);
    mkdirSync(path.join(site, 'img', '_notes'));
    writeFileSync(path.join(site, 'img', '_notes', 'dwsync.xml'), '<!DOCTYPE dwsync>\n<dwsync></dwsync>');
  });

  after(() => {
    temp.cleanup();
  });

  test('lists each server once, whatever the case and final slash of its name, with the most used first', async () => {
    assert.deepEqual(await findDreamweaverServers(site), [
      { server: FTP, files: 3 },
      { server: FOLDER, files: 2 },
      { server: 'sftp.example.com//var/www/my-site/', files: 1 },
    ]);
  });

  test('leaves cloaked folders out', async () => {
    const cloak = siteCloak({ cloaking: { enabled: true, patterns: ['/drafts/'], paths: [] } });
    assert.deepEqual(
      (await findDreamweaverServers(site, { cloak })).map((found) => found.server),
      [FTP, FOLDER],
    );
  });

  test('stops at the folder limit and when it is told to', async () => {
    assert.deepEqual(await findDreamweaverServers(site, { maxFolders: 1 }), [
      { server: FTP, files: 2 },
      { server: FOLDER, files: 1 },
    ]);
    assert.deepEqual(await findDreamweaverServers(site, { maxFolders: 0 }), []);
    assert.deepEqual(await findDreamweaverServers(site, { signal: AbortSignal.abort() }), []);
  });

  test('finds records in the folder or below it, and none where there are none', async () => {
    assert.equal(await hasDreamweaverRecords(site), true);
    assert.equal(await hasDreamweaverRecords(path.join(site, 'css')), true);
    assert.equal(await hasDreamweaverRecords(path.join(site, 'img')), false);
    assert.equal(await hasDreamweaverRecords(plain), false);
    assert.equal(await hasDreamweaverRecords(path.join(temp.dir, 'missing')), false);
    assert.deepEqual(await findDreamweaverServers(path.join(temp.dir, 'missing')), []);
  });

  test('never enters a link, and never reads records through one', async (t) => {
    const linked = path.join(temp.dir, 'linked');
    mkdirSync(path.join(linked, 'docs'), { recursive: true });
    try {
      symlinkSync(path.join(site, '_notes'), path.join(linked, '_notes'), 'junction');
      symlinkSync(path.join(site, 'css'), path.join(linked, 'docs', 'css'), 'junction');
    } catch {
      t.skip('creating folder links is not permitted here');
      return;
    }
    assert.equal(await hasDreamweaverRecords(linked), false);
    assert.deepEqual(await findDreamweaverServers(linked), []);
  });

  test('reads a file as records, as missing, or as damaged', async () => {
    const read = await readDwsyncFile(path.join(site, '_notes', 'dwsync.xml'));
    assert.equal(read.state, 'ok');
    assert.equal(read.document.entries.length, 3);
    assert.deepEqual(await readDwsyncFile(path.join(site, 'scripts', '_notes', 'dwsync.xml')), { state: 'missing' });
    assert.deepEqual(await readDwsyncFile(path.join(site, 'index.html', 'dwsync.xml')), { state: 'missing' });
    assert.deepEqual(await readDwsyncFile(path.join(site, 'img', '_notes', 'dwsync.xml')), { state: 'damaged' });
    assert.deepEqual(await readDwsyncFile(path.join(site, 'css')), { state: 'damaged' });
  });

  test('treats a file over the size limit as damaged', async () => {
    const big = path.join(temp.dir, 'big.xml');
    const text = dwsyncText([entry('index.html', FTP)], '\n');
    writeFileSync(big, text.replace('</dwsync>', `${' '.repeat(MAX_DWSYNC_BYTES)}</dwsync>`));
    assert.deepEqual(await readDwsyncFile(big), { state: 'damaged' });
  });

  test('removes the entries of one server from every folder and keeps the rest', async () => {
    const copy = path.join(temp.dir, 'reset');
    mkdirSync(path.join(copy, 'css'), { recursive: true });
    mkdirSync(path.join(copy, 'img'), { recursive: true });
    const root = writeDwsync(copy, [entry('index.html', FTP), entry('index.html', FOLDER), entry('about.html', FTP)], '\n');
    const css = writeDwsync(path.join(copy, 'css'), [entry('site.css', '203.0.113.10//PUBLIC_HTML')]);
    const img = writeDwsync(path.join(copy, 'img'), [entry('hero.svg', FOLDER)]);
    const imgBefore = readFileSync(img, 'utf8');

    assert.equal(await removeDreamweaverEntries(copy, FTP), 3);
    assert.equal(readFileSync(root, 'utf8'), dwsyncText([entry('index.html', FOLDER)], '\n'));
    assert.equal(existsSync(css), false);
    assert.equal(existsSync(path.dirname(css)), false, 'a _notes folder left empty goes with its file');
    assert.equal(readFileSync(img, 'utf8'), imgBefore);
    assert.equal(await removeDreamweaverEntries(copy, FTP), 0);
  });

  test('an emptied folder loses the records left in it, and only then', async () => {
    const emptied = path.join(temp.dir, 'emptied');
    const kept = path.join(temp.dir, 'kept');
    const extra = path.join(temp.dir, 'extra');
    for (const folder of [emptied, kept, extra]) {
      mkdirSync(folder);
      writeDwsync(folder, [entry('index.html', FTP)]);
    }
    writeFileSync(path.join(kept, 'index.html'), '<h1>Home</h1>');
    writeFileSync(path.join(extra, '_notes', 'index.html.mno'), '<info/>');

    await removeLeftoverNotes(emptied);
    assert.deepEqual(readdirSync(emptied), []);
    await removeLeftoverNotes(kept);
    assert.deepEqual(readdirSync(kept).sort(), ['_notes', 'index.html']);
    await removeLeftoverNotes(extra);
    assert.deepEqual(readdirSync(path.join(extra, '_notes')).sort(), ['dwsync.xml', 'index.html.mno']);
  });
});

describe('the clock of a server as Dreamweaver reads it', () => {
  const HOUR = 3600;

  test('is the step most entries share, when at least three share it', () => {
    assert.deepEqual(learnClock([-5 * HOUR, -5 * HOUR, -5 * HOUR, 7200, 90], 'minute', 5), new DreamweaverClock('minute', -5 * HOUR));
    assert.equal(learnClock([-5 * HOUR, -5 * HOUR], 'minute', 2), undefined);
    assert.equal(learnClock([], 'minute', 4), undefined);
  });

  test('is not known when another step ties with the winner, or the winner is beyond 16 hours', () => {
    assert.equal(learnClock([60, 60, 60, 900, 900, 900], 'minute', 6), undefined);
    assert.equal(learnClock([17 * HOUR, 17 * HOUR, 17 * HOUR], 'minute', 3), undefined);
    assert.deepEqual(learnClock([16 * HOUR, 16 * HOUR, 16 * HOUR], 'minute', 3), new DreamweaverClock('minute', 16 * HOUR));
  });

  test('a step one hour from the winner does not unseat it, whichever has more', () => {
    assert.deepEqual(learnClock([0, 0, 0, HOUR, HOUR, HOUR], 'second', 6), new DreamweaverClock('second', 0));
    assert.deepEqual(learnClock([-HOUR, -HOUR, -HOUR, -HOUR, 0, 0, 0], 'second', 7), new DreamweaverClock('second', -HOUR));
  });

  test("is this tool's own when no entry names the server", () => {
    assert.deepEqual(learnClock([], 'second', 0), new DreamweaverClock('second', 0));
    assert.deepEqual(learnClock([], 'minute', 0), new DreamweaverClock('minute', 0));
  });

  test('matches a server time on its own clock, give or take the hour of daylight time', () => {
    const server = Date.parse('2026-01-15T19:21:42.500Z');
    const minute = new DreamweaverClock('minute', 5 * HOUR);
    const recorded = minute.remoteFor(server, Date.now());
    assert.equal(filetimeToMs(recorded), Date.parse('2026-01-15T14:21:00.000Z'));
    assert.equal(minute.matches(server, recorded), true);
    assert.equal(minute.matches(server + 17_000, recorded), true, 'within the same minute');
    assert.equal(minute.matches(server + 60_000, recorded), false);
    assert.equal(minute.matches(server + 3_600_000, recorded), true);
    assert.equal(minute.matches(server - 3_600_000, recorded), true);
    assert.equal(minute.matches(server + 7_200_000, recorded), false);

    const second = new DreamweaverClock('second', 0);
    const exact = second.remoteFor(server, Date.now());
    assert.equal(filetimeToMs(exact), Date.parse('2026-01-15T19:21:42.000Z'));
    assert.equal(second.matches(server, exact), true);
    assert.equal(second.matches(server + 1000, exact), false);
    assert.equal(DreamweaverClock.step('second', server, exact), 0);
    assert.equal(DreamweaverClock.step('minute', server, recorded), 5 * HOUR);
  });

  test('moves the time of a folder server by the difference between the zone offset now and then', () => {
    const winter = Date.parse('2025-12-02T18:05:41.118Z');
    const summer = Date.parse('2026-07-10T09:00:00.000Z');
    const zone = (atMs: number): number => (new Date(atMs).getUTCMonth() >= 3 && new Date(atMs).getUTCMonth() <= 9 ? 240 : 300);
    const clock = new DreamweaverClock('second', 0);
    assert.equal(clock.remoteFor(winter, summer, zone), 134091687410000000n);
    assert.equal(filetimeToMs(clock.remoteFor(winter, winter, zone)), Date.parse('2025-12-02T18:05:41.000Z'));
    assert.equal(filetimeToMs(clock.remoteFor(summer, winter, zone)), summer + 3_600_000);
    assert.equal(clock.matches(winter, clock.remoteFor(winter, summer, zone)), true);
  });
});
