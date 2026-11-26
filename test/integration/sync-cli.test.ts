import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { dreamweaverServerName } from '../../src/sync/dwsync.ts';
import { cli, filesContaining } from '../helpers/cli.ts';
import { entryFor, writeDwsync } from '../helpers/dwsync.ts';
import type { Kind } from '../sandbox/rig.ts';
import { BASE_TIME, startSiteRig, type SiteRig } from '../sandbox/site-rig.ts';

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- a typed JSON.parse keeps the assertions readable
function json<T>(text: string): T {
  return JSON.parse(text) as T;
}

async function withSite(kind: Kind, run: (rig: SiteRig, run: (...args: string[]) => ReturnType<typeof cli>) => Promise<void>, input?: string, tty?: boolean): Promise<void> {
  const rig = await startSiteRig(kind);
  try {
    const call = (...args: string[]): ReturnType<typeof cli> =>
      cli({ home: rig.home, cwd: rig.localDir, env: { SYNC_SERVERS_PASSWORD: rig.rig.password }, ...(input === undefined ? {} : { input }), ...(tty === true ? { tty } : {}) }, '--ascii', ...args);
    await run(rig, call);
    assert.deepEqual(filesContaining(rig.home, rig.rig.password), []);
  } finally {
    await rig.close();
  }
}

test('sync without --yes previews and transfers nothing; with --yes it synchronizes', async () => {
  await withSite('local', async (rig, run) => {
    rig.write('local', 'index.html', 'home');
    rig.write('local', '.env', 'SECRET=1');
    const preview = await run('sync', '--put');
    assert.equal(preview.code, 0);
    assert.match(preview.stdout, /^Synchronize: My Site -> Folder \(Local\/Network\) {3}Put newer files to remote$/m);
    assert.match(preview.stdout, /^Files: 1 will be updated, 1 will be skipped$/m);
    assert.match(preview.stdout, /^ {2}\[x\] \^ Put +index\.html$/m);
    assert.match(preview.stdout, /^ {2}\[ \] \^ Put +\.env +Matches the sensitive pattern "\.env"/m);
    assert.match(preview.stderr, /Preview only/);
    assert.equal(rig.read('remote', 'index.html'), undefined);

    const done = await run('sync', '--put', '--yes');
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /^Synchronized 1 file\. 0 failed\. 1 skipped\.$/m);
    assert.equal(rig.read('remote', 'index.html'), 'home');
    assert.equal(rig.read('remote', '.env'), undefined);

    const again = await run('sync', '--both', '--yes');
    assert.match(again.stdout, /^Nothing to synchronize\.$/m);
  });
});

test('a sync with nothing to transfer saves what it found in sync; a dry run and status save nothing', async () => {
  await withSite('local', async (rig, run) => {
    rig.write('local', 'index.html', 'home');
    rig.write('remote', 'index.html', 'home');
    const records = path.join(rig.home, 'state', 'sites', rig.site.id, `${rig.site.servers[0]?.id ?? ''}.json`);
    const dry = await run('sync', '--both', '--dry-run');
    assert.match(dry.stdout, /^Nothing to synchronize\.$/m);
    assert.equal((await run('status')).code, 0);
    assert.equal(existsSync(records), false);

    const done = await run('sync', '--both');
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /^Nothing to synchronize\.$/m);
    assert.deepEqual(Object.keys(json<{ records: object }>(readFileSync(records, 'utf8')).records), ['index.html']);
  });
});

