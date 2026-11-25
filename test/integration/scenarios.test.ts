import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { isSyncError } from '../../src/errors.ts';
import { dreamweaverServerName, parseDwsync, toFiletime, type DwsyncEntry } from '../../src/sync/dwsync.ts';
import { STATUS } from '../../src/sync/messages.ts';
import { isCaseSensitive, type LinkPolicy } from '../../src/sync/paths.ts';
import { resultLine, type SyncResult } from '../../src/sync/execute.ts';
import type { SyncPlan } from '../../src/sync/plan.ts';
import type { SyncSession } from '../../src/sync/session.ts';
import { filesContaining } from '../helpers/cli.ts';
import { entryFor, writeDwsync, type FixtureEntry } from '../helpers/dwsync.ts';
import type { Kind } from '../sandbox/rig.ts';
import { BASE_TIME, startSiteRig, type SessionOptions, type SiteRig, type SiteRigOptions } from '../sandbox/site-rig.ts';
import type { SftpSandbox } from '../sandbox/sftp-server.ts';

const LATER = BASE_TIME + 3_600_000;
const KINDS: readonly Kind[] = ['local', 'sftp', 'ftps'];

/**
 * Runs a scenario on a fresh site, then searches every file the run wrote
 * (settings, state, logs, the local folder) and every log record for the
 * server password.
 */
async function withSite<T>(kind: Kind, options: SiteRigOptions, run: (rig: SiteRig) => Promise<T>): Promise<T> {
  const rig = await startSiteRig(kind, options);
  try {
    const value = await run(rig);
    assert.deepEqual(filesContaining(rig.home, rig.rig.password), [], 'a settings or state file holds the password');
    assert.deepEqual(filesContaining(rig.localDir, rig.rig.password), [], 'a local file holds the password');
    assert.ok(!JSON.stringify(rig.records).includes(rig.rig.password), 'a log record holds the password');
    return value;
  } finally {
    await rig.close();
  }
}

/** Puts the starting files on both sides and synchronizes them, so later steps have records. */
async function synced(rig: SiteRig, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    rig.write('local', name, content);
  }
  const session = await rig.open();
  try {
    const result = await session.execute(await session.plan({ direction: 'put' }));
    assert.equal(result.failed, 0, JSON.stringify(result.items));
  } finally {
    await session.close();
  }
}

