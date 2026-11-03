import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { formatPreview } from '../../../src/cli/commands/sync.ts';
import { CommandContext } from '../../../src/cli/context.ts';
import { formatNumberedPreview } from '../../../src/cli/plain.ts';
import { formatPlanForEditor } from '../../../src/cli/preview-editor.ts';
import type { Server, Site } from '../../../src/config/schema.ts';
import { isSyncError } from '../../../src/errors.ts';
import { fakeIo, tempDir } from '../../helpers/cli.ts';
import { guardedStatus, STATUS } from '../../../src/sync/messages.ts';
import { toRemotePath, type RemotePath } from '../../../src/sync/paths.ts';
import { SyncPlan, type PlanInput } from '../../../src/sync/plan.ts';
import { siteGuard } from '../../../src/sync/guard.ts';
import type { LinkedFile, ScanResult } from '../../../src/sync/scan-local.ts';
import type { SyncRecord } from '../../../src/sync/state.ts';
import type { Observation, ScanProblem } from '../../../src/sync/types.ts';

const T = 1_761_753_600_000;
const obs = (size: number, mtimeMs = T): Observation => ({ size, mtimeMs });

function scan(files: Record<string, Observation>, problems: ScanProblem[] = [], linked: Record<string, LinkedFile> = {}): ScanResult {
  return {
    files: new Map(Object.entries(files).map(([key, value]) => [toRemotePath(key), value])),
    dirs: new Set<RemotePath>(),
    problems,
    cloaked: 0,
    linked: new Map(Object.entries(linked).map(([key, value]) => [toRemotePath(key), value])),
  };
}

/** A file reached through a link that leads to `parts` under the top of this drive. */
const linkTo = (sitePath: string | undefined, ...parts: string[]): LinkedFile => ({
  real: path.resolve(path.sep, ...parts),
  outside: sitePath === undefined,
  sitePath: sitePath === undefined ? undefined : toRemotePath(sitePath),
});

function plan(overrides: Partial<PlanInput> = {}): SyncPlan {
  return new SyncPlan({
    siteId: 'site-1',
    serverId: 'server-1',
    direction: 'put',
    deleteOrphans: false,
    scope: { kind: 'site' },
    local: scan({}),
    remote: scan({}),
    records: new Map<string, SyncRecord>(),
    compare: { toleranceMs: 2000, checksum: false },
    guard: { match: (target) => (target === '.env' ? '.env' : undefined) },
    caseInsensitive: false,
    now: T,
    ...overrides,
  });
}

test('only paths with a difference are listed; the rest are counted as skipped', () => {
  const same = obs(5);
  const result = plan({
    local: scan({ 'index.html': same, 'css/site.css': obs(9, T + 60_000), 'new.html': obs(3) }),
    remote: scan({ 'index.html': same, 'css/site.css': obs(8) }),
    records: new Map([
      ['index.html', { local: same, remote: same, syncedAt: T }],
      ['css/site.css', { local: obs(8), remote: obs(8), syncedAt: T }],
    ]),
  });
  assert.deepEqual(result.items.map((item) => [item.id, item.path, item.action, item.checked]), [
    [1, 'css/site.css', 'put', true],
    [2, 'new.html', 'put', true],
  ]);
  assert.deepEqual(result.summary, { update: 2, delete: 0, skip: 1, resolve: 0, guarded: 0, errors: 0 });
  assert.equal(result.summaryLine(), 'Files: 2 will be updated, 1 will be skipped');
});

test('matching first-sync copies and vanished files only touch the records', () => {
  const result = plan({
    local: scan({ 'same.txt': obs(4) }),
    remote: scan({ 'same.txt': obs(4, T + 1000) }),
    records: new Map([['gone.txt', { local: obs(1), remote: obs(1), syncedAt: T }]]),
  });
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.silent.map((update) => [update.path, update.record === undefined]), [
    ['gone.txt', true],
    ['same.txt', false],
  ]);
});