test("status says what Dreamweaver's records gave, and state reset forgets them only when told to", async () => {
  const rig = await startSiteRig('local', { site: { sync: { dreamweaver: { enabled: true } } } });
  try {
    const run = (...args: string[]): ReturnType<typeof cli> => cli({ home: rig.home, cwd: rig.localDir }, '--ascii', ...args);
    const server = rig.site.servers[0];
    assert.ok(server !== undefined);
    const name = dreamweaverServerName(server);
    const files = ['index.html', 'about.html', 'contact.html'];
    files.forEach((file, index) => {
      rig.write('local', file, `<h1>${file}</h1>`, BASE_TIME + index * 60_000);
      rig.write('remote', file, `<h1>${file}</h1>`, BASE_TIME + 3_600_000 + index * 60_000 + 13_000);
    });
    const entries = files.map((file) => entryFor(path.join(rig.localDir, file), statSync(path.join(rig.remoteDir, file)).mtimeMs, name, { unit: 'second', dst: 0 }));
    const notes = writeDwsync(rig.localDir, [...entries, { ...entries[0], name: 'index.html', server: 'D:/Sites/my-site-testing/', local: 1n, remote: 2n }]);

    const status = await run('status');
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /^In sync: 3 file\(s\)\.\nDreamweaver's records: 3 files in sync\.$/m);
    const asJson = json<{ dreamweaver: unknown }>((await run('status', '--json')).stdout);
    assert.deepEqual(asJson.dreamweaver, { inSync: 3, clock: 'known' });
    assert.match((await run('status', 'index.html')).stdout, /^Dreamweaver's records are not used yet: a sync of the whole site first learns how Dreamweaver reads this server's clock\.$/m);

    assert.match((await run('sync', '--both')).stdout, /^Nothing to synchronize\.$/m);
    assert.doesNotMatch((await run('status')).stdout, /Dreamweaver/, 'files in sync by the records of sync-servers itself are not counted again');

    const kept = await run('state', 'reset', '--yes');
    assert.match(kept.stdout, /^Forgot the sync records of "My Site: Folder"\. Dreamweaver's records are as they were, so the next sync of the whole site takes them over again; pass --dreamweaver to remove this server's entries too\.$/m);
    assert.match((await run('status')).stdout, /^Dreamweaver's records: 3 files in sync\.$/m);

    const removed = await run('state', 'reset', '--dreamweaver', '--yes');
    assert.match(removed.stdout, /^Forgot the sync records of "My Site: Folder", and removed its entries from Dreamweaver's records\. The next sync compares both sides from scratch\.$/m);
    const left = readFileSync(notes, 'utf8');
    assert.ok(left.includes('D:/Sites/my-site-testing/') && !left.includes(name), "only the other server's entry is left");
    const after = await run('status');
    assert.match(after.stdout, /^Server changes \(3\)$/m);
    assert.doesNotMatch(after.stdout, /Dreamweaver/);

    writeDwsync(rig.localDir, entries.slice(0, 2));
    assert.match((await run('status')).stdout, /^Dreamweaver's records are not used yet: too few files match them to tell how Dreamweaver reads this server's clock\.$/m);
  } finally {
    await rig.close();
  }
});

test('sync needs a direction without a terminal, and asks for one in a terminal', async () => {
  await withSite('local', async (rig, run) => {
    rig.write('local', 'a.html', 'a');
    const missing = await run('sync');
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /Pass --put, --get or --both/);
  });
  await withSite(
    'local',
    async (rig, run) => {
      rig.write('local', 'a.html', 'a');
      const asked = await run('sync', '--preview', 'none');
      assert.equal(asked.code, 0, asked.stderr);
      assert.match(
        asked.stderr,
        /Direction\n {2}1\. Put files from a time range\n {2}2\. Put newer files to remote\n {2}3\. Get newer files from remote\n {2}4\. Get and put newer files\nChoose a number \[2\]: Delete remote files not on the local drive\? \(y\/N\): /,
        'Enter takes Put newer files to remote',
      );
      assert.match(asked.stdout, /^Synchronize: My Site -> Folder \(Local\/Network\) {3}Put newer files to remote$/m);
      assert.equal(rig.read('remote', 'a.html'), 'a');
    },
    '\nn\ny\n',
    true,
  );
  await withSite(
    'local',
    async (rig, run) => {
      rig.write('local', 'a.html', 'a');
      const asked = await run('sync', '--delete', '--preview', 'none');
      assert.equal(asked.code, 0, asked.stderr);
      assert.match(asked.stderr, /Direction\n {2}1\. Put newer files to remote\n {2}2\. Get newer files from remote\n {2}3\. Get and put newer files\nChoose a number \[1\]: /, 'a range is not offered beside --delete');
      assert.match(asked.stdout, /Put newer files to remote, deleting files missing on the other side$/m);
      assert.equal(rig.read('remote', 'a.html'), 'a');
    },
    '\ny\n',
    true,
  );
});

test('in a terminal without raw mode the preview falls back to plain mode', async () => {
  await withSite(
    'local',
    async (rig, run) => {
      rig.write('local', 'a.html', 'a');
      rig.write('local', 'b.html', 'b');
      const result = await run('sync', '--put');
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /^ {2}1 \[x\] \^ Put +a\.html$/m);
      assert.match(result.stdout, /^ {2}2 \[x\] \^ Put +b\.html$/m);
      assert.match(result.stdout, /^Files: 1 will be updated, 1 will be skipped$/m);
      assert.match(result.stdout, /^Synchronized 1 file\. 0 failed\. 1 skipped\.$/m);
      assert.equal(rig.read('remote', 'a.html'), 'a');
      assert.equal(rig.read('remote', 'b.html'), undefined);
    },
    '2\ngo\ny\n',
    true,
  );
  await withSite(
    'local',
    async (rig, run) => {
      rig.write('local', 'a.html', 'a');
      const result = await run('sync', '--put');
      assert.equal(result.code, 4);
      assert.match(result.stderr, /Nothing was changed/);
      assert.equal(rig.read('remote', 'a.html'), undefined);
    },
    'q\n',
    true,
  );
});