for (const kind of KINDS) {
  describe(`scenarios over ${kind}`, () => {
    test('first sync in each direction', async () => {
      await withSite(kind, {}, async (rig) => {
        rig.write('local', 'index.html', '<h1>Home</h1>');
        rig.write('local', 'css/site.css', 'body {}');
        const session = await rig.open();
        try {
          const plan = await session.plan({ direction: 'put' });
          assert.deepEqual(plan.items.map((item) => [item.path, item.action, item.checked]), [
            ['css/site.css', 'put', true],
            ['index.html', 'put', true],
          ]);
          const result = await session.execute(plan);
          assert.equal(resultLine(result), 'Synchronized 2 files. 0 failed. 0 skipped.');
          assert.equal(rig.read('remote', 'css/site.css'), 'body {}');
          assert.equal(Math.floor(statSync(path.join(rig.remoteDir, 'index.html')).mtimeMs / 1000), BASE_TIME / 1000);
          assert.deepEqual((await session.plan({ direction: 'both' })).items, []);
          assert.deepEqual(readdirSync(rig.remoteDir).filter((name) => name.endsWith('.part')), []);
        } finally {
          await session.close();
        }
      });
      await withSite(kind, {}, async (rig) => {
        rig.write('remote', 'about.html', 'About', BASE_TIME);
        const session = await rig.open();
        try {
          const result = await session.execute(await session.plan({ direction: 'get' }));
          assert.equal(result.done, 1);
          assert.equal(rig.read('local', 'about.html'), 'About');
          assert.equal(statSync(path.join(rig.localDir, 'about.html')).mtimeMs, BASE_TIME);
        } finally {
          await session.close();
        }
      });
    });

    test('an edit on each side goes the right way', async () => {
      await withSite(kind, {}, async (rig) => {
        await synced(rig, { 'index.html': 'v1', 'about.html': 'v1' });
        rig.write('local', 'index.html', 'v2 local', LATER);
        rig.write('remote', 'about.html', 'v2 remote', LATER);
        const session = await rig.open();
        try {
          const plan = await session.plan({ direction: 'both' });
          assert.deepEqual(plan.items.map((item) => [item.path, item.state, item.action]), [
            ['about.html', 'remote-changed', 'get'],
            ['index.html', 'local-changed', 'put'],
          ]);
          await session.execute(plan);
          assert.equal(rig.read('remote', 'index.html'), 'v2 local');
          assert.equal(rig.read('local', 'about.html'), 'v2 remote');
          assert.deepEqual((await session.plan({ direction: 'both' })).items, []);
        } finally {
          await session.close();
        }
      });
    });

    test('a conflict waits for a decision, and each decision does what it says', async () => {
      await withSite(kind, {}, async (rig) => {
        const files = { 'put.html': 'v1', 'get.html': 'v1', 'skip.html': 'v1', 'synced.html': 'v1' };
        await synced(rig, files);
        for (const name of Object.keys(files)) {
          rig.write('local', name, `${name} local edit`, LATER);
          rig.write('remote', name, `${name} remote edit!`, LATER);
        }
        const session = await rig.open();
        try {
          const plan = await session.plan({ direction: 'put' });
          assert.ok(plan.items.every((item) => item.action === 'resolve' && item.checked === undefined));
          const untouched = await session.execute(plan);
          assert.equal(untouched.done, 0);
          assert.equal(untouched.unresolved, 4);
          plan.setAction('put.html', 'put');
          plan.setAction('get.html', 'get');
          plan.setAction('skip.html', 'skip');
          plan.setAction('synced.html', 'synced');
          const result = await session.execute(plan);
          assert.equal(result.done, 3);
          assert.equal(rig.read('remote', 'put.html'), 'put.html local edit');
          assert.equal(rig.read('local', 'get.html'), 'get.html remote edit!');
          assert.equal(rig.read('local', 'skip.html'), 'skip.html local edit');
          assert.equal(rig.read('remote', 'skip.html'), 'skip.html remote edit!');
          const next = await session.plan({ direction: 'both' });
          assert.deepEqual(next.items.map((item) => [item.path, item.action]), [['skip.html', 'resolve']]);
          const kept = readdirSync(path.join(rig.home, 'state', 'recovery', rig.site.id), { recursive: true, encoding: 'utf8' });
          assert.ok(kept.some((name) => name.endsWith('get.html')), 'the overwritten local file was kept');
        } finally {
          await session.close();
        }
      });
    });

    test('deletes need the delete option, and never-synced orphans wait for a check', async () => {
      await withSite(kind, {}, async (rig) => {
        await synced(rig, { 'keep.html': 'k', 'old/page.html': 'old' });
        rig.remove('local', 'old');
        rig.write('remote', 'stray.html', 'stray');
        const session = await rig.open();
        try {
          assert.deepEqual((await session.plan({ direction: 'put' })).items, []);
          const plan = await session.plan({ direction: 'put', deleteOrphans: true });
          assert.deepEqual(plan.items.map((item) => [item.path, item.action, item.checked]), [
            ['old/page.html', 'delete-remote', true],
            ['stray.html', 'delete-remote', false],
          ]);
          await session.execute(plan, { allowMassDelete: true });
          assert.equal(rig.read('remote', 'old/page.html'), undefined);
          assert.equal(readdirSync(rig.remoteDir).includes('old'), false, 'the emptied folder was removed');
          assert.equal(rig.read('remote', 'stray.html'), 'stray');
          const again = await session.plan({ direction: 'put', deleteOrphans: true });
          again.setChecked('stray.html', true);
          await session.execute(again, { allowMassDelete: true });
          assert.equal(rig.read('remote', 'stray.html'), undefined);
          assert.equal(rig.read('remote', 'keep.html'), 'k');
        } finally {
          await session.close();
        }
      });
    });

    test('the mass-delete and empty-root guards stop a mirror before it starts', async () => {
      await withSite(kind, {}, async (rig) => {
        await synced(rig, { 'a.html': 'a', 'b.html': 'b', 'c.html': 'c', 'd.html': 'd' });
        rig.remove('local', 'a.html');
        rig.remove('local', 'b.html');
        const session = await rig.open();
        try {
          const plan = await session.plan({ direction: 'put', deleteOrphans: true });
          await assert.rejects(session.execute(plan), (error) => isSyncError(error, 'E_MASS_DELETE') && error.message.includes('2 remote deletes'));
          assert.equal(rig.read('remote', 'a.html'), 'a');
          const asked: number[] = [];
          await session.execute(plan, {
            confirmMassDelete: (count) => {
              asked.push(count);
              return Promise.resolve(true);
            },
          });
          assert.deepEqual(asked, [2]);
          assert.equal(rig.read('remote', 'a.html'), undefined);

          rig.remove('local', 'c.html');
          rig.remove('local', 'd.html');
          const empty = await session.plan({ direction: 'put', deleteOrphans: true });
          await assert.rejects(session.execute(empty, { allowMassDelete: true }), (error) => isSyncError(error, 'E_EMPTY_ROOT'));
          assert.equal(rig.read('remote', 'c.html'), 'c');
        } finally {
          await session.close();
        }
      });
    });

    test('cloaked files are never scanned, transferred or deleted', async () => {
      await withSite(kind, { site: { cloaking: { patterns: ['.psd archive*', 'node_modules/'], paths: ['drafts'] } } }, async (rig) => {
        for (const name of ['art/cover.psd', 'archive-2026.zip', 'node_modules/lib/x.js', 'drafts/next.html', 'index.html']) {
          rig.write('local', name, name);
        }
        rig.write('remote', 'drafts/remote-only.html', 'r');
        const session = await rig.open();
        try {
          const plan = await session.plan({ direction: 'both', deleteOrphans: true });
          assert.deepEqual(plan.items.map((item) => item.path), ['index.html']);
          await session.execute(plan);
          assert.deepEqual(readdirSync(rig.remoteDir).sort(), ['drafts', 'index.html']);
          assert.equal(rig.read('remote', 'drafts/remote-only.html'), 'r');
        } finally {
          await session.close();
        }
      });
    });

    test('the guard holds back sensitive files until checked', async () => {
      await withSite(kind, {}, async (rig) => {
        rig.write('local', '.env', 'SECRET=1');
        rig.write('local', 'index.html', 'home');
        const session = await rig.open();
        try {
          const plan = await session.plan({ direction: 'put' });
          assert.equal(plan.item('.env')?.checked, false);
          assert.equal(plan.item('.env')?.guarded, '.env');
          await session.execute(plan);
          assert.equal(rig.read('remote', '.env'), undefined);
          assert.equal(rig.read('remote', 'index.html'), 'home');
        } finally {
          await session.close();
        }
      });
    });

    test('a file changed after the preview is skipped as stale', async () => {
      await withSite(kind, {}, async (rig) => {
        rig.write('local', 'a.html', 'a');
        rig.write('local', 'b.html', 'b');
        const session = await rig.open();
        try {
          const plan = await session.plan({ direction: 'put' });
          rig.write('local', 'a.html', 'a changed', LATER);
          const result = await session.execute(plan);
          assert.deepEqual(result.items.map((item) => [item.path, item.outcome]), [
            ['a.html', 'stale'],
            ['b.html', 'done'],
          ]);
          assert.equal(rig.read('remote', 'a.html'), undefined);
        } finally {
          await session.close();
        }
      });
    });

    test('a cancelled run keeps what it finished and leaves no partial files', async () => {
      await withSite(kind, {}, async (rig) => {
        rig.write('local', 'a.html', 'a');
        const session = await rig.open();
        try {
          const plan = await session.plan({ direction: 'put' });
          const controller = new AbortController();
          controller.abort();
          const result = await session.execute(plan, { signal: controller.signal });
          assert.equal(result.cancelled, true);
          assert.equal(result.items[0]?.outcome, 'cancelled');
          assert.deepEqual(readdirSync(rig.remoteDir), []);
          assert.equal(session.record('a.html'), undefined);
        } finally {
          await session.close();
        }
      });
    });

    test('status reports changes on each side and the last sync time', async () => {
      await withSite(kind, {}, async (rig) => {
        await synced(rig, { 'a.html': 'a', 'b.html': 'b' });
        rig.write('local', 'a.html', 'a2', LATER);
        rig.write('remote', 'c.html', 'c');
        const session = await rig.open();
        try {
          const status = await session.status();
          assert.deepEqual(status.local.map((entry) => [entry.path, entry.state]), [['a.html', 'local-changed']]);
          assert.deepEqual(status.remote.map((entry) => [entry.path, entry.state]), [['c.html', 'remote-only']]);
          assert.equal(status.inSync, 1);
          assert.ok((status.lastSyncedAt ?? 0) > 0);
        } finally {
          await session.close();
        }
      });
    });

    test('single-file Put and Get run at once unless a decision is needed', async () => {
      await withSite(kind, {}, async (rig) => {
        await synced(rig, { 'a.html': 'a', 'b.html': 'b' });
        rig.write('local', 'a.html', 'a2', LATER);
        rig.write('remote', 'b.html', 'b2', LATER);
        const session = await rig.open();
        try {
          const put = await session.put(['a.html']);
          assert.equal(put.result?.done, 1);
          assert.equal(rig.read('remote', 'a.html'), 'a2');
          const blocked = await session.put(['b.html']);
          assert.equal(blocked.result, undefined);
          assert.equal(blocked.plan.items[0]?.action, 'resolve');
          const got = await session.get(['b.html']);
          assert.equal(got.result?.done, 1);
          assert.equal(rig.read('local', 'b.html'), 'b2');
        } finally {
          await session.close();
        }
      });
    });

    test('compare fetches the remote copy to a private temp file; mark-synced and reset change only records', async () => {
      await withSite(kind, {}, async (rig) => {
        rig.write('local', 'a.html', 'local copy');
        rig.write('remote', 'a.html', 'remote copy');
        const session = await rig.open();
        try {
          const comparison = await session.compare('a.html');
          assert.equal(readFileSync(comparison.remote?.file ?? '', 'utf8'), 'remote copy');
          assert.equal(comparison.local?.file, path.join(rig.localDir, 'a.html'));
          await comparison.dispose();
          assert.equal(await session.markSynchronized(['a.html']), 1);
          assert.deepEqual((await session.plan({ direction: 'both' })).items, []);
          await session.resetState();
          assert.equal((await session.plan({ direction: 'both' })).items[0]?.state, 'first-sync-conflict');
        } finally {
          await session.close();
        }
      });
    });
  });
}

/** Makes a link, or says it could not: a file link needs a privilege on Windows that a junction does not. */
function link(target: string, at: string, type: 'file' | 'junction'): boolean {
  mkdirSync(path.dirname(at), { recursive: true });
  try {
    symlinkSync(target, at, type);
    return true;
  } catch {
    return false;
  }
}