test('the guard unchecks sensitive files and names the pattern', () => {
  const result = plan({ local: scan({ '.env': obs(1), 'index.html': obs(2) }) });
  const env = result.item('.env');
  assert.equal(env?.checked, false);
  assert.equal(env.guarded, '.env');
  assert.equal(env.status, guardedStatus('.env'));
  assert.equal(result.summary.guarded, 1);
});

test('conflicts need a decision, and choosing an action checks the row', () => {
  const result = plan({
    local: scan({ 'css/site.css': obs(9, T + 60_000) }),
    remote: scan({ 'css/site.css': obs(7, T + 60_000) }),
    records: new Map([['css/site.css', { local: obs(8), remote: obs(8), syncedAt: T }]]),
  });
  const row = result.item(1);
  assert.equal(row?.action, 'resolve');
  assert.equal(row.checked, undefined);
  assert.equal(row.status, STATUS.bothChanged);
  assert.equal(result.summaryLine(), 'Files: 0 will be updated, 0 will be skipped, 1 needs a decision');
  assert.throws(() => {
    result.setChecked(1, true);
  }, (error) => isSyncError(error, 'E_PLAN_INVALID'));
  assert.deepEqual(result.allowedActions(1), ['put', 'get', 'skip', 'synced', 'delete-remote', 'delete-local']);
  result.setAction(1, 'get');
  assert.deepEqual([result.item(1)?.action, result.item(1)?.checked], ['get', true]);
  result.setAction('css/site.css', 'skip');
  assert.equal(result.item(1)?.checked, false);
});

test('actions are limited to the copies that exist', () => {
  const result = plan({ local: scan({ 'new.html': obs(1) }) });
  assert.deepEqual(result.allowedActions('new.html'), ['put', 'skip', 'delete-local']);
  assert.throws(() => {
    result.setAction('new.html', 'get');
  }, (error) => isSyncError(error, 'E_PLAN_INVALID'));
  assert.throws(() => result.allowedActions('missing.html'), (error) => isSyncError(error, 'E_PLAN_INVALID'));
});

test('deletes and never-synced orphans with the delete option', () => {
  const result = plan({
    deleteOrphans: true,
    local: scan({}),
    remote: scan({ 'old.html': obs(1), 'stray.html': obs(2) }),
    records: new Map([['old.html', { local: obs(1), remote: obs(1), syncedAt: T }]]),
  });
  assert.deepEqual(result.items.map((item) => [item.path, item.action, item.checked, item.neverSynced]), [
    ['old.html', 'delete-remote', true, false],
    ['stray.html', 'delete-remote', false, true],
  ]);
  assert.equal(result.summaryLine(), 'Files: 0 will be updated, 1 will be deleted, 1 will be skipped');
});

test('problem rows come last, can only be skipped, and block their path', () => {
  const result = plan({
    local: scan({ 'link.html': obs(1) }),
    remote: scan({ 'ok.html': obs(1) }, [
      { path: 'CON.txt', side: 'remote', kind: 'unsafe', status: 'Name is not valid on this system: reserved device name.' },
      { path: 'link.html', side: 'remote', kind: 'symlink', status: STATUS.symlink },
    ]),
    direction: 'both',
  });
  assert.deepEqual(result.items.map((item) => [item.path, item.state, item.action]), [
    ['ok.html', 'remote-only', 'get'],
    ['CON.txt', 'problem', 'skip'],
    ['link.html', 'problem', 'skip'],
  ]);
  assert.deepEqual(result.allowedActions('CON.txt'), ['skip']);
  assert.throws(() => {
    result.setChecked('CON.txt', true);
  }, (error) => isSyncError(error, 'E_PLAN_INVALID'));
  assert.equal(result.summary.errors, 2);
  assert.match(result.summaryLine(), /2 cannot be synchronized$/);
});

