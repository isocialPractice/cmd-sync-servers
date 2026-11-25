import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { siteCloak } from '../../../src/sync/cloak.ts';
import { findDreamweaverServers, hasDreamweaverRecords, MAX_DWSYNC_BYTES, readDwsyncFile } from '../../../src/sync/dreamweaver.ts';
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
});
