import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSyncError } from '../../../src/errors.ts';
import { guardedStatus, STATUS } from '../../../src/sync/messages.ts';
import { toRemotePath, type RemotePath } from '../../../src/sync/paths.ts';
import { SyncPlan, type PlanInput } from '../../../src/sync/plan.ts';
import type { ScanResult } from '../../../src/sync/scan-local.ts';
import type { SyncRecord } from '../../../src/sync/state.ts';
import type { Observation, ScanProblem } from '../../../src/sync/types.ts';

const T = 1_761_753_600_000;
const obs = (size: number, mtimeMs = T): Observation => ({ size, mtimeMs });

function scan(files: Record<string, Observation>, problems: ScanProblem[] = []): ScanResult {
  return {
    files: new Map(Object.entries(files).map(([key, value]) => [toRemotePath(key), value])),
    dirs: new Set<RemotePath>(),
    problems,
    cloaked: 0,
  };
}

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
  const sensitive = plan({ ...input, caseInsensitive: false });
  assert.equal(sensitive.items.some((item) => item.problem === 'case'), false);
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

test('toJSON never carries more than paths, sizes and times', () => {
  const json = JSON.stringify(plan({ local: scan({ 'a.html': obs(1) }) }).toJSON());
  assert.match(json, /"schema":"sync-servers\/plan@1"/);
  assert.doesNotMatch(json, /password|secret/i);
});