test('on a case-insensitive file system, names that differ only by case are never transferred', () => {
  const input = {
    local: scan({ 'About.html': obs(1), 'notes.txt': obs(1) }),
    remote: scan({ 'Index.html': obs(1), 'index.html': obs(2), 'about.html': obs(3), 'notes.txt': obs(1) }),
    direction: 'both' as const,
  };
  const insensitive = plan({ ...input, caseInsensitive: true });
  assert.deepEqual(
    insensitive.items.filter((item) => item.problem === 'case').map((item) => item.path).sort(),
    ['About.html', 'Index.html', 'about.html', 'index.html'],
  );
  assert.equal(insensitive.items.some((item) => item.problem === undefined && /index|about/i.test(item.path)), false);
  // Here both spellings of index.html can live side by side, but a name spelled one way here and only
  // another way on the server, as after renaming by case, is held back: the server may ignore case.
  const sensitive = plan({ ...input, caseInsensitive: false });
  const renamed = sensitive.items.filter((item) => item.problem === 'case');
  assert.deepEqual(renamed.map((item) => item.path).sort(), ['About.html', 'about.html']);
  assert.ok(renamed.every((item) => item.status === STATUS.caseRename));
  assert.equal(sensitive.items.some((item) => item.problem === undefined && /about/i.test(item.path)), false);
});

test('nothing is transferred inside a linked folder on either side', () => {
  const result = plan({
    local: scan({ 'docs/readme.html': obs(1), 'index.html': obs(1) }, [{ path: 'assets', side: 'local', kind: 'symlink', status: STATUS.symlink }]),
    remote: scan({ 'assets/app.js': obs(2) }, [{ path: 'docs', side: 'remote', kind: 'symlink', status: STATUS.symlink }]),
    direction: 'both',
  });
  const held = result.items.filter((item) => item.status === STATUS.underLink).map((item) => item.path);
  assert.deepEqual(held.sort(), ['assets/app.js', 'docs/readme.html']);
  assert.deepEqual(result.items.filter((item) => item.state !== 'problem').map((item) => item.path), ['index.html']);
});

test('the guard sees through links, inside the site and out of it', () => {
  const guard = siteGuard({ sync: { guard: { enabled: true, patterns: [] } } } as unknown as Pick<Site, 'sync'>, 'linux');
  const result = plan({
    guard,
    local: scan(
      { 'css/app.css': obs(1), 'keys/site.txt': obs(1), 'img/hero.svg': obs(1) },
      [],
      {
        'css/app.css': linkTo('.env', 'site', '.env'),
        'keys/site.txt': linkTo(undefined, 'shared', '.ssh', 'config'),
        'img/hero.svg': linkTo('shared/img/hero.svg', 'site', 'shared', 'img', 'hero.svg'),
      },
    ),
  });
  assert.deepEqual(
    result.items.map((item) => [item.path, item.guarded, item.checked, item.status]),
    [
      ['css/app.css', '.env', false, guardedStatus('.env')],
      ['img/hero.svg', undefined, true, ''],
      ['keys/site.txt', '.ssh/', false, `${guardedStatus('.ssh/')} ${STATUS.throughLinkOutside}`],
    ],
  );
});

test('every row reached through a link out of the site says so, whatever its action', () => {
  const result = plan({
    direction: 'both',
    local: scan({ 'a.css': obs(1), 'b.css': obs(1), 'c.css': obs(5, T + 60_000) }, [], {
      'a.css': linkTo(undefined, 'shared', 'a.css'),
      'b.css': linkTo(undefined, 'shared', 'b.css'),
      'c.css': linkTo(undefined, 'shared', 'c.css'),
    }),
    remote: scan({ 'b.css': obs(2, T + 60_000), 'c.css': obs(6, T + 60_000) }),
    records: new Map([
      ['b.css', { local: obs(1), remote: obs(1), syncedAt: T }],
      ['c.css', { local: obs(1), remote: obs(1), syncedAt: T }],
    ]),
  });
  assert.deepEqual(
    result.items.map((item) => [item.path, item.action, item.status]),
    [
      ['a.css', 'put', STATUS.throughLinkOutside],
      ['b.css', 'get', STATUS.throughLinkOutside],
      ['c.css', 'resolve', `${STATUS.bothChanged} ${STATUS.throughLinkOutside}`],
    ],
  );
});