test('--preview needs a terminal and does not mix with --yes', async () => {
  await withSite('local', async (rig, run) => {
    rig.write('local', 'a.html', 'a');
    const noTerminal = await run('sync', '--put', '--preview', 'plain');
    assert.equal(noTerminal.code, 2);
    assert.match(noTerminal.stderr, /--preview plain needs a terminal/);
    const both = await run('sync', '--put', '--preview', 'editor', '--yes');
    assert.equal(both.code, 2);
    assert.match(both.stderr, /--yes runs without a preview/);
    const unknown = await run('sync', '--put', '--preview', 'fancy');
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /--preview must be one of: tui, editor, plain, none/);
  });
});

test('unresolved conflicts exit 3; mass deletes exit 5 unless allowed', async () => {
  await withSite('local', async (rig, run) => {
    for (const name of ['a.html', 'b.html', 'c.html']) {
      rig.write('local', name, name);
    }
    assert.equal((await run('sync', '--put', '--yes')).code, 0);
    rig.write('local', 'a.html', 'a local', BASE_TIME + 3_600_000);
    rig.write('remote', 'a.html', 'a remote!', BASE_TIME + 3_600_000);
    const conflict = await run('sync', '--both', '--yes');
    assert.equal(conflict.code, 3);
    assert.match(conflict.stdout, /\[ \] \? Resolve +a\.html +Changed locally and on the server/);

    rig.remove('local', 'b.html');
    rig.remove('local', 'c.html');
    const refused = await run('sync', '--put', '--delete', '--yes');
    assert.equal(refused.code, 5);
    assert.match(refused.stderr, /2 remote deletes/);
    assert.equal(rig.read('remote', 'b.html'), 'b.html');
    const allowed = await run('sync', '--put', '--delete', '--yes', '--allow-mass-delete');
    assert.equal(allowed.code, 3, allowed.stdout);
    assert.equal(rig.read('remote', 'b.html'), undefined);
  });
});

test('a saved plan runs only while the site is unchanged', async () => {
  await withSite('local', async (rig, run) => {
    rig.write('local', 'a.html', 'a');
    rig.write('local', 'b.html', 'b');
    const planFile = path.join(rig.home, 'plan.json');
    assert.equal((await run('sync', '--put', '--plan-out', planFile)).code, 0);
    const saved = json<{ schema: string; items: { path: string; checked: boolean }[] }>(readFileSync(planFile, 'utf8'));
    assert.equal(saved.schema, 'sync-servers/plan@1');
    const edited = { ...saved, items: saved.items.map((item) => (item.path === 'b.html' ? { ...item, checked: false } : item)) };
    writeFileSync(planFile, JSON.stringify(edited));
    const ran = await run('sync', '--plan-in', planFile, '--yes');
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(rig.read('remote', 'a.html'), 'a');
    assert.equal(rig.read('remote', 'b.html'), undefined);
    const stale = await run('sync', '--plan-in', planFile, '--yes');
    assert.equal(stale.code, 1);
    assert.match(stale.stderr, /changed since the plan was saved/);
    const mixed = await run('sync', '--plan-in', planFile, '--put');
    assert.equal(mixed.code, 2);
  });
});