function writeAt(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const isLink = (file: string): boolean => lstatSync(file).isSymbolicLink();

/**
 * The local folder of a site with links: `shared/site.css` and
 * `shared/img/hero.svg`; `css/site.css`, a file link to `../shared/site.css`;
 * `img/`, a junction to `shared/img`; and out of the site, `css/theme.css`
 * to `<outside>/theme/theme.css` and `fonts/` to `<outside>/fonts`. File
 * links are left out where this system refuses them.
 */
function linkedSite(rig: SiteRig): { readonly outside: string; readonly fileLinks: boolean } {
  rig.write('local', 'shared/site.css', 'body {}');
  rig.write('local', 'shared/img/hero.svg', '<svg/>');
  const outside = path.join(rig.localDir, '..', 'outside');
  writeAt(path.join(outside, 'fonts', 'site.woff2'), 'font');
  writeAt(path.join(outside, 'theme', 'theme.css'), 'h1 {}');
  assert.ok(link(path.join(rig.localDir, 'shared', 'img'), path.join(rig.localDir, 'img'), 'junction'));
  assert.ok(link(path.join(outside, 'fonts'), path.join(rig.localDir, 'fonts'), 'junction'));
  const fileLinks =
    link(path.join('..', 'shared', 'site.css'), path.join(rig.localDir, 'css', 'site.css'), 'file') &&
    link(path.join(outside, 'theme', 'theme.css'), path.join(rig.localDir, 'css', 'theme.css'), 'file');
  return { outside, fileLinks };
}

const linkPolicy = (symlinks: LinkPolicy, more: Pick<SiteRigOptions, 'site'>['site'] = {}): SiteRigOptions => ({ site: { ...more, sync: { symlinks } } });

/** Runs a plan in `direction` and checks that nothing failed. */
async function run(rig: SiteRig, direction: 'put' | 'get', deleteOrphans = false): Promise<SyncResult> {
  const session = await rig.open();
  try {
    const result = await session.execute(await session.plan({ direction, deleteOrphans }), { allowMassDelete: true });
    return result;
  } finally {
    await session.close();
  }
}

async function planOf(rig: SiteRig, direction: 'put' | 'get' | 'both'): Promise<SyncPlan> {
  const session = await rig.open();
  try {
    return await session.plan({ direction });
  } finally {
    await session.close();
  }
}

const rows = (plan: SyncPlan): string[] => plan.items.filter((item) => item.state !== 'problem').map((item) => `${item.path} ${item.action}`);
const problems = (plan: SyncPlan): string[] => plan.items.filter((item) => item.state === 'problem').map((item) => `${item.path}: ${item.status}`);
const outcome = (result: SyncResult, target: string): string | undefined => result.items.find((item) => item.path === target)?.outcome;

for (const kind of ['local', 'sftp', 'ftps'] as const) {
  describe(`symbolic links over ${kind}`, () => {
    test('follow-inside-root puts linked files and folders as ordinary files', async () => {
      await withSite(kind, linkPolicy('follow-inside-root'), async (rig) => {
        const { fileLinks } = linkedSite(rig);
        const result = await run(rig, 'put');
        assert.equal(result.failed, 0, JSON.stringify(result.items));
        assert.equal(result.done, fileLinks ? 4 : 3);
        assert.equal(rig.read('remote', 'img/hero.svg'), '<svg/>');
        assert.equal(isLink(path.join(rig.remoteDir, 'img')), false);
        if (fileLinks) {
          assert.equal(rig.read('remote', 'css/site.css'), 'body {}');
          assert.equal(isLink(path.join(rig.remoteDir, 'css', 'site.css')), false);
        }
        assert.deepEqual(rows(await planOf(rig, 'both')), []);
      });
    });

    test('a Get through a file link writes the file it points to and keeps the link', async (t) => {
      await withSite(kind, linkPolicy('follow-inside-root'), async (rig) => {
        if (!linkedSite(rig).fileLinks) {
          t.skip('creating file links is not permitted here');
          return;
        }
        await run(rig, 'put');
        rig.write('remote', 'css/site.css', 'h1 {}', LATER);
        const result = await run(rig, 'get');
        assert.equal(outcome(result, 'css/site.css'), 'done', JSON.stringify(result.items));
        assert.equal(readFileSync(path.join(rig.localDir, 'shared', 'site.css'), 'utf8'), 'h1 {}');
        assert.ok(isLink(path.join(rig.localDir, 'css', 'site.css')));
        const kept = result.items.find((item) => item.path === 'css/site.css')?.recoveredTo ?? '';
        assert.equal(readFileSync(kept, 'utf8'), 'body {}');
        assert.deepEqual(rows(await planOf(rig, 'put')), ['shared/site.css put']);
      });
    });

    test('a new file on the server lands in the folder a folder link points to', async () => {
      await withSite(kind, linkPolicy('follow-inside-root'), async (rig) => {
        linkedSite(rig);
        await run(rig, 'put');
        rig.write('remote', 'img/icon.svg', '<svg id="icon"/>', LATER);
        const result = await run(rig, 'get');
        assert.equal(outcome(result, 'img/icon.svg'), 'done', JSON.stringify(result.items));
        assert.equal(readFileSync(path.join(rig.localDir, 'shared', 'img', 'icon.svg'), 'utf8'), '<svg id="icon"/>');
        assert.ok(isLink(path.join(rig.localDir, 'img')));
      });
    });

    test('two names of one file changed on the server: one Get runs, the other is stale and waits for a decision', async (t) => {
      await withSite(kind, linkPolicy('follow-inside-root'), async (rig) => {
        if (!linkedSite(rig).fileLinks) {
          t.skip('creating file links is not permitted here');
          return;
        }
        await run(rig, 'put');
        rig.write('remote', 'css/site.css', 'a { color: red }', LATER);
        rig.write('remote', 'shared/site.css', 'b {}', LATER);
        const result = await run(rig, 'get');
        assert.equal(outcome(result, 'css/site.css'), 'done', JSON.stringify(result.items));
        assert.equal(outcome(result, 'shared/site.css'), 'stale', JSON.stringify(result.items));
        assert.equal(readFileSync(path.join(rig.localDir, 'shared', 'site.css'), 'utf8'), 'a { color: red }');
        assert.deepEqual(rows(await planOf(rig, 'both')), ['shared/site.css resolve']);
      });
    });

    test('a local delete of a file link removes the link and keeps a copy of its content', async (t) => {
      await withSite(kind, linkPolicy('follow-inside-root'), async (rig) => {
        if (!linkedSite(rig).fileLinks) {
          t.skip('creating file links is not permitted here');
          return;
        }
        await run(rig, 'put');
        rig.remove('remote', 'css/site.css');
        const result = await run(rig, 'get', true);
        assert.equal(outcome(result, 'css/site.css'), 'done', JSON.stringify(result.items));
        assert.equal(existsSync(path.join(rig.localDir, 'css', 'site.css')), false);
        assert.equal(readFileSync(path.join(rig.localDir, 'shared', 'site.css'), 'utf8'), 'body {}');
        const kept = result.items.find((item) => item.path === 'css/site.css')?.recoveredTo ?? '';
        assert.equal(isLink(kept), false);
        assert.equal(readFileSync(kept, 'utf8'), 'body {}');
      });
    });

    test('a folder link emptied by the delete option stays', async () => {
      await withSite(kind, linkPolicy('follow-inside-root'), async (rig) => {
        linkedSite(rig);
        await run(rig, 'put');
        rig.remove('remote', 'img');
        const result = await run(rig, 'get', true);
        assert.equal(outcome(result, 'img/hero.svg'), 'done', JSON.stringify(result.items));
        assert.ok(isLink(path.join(rig.localDir, 'img')));
        assert.equal(existsSync(path.join(rig.localDir, 'shared', 'img', 'hero.svg')), false);
        assert.ok(existsSync(path.join(rig.localDir, 'shared', 'img')));
      });
    });

    test('follow puts and gets through links out of the site, and says so on every such row', async () => {
      await withSite(kind, linkPolicy('follow'), async (rig) => {
        const { outside, fileLinks } = linkedSite(rig);
        const put = await planOf(rig, 'put');
        const out = put.items.filter((item) => item.status === STATUS.throughLinkOutside).map((item) => item.path);
        assert.deepEqual(out, fileLinks ? ['css/theme.css', 'fonts/site.woff2'] : ['fonts/site.woff2']);
        assert.equal((await run(rig, 'put')).failed, 0);
        assert.equal(rig.read('remote', 'fonts/site.woff2'), 'font');
        rig.write('remote', 'fonts/site.woff2', 'font 2', LATER);
        const get = await planOf(rig, 'get');
        assert.equal(get.item('fonts/site.woff2')?.status, STATUS.throughLinkOutside);
        const result = await run(rig, 'get');
        assert.equal(outcome(result, 'fonts/site.woff2'), 'done', JSON.stringify(result.items));
        assert.equal(readFileSync(path.join(outside, 'fonts', 'site.woff2'), 'utf8'), 'font 2');
        assert.ok(isLink(path.join(rig.localDir, 'fonts')));
      });
    });

    test('links that are not followed are problem rows that say why, single paths too', async () => {
      await withSite(kind, linkPolicy('follow-inside-root'), async (rig) => {
        const { fileLinks } = linkedSite(rig);
        assert.deepEqual(problems(await planOf(rig, 'put')), [
          ...(fileLinks ? [`css/theme.css: ${STATUS.linkOutside}`] : []),
          `fonts: ${STATUS.linkOutside}`,
        ]);
      });
      await withSite(kind, linkPolicy('skip'), async (rig) => {
        const { fileLinks } = linkedSite(rig);
        assert.deepEqual(
          problems(await planOf(rig, 'put')),
          [...(fileLinks ? ['css/site.css', 'css/theme.css'] : []), 'fonts', 'img'].map((item) => `${item}: ${STATUS.linkNotFollowed}`),
        );
        const session = await rig.open();
        try {
          const single = await session.put(['img/hero.svg']);
          assert.equal(single.result, undefined);
          assert.deepEqual(problems(single.plan), [`img: ${STATUS.linkNotFollowed}`]);
          assert.deepEqual(rows(single.plan), []);
        } finally {
          await session.close();
        }
      });
    });

    test('a link to a sensitive file is held back like the file', async (t) => {
      await withSite(kind, linkPolicy('follow-inside-root'), async (rig) => {
        rig.write('local', '.env', 'TOKEN=demo');
        if (!link(path.join('..', '.env'), path.join(rig.localDir, 'css', 'app.css'), 'file')) {
          t.skip('creating file links is not permitted here');
          return;
        }
        const row = (await planOf(rig, 'put')).item('css/app.css');
        assert.equal(row?.guarded, '.env');
        assert.equal(row.checked, false);
      });
    });

    test('a folder link into a cloaked folder is cloaked', async () => {
      await withSite(kind, linkPolicy('follow-inside-root', { cloaking: { patterns: ['/drafts/'] } }), async (rig) => {
        rig.write('local', 'drafts/img/raw.svg', '<svg id="raw"/>');
        rig.write('local', 'index.html', '<h1>Home</h1>');
        assert.ok(link(path.join(rig.localDir, 'drafts', 'img'), path.join(rig.localDir, 'img'), 'junction'));
        const plan = await planOf(rig, 'put');
        assert.deepEqual(rows(plan), ['index.html put']);
        assert.deepEqual(problems(plan), []);
      });
    });

    test('compare reads the file a link points to', async (t) => {
      await withSite(kind, linkPolicy('follow-inside-root'), async (rig) => {
        if (!linkedSite(rig).fileLinks) {
          t.skip('creating file links is not permitted here');
          return;
        }
        rig.write('remote', 'css/site.css', 'h1 {}');
        const session = await rig.open();
        try {
          const comparison = await session.compare('css/site.css');
          assert.equal(comparison.local?.file, path.join(realpathSync.native(rig.localDir), 'shared', 'site.css'));
          assert.equal(path.basename(comparison.remote?.file ?? ''), 'site.css');
          assert.equal(readFileSync(comparison.remote?.file ?? '', 'utf8'), 'h1 {}');
          await comparison.dispose();
        } finally {
          await session.close();
        }
      });
    });

    test('a link back to the local root is a problem row, and the scan ends', async () => {
      await withSite(kind, linkPolicy('follow-inside-root'), async (rig) => {
        rig.write('local', 'index.html', '<h1>Home</h1>');
        assert.ok(link(rig.localDir, path.join(rig.localDir, 'css', 'loop'), 'junction'));
        const plan = await planOf(rig, 'put');
        assert.deepEqual(rows(plan), ['index.html put']);
        assert.deepEqual(problems(plan), [`css/loop: ${STATUS.linkLoop}`]);
      });
    });
  });
}

describe('faults and hostile servers', () => {
  for (const kind of ['sftp', 'ftps'] as const) {
    test(`${kind}: an interrupted download is retried on a fresh connection`, async () => {
      await withSite(kind, { faults: { dropAfterBytes: 65_536, dropTransfers: 1 } }, async (rig) => {
        rig.write('remote', 'big.bin', 'x'.repeat(400_000));
        const session = await rig.open();
        try {
          const result = await session.execute(await session.plan({ direction: 'get' }));
          assert.equal(result.done, 1, JSON.stringify(result.items));
          assert.equal(rig.read('local', 'big.bin')?.length, 400_000);
          assert.deepEqual(readdirSync(rig.localDir).filter((name) => name.endsWith('.part')), []);
        } finally {
          await session.close();
        }
      });
    });

    test(`${kind}: a download that keeps failing leaves the local copy as it was`, async () => {
      await withSite(kind, { faults: { dropAfterBytes: 65_536, dropTransfers: 10 } }, async (rig) => {
        rig.write('local', 'big.bin', 'old local copy');
        rig.write('remote', 'big.bin', 'x'.repeat(400_000), LATER);
        const session = await rig.open();
        try {
          const result = await session.execute(await session.plan({ direction: 'get' }));
          assert.equal(result.failed, 1, JSON.stringify(result.items));
          assert.equal(rig.read('local', 'big.bin'), 'old local copy');
          assert.deepEqual(readdirSync(rig.localDir).filter((name) => name.includes('.part')), []);
        } finally {
          await session.close();
        }
      });
    });

    test(`${kind}: hostile names and case twins become rows that are never written locally`, async () => {
      const names = ['../escape', 'CON.txt', 'a\\b.txt', 'Index.html', 'bad\u0000name'];
      await withSite(kind, { faults: { hostileNames: names, listingFolder: '/site' } }, async (rig) => {
        rig.write('remote', 'index.html', 'home');
        const session = await rig.open();
        try {
          const plan = await session.plan({ direction: 'get' });
          const problems = plan.items.filter((item) => item.state === 'problem').map((item) => item.path);
          assert.ok(problems.some((name) => name.includes('\u0000')));
          if (!(await isCaseSensitive(rig.localDir))) {
            assert.ok(problems.includes('Index.html') && problems.includes('index.html'));
          }
          if (process.platform === 'win32') {
            assert.ok(problems.includes('CON.txt') && problems.includes('a\\b.txt'));
          }
          await session.execute(plan);
          const written = readdirSync(rig.localDir, { recursive: true, encoding: 'utf8' });
          assert.ok(written.every((name) => !name.includes('escape') && !name.includes('\u0000')));
          assert.equal(readdirSync(path.dirname(rig.localDir)).includes('escape'), false);
        } finally {
          await session.close();
        }
      });
    });
  }

  test('local: with recovery off, a Get replaces the local file in one step and keeps nothing', async () => {
    await withSite('local', { site: { sync: { recovery: { enabled: false } } } }, async (rig) => {
      rig.write('local', 'page.html', 'old local copy');
      rig.write('remote', 'page.html', 'new server copy', LATER);
      const session = await rig.open();
      try {
        const result = await session.execute(await session.plan({ direction: 'get' }));
        assert.equal(result.done, 1, JSON.stringify(result.items));
        assert.equal(rig.read('local', 'page.html'), 'new server copy');
        assert.equal(result.items[0]?.recoveredTo, undefined);
      } finally {
        await session.close();
      }
    });
  });

  test('local: partial copies left by a crash are never synchronized', async () => {
    await withSite('local', {}, async (rig) => {
      rig.write('local', 'index.html', 'home');
      rig.write('local', '.index.html.sync-servers-0a1b2c3d.part', 'half a file');
      rig.write('remote', 'css/.site.css.sync-servers-99887766.part', 'half');
      const session = await rig.open();
      try {
        const plan = await session.plan({ direction: 'both' });
        assert.deepEqual(plan.items.map((item) => item.path), ['index.html']);
      } finally {
        await session.close();
      }
    });
  });

  test('sftp: an upload that keeps stalling leaves the server copy as it was', async () => {
    await withSite('sftp', { faults: { stallTransfers: 20 } }, async (rig) => {
      const serverId = rig.site.servers[0]?.id ?? '';
      await rig.registry.updateServer(rig.site.id, serverId, (server) => {
        server.options.timeoutSeconds = 1;
      });
      rig.write('remote', 'page.html', 'old server copy');
      rig.write('local', 'page.html', 'new local copy', LATER);
      const session = await rig.open();
      try {
        const result = await session.execute(await session.plan({ direction: 'put' }));
        assert.equal(result.failed, 1, JSON.stringify(result.items));
        assert.equal(rig.read('remote', 'page.html'), 'old server copy');
        assert.deepEqual(readdirSync(rig.remoteDir).filter((name) => name.includes('.part')), []);
      } finally {
        await session.close();
      }
    });
  });

  test('sftp: a new host key is pinned through the session, and a refused one stops the plan', async () => {
    await withSite('sftp', { unpinned: true }, async (rig) => {
      const refused = await rig.open();
      try {
        await assert.rejects(refused.plan({ direction: 'put' }), (error) => isSyncError(error, 'E_HOST_KEY_MISMATCH'));
      } finally {
        await refused.close();
      }
      const session = await rig.open({ interactive: true, confirmHostKey: () => Promise.resolve('accept-and-pin') });
      try {
        await session.plan({ direction: 'put' });
      } finally {
        await session.close();
      }
      const pinned = rig.registry.get(rig.site.id)?.servers[0]?.options.hostKey?.sha256;
      assert.equal(pinned, (rig.rig.sandbox as SftpSandbox).hostKeySha256);
    });
  });
});

/** The server of the scenarios as Dreamweaver names it, and another server of the same site. */
const DW_SERVER = '203.0.113.10//public_html/';
const DW_OTHER = 'D:/Sites/my-site-testing/';
/** This tool reads the server's clock five hours ahead of the Dreamweaver that wrote the fixture's records. */
const DW_CLOCK = 5 * 3600;
const DW_FILES: Readonly<Record<string, string>> = {
  'index.html': '<h1>Home</h1>',
  'about.html': '<h1>About</h1>',
  'contact.html': '<h1>Contact</h1>',
  'css/site.css': 'body {}',
  'img/hero.svg': '<svg/>',
  'img/icon.svg': '<svg id="icon"/>',
  'scripts/app.js': 'void 0;',
};
const DW_PATHS = Object.keys(DW_FILES).sort();
const DW_COUNT = DW_PATHS.length;
/** The files of the site's top folder, in the order their entries are written. */
const DW_ROOT = ['index.html', 'about.html', 'contact.html'];
const HOUR = 3_600_000;

/** A computer in a zone without daylight time, so what a run writes is the same wherever the tests run. */
const NO_DAYLIGHT: SessionOptions = { zoneOffsetMinutes: () => 0 };

interface DreamweaverSiteOptions {
  /** The setting. Default on. */
  readonly enabled?: boolean;
  readonly sync?: NonNullable<SiteRigOptions['site']>['sync'];
  /** The files Dreamweaver has an entry for. Default all. */
  readonly entries?: readonly string[];
}

/** Dreamweaver keeps an FTP server's times to the minute and a folder's to the second. */
const dwUnit = (kind: Kind): 'minute' | 'second' => (kind === 'local' ? 'second' : 'minute');
const parts = (target: string): string[] => target.split('/').filter((part) => part !== '');
const notesFile = (rig: SiteRig, folder = ''): string => path.join(rig.localDir, ...parts(folder), '_notes', 'dwsync.xml');
const clockPath = (rig: SiteRig): string => path.join(rig.home, 'state', 'sites', rig.site.id, `${rig.site.servers[0]?.id ?? ''}.dwsync.json`);
const serverTime = (rig: SiteRig, target: string): number => statSync(path.join(rig.remoteDir, ...parts(target))).mtimeMs;
const localTicks = (rig: SiteRig, target: string): bigint => toFiletime(lstatSync(path.join(rig.localDir, ...parts(target)), { bigint: true }).mtimeNs);

/** The server time Dreamweaver's records hold for a file as the server has it now. */
function recordedTime(rig: SiteRig, target: string, clockSeconds = DW_CLOCK): bigint {
  const unitMs = dwUnit(rig.kind) === 'second' ? 1000 : 60_000;
  return toFiletime(BigInt(Math.floor(serverTime(rig, target) / unitMs) * unitMs - clockSeconds * 1000) * 1_000_000n);
}

/** The entry Dreamweaver would hold for a file of the site as both sides are now. */
function dwEntry(rig: SiteRig, target: string, server = DW_SERVER): FixtureEntry {
  return entryFor(path.join(rig.localDir, ...parts(target)), serverTime(rig, target), server, { seconds: DW_CLOCK, unit: dwUnit(rig.kind) });
}

/** Writes the records of the folders of `targets` anew, with an entry per target and whatever `more` adds for it. */
function writeEntries(rig: SiteRig, targets: readonly string[], more: (target: string) => FixtureEntry[] = () => []): void {
  const folders = new Map<string, FixtureEntry[]>();
  for (const target of targets) {
    const folder = parts(target).slice(0, -1).join('/');
    folders.set(folder, [...(folders.get(folder) ?? []), dwEntry(rig, target), ...more(target)]);
  }
  for (const [folder, entries] of folders) {
    writeDwsync(path.join(rig.localDir, ...parts(folder)), entries);
  }
}

/** The entries a folder's records hold, as `name server` with what each records. */
function entriesOf(rig: SiteRig, folder = ''): DwsyncEntry[] {
  const file = notesFile(rig, folder);
  return existsSync(file) ? [...(parseDwsync(readFileSync(file, 'utf8'))?.entries ?? [])] : [];
}

async function inSession<T>(rig: SiteRig, work: (session: SyncSession) => Promise<T>, options: SessionOptions = NO_DAYLIGHT): Promise<T> {
  const session = await rig.open(options);
  try {
    return await work(session);
  } finally {
    await session.close();
  }
}

/** Plans the whole site both ways and saves what the plan found in sync, as a sync with nothing to transfer does. */
async function takeOver(rig: SiteRig): Promise<SyncPlan> {
  return inSession(rig, async (session) => {
    const plan = await session.plan({ direction: 'both' });
    await session.settle(plan);
    return plan;
  });
}

/**
 * A site as Dreamweaver left it: the same files on both sides, each server
 * copy later than its local copy, as after an upload, and an entry per file
 * in the `_notes/dwsync.xml` of its folder, on a clock five hours from the
 * server's. The server is known to Dreamweaver by another name than its host.
 */
async function dreamweaverSite<T>(kind: Kind, options: DreamweaverSiteOptions, run: (rig: SiteRig) => Promise<T>): Promise<T> {
  return withSite(kind, { site: { sync: { ...options.sync, dreamweaver: { enabled: options.enabled ?? true } } } }, async (rig) => {
    await rig.registry.updateServer(rig.site.id, rig.site.servers[0]?.id ?? '', (draft) => {
      draft.options.dreamweaverServer = DW_SERVER;
    });
    Object.entries(DW_FILES).forEach(([target, content], index) => {
      rig.write('local', target, content, BASE_TIME + index * 60_000);
      rig.write('remote', target, content, BASE_TIME + HOUR + index * 420_000 + 13_000);
    });
    writeEntries(rig, options.entries ?? DW_PATHS);
    return run(rig);
  });
}

const states = (plan: SyncPlan): string[] => plan.items.map((item) => `${item.path} ${item.state} ${item.action}`);
const snapshot = (rig: SiteRig): string[] => ['', 'css', 'img', 'scripts'].map((folder) => `${readFileSync(notesFile(rig, folder), 'latin1')} @${String(statSync(notesFile(rig, folder)).mtimeMs)}`);

for (const kind of ['local', 'sftp', 'ftps'] as const) {
  describe(`Dreamweaver's records over ${kind}`, () => {
    test('a site Dreamweaver synchronized is in sync from its first plan, and stays so without the records', async () => {
      await dreamweaverSite(kind, {}, async (rig) => {
        const before = snapshot(rig);
        await inSession(rig, async (session) => {
          const plan = await session.plan({ direction: 'both' });
          assert.deepEqual(states(plan), []);
          assert.equal(plan.adopted, DW_COUNT);
          assert.deepEqual((await session.status()).dreamweaver, { inSync: DW_COUNT, clock: 'known' });
          assert.equal(existsSync(clockPath(rig)), false, 'a plan alone keeps nothing');
          assert.equal(await session.settle(plan), DW_COUNT);
        });
        assert.deepEqual(JSON.parse(readFileSync(clockPath(rig), 'utf8')), { schemaVersion: 1, server: DW_SERVER, unit: dwUnit(kind), offsetSeconds: DW_CLOCK });
        assert.deepEqual(snapshot(rig), before, 'entries that already say the same are left as Dreamweaver wrote them');

        for (const folder of ['_notes', 'css/_notes', 'img/_notes', 'scripts/_notes']) {
          rig.remove('local', folder);
        }
        await inSession(rig, async (session) => {
          const plan = await session.plan({ direction: 'both' });
          assert.deepEqual(states(plan), []);
          assert.equal(plan.adopted, 0);
          assert.deepEqual(plan.silent, []);
        });
      });
    });

    test('_notes/dwsync.xml is never a row or a count, with the setting on or off', async () => {
      for (const enabled of [true, false]) {
        await dreamweaverSite(kind, { enabled }, async (rig) => {
          rig.write('remote', '_notes/dwsync.xml', '<dwsync/>');
          rig.write('remote', 'css/_notes/dwsync.xml', '<dwsync/>');
          await inSession(rig, async (session) => {
            const plan = await session.plan({ direction: 'both', deleteOrphans: true });
            assert.equal(plan.localFiles, DW_COUNT);
            assert.equal(plan.remoteFiles, DW_COUNT);
            // Without the records, every file Dreamweaver uploaded looks newer on the server.
            assert.deepEqual(rows(plan), enabled ? [] : DW_PATHS.map((target) => `${target} get`));
            const single = await session.put(['_notes/dwsync.xml', 'css/_notes/dwsync.xml']);
            assert.deepEqual(single.plan.items, []);
          });
          assert.equal(rig.read('remote', '_notes/dwsync.xml'), '<dwsync/>');
        });
      }
    });

    test('a change on one side since Dreamweaver goes the right way; a change on both is compared from scratch', async () => {
      await dreamweaverSite(kind, {}, async (rig) => {
        rig.write('local', 'index.html', '<h1>Home, edited here</h1>', BASE_TIME + 2 * HOUR);
        rig.write('remote', 'about.html', '<h1>About, edited there</h1>', BASE_TIME + 3 * HOUR + 20_000);
        rig.write('local', 'css/site.css', 'body { margin: 0 }', BASE_TIME + 2 * HOUR);
        rig.write('remote', 'css/site.css', 'body { padding: 0 }', BASE_TIME + 4 * HOUR + 20_000);
        await inSession(rig, async (session) => {
          const plan = await session.plan({ direction: 'both' });
          assert.deepEqual(states(plan), ['about.html remote-changed get', 'css/site.css first-sync-remote-newer get', 'index.html local-changed put']);
          assert.equal(plan.adopted, DW_COUNT - 3);
          assert.equal((await session.execute(plan)).failed, 0);
          assert.deepEqual(states(await session.plan({ direction: 'both' })), []);
        });
        assert.equal(rig.read('remote', 'index.html'), '<h1>Home, edited here</h1>');
        assert.equal(rig.read('local', 'about.html'), '<h1>About, edited there</h1>');
      });
    });

    test('a file Dreamweaver put in between is in sync, not changed on both sides', async () => {
      await dreamweaverSite(kind, {}, async (rig) => {
        await takeOver(rig);
        rig.write('local', 'index.html', '<h1>Home, put with Dreamweaver</h1>', BASE_TIME + 2 * HOUR);
        rig.write('remote', 'index.html', '<h1>Home, put with Dreamweaver</h1>', BASE_TIME + 2 * HOUR + 73_000);
        assert.deepEqual(states(await inSession(rig, (session) => session.plan({ direction: 'both' }))), ['index.html both-changed resolve']);
        writeEntries(rig, DW_ROOT);
        await inSession(rig, async (session) => {
          const plan = await session.plan({ direction: 'both' });
          assert.deepEqual(states(plan), []);
          assert.equal(plan.adopted, 1);
          await session.settle(plan);
          assert.equal(session.record('index.html')?.local.mtimeMs, BASE_TIME + 2 * HOUR);
        });
      });
    });

    test('a Put and a Get write the entry Dreamweaver would have, and keep everything else in the file', async () => {
      await dreamweaverSite(kind, {}, async (rig) => {
        writeEntries(rig, DW_ROOT, (target) => [dwEntry(rig, target, DW_OTHER)]);
        const original = readFileSync(notesFile(rig), 'utf8').replace(' Dst="1" />', ' Dst="1" testing="3" />');
        writeFileSync(notesFile(rig), original);
        const others = original.split('\r\n').filter((line) => line.includes(DW_OTHER));
        assert.equal(others.length, 3);
        assert.equal((await takeOver(rig)).adopted, DW_COUNT);
        assert.equal(readFileSync(notesFile(rig), 'utf8'), original);

        rig.write('local', 'index.html', '<h1>Home, edited here</h1>', BASE_TIME + 2 * HOUR);
        rig.write('remote', 'about.html', '<h1>About, edited there</h1>', BASE_TIME + 5 * HOUR + 20_000);
        await inSession(rig, async (session) => {
          const plan = await session.plan({ direction: 'both' });
          assert.deepEqual(rows(plan), ['about.html get', 'index.html put']);
          assert.equal((await session.execute(plan)).failed, 0);
        });

        const text = readFileSync(notesFile(rig), 'utf8');
        assert.ok(!text.replaceAll('\r\n', '').includes('\n'), 'the line ends are kept');
        assert.ok(!text.endsWith('\n'));
        for (const line of others) {
          assert.ok(text.includes(`${line}\r\n`), 'the entry of another server is as it was');
        }
        const written = entriesOf(rig).filter((entry) => entry.server === DW_SERVER);
        assert.deepEqual(written.map((entry) => entry.name), DW_ROOT);
        for (const entry of written) {
          assert.equal(entry.local, localTicks(rig, entry.name), `${entry.name}: the local time to the last digit`);
          assert.equal(entry.remote, recordedTime(rig, entry.name), `${entry.name}: the server's time on Dreamweaver's clock`);
        }
        const attributes = written[0]?.attributes ?? [];
        assert.deepEqual(attributes.map(([name]) => name), ['name', 'server', 'local', 'remote', 'Dst', 'testing']);
        assert.deepEqual(attributes.slice(-2), [['Dst', '0'], ['testing', '3']]);
        assert.deepEqual(states(await inSession(rig, (session) => session.plan({ direction: 'both' }))), []);
      });
    });

    test('a delete removes the entry, the last entry its file, and an emptied folder goes with the records left in it', async () => {
      await dreamweaverSite(kind, {}, async (rig) => {
        writeDwsync(path.join(rig.localDir, 'img'), [dwEntry(rig, 'img/hero.svg'), dwEntry(rig, 'img/hero.svg', DW_OTHER), dwEntry(rig, 'img/icon.svg')]);
        assert.equal((await takeOver(rig)).adopted, DW_COUNT);

        rig.remove('local', 'scripts/app.js');
        await inSession(rig, async (session) => {
          const plan = await session.plan({ direction: 'put', deleteOrphans: true });
          assert.deepEqual(rows(plan), ['scripts/app.js delete-remote']);
          assert.equal((await session.execute(plan, { allowMassDelete: true })).done, 1);
        });
        assert.equal(rig.read('remote', 'scripts/app.js'), undefined);
        assert.equal(existsSync(path.join(rig.localDir, 'scripts', '_notes')), false, 'the last entry takes the file and its folder with it');

        rig.remove('remote', 'img');
        await inSession(rig, async (session) => {
          const plan = await session.plan({ direction: 'get', deleteOrphans: true });
          assert.deepEqual(plan.items.map((item) => [item.path, item.action, item.checked]), [
            ['img/hero.svg', 'delete-local', true],
            ['img/icon.svg', 'delete-local', true],
          ]);
          assert.equal((await session.execute(plan, { allowMassDelete: true })).done, 2);
        });
        assert.equal(existsSync(path.join(rig.localDir, 'img')), false, 'the folder held nothing but _notes/dwsync.xml');
        assert.deepEqual(entriesOf(rig).map((entry) => entry.name).sort(), [...DW_ROOT].sort());
      });
    });

    test('an entry never makes a delete: a file missing on one side starts unchecked', async () => {
      await dreamweaverSite(kind, {}, async (rig) => {
        rig.remove('remote', 'about.html');
        await inSession(rig, async (session) => {
          const plan = await session.plan({ direction: 'get', deleteOrphans: true });
          assert.deepEqual(plan.items.map((item) => [item.path, item.state, item.action, item.checked]), [['about.html', 'local-only', 'delete-local', false]]);
          assert.equal(plan.adopted, DW_COUNT - 1);
        });
      });
    });

    test('until the clock is known nothing is taken over or written, a single path included', async () => {
      await dreamweaverSite(kind, { entries: ['index.html', 'about.html'] }, async (rig) => {
        const before = readFileSync(notesFile(rig), 'utf8');
        await inSession(rig, async (session) => {
          const plan = await session.plan({ direction: 'both' });
          assert.equal(plan.adopted, 0);
          assert.deepEqual(rows(plan), DW_PATHS.map((target) => `${target} get`));
          assert.deepEqual((await session.status()).dreamweaver, { inSync: 0, clock: 'unknown' });
          assert.equal((await session.execute(plan)).failed, 0);
        });
        assert.equal(existsSync(clockPath(rig)), false);
        assert.equal(readFileSync(notesFile(rig), 'utf8'), before);
        assert.equal(existsSync(notesFile(rig, 'css')), false);
      });
      await dreamweaverSite(kind, {}, async (rig) => {
        const before = readFileSync(notesFile(rig), 'utf8');
        rig.write('local', 'index.html', '<h1>Home, edited here</h1>', BASE_TIME + 2 * HOUR);
        await inSession(rig, async (session) => {
          const single = await session.put(['index.html']);
          assert.deepEqual(states(single.plan), ['index.html first-sync-local-newer put']);
          assert.equal(single.result?.done, 1);
        });
        assert.equal(readFileSync(notesFile(rig), 'utf8'), before);
        assert.equal(existsSync(clockPath(rig)), false);
      });
    });

    test('a site new to Dreamweaver gets an entry per file, and one turned on later catches up', async () => {
      await withSite(kind, { site: { sync: { dreamweaver: { enabled: true } } } }, async (rig) => {
        for (const [target, content] of Object.entries(DW_FILES)) {
          rig.write('local', target, content);
        }
        const server = rig.site.servers[0];
        assert.ok(server !== undefined);
        const name = dreamweaverServerName(server);
        await inSession(rig, async (session) => {
          assert.equal((await session.execute(await session.plan({ direction: 'put' }))).done, DW_COUNT);
        });
        assert.deepEqual(JSON.parse(readFileSync(clockPath(rig), 'utf8')), { schemaVersion: 1, server: name, unit: dwUnit(kind), offsetSeconds: 0 });
        for (const target of DW_PATHS) {
          const [entry, ...rest] = entriesOf(rig, parts(target).slice(0, -1).join('/')).filter((item) => item.name === parts(target).at(-1));
          assert.deepEqual(rest, []);
          assert.deepEqual([entry?.server, entry?.local, entry?.remote], [name, localTicks(rig, target), recordedTime(rig, target, 0)], target);
          assert.deepEqual(entry?.attributes.map(([key]) => key), ['name', 'server', 'local', 'remote', 'Dst']);
        }
      });
      await withSite(kind, {}, async (rig) => {
        await synced(rig, DW_FILES);
        assert.equal(existsSync(notesFile(rig)), false);
        await rig.registry.update(rig.site.id, (draft) => {
          draft.sync.dreamweaver.enabled = true;
        });
        const plan = await takeOver(rig);
        assert.deepEqual(states(plan), []);
        assert.equal(plan.adopted, 0);
        assert.equal(plan.silent.length, DW_COUNT);
        assert.deepEqual(['', 'css', 'img', 'scripts'].flatMap((folder) => entriesOf(rig, folder).map((entry) => entry.name)).sort(), DW_PATHS.map((target) => parts(target).at(-1)).sort());
        assert.equal((await takeOver(rig)).silent.length, 0, 'catching up happens once');
      });
    });

    test('a damaged dwsync.xml is neither read nor written, and the log names it once', async () => {
      await dreamweaverSite(kind, {}, async (rig) => {
        const damaged = '<!DOCTYPE dwsync>\r\n<dwsync>\r\n</dwsync>';
        writeFileSync(notesFile(rig, 'css'), damaged);
        await inSession(rig, async (session) => {
          const plan = await session.plan({ direction: 'both' });
          assert.deepEqual(rows(plan), ['css/site.css get']);
          assert.equal(plan.adopted, DW_COUNT - 1);
          assert.equal((await session.execute(plan)).failed, 0);
          assert.deepEqual(states(await session.plan({ direction: 'both' })), []);
        });
        assert.equal(readFileSync(notesFile(rig, 'css'), 'utf8'), damaged);
        assert.equal(rig.records.filter((record) => record.level === 'warn' && record.message.includes('css/_notes/dwsync.xml could not be read')).length, 1);
      });
    });

    test('records behind a link out of the site are neither read nor written, whatever links the site follows', async (t) => {
      for (const symlinks of ['skip', 'follow'] as const) {
        const made = await dreamweaverSite(kind, { sync: { symlinks } }, async (rig) => {
          const outside = path.join(rig.localDir, '..', 'outside-notes');
          mkdirSync(outside);
          writeFileSync(path.join(outside, 'dwsync.xml'), readFileSync(notesFile(rig, 'img')));
          rig.remove('local', 'img/_notes');
          if (!link(outside, path.join(rig.localDir, 'img', '_notes'), 'junction')) {
            return false;
          }
          const before = readFileSync(path.join(outside, 'dwsync.xml'), 'utf8');
          await inSession(rig, async (session) => {
            const plan = await session.plan({ direction: 'both' });
            assert.deepEqual(rows(plan), ['img/hero.svg get', 'img/icon.svg get']);
            assert.equal(plan.adopted, DW_COUNT - 2);
            assert.equal((await session.execute(plan)).failed, 0);
          });
          assert.equal(readFileSync(path.join(outside, 'dwsync.xml'), 'utf8'), before);
          assert.ok(isLink(path.join(rig.localDir, 'img', '_notes')));
          return true;
        });
        if (!made) {
          t.skip('creating folder links is not permitted here');
          return;
        }
      }
    });

    test('with the setting off, or without sync records, nothing is read, written or removed', async () => {
      for (const options of [{ enabled: false }, { enabled: true, sync: { maintainInfo: false } }] as const) {
        await dreamweaverSite(kind, options, async (rig) => {
          const before = snapshot(rig);
          await inSession(rig, async (session) => {
            const plan = await session.plan({ direction: 'both' });
            assert.equal(plan.adopted, 0);
            assert.deepEqual(rows(plan), DW_PATHS.map((target) => `${target} get`));
            assert.equal((await session.status()).dreamweaver, undefined);
            assert.equal((await session.execute(plan)).failed, 0);
            await session.settle(await session.plan({ direction: 'both' }));
          });
          assert.deepEqual(snapshot(rig), before);
          assert.equal(existsSync(clockPath(rig)), false);
        });
      }
    });

    test('a reset forgets the clock, and with the dreamweaver option the entries of this server too', async () => {
      await dreamweaverSite(kind, {}, async (rig) => {
        writeEntries(rig, DW_ROOT, (target) => [dwEntry(rig, target, DW_OTHER)]);
        await takeOver(rig);
        await inSession(rig, (session) => session.resetState());
        assert.equal(existsSync(clockPath(rig)), false);
        assert.equal((await takeOver(rig)).adopted, DW_COUNT, 'the records are still there, and are taken over again');

        await inSession(rig, (session) => session.resetState({ dreamweaver: true }));
        assert.equal(existsSync(clockPath(rig)), false);
        assert.deepEqual(entriesOf(rig).map((entry) => `${entry.name} ${entry.server}`), DW_ROOT.map((name) => `${name} ${DW_OTHER}`));
        for (const folder of ['css', 'img', 'scripts']) {
          assert.equal(existsSync(path.join(rig.localDir, folder, '_notes')), false, folder);
        }
        const plan = await inSession(rig, (session) => session.plan({ direction: 'both' }));
        assert.equal(plan.adopted, 0);
        assert.deepEqual(rows(plan), DW_PATHS.map((target) => `${target} get`));
      });
    });
  });
}

describe("Dreamweaver's records of a folder server across daylight time", () => {
  test('entries written in the other season are taken over, and a new one is moved by the hour as Dreamweaver moves it', async () => {
    const now = Date.now();
    const summerHalf = (atMs: number): boolean => new Date(atMs).getUTCMonth() >= 3 && new Date(atMs).getUTCMonth() <= 8;
    /** A zone five hours behind UTC whose daylight time covers the half of the year today is in. */
    const zone = (atMs: number): number => (summerHalf(atMs) === summerHalf(now) ? 240 : 300);
    const year = new Date(now).getUTCFullYear();
    // A day in the middle of the other half of the year, in the past.
    const then = summerHalf(now) ? Date.UTC(year, 0, 15, 12) : Date.UTC(year - 1, 6, 15, 12);
    await withSite('local', { site: { sync: { dreamweaver: { enabled: true } } } }, async (rig) => {
      const server = rig.site.servers[0];
      assert.ok(server !== undefined);
      const name = dreamweaverServerName(server);
      Object.entries(DW_FILES).forEach(([target, content], index) => {
        rig.write('local', target, content, then + index * 60_000);
        rig.write('remote', target, content, then + index * 60_000 + 13_000);
      });
      // Written during daylight time for files of standard time: Dreamweaver records the server copy an hour early.
      const folders = new Map<string, FixtureEntry[]>();
      for (const target of DW_PATHS) {
        const folder = parts(target).slice(0, -1).join('/');
        const entry = entryFor(path.join(rig.localDir, ...parts(target)), serverTime(rig, target), name, { unit: 'second', shiftSeconds: -3600, dst: 2 });
        folders.set(folder, [...(folders.get(folder) ?? []), entry]);
      }
      for (const [folder, entries] of folders) {
        writeDwsync(path.join(rig.localDir, ...parts(folder)), entries);
      }
      const before = snapshot(rig);

      await inSession(
        rig,
        async (session) => {
          const plan = await session.plan({ direction: 'both' });
          assert.deepEqual(states(plan), []);
          assert.equal(plan.adopted, DW_COUNT);
          await session.settle(plan);
        },
        { zoneOffsetMinutes: zone },
      );
      assert.deepEqual(JSON.parse(readFileSync(clockPath(rig), 'utf8')), { schemaVersion: 1, server: name, unit: 'second', offsetSeconds: 0 });
      assert.deepEqual(snapshot(rig), before);

      rig.write('local', 'index.html', '<h1>Home, edited here</h1>', then + HOUR);
      await inSession(
        rig,
        async (session) => {
          const plan = await session.plan({ direction: 'both' });
          assert.deepEqual(rows(plan), ['index.html put']);
          assert.equal((await session.execute(plan)).failed, 0);
        },
        { zoneOffsetMinutes: zone },
      );
      const entry = entriesOf(rig).find((item) => item.name === 'index.html');
      assert.equal(entry?.local, localTicks(rig, 'index.html'));
      assert.equal(entry.remote, toFiletime(BigInt(Math.floor(serverTime(rig, 'index.html') / 1000) * 1000 - HOUR) * 1_000_000n), 'one hour early, as Dreamweaver writes it in daylight time');
      assert.deepEqual(entry.attributes.at(-1), ['Dst', '2']);
    });
  });
});