test('the fingerprint changes when a link points elsewhere, and only then', () => {
  const files = { 'img/hero.svg': obs(1) };
  const through = (folder: string): ScanResult => scan(files, [], { 'img/hero.svg': linkTo(undefined, folder, 'hero.svg') });
  assert.equal(plan({ local: through('one') }).fingerprint, plan({ local: through('one') }).fingerprint);
  assert.notEqual(plan({ local: through('one') }).fingerprint, plan({ local: through('two') }).fingerprint);
  assert.notEqual(plan({ local: through('one') }).fingerprint, plan({ local: scan(files) }).fingerprint);
});

test('a saved plan round-trips through JSON and is refused once the scan changes', () => {
  const local = scan({ 'a.html': obs(1), 'b.html': obs(2) });
  const first = plan({ local });
  first.setChecked('b.html', false);
  const saved = SyncPlan.fromJSON(JSON.parse(JSON.stringify(first.toJSON())));
  const fresh = plan({ local });
  fresh.applySaved(saved);
  assert.equal(fresh.item('b.html')?.checked, false);
  assert.equal(fresh.item('a.html')?.checked, true);
  const changed = plan({ local: scan({ 'a.html': obs(1), 'b.html': obs(3) }) });
  assert.throws(() => {
    changed.applySaved(saved);
  }, (error) => isSyncError(error, 'E_STALE_ITEM'));
  assert.throws(() => SyncPlan.fromJSON({ schema: 'other' }), (error) => isSyncError(error, 'E_PLAN_INVALID'));
});

test('a tampered saved plan is refused whole: added paths, wrong numbers and impossible actions', () => {
  const local = scan({ 'a.html': obs(1), 'b.html': obs(2) });
  const saved = SyncPlan.fromJSON(JSON.parse(JSON.stringify(plan({ local }).toJSON())));
  const tamper = (items: typeof saved.items): typeof saved => ({ ...saved, items });
  const [a, b] = saved.items;
  assert.ok(a !== undefined && b !== undefined);
  const cases: (typeof saved)[] = [
    tamper([...saved.items, { id: 3, path: '../../etc/passwd', action: 'get', checked: true }]),
    tamper([{ ...a, checked: false }, { ...b, id: 7 }]),
    tamper([{ ...a, checked: false }, { ...b, action: 'get' }]),
    tamper([{ ...a, checked: false }, { ...b, action: 'resolve' }]),
  ];
  for (const tampered of cases) {
    const fresh = plan({ local });
    assert.throws(() => {
      fresh.applySaved(tampered);
    }, (error) => isSyncError(error, 'E_PLAN_INVALID'));
    assert.equal(fresh.item('a.html')?.checked, true, 'nothing was applied');
    assert.equal(fresh.items.length, 2);
  }
});

test('a hostile name with escape sequences is shown escaped in every printed preview', () => {
  const hostile = 'evil\u001b]0;owned\u0007\u001b[2Jname.html';
  const result = plan({
    local: scan({ 'index.html': obs(1) }),
    remote: scan({}, [{ path: hostile, side: 'remote', kind: 'unsafe', status: 'Name is not valid on this system: contains a control character.' }]),
  });
  const home = tempDir();
  try {
    const ctx = new CommandContext(fakeIo({ home: home.dir }).io, { json: false, plain: false, debug: false });
    const site = { name: 'My Site' } as Site;
    const server = { name: 'Production', protocol: 'sftp' } as Server;
    const outputs = [formatPreview(ctx, result, site, server), formatNumberedPreview(ctx, result), formatPlanForEditor(result, site, server)];
    for (const output of outputs) {
      assert.ok(output.includes('evil'), output);
      // eslint-disable-next-line no-control-regex -- control characters are what must not appear
      assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(output.replaceAll('\n', '')), JSON.stringify(output));
    }
    ctx.close();
  } finally {
    home.cleanup();
  }
});

test('toJSON never carries more than paths, sizes and times', () => {
  const json = JSON.stringify(plan({ local: scan({ 'a.html': obs(1) }) }).toJSON());
  assert.match(json, /"schema":"sync-servers\/plan@1"/);
  assert.doesNotMatch(json, /password|secret/i);
});