test('--json writes one document for sync and status', async () => {
  await withSite('local', async (rig, run) => {
    rig.write('local', 'a.html', 'a');
    const synced = json<{ schema: string; plan: { summary: { update: number } }; result: { done: number } }>((await run('sync', '--put', '--yes', '--json')).stdout);
    assert.deepEqual([synced.schema, synced.plan.summary.update, synced.result.done], ['sync-servers/sync@1', 1, 1]);
    rig.write('remote', 'b.html', 'b');
    const status = json<{ schema: string; remote: { path: string; state: string }[]; inSync: number }>((await run('status', '--json')).stdout);
    assert.deepEqual([status.schema, status.remote, status.inSync], ['sync-servers/status@1', [{ path: 'b.html', state: 'remote-only' }], 1]);
    const text = await run('status');
    assert.match(text.stdout, /^Server changes \(1\)\n {2}b\.html {2}new$/m);
  });
});

test('put, get, diff, mark-synced and state reset', async () => {
  await withSite('local', async (rig, run) => {
    rig.write('local', 'css/site.css', 'body { color: red; }\n');
    const put = await run('put', path.join('css', 'site.css'));
    assert.equal(put.code, 0, put.stderr);
    assert.equal(rig.read('remote', 'css/site.css'), 'body { color: red; }\n');
    assert.match((await run('put', 'css/site.css')).stdout, /^Already in sync\.$/m);

    rig.write('remote', 'css/site.css', 'body { color: blue; }\n', BASE_TIME + 60_000);
    const diff = await run('diff', 'css/site.css');
    assert.match(diff.stdout, /^-body \{ color: red; \}$/m);
    assert.match(diff.stdout, /^\+body \{ color: blue; \}$/m);
    const get = await run('get', 'css');
    assert.equal(get.code, 0, get.stderr);
    assert.equal(rig.read('local', 'css/site.css'), 'body { color: blue; }\n');
    assert.match((await run('diff', 'css/site.css')).stdout, /identical/);

    rig.write('local', 'logo.png', '\u0000\u0001binary');
    rig.write('remote', 'logo.png', '\u0000\u0002binary!');
    const binary = json<{ binary: boolean; identical: boolean; local: { sha256: string } }>((await run('diff', 'logo.png', '--json')).stdout);
    assert.deepEqual([binary.binary, binary.identical, binary.local.sha256.length], [true, false, 64]);

    const marked = await run('mark-synced', '.');
    assert.match(marked.stdout, /^Marked 2 file\(s\) as synchronized\.$/m);
    assert.match((await run('status')).stdout, /^In sync: 2 file\(s\)\.$/m);
    assert.equal((await run('state', 'reset')).code, 2);
    assert.match((await run('state', 'reset', '--yes')).stdout, /^Forgot the sync records/);
    const outside = await run('put', path.join('..', 'elsewhere.html'));
    assert.equal(outside.code, 2);
  });
});

test('sync over SFTP from the CLI, with the password from the environment, never shows it in any output', async () => {
  await withSite('sftp', async (rig, run) => {
    rig.write('local', 'index.html', 'home');
    const first = await run('sync', '--put', '--yes', '--debug');
    assert.equal(first.code, 0, first.stderr);
    assert.equal(rig.read('remote', 'index.html'), 'home');
    assert.match(first.stderr, /debug: /, 'the debug traces were on');
    const runs = [
      first,
      await run('status', '--json', '--debug'),
      await run('sync', '--both', '--json', '--debug'),
      await run('diff', 'index.html', '--debug'),
      await run('server', 'test', '--json', '--debug'),
    ];
    for (const result of runs) {
      assert.ok(!result.stdout.includes(rig.rig.password), 'stdout holds the password');
      assert.ok(!result.stderr.includes(rig.rig.password), 'stderr holds the password');
    }
  });
});

