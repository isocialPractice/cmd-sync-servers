import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { cli, filesContaining } from '../helpers/cli.ts';
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
      const asked = await run('sync');
      assert.equal(asked.code, 0, asked.stderr);
      assert.match(asked.stderr, /Direction\n {2}1\. Put newer files to remote/);
      assert.equal(rig.read('remote', 'a.html'), 'a');
    },
    '1\nn\ny\n',
    true,
  );
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

test('sync over SFTP from the CLI, with the password from the environment', async () => {
  await withSite('sftp', async (rig, run) => {
    rig.write('local', 'index.html', 'home');
    const result = await run('sync', '--put', '--yes', '--debug');
    assert.equal(result.code, 0, result.stderr);
    assert.equal(rig.read('remote', 'index.html'), 'home');
    assert.ok(!result.stderr.includes(rig.rig.password));
  });
});
