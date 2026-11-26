import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { describe, test, type TestContext } from 'node:test';
import { isSyncError } from '../../src/errors.ts';
import { dreamweaverServerName, parseDwsync, toFiletime } from '../../src/sync/dwsync.ts';
import { guardedStatus } from '../../src/sync/messages.ts';
import { SyncPlan } from '../../src/sync/plan.ts';
import type { PlanOptions, SyncSession } from '../../src/sync/session.ts';
import type { ProgressEvent } from '../../src/sync/types.ts';
import { TransportPool } from '../../src/transport/pool.ts';
import type { Transport } from '../../src/transport/types.ts';
import { filesContaining } from '../helpers/cli.ts';
import type { Kind } from '../sandbox/rig.ts';
import { BASE_TIME, startSiteRig, type SiteRig, type SiteRigOptions } from '../sandbox/site-rig.ts';

const KINDS: readonly Kind[] = ['local', 'sftp', 'ftps'];
const LATER = BASE_TIME + 3_600_000;

/** The files written before the moment a range starts, and those written after it. */
const OLDER: Readonly<Record<string, string>> = { 'index.html': '<h1>Home</h1>', 'about.html': '<h1>About</h1>', 'css/site.css': 'body {}' };
const NEWER: Readonly<Record<string, string>> = { 'img/hero.svg': '<svg/>', 'scripts/app.js': 'void 0;' };
const NEWER_PATHS = Object.keys(NEWER).sort();

/**
 * Runs a scenario on a fresh site, then searches every file the run wrote
 * and every log record for the server password.
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

async function inSession<T>(rig: SiteRig, work: (session: SyncSession) => Promise<T>): Promise<T> {
  const session = await rig.open();
  try {
    return await work(session);
  } finally {
    await session.close();
  }
}

/** A modification time that is not before now, in whole seconds, as every protocol reports it. */
const fresh = (): number => Math.ceil(Date.now() / 1000) * 1000;

/** Writes files as they were long before a range: modified at the base time, and created now. */
function writeOlder(rig: SiteRig, files: Readonly<Record<string, string>> = OLDER): void {
  for (const [name, content] of Object.entries(files)) {
    rig.write('local', name, content);
  }
}

/** Writes files as edited just now. */
function writeNewer(rig: SiteRig, files: Readonly<Record<string, string>> = NEWER): void {
  for (const [name, content] of Object.entries(files)) {
    rig.write('local', name, content, fresh());
  }
}

/** A moment with quiet on each side of it, so what is written before and after lies clearly apart. */
async function moment(): Promise<Date> {
  await wait(50);
  const at = new Date();
  await wait(50);
  return at;
}

/** Puts the files on both sides and synchronizes them, so later steps have records. */
async function synced(rig: SiteRig, files: Readonly<Record<string, string>>): Promise<void> {
  writeOlder(rig, files);
  await inSession(rig, async (session) => {
    const result = await session.execute(await session.plan({ direction: 'put' }));
    assert.equal(result.failed, 0, JSON.stringify(result.items));
  });
}

const rows = (plan: SyncPlan): [string, string, boolean | undefined][] => plan.items.map((item) => [item.path, item.action, item.checked]);

/** Records every call a plan or a run makes on a transport, and how often a connection was asked for. */
function recordCalls(t: TestContext): { readonly calls: string[]; readonly runs: () => number } {
  const calls: string[] = [];
  let runs = 0;
  const run = Object.getOwnPropertyDescriptor(TransportPool.prototype, 'run')?.value as TransportPool['run'];
  const recording = (transport: Transport): Transport =>
    new Proxy(transport, {
      get: (target, key) => {
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== 'function') {
          return value;
        }
        return (...values: unknown[]): unknown => {
          calls.push(typeof values[0] === 'string' ? `${String(key)} ${values[0]}` : String(key));
          return (value as (...given: unknown[]) => unknown).apply(target, values);
        };
      },
    });
  t.mock.method(TransportPool.prototype, 'run', function <T>(this: TransportPool, operation: (transport: Transport) => Promise<T>, signal?: AbortSignal): Promise<T> {
    runs += 1;
    return run.call(this, (transport: Transport) => operation(recording(transport)), signal) as Promise<T>;
  });
  return { calls, runs: () => runs };
}