test('a global pattern keeps matching files out of the plan on both sides, unless the site ignores it or re-includes them', async () => {
  await withSite('local', async (rig, run) => {
    rig.write('local', 'index.html', 'home');
    rig.write('local', 'node_modules/lib.js', 'local');
    rig.write('remote', 'node_modules/other.js', 'remote');
    assert.equal((await run('cloak', '--global', 'node_modules/')).code, 0);
    const cloaked = await run('sync', '--both', '--dry-run');
    assert.equal(cloaked.code, 0, cloaked.stderr);
    assert.match(cloaked.stdout, /index\.html/);
    assert.doesNotMatch(cloaked.stdout, /node_modules/);

    await run('cloak', '--ignore-global');
    const ignored = await run('sync', '--both', '--dry-run');
    assert.match(ignored.stdout, /^ {2}\[x\] \^ Put +node_modules\/lib\.js$/m);
    assert.match(ignored.stdout, /^ {2}\[x\] v Get +node_modules\/other\.js$/m);

    await run('cloak', '--use-global', '!node_modules/');
    assert.match((await run('sync', '--both', '--dry-run')).stdout, /node_modules\/lib\.js/, 'the site re-includes what the global pattern cloaks');

    await run('uncloak', '!node_modules/');
    assert.equal((await run('sync', '--both', '--yes')).code, 0);
    assert.equal(rig.read('remote', 'index.html'), 'home');
    assert.equal(rig.read('remote', 'node_modules/lib.js'), undefined, 'a cloaked file is never transferred');
    assert.equal(rig.read('remote', 'node_modules/other.js'), 'remote', 'nor deleted');
  });
});

const DAY = 86_400_000;
const RANGE_FORMAT = 'a number and a unit: m for minutes, h for hours, d for days or w for weeks, such as 90m, 24h, 2d or 1w';

/** The files a site holds before a range starts, and those written after. */
const OLDER: Readonly<Record<string, string>> = { 'about.html': '<h1>About</h1>', 'css/site.css': 'body {}' };
const NEWER: Readonly<Record<string, string>> = { 'index.html': '<h1>Home</h1>', 'css/print.css': 'p {}' };

/**
 * Writes the older files, then the newer ones, and moves this computer's
 * clock ahead so that a range of `rangeMs` starts between the two. Returns
 * the moment the range then starts.
 */
async function aroundRange(t: TestContext, rig: SiteRig, rangeMs: number, older = OLDER, newer = NEWER): Promise<number> {
  for (const [name, content] of Object.entries(older)) {
    rig.write('local', name, content);
  }
  await wait(50);
  const start = Date.now();
  await wait(50);
  const edited = Math.ceil(Date.now() / 1000) * 1000;
  for (const [name, content] of Object.entries(newer)) {
    rig.write('local', name, content, edited);
  }
  t.mock.timers.enable({ apis: ['Date'], now: start + rangeMs });
  return start;
}

/**
 * Writes a local file that every range takes in. Its modification time is
 * now: on macOS a file given an earlier modification time takes that time
 * as its creation time too, so the default time of the rig would leave it
 * out.
 */
function writeRecent(rig: SiteRig, name: string, content: string): void {
  rig.write('local', name, content, Date.now());
}

/** Every file of the state folder but the run logs, with its content. */
function stateFiles(rig: SiteRig): string[] {
  const state = path.join(rig.home, 'state');
  if (!existsSync(state)) {
    return [];
  }
  return readdirSync(state, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.split(path.sep)[0] !== 'logs' && statSync(path.join(state, name)).isFile())
    .sort()
    .map((name) => `${name}: ${readFileSync(path.join(state, name), 'utf8')}`);
}

const previewRows = (stdout: string): string[] => [...stdout.matchAll(/^ {2}\[.\] . \w+ +(\S+)/gm)].map((match) => match[1] ?? '');

test('sync --put recent --range lists only the files of the range, however the range and the word are written', async (t) => {
  await withSite('local', async (rig, run) => {
    await aroundRange(t, rig, 2 * DAY);
    const preview = await run('sync', '--put', 'recent', '--range', '2d');
    assert.equal(preview.code, 0, preview.stderr);
    assert.match(preview.stdout, /^Synchronize: My Site -> Folder \(Local\/Network\) {3}Put files from the last 2 days$/m);
    assert.match(preview.stdout, /^Files: 2 will be updated, 0 will be skipped$/m);
    assert.deepEqual(previewRows(preview.stdout), ['css/print.css', 'index.html']);
    assert.match(preview.stderr, /Preview only/);
    assert.equal(rig.read('remote', 'index.html'), undefined);

    for (const args of [['--put', 'recent', '-r', '2d'], ['--put', '--range', '2d'], ['recent', '-r', '2d'], ['-r', '2d'], ['--range=2d', '--put', 'recent'], ['--put', 'recent', '--range', '48h']]) {
      const same = await run('sync', ...args);
      assert.equal(same.code, 0, `${args.join(' ')}: ${same.stderr}`);
      assert.deepEqual(previewRows(same.stdout), ['css/print.css', 'index.html'], args.join(' '));
    }
    assert.match((await run('sync', '--put', 'recent', '--range', '48h')).stdout, / {3}Put files from the last 48 hours$/m);

    const folder = await run('sync', '--put', 'recent', '-r', '2d', 'css');
    assert.deepEqual(previewRows(folder.stdout), ['css/print.css']);
    assert.deepEqual(previewRows((await run('sync', '--put', 'recent', '--range', '2d', 'about.html', 'index.html')).stdout), ['index.html']);
    assert.equal((await run('sync', '--put')).stdout.match(/\^ Put/g)?.length, 4, 'without a range every file is listed');
  });
});

