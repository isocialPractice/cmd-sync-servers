import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { applyEditedRows, editPlan, formatPlanForEditor, parseEditedPlan } from '../../src/cli/preview-editor.ts';
import { parseNumbers } from '../../src/cli/plain.ts';
import type { SyncPlan } from '../../src/sync/plan.ts';
import { cli, tempDir } from '../helpers/cli.ts';
import { startSiteRig, type SiteRig } from '../sandbox/site-rig.ts';

async function withPlan(run: (plan: SyncPlan, rig: SiteRig) => void | Promise<void>): Promise<void> {
  const rig = await startSiteRig('local');
  try {
    rig.write('local', 'index.html', 'home');
    rig.write('local', '.env', 'SECRET=1');
    rig.write('local', 'css/site.css', 'body { color: red }');
    rig.write('remote', 'css/site.css', 'body {}');
    rig.write('remote', 'old.html', 'old');
    const session = await rig.open();
    try {
      await run(await session.plan({ direction: 'both', deleteOrphans: false }), rig);
    } finally {
      await session.close();
    }
  } finally {
    await rig.close();
  }
}

function row(plan: SyncPlan, file: string): { id: number; action: string; checked: boolean | undefined } {
  const item = plan.item(file);
  assert.ok(item !== undefined, file);
  return { id: item.id, action: item.action, checked: item.checked };
}