for (const kind of KINDS) {
  describe(`a Put from a time range over ${kind}`, () => {
    test('only the files created or modified since the moment are listed', async () => {
      await withSite(kind, {}, async (rig) => {
        writeOlder(rig);
        const since = await moment();
        writeNewer(rig);
        await inSession(rig, async (session) => {
          const events: ProgressEvent['type'][] = [];
          const plan = await session.plan({ direction: 'put', changedSince: since, onProgress: (event) => events.push(event.type) });
          assert.deepEqual(rows(plan), NEWER_PATHS.map((target) => [target, 'put', true]));
          assert.deepEqual(plan.scope, { kind: 'paths', paths: NEWER_PATHS });
          assert.equal(plan.direction, 'put');
          assert.equal(plan.deleteOrphans, false);
          assert.equal(plan.unlisted, 0);
          assert.deepEqual([...new Set(events)], ['scan-local', 'scan-remote', 'compare']);
          assert.equal((await session.plan({ direction: 'put' })).items.length, Object.keys(OLDER).length + NEWER_PATHS.length, 'every file differs from the server');

          const result = await session.execute(plan);
          assert.equal(result.done, NEWER_PATHS.length);
          for (const [target, content] of Object.entries(NEWER)) {
            assert.equal(rig.read('remote', target), content);
          }
          for (const target of Object.keys(OLDER)) {
            assert.equal(rig.read('remote', target), undefined, `${target} is older than the range`);
          }
        });
      });
    });

    test('a file created since the moment counts, however old its modification time', async (t) => {
      await withSite(kind, {}, async (rig) => {
        writeOlder(rig);
        const since = await moment();
        // A file copied into the site keeps the modification time it came with.
        rig.write('local', 'img/hero.svg', '<svg/>', BASE_TIME - 365 * 86_400_000);
        if (statSync(path.join(rig.localDir, 'img', 'hero.svg')).birthtimeMs < since.getTime()) {
          t.skip('this file system keeps no creation time');
          return;
        }
        await inSession(rig, async (session) => {
          assert.deepEqual(rows(await session.plan({ direction: 'put', changedSince: since })), [['img/hero.svg', 'put', true]]);
        });
      });
    });

    test('a recent file that is in sync is counted, not listed', async () => {
      await withSite(kind, {}, async (rig) => {
        writeOlder(rig);
        const since = await moment();
        writeNewer(rig);
        await inSession(rig, async (session) => {
          await session.execute(await session.plan({ direction: 'put', changedSince: since }));
          const again = await session.plan({ direction: 'put', changedSince: since });
          assert.deepEqual(again.items, []);
          assert.equal(again.unlisted, NEWER_PATHS.length);
          assert.deepEqual(again.scope, { kind: 'paths', paths: NEWER_PATHS });
        });
      });
    });

    test('a range never lists a delete or a Get', async () => {
      await withSite(kind, {}, async (rig) => {
        await synced(rig, OLDER);
        const since = await moment();
        writeNewer(rig, { 'scripts/app.js': 'void 0;' });
        // Only the server has one file, one synchronized file is gone here, one changed on the server, and one new file is gone again.
        rig.write('remote', 'old/legacy.html', '<h1>Legacy</h1>');
        rig.remove('local', 'about.html');
        rig.write('remote', 'index.html', '<h1>Home, edited on the server</h1>', LATER);
        writeNewer(rig, { 'img/hero.svg': '<svg/>' });
        rig.remove('local', 'img/hero.svg');
        await inSession(rig, async (session) => {
          const plan = await session.plan({ direction: 'put', changedSince: since });
          assert.deepEqual(rows(plan), [['scripts/app.js', 'put', true]]);
          assert.deepEqual(plan.scope, { kind: 'paths', paths: ['scripts/app.js'] });
          const whole = await session.plan({ direction: 'both', deleteOrphans: true });
          assert.deepEqual(
            whole.items.map((item) => [item.path, item.action]),
            [
              ['about.html', 'delete-remote'],
              ['index.html', 'get'],
              ['old/legacy.html', 'delete-remote'],
              ['scripts/app.js', 'put'],
            ],
            'a plan of the whole site lists what the range leaves out',
          );

          const refused: readonly PlanOptions[] = [
            { direction: 'put', changedSince: since, deleteOrphans: true },
            { direction: 'get', changedSince: since },
            { direction: 'both', changedSince: since },
            { direction: 'put', changedSince: new Date(Number.NaN) },
          ];
          for (const options of refused) {
            await assert.rejects(session.plan(options), (error) => isSyncError(error, 'E_PLAN_INVALID') && error.message.includes('changedSince'), JSON.stringify(options));
          }
        });
      });
    });

    test('a recent file that also changed on the server waits for a decision', async () => {
      await withSite(kind, {}, async (rig) => {
        await synced(rig, OLDER);
        const since = await moment();
        rig.write('local', 'index.html', '<h1>Home, edited here</h1>', fresh());
        rig.write('remote', 'index.html', '<h1>Home, edited on the server</h1>', LATER);
        await inSession(rig, async (session) => {
          const plan = await session.plan({ direction: 'put', changedSince: since });
          assert.deepEqual(plan.items.map((item) => [item.path, item.state, item.action, item.checked]), [['index.html', 'both-changed', 'resolve', undefined]]);
        });
      });
    });

    test('with nothing recent the plan is empty and the server is never asked', async (t) => {
      await withSite(kind, {}, async (rig) => {
        writeOlder(rig);
        const since = await moment();
        const recorded = recordCalls(t);
        await inSession(rig, async (session) => {
          const plan = await session.plan({ direction: 'put', changedSince: since });
          assert.deepEqual(plan.items, []);
          assert.deepEqual(plan.scope, { kind: 'paths', paths: [] });
          assert.equal(plan.unlisted, 0);
          assert.equal(await session.settle(plan), 0);
        });
        assert.equal(recorded.runs(), 0);
        assert.deepEqual(recorded.calls, []);
        assert.equal(rig.rig.sandbox?.connections ?? 0, 0, 'the server saw no connection');
      });
    });

    test('within a folder, only its recent files are listed', async () => {
      await withSite(kind, {}, async (rig) => {
        writeOlder(rig);
        const since = await moment();
        writeNewer(rig, { 'css/print.css': 'p {}', 'css/theme/dark.css': 'h1 {}', 'img/hero.svg': '<svg/>' });
        await inSession(rig, async (session) => {
          const plan = await session.plan({ direction: 'put', changedSince: since, scope: { kind: 'paths', paths: ['css'] } });
          assert.deepEqual(rows(plan), [
            ['css/print.css', 'put', true],
            ['css/theme/dark.css', 'put', true],
          ]);
          const files = await session.plan({ direction: 'put', changedSince: since, scope: { kind: 'paths', paths: ['index.html', 'img/hero.svg', 'missing.html'] } });
          assert.deepEqual(rows(files), [['img/hero.svg', 'put', true]]);
        });
      });
    });

    test('a recent cloaked file has no row, and a recent sensitive file is held back', async () => {
      await withSite(kind, { site: { cloaking: { enabled: true, patterns: ['/drafts/', '.psd'], paths: [] } } }, async (rig) => {
        writeOlder(rig);
        const since = await moment();
        writeNewer(rig, { 'drafts/notes.md': 'Notes', 'img/hero.psd': 'layers', '.env': 'MODE=demo', 'img/hero.svg': '<svg/>' });
        await inSession(rig, async (session) => {
          const plan = await session.plan({ direction: 'put', changedSince: since });
          assert.deepEqual(
            plan.items.map((item) => [item.path, item.action, item.checked, item.guarded, item.status]),
            [
              ['.env', 'put', false, '.env', guardedStatus('.env')],
              ['img/hero.svg', 'put', true, undefined, ''],
            ],
          );
          const result = await session.execute(plan);
          assert.equal(result.done, 1);
          assert.equal(rig.read('remote', '.env'), undefined);
        });
      });
    });

    test('the server is asked about each recent file, and lists no folder', async (t) => {
      await withSite(kind, {}, async (rig) => {
        writeOlder(rig);
        const since = await moment();
        writeNewer(rig);
        const recorded = recordCalls(t);
        await inSession(rig, async (session) => {
          const plan = await session.plan({ direction: 'put', changedSince: since });
          assert.equal(plan.items.length, NEWER_PATHS.length);
          assert.deepEqual([...recorded.calls].sort(), NEWER_PATHS.map((target) => `stat ${target}`));
        });
      });
    });

    test('a saved plan runs again on a fresh plan of its files, and is refused once one of them changed', async () => {
      await withSite(kind, {}, async (rig) => {
        writeOlder(rig);
        const since = await moment();
        writeNewer(rig);
        await inSession(rig, async (session) => {
          const plan = await session.plan({ direction: 'put', changedSince: since });
          plan.setChecked('img/hero.svg', false);
          const saved = SyncPlan.fromJSON(JSON.parse(JSON.stringify(plan)));
          assert.deepEqual(saved.scope, { kind: 'paths', paths: NEWER_PATHS });
          assert.equal(saved.deleteOrphans, false);

          rig.write('local', 'scripts/app.js', 'void 0; // edited', fresh() + 60_000);
          const changed = await session.plan({ direction: saved.direction, deleteOrphans: saved.deleteOrphans, scope: saved.scope });
          assert.throws(() => {
            changed.applySaved(saved);
          }, (error) => isSyncError(error, 'E_STALE_ITEM'));
          rig.write('local', 'scripts/app.js', NEWER['scripts/app.js'] ?? '', plan.item('scripts/app.js')?.local?.mtimeMs);

          const again = await session.plan({ direction: saved.direction, deleteOrphans: saved.deleteOrphans, scope: saved.scope });
          again.applySaved(saved);
          assert.deepEqual(rows(again), [
            ['img/hero.svg', 'put', false],
            ['scripts/app.js', 'put', true],
          ]);
          const result = await session.execute(again);
          assert.equal(result.done, 1);
          assert.equal(rig.read('remote', 'scripts/app.js'), NEWER['scripts/app.js']);
          assert.equal(rig.read('remote', 'img/hero.svg'), undefined);
        });
      });
    });

    test('a plan is cancelled while the local files are looked through', async () => {
      await withSite(kind, {}, async (rig) => {
        writeOlder(rig);
        await inSession(rig, async (session) => {
          await assert.rejects(session.plan({ direction: 'put', changedSince: new Date(0), signal: AbortSignal.abort() }), (error) => isSyncError(error, 'E_CANCELLED'));
        });
      });
    });

    test("beside Dreamweaver's records, a Put from a range writes the file's entry once the clock is known", async () => {
      await withSite(kind, { site: { sync: { dreamweaver: { enabled: true } } } }, async (rig) => {
        const server = rig.site.servers[0];
        assert.ok(server !== undefined);
        const notes = path.join(rig.localDir, '_notes', 'dwsync.xml');
        const clock = path.join(rig.home, 'state', 'sites', rig.site.id, `${server.id}.dwsync.json`);
        const entryOf = (name: string): bigint | undefined =>
          parseDwsync(readFileSync(notes, 'utf8'))?.entries.find((entry) => entry.name === name && entry.server === dreamweaverServerName(server))?.local;
        const ticks = (name: string): bigint => toFiletime(lstatSync(path.join(rig.localDir, name), { bigint: true }).mtimeNs);

        // While the clock is unknown, a range plan learns nothing and writes no entry.
        writeOlder(rig, { 'about.html': '<h1>About</h1>' });
        const first = await moment();
        writeNewer(rig, { 'index.html': '<h1>Home</h1>' });
        await inSession(rig, async (session) => {
          const plan = await session.plan({ direction: 'put', changedSince: first });
          assert.deepEqual(rows(plan), [['index.html', 'put', true]]);
          assert.equal(session.dreamweaverClock, 'unknown');
          assert.equal((await session.execute(plan)).done, 1);
          assert.equal(session.dreamweaverClock, 'unknown');
        });
        assert.equal(existsSync(clock), false, 'a range plan does not learn the clock');
        assert.equal(existsSync(notes), false, 'no entry is written before the clock is known');

        // A synchronization of the whole site learns the clock; from then on a range writes entries.
        await inSession(rig, async (session) => {
          assert.equal((await session.execute(await session.plan({ direction: 'put' }))).failed, 0);
        });
        assert.equal(existsSync(clock), true);
        const second = await moment();
        rig.write('local', 'index.html', '<h1>Home, edited</h1>', fresh() + 120_000);
        await inSession(rig, async (session) => {
          const plan = await session.plan({ direction: 'put', changedSince: second });
          assert.deepEqual(rows(plan), [['index.html', 'put', true]]);
          assert.equal(session.dreamweaverClock, 'known');
          assert.equal((await session.execute(plan)).done, 1);
        });
        assert.equal(entryOf('index.html'), ticks('index.html'));
        assert.equal(entryOf('about.html'), ticks('about.html'));
      });
    });
  });
}