test('a sync from a range runs with --yes, and a dry run of one leaves the state folder as it was', async (t) => {
  await withSite('local', async (rig, run) => {
    const start = await aroundRange(t, rig, 2 * DAY);
    const dry = await run('sync', '--put', 'recent', '--range', '2d', '--dry-run');
    assert.equal(dry.code, 0, dry.stderr);
    assert.deepEqual(previewRows(dry.stdout), ['css/print.css', 'index.html']);
    assert.deepEqual(stateFiles(rig), []);
    assert.equal(rig.read('remote', 'index.html'), undefined);

    const done = await run('sync', '--put', 'recent', '--range', '2d', '--yes', '--json');
    assert.equal(done.code, 0, done.stderr);
    const document = json<{ schema: string; plan: { direction: string; deleteOrphans: boolean; scope: unknown }; result: { done: number }; range: unknown }>(done.stdout);
    assert.equal(document.schema, 'sync-servers/sync@1');
    assert.deepEqual(document.range, { text: '2d', since: new Date(start).toISOString() });
    assert.deepEqual(document.plan.scope, { kind: 'paths', paths: ['css/print.css', 'index.html'] });
    assert.deepEqual([document.plan.direction, document.plan.deleteOrphans, document.result.done], ['put', false, 2]);
    assert.equal(rig.read('remote', 'index.html'), NEWER['index.html']);
    assert.equal(rig.read('remote', 'css/print.css'), NEWER['css/print.css']);
    assert.equal(rig.read('remote', 'about.html'), undefined, 'a file older than the range stays where it is');

    const records = stateFiles(rig);
    assert.equal(records.length, 1);
    const again = await run('sync', '--put', 'recent', '--range', '2d', '--dry-run');
    assert.match(again.stdout, /^Files: 0 will be updated, 2 will be skipped\nNothing to synchronize\.$/m);
    assert.deepEqual(stateFiles(rig), records);
    assert.equal(existsSync(path.join(rig.localDir, '_notes')), false);
    assert.equal(json<{ range: { text: string } }>((await run('sync', '--put', '-r', '2d', '--dry-run', '--json')).stdout).range.text, '2d');
  });
});

test('--range is refused with what it does not go with, before anything is looked at', async () => {
  await withSite('local', async (rig, run) => {
    rig.write('local', 'index.html', 'home');
    const planFile = path.join(rig.home, 'plan.json');
    assert.equal((await run('sync', '--put', '--plan-out', planFile)).code, 0);
    const refusals: readonly (readonly [readonly string[], string])[] = [
      [['--put', '--range', '2D'], `--range takes ${RANGE_FORMAT}.`],
      [['--range', '2M'], `--range takes ${RANGE_FORMAT}.`],
      [['--get', '--range', '2d'], '--range goes with --put: it chooses among the files of this computer.'],
      [['--both', '-r', '2d'], '--range goes with --put: it chooses among the files of this computer.'],
      [['--put', '--delete', '--range', '2d'], '--range does not go with --delete: a range never lists a delete.'],
      [['--delete', '-r', '90m', 'recent'], '--range does not go with --delete: a range never lists a delete.'],
      [['--plan-in', planFile, '--range', '2d'], 'A saved plan already holds its files: --range does not go with --plan-in.'],
      [['--plan-in', path.join(rig.home, 'missing.json'), '-r', '2d'], 'A saved plan already holds its files: --range does not go with --plan-in.'],
    ];
    for (const [args, message] of refusals) {
      const refused = await run('sync', ...args, '--yes');
      assert.equal(refused.code, 2, args.join(' '));
      assert.ok(refused.stderr.startsWith(`sync-servers: ${message}\n`), `${args.join(' ')}: ${refused.stderr}`);
      assert.equal(refused.stdout, '');
    }
    assert.equal(rig.read('remote', 'index.html'), undefined);
  });
});