test('editor mode writes the plan as numbered rows under a commented header', async () => {
  await withPlan((plan, rig) => {
    const text = formatPlanForEditor(plan, rig.site, rig.site.servers[0] ?? assert.fail());
    const lines = text.split('\n');
    assert.equal(lines[0], '# sync-servers preview: My Site -> Folder (Local/Network)');
    assert.equal(lines[1], '# Get and put newer files');
    assert.match(lines[2] ?? '', /^# Files: \d+ will be updated/);
    assert.ok(lines.includes('#   put  get  skip  synced  delete-remote  delete-local'));
    const env = row(plan, '.env');
    const css = row(plan, 'css/site.css');
    assert.match(text, new RegExp(`^\\[ \\] put +${String(env.id)}  \\.env +# Matches the sensitive pattern "\\.env"`, 'm'));
    assert.match(text, new RegExp(`^\\[ \\] resolve +${String(css.id)}  css/site\\.css +# `, 'm'));
    assert.match(text, /^\[x\] put +\d+ {2}index\.html$/m);
    assert.match(text, /^\[x\] get +\d+ {2}old\.html$/m);
    assert.deepEqual(parseEditedPlan(text, plan), {
      kind: 'ok',
      rows: plan.items.map((item) => ({ id: item.id, action: item.action, checked: item.checked === true && item.action !== 'skip' })),
    });
  });
});

test('editor mode applies changed boxes and actions; deleted rows are skipped', async () => {
  await withPlan((plan, rig) => {
    const css = row(plan, 'css/site.css');
    const index = row(plan, 'index.html');
    const old = row(plan, 'old.html');
    const text = formatPlanForEditor(plan, rig.site, rig.site.servers[0] ?? assert.fail())
      .replace(/^\[ \] resolve( +\d+ {2}css\/site\.css)/m, '[x] put    $1')
      .replace(/^\[x\] get +\d+ {2}old\.html\n/m, '')
      .replace(/^\[x\] put( +\d+ {2}index\.html)/m, '[ ] put$1');
    const parsed = parseEditedPlan(text, plan);
    assert.equal(parsed.kind, 'ok');
    applyEditedRows(plan, parsed.rows);
    assert.deepEqual(row(plan, 'css/site.css'), { ...css, action: 'put', checked: true });
    assert.equal(row(plan, 'index.html').checked, false);
    assert.equal(row(plan, 'index.html').id, index.id);
    assert.equal(row(plan, 'old.html').checked, false);
    assert.equal(row(plan, 'old.html').id, old.id);
  });
});

test('editor mode refuses rows the plan does not hold, changed paths, unknown or impossible actions and a checked resolve', async () => {
  await withPlan((plan) => {
    const index = row(plan, 'index.html').id;
    const css = row(plan, 'css/site.css').id;
    const check = (line: string, pattern: RegExp): void => {
      const parsed = parseEditedPlan(`# header\n${line}\n`, plan);
      assert.equal(parsed.kind, 'errors', line);
      assert.match(parsed.errors[0] ?? '', pattern, line);
    };
    check('[x] put  99  new.html', /^Line 2: the plan has no row 99\. Rows can only be changed or deleted, never added\.$/);
    check(`[x] put  ${String(index)}  other.html`, new RegExp(`row ${String(index)} is index\\.html; put the path back as it was\\.`));
    check(`[x] upload  ${String(index)}  index.html`, /"upload" is not an action\. Use one of: put, get, skip, synced, delete-remote, delete-local\./);
    check(`[x] get  ${String(index)}  index.html`, /index\.html cannot take "get"; it can take put, skip, delete-local\./);
    check(`[x] resolve  ${String(css)}  css/site.css`, /css\/site\.css needs a decision\./);
    check(`[ ] resolve  ${String(index)}  index.html`, /"resolve" is not a choice/);
    check('put index.html', /expected "\[x\] action number path"/);
    const twice = parseEditedPlan(`[x] put  ${String(index)}  index.html\n[ ] put  ${String(index)}  index.html\n`, plan);
    assert.deepEqual(twice, { kind: 'errors', errors: [`Line 2: row ${String(index)} appears twice.`] });
    assert.deepEqual(parseEditedPlan('# every row deleted\n\n', plan), { kind: 'cancel' });
    const bom = String.fromCharCode(0xfeff);
    assert.equal(parseEditedPlan(`${bom}[ ] resolve  ${String(css)}  css/site.css   # still undecided\n`, plan).kind, 'ok');
  });
});

test('editor mode reopens with the problems at the top until the file reads cleanly, and cancels when closed unchanged', async () => {
  await withPlan(async (plan, rig) => {
    const server = rig.site.servers[0] ?? assert.fail();
    const seen: string[] = [];
    let file = '';
    const edits = [
      async (target: string) => {
        file = target;
        if (process.platform !== 'win32') {
          assert.equal(statSync(target).mode & 0o777, 0o600);
        }
        const text = await readFile(target, 'utf8');
        seen.push(text);
        await writeFile(target, text.replace(/^\[x\] get( +\d+ {2}old\.html)/m, '[x] fetch$1'));
      },
      async (target: string) => {
        const text = await readFile(target, 'utf8');
        seen.push(text);
        await writeFile(target, text.replace(/^\[x\] fetch( +\d+ {2}old\.html)/m, '[ ] get$1'));
      },
    ];
    const go = await editPlan(plan, rig.site, server, { env: {}, platform: process.platform }, (target) => (edits.shift() ?? assert.fail())(target));
    assert.equal(go, true);
    assert.equal(seen.length, 2);
    assert.match(seen[1] ?? '', /^# ! Fix these problems, then save and close\. Delete every row to cancel\.\n# ! {3}Line \d+: "fetch" is not an action\./);
    assert.match(seen[1] ?? '', /^\[x\] fetch +\d+ {2}old\.html$/m);
    assert.equal(row(plan, 'old.html').checked, false);
    assert.ok(!existsSync(file));

    assert.equal(await editPlan(plan, rig.site, server, { env: {}, platform: process.platform }, () => Promise.resolve()), false);
    assert.equal(
      await editPlan(plan, rig.site, server, { env: {}, platform: process.platform }, async (target) => {
        await writeFile(target, '# nothing left\n');
      }),
      false,
    );
  });
});

test('plain mode reads row numbers and ranges', () => {
  assert.deepEqual(parseNumbers(['3']), [3]);
  assert.deepEqual(parseNumbers(['1', '4-6']), [1, 4, 5, 6]);
  assert.equal(parseNumbers(['6-4']), undefined);
  assert.equal(parseNumbers(['x']), undefined);
  assert.deepEqual(parseNumbers([]), []);
});

async function withSite(run: (rig: SiteRig) => Promise<void>): Promise<void> {
  const rig = await startSiteRig('local');
  try {
    await run(rig);
  } finally {
    await rig.close();
  }
}

test('sync --preview editor opens the plan in the editor and runs what was saved', async () => {
  await withSite(async (rig) => {
    rig.write('local', 'a.html', 'a');
    rig.write('local', 'b.html', 'b');
    const scripts = tempDir();
    try {
      const script = path.join(scripts.dir, 'uncheck-b.mjs');
      writeFileSync(
        script,
        [
          "import { readFileSync, writeFileSync } from 'node:fs';",
          'const file = process.argv[2];',
          "writeFileSync(file, readFileSync(file, 'utf8').replace(/^\\[x\\] (put +\\d+ {2}b\\.html)/m, '[ ] $1'));",
          '',
        ].join('\n'),
      );
      const env = { SYNC_SERVERS_EDITOR: `node "${script}"` };
      const result = await cli({ home: rig.home, cwd: rig.localDir, env, tty: true }, '--ascii', 'sync', '--put', '--preview', 'editor');
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /^Synchronized 1 file\. 0 failed\. 1 skipped\.$/m);
      assert.equal(rig.read('remote', 'a.html'), 'a');
      assert.equal(rig.read('remote', 'b.html'), undefined);

      rig.write('local', 'c.html', 'c');
      const fromEnv = await cli({ home: rig.home, cwd: rig.localDir, env: { ...env, SYNC_SERVERS_UI: 'editor' }, tty: true }, '--ascii', 'sync', '--put');
      assert.equal(fromEnv.code, 0, fromEnv.stderr);
      assert.equal(rig.read('remote', 'c.html'), 'c');
    } finally {
      scripts.cleanup();
    }
  });
});

test('SYNC_SERVERS_UI=none keeps the printed preview and the yes or no question', async () => {
  await withSite(async (rig) => {
    rig.write('local', 'a.html', 'a');
    const result = await cli({ home: rig.home, cwd: rig.localDir, env: { SYNC_SERVERS_UI: 'none' }, input: 'y\n', tty: true }, '--ascii', 'sync', '--put');
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, /Synchronize 1 file\(s\)\? \(y\/N\)/);
    assert.equal(rig.read('remote', 'a.html'), 'a');
  });
});

