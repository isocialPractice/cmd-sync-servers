import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { isSyncError } from '../../src/errors.ts';
import { STATUS } from '../../src/sync/messages.ts';
import { isCaseSensitive, type LinkPolicy } from '../../src/sync/paths.ts';
import { resultLine, type SyncResult } from '../../src/sync/execute.ts';
import type { SyncPlan } from '../../src/sync/plan.ts';
import { filesContaining } from '../helpers/cli.ts';
import type { Kind } from '../sandbox/rig.ts';
import { BASE_TIME, startSiteRig, type SiteRig, type SiteRigOptions } from '../sandbox/site-rig.ts';
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