test('recent is a path without a range, and with one ./recent names a folder of that name', async () => {
  await withSite('local', async (rig, run) => {
    writeRecent(rig, 'index.html', 'home');
    writeRecent(rig, 'recent/news.html', 'news');
    const asPath = await run('sync', '--put', 'recent');
    assert.equal(asPath.code, 0, asPath.stderr);
    assert.match(asPath.stdout, / {3}Put newer files to remote$/m);
    assert.deepEqual(previewRows(asPath.stdout), ['recent/news.html']);
    assert.doesNotMatch(asPath.stderr, /add a range/);

    assert.deepEqual(previewRows((await run('sync', '--put', 'recent', '--range', '2d')).stdout), ['index.html', 'recent/news.html'], 'the word, then the whole site');
    assert.deepEqual(previewRows((await run('sync', '--put', './recent', '--range', '2d')).stdout), ['recent/news.html']);
    assert.deepEqual(previewRows((await run('sync', '--put', 'recent', 'recent', '--range', '2d')).stdout), ['recent/news.html'], 'the word, then the folder');
    assert.deepEqual(previewRows((await run('sync', '--put', 'index.html', 'recent', '-r', '2d')).stdout), ['index.html', 'recent/news.html'], 'only the first argument is the word');
  });
});

test('sync --put recent without a range hints at the range when nothing is named recent', async () => {
  await withSite('local', async (rig, run) => {
    rig.write('local', 'index.html', 'home');
    const hint = 'No file or folder named "recent" is in "My Site". For the files changed lately, add a range: sync-servers sync --put recent --range 1d\n';
    const slip = await run('sync', '--put', 'recent');
    assert.equal(slip.code, 0, slip.stderr);
    assert.match(slip.stdout, /^Nothing to synchronize\.$/m);
    assert.equal(slip.stderr, hint);
    const beside = await run('sync', '--put', 'recent', 'index.html');
    assert.deepEqual(previewRows(beside.stdout), ['index.html']);
    assert.ok(beside.stderr.endsWith(hint), beside.stderr);
    assert.ok((await run('sync', '--put', 'recent', '--json')).stderr.endsWith(hint));

    assert.doesNotMatch((await run('sync', '--get', 'recent')).stderr, /add a range/, 'the hint is for a Put');
    assert.doesNotMatch((await run('sync', '--put', './recent')).stderr, /add a range/, 'and for the bare word');
    assert.doesNotMatch((await run('sync', '--put', 'index.html', 'recent')).stderr, /add a range/, 'as the first argument');
    rig.write('remote', 'recent/old.html', 'old');
    assert.doesNotMatch((await run('sync', '--put', 'recent')).stderr, /add a range/, 'the server has a folder of that name');
    assert.doesNotMatch((await run('sync', '--put', 'recent', 'index.html')).stderr, /add a range/);
    rig.remove('remote', 'recent');
    rig.write('local', 'recent', 'a file named recent');
    assert.doesNotMatch((await run('sync', '--put', 'recent', '--yes')).stderr, /add a range/, 'a file of that name is put');
    assert.equal(rig.read('remote', 'recent'), 'a file named recent');
  });
});

test('a range with no recent file says so and ends well, in every form of output', async (t) => {
  await withSite('local', async (rig, run) => {
    rig.write('local', 'index.html', 'home');
    const now = Date.now() + 30 * DAY;
    t.mock.timers.enable({ apis: ['Date'], now });
    const message = 'No file of "My Site" was created or modified in the last day.\n';
    for (const args of [[], ['--yes'], ['--dry-run'], ['--preview', 'none']]) {
      const none = await run('sync', '--put', 'recent', '--range', '1d', ...args);
      assert.deepEqual([none.code, none.stdout, none.stderr], [0, message, ''], args.join(' '));
    }
    assert.equal((await run('sync', '--put', 'recent', '-r', '90m', 'index.html')).stdout, 'No file of "My Site" was created or modified in the last 90 minutes.\n');
    const document = json<{ plan: { items: unknown[]; scope: unknown }; result: unknown; range: unknown }>((await run('sync', '--put', 'recent', '--range', '1d', '--json')).stdout);
    assert.deepEqual(document.plan.items, []);
    assert.deepEqual(document.plan.scope, { kind: 'paths', paths: [] });
    assert.equal(document.result, null);
    assert.deepEqual(document.range, { text: '1d', since: new Date(now - DAY).toISOString() });
    assert.deepEqual(stateFiles(rig), []);
    t.mock.timers.reset();
  });
  for (const mode of ['plain', 'editor', 'tui']) {
    await withSite(
      'local',
      async (rig, run) => {
        rig.write('local', 'index.html', 'home');
        t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 30 * DAY });
        const none = await run('sync', '--put', 'recent', '--range', '1w', '--preview', mode);
        assert.deepEqual([none.code, none.stdout], [0, 'No file of "My Site" was created or modified in the last week.\n'], mode);
        t.mock.timers.reset();
      },
      '',
      true,
    );
  }
});