test('with no command, a terminal gets the plain menus; a pipe gets the help', async () => {
  await withSite(async (rig) => {
    rig.write('local', 'a.html', 'a');
    const help = await cli({ home: rig.home, cwd: rig.localDir });
    assert.equal(help.code, 0);
    assert.match(help.stdout, /^Usage:\n {2}sync-servers +Open the sites in the terminal UI/m);

    const status = await cli({ home: rig.home, cwd: rig.localDir, input: '4\n8\n', tty: true }, '--ascii');
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /^My Site {2}/m);
    assert.match(status.stdout, /^Local changes \(1\)$/m);
    assert.match(status.stderr, /What now\?\n {2}1\. Synchronize\.\.\./);

    const cdFile = path.join(rig.home, 'cd.txt');
    const put = await cli({ home: rig.home, cwd: rig.home, input: '1\n2\ngo\ny\n8\n', tty: true }, '--ascii', '--cd-file', cdFile);
    assert.equal(put.code, 0, put.stderr);
    assert.match(put.stdout, /^Sites\n {2}1\. My Site {2}/m);
    assert.match(put.stdout, /^Synchronized 1 file\. 0 failed\. 0 skipped\.$/m);
    assert.equal(rig.read('remote', 'a.html'), 'a');
    assert.equal(readFileSync(cdFile, 'utf8'), rig.localDir);

    const back = await cli({ home: rig.home, cwd: rig.localDir, input: '7\nq\n', tty: true }, '--plain');
    assert.equal(back.code, 0, back.stderr);
    assert.match(back.stdout, /^Sites$/m);

    rig.write('local', 'b.html', 'b');
    const cancelled = await cli({ home: rig.home, cwd: rig.localDir, input: '1\n1\nn\nzz\nq\n8\n', tty: true }, '--ascii');
    assert.equal(cancelled.code, 4);
    assert.match(cancelled.stdout, /Unknown command "zz"\. Type "help" for commands\./);
    assert.match(cancelled.stderr, /Nothing was changed\./);
    assert.equal(rig.read('remote', 'b.html'), undefined);
  });
});