test('a plan saved from a range runs again with --plan-in', async (t) => {
  await withSite('local', async (rig, run) => {
    await aroundRange(t, rig, 90 * 60_000);
    const planFile = path.join(rig.home, 'plan.json');
    const saved = await run('sync', '--put', 'recent', '--range', '90m', '--plan-out', planFile);
    assert.equal(saved.code, 0, saved.stderr);
    assert.match(saved.stdout, / {3}Put files from the last 90 minutes$/m);
    const plan = json<{ direction: string; deleteOrphans: boolean; scope: unknown; items: { path: string }[] }>(readFileSync(planFile, 'utf8'));
    assert.deepEqual([plan.direction, plan.deleteOrphans], ['put', false]);
    assert.deepEqual(plan.scope, { kind: 'paths', paths: ['css/print.css', 'index.html'] });
    assert.deepEqual(plan.items.map((item) => item.path), ['css/print.css', 'index.html']);

    const ran = await run('sync', '--plan-in', planFile, '--yes');
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /^Synchronized 2 files\. 0 failed\. 0 skipped\.$/m);
    assert.equal(rig.read('remote', 'index.html'), NEWER['index.html']);
    assert.equal(rig.read('remote', 'about.html'), undefined);
    const stale = await run('sync', '--plan-in', planFile, '--yes');
    assert.equal(stale.code, 1);
    assert.match(stale.stderr, /changed since the plan was saved/);
  });
});

test('the direction question offers the range first, asks for it until it is one, and takes Enter as 1d', async () => {
  await withSite(
    'local',
    async (rig, run) => {
      writeRecent(rig, 'a.html', 'a');
      const asked = await run('sync', '--preview', 'none');
      assert.equal(asked.code, 0, asked.stderr);
      assert.match(
        asked.stderr,
        new RegExp(
          [
            'Direction',
            ' {2}1\\. Put files from a time range',
            ' {2}2\\. Put newer files to remote',
            ' {2}3\\. Get newer files from remote',
            ' {2}4\\. Get and put newer files',
            `Choose a number \\[2\\]: Put files created or modified in the last \\[1d\\]: Enter ${RANGE_FORMAT}\\.`,
            `Put files created or modified in the last \\[1d\\]: Enter ${RANGE_FORMAT}\\.`,
            'Put files created or modified in the last \\[1d\\]: Synchronize 1 file\\(s\\)\\? \\(y\\/N\\): ',
          ].join('\n'),
        ),
      );
      assert.doesNotMatch(asked.stderr, /Delete remote files/, 'a range asks nothing about deletes');
      assert.match(asked.stdout, /^Synchronize: My Site -> Folder \(Local\/Network\) {3}Put files from the last day$/m);
      assert.deepEqual(previewRows(asked.stdout), ['a.html']);
      assert.equal(rig.read('remote', 'a.html'), 'a');
    },
    '1\n2x\n2 d\n\ny\n',
    true,
  );
  await withSite(
    'local',
    async (rig, run) => {
      writeRecent(rig, 'recent/news.html', 'news');
      writeRecent(rig, 'a.html', 'a');
      const asked = await run('sync', 'recent', '--preview', 'none');
      assert.equal(asked.code, 0, asked.stderr);
      assert.match(asked.stdout, / {3}Put files from the last 90 minutes$/m);
      assert.deepEqual(previewRows(asked.stdout), ['recent/news.html'], 'without --range the word is a path, even when the range is chosen in the question');
    },
    '1\n90m\ny\n',
    true,
  );
});
