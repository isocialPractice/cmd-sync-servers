import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { classify, copiesMatch, hasChanged, type CompareOptions, type SyncState } from '../../../src/sync/classify.ts';
import { decide } from '../../../src/sync/plan.ts';
import { STATUS } from '../../../src/sync/messages.ts';
import type { SyncRecord } from '../../../src/sync/state.ts';
import type { Action, Direction, Observation } from '../../../src/sync/types.ts';

const options: CompareOptions = { toleranceMs: 2000, checksum: false };
const T = 1_761_753_600_000;
const obs = (size: number, mtimeMs: number = T, sha256?: string): Observation => ({ size, mtimeMs, ...(sha256 === undefined ? {} : { sha256 }) });
/** A copy whose server reports no time, as an FTP server without MLSD or MDTM. */
const untimed = (size: number): Observation => ({ size });
const record = (local: Observation, remote: Observation): SyncRecord => ({ local, remote, syncedAt: T });

describe('hasChanged', () => {
  test('equal size and time within the tolerance is unchanged', () => {
    assert.equal(hasChanged(obs(10), obs(10), options), false);
    assert.equal(hasChanged(obs(10, T + 2000), obs(10), options), false);
  });
  test('a different size or a time past the tolerance is a change', () => {
    assert.equal(hasChanged(obs(11), obs(10), options), true);
    assert.equal(hasChanged(obs(10, T + 2001), obs(10), options), true);
  });
  test('without times, the size decides', () => {
    assert.equal(hasChanged(untimed(10), untimed(10), options), false);
    assert.equal(hasChanged(untimed(10), obs(10), options), false);
    assert.equal(hasChanged(untimed(11), untimed(10), options), true);
  });
  test('in checksum mode, different hashes are a change even with equal size and time', () => {
    const checksum = { ...options, checksum: true };
    assert.equal(hasChanged(obs(10, T, 'a'.repeat(64)), obs(10, T, 'b'.repeat(64)), checksum), true);
    assert.equal(hasChanged(obs(10, T, 'a'.repeat(64)), obs(10, T, 'a'.repeat(64)), checksum), false);
    assert.equal(hasChanged(obs(10, T, 'a'.repeat(64)), obs(10, T, 'b'.repeat(64)), options), false);
    assert.equal(hasChanged(obs(10, T, 'a'.repeat(64)), obs(10, T), checksum), false);
  });
});

describe('copiesMatch', () => {
  test('needs equal size, and equal times within the tolerance', () => {
    assert.equal(copiesMatch(obs(10), obs(10, T + 1000), options), true);
    assert.equal(copiesMatch(obs(10), obs(11), options), false);
    assert.equal(copiesMatch(obs(10), obs(10, T + 5000), options), false);
  });
  test('unknown times never match', () => {
    assert.equal(copiesMatch(obs(10), untimed(10), options), false);
  });
  test('in checksum mode, hashes decide when both are known', () => {
    const checksum = { ...options, checksum: true };
    assert.equal(copiesMatch(obs(10, T, 'a'.repeat(64)), obs(10, T + 9999, 'a'.repeat(64)), checksum), true);
    assert.equal(copiesMatch(obs(10, T, 'a'.repeat(64)), obs(10, T, 'b'.repeat(64)), checksum), false);
    assert.equal(copiesMatch(obs(10, T, 'a'.repeat(64)), obs(10, T), checksum), true);
  });
});

describe('classify', () => {
  const base = obs(10);
  const changed = obs(20, T + 60_000);
  const recorded = record(base, base);
  const cases: [string, Observation | undefined, Observation | undefined, SyncRecord | undefined, SyncState | undefined][] = [
    ['unchanged / unchanged', base, base, recorded, 'in-sync'],
    ['changed / unchanged', changed, base, recorded, 'local-changed'],
    ['unchanged / changed', base, changed, recorded, 'remote-changed'],
    ['changed / changed, different', changed, obs(30, T + 60_000), recorded, 'both-changed'],
    ['changed / changed, now equal', changed, changed, recorded, 'refresh-record'],
    ['new / absent', base, undefined, undefined, 'local-only'],
    ['absent / new', undefined, base, undefined, 'remote-only'],
    ['new / new, equal', base, obs(10, T + 1000), undefined, 'refresh-record'],
    ['new / new, local newer', obs(11, T + 60_000), base, undefined, 'first-sync-local-newer'],
    ['new / new, remote newer', base, obs(11, T + 60_000), undefined, 'first-sync-remote-newer'],
    ['new / new, equal times, sizes differ', base, obs(11), undefined, 'first-sync-conflict'],
    ['new / new, remote time unknown', base, untimed(11), undefined, 'first-sync-conflict'],
    ['new / new, equal size, remote time unknown', base, untimed(10), undefined, 'first-sync-conflict'],
    ['untimed server, unchanged', base, untimed(10), record(base, untimed(10)), 'in-sync'],
    ['untimed server, size changed', base, untimed(12), record(base, untimed(10)), 'remote-changed'],
    ['unchanged / deleted', base, undefined, recorded, 'remote-deleted'],
    ['deleted / unchanged', undefined, base, recorded, 'local-deleted'],
    ['changed / deleted', changed, undefined, recorded, 'changed-locally-deleted-remotely'],
    ['deleted / changed', undefined, changed, recorded, 'deleted-locally-changed-remotely'],
    ['deleted / deleted', undefined, undefined, recorded, 'drop-record'],
    ['nothing anywhere', undefined, undefined, undefined, undefined],
  ];
  for (const [name, local, remote, rec, expected] of cases) {
    test(name, () => {
      assert.equal(classify(local, remote, rec, options), expected);
    });
  }

  test('the two clocks never have to agree once a record exists', () => {
    const skewed = record(obs(10, T), obs(10, T + 3_600_000));
    assert.equal(classify(obs(10, T), obs(10, T + 3_600_000), skewed, options), 'in-sync');
  });
});

describe('decide', () => {
  type Row = [SyncState, Direction, boolean, Action | undefined, boolean | undefined, string?];
  const rows: Row[] = [
    ['local-changed', 'put', false, 'put', true],
    ['local-changed', 'both', false, 'put', true],
    ['local-changed', 'get', false, undefined, undefined],
    ['local-changed', 'get', true, undefined, undefined],
    ['local-only', 'put', false, 'put', true],
    ['local-only', 'both', true, 'put', true],
    ['local-only', 'get', false, undefined, undefined],
    ['local-only', 'get', true, 'delete-local', false, STATUS.deleteLocalNeverSynced],
    ['remote-changed', 'get', false, 'get', true],
    ['remote-changed', 'both', true, 'get', true],
    ['remote-changed', 'put', false, undefined, undefined],
    ['remote-only', 'get', false, 'get', true],
    ['remote-only', 'get', true, 'get', true],
    ['remote-only', 'both', false, 'get', true],
    ['remote-only', 'both', true, 'delete-remote', false, STATUS.deleteRemoteNeverSynced],
    ['remote-only', 'put', false, undefined, undefined],
    ['remote-only', 'put', true, 'delete-remote', false, STATUS.deleteRemoteNeverSynced],
    ['first-sync-local-newer', 'put', false, 'put', true],
    ['first-sync-local-newer', 'both', false, 'put', true],
    ['first-sync-local-newer', 'get', false, undefined, undefined],
    ['first-sync-remote-newer', 'get', false, 'get', true],
    ['first-sync-remote-newer', 'both', false, 'get', true],
    ['first-sync-remote-newer', 'put', false, undefined, undefined],
    ['both-changed', 'put', false, 'resolve', undefined, STATUS.bothChanged],
    ['both-changed', 'get', true, 'resolve', undefined, STATUS.bothChanged],
    ['first-sync-conflict', 'both', false, 'resolve', undefined, STATUS.firstSyncDiffers],
    ['changed-locally-deleted-remotely', 'both', false, 'resolve', undefined, STATUS.changedLocallyDeletedRemotely],
    ['deleted-locally-changed-remotely', 'put', false, 'resolve', undefined, STATUS.deletedLocallyChangedRemotely],
    ['remote-deleted', 'put', false, 'put', true, STATUS.putRestore],
    ['remote-deleted', 'put', true, 'put', true, STATUS.putRestore],
    ['remote-deleted', 'both', true, 'put', true, STATUS.putRestore],
    ['remote-deleted', 'get', false, undefined, undefined],
    ['remote-deleted', 'get', true, 'delete-local', true, STATUS.deleteLocalSynced],
    ['local-deleted', 'put', false, undefined, undefined],
    ['local-deleted', 'put', true, 'delete-remote', true, STATUS.deleteRemoteSynced],
    ['local-deleted', 'get', false, 'get', true, STATUS.getRestore],
    ['local-deleted', 'get', true, 'get', true, STATUS.getRestore],
    ['local-deleted', 'both', false, 'get', true, STATUS.getRestoreBoth],
    ['local-deleted', 'both', true, 'delete-remote', true, STATUS.deleteRemoteSynced],
    ['in-sync', 'both', true, undefined, undefined],
    ['refresh-record', 'put', false, undefined, undefined],
  ];
  for (const [state, direction, deleteOrphans, action, checked, status] of rows) {
    test(`${state}, ${direction}${deleteOrphans ? ', delete option' : ''}`, () => {
      const decision = decide(state, direction, deleteOrphans);
      assert.equal(decision?.action, action);
      assert.equal(decision?.checked, checked);
      if (status !== undefined) {
        assert.equal(decision?.status, status);
      }
    });
  }

  test('a single-file Put or Get offers a decision for a change on the other side', () => {
    assert.deepEqual(decide('remote-changed', 'put', false, true), { action: 'resolve', checked: undefined, status: STATUS.remoteNewer });
    assert.deepEqual(decide('local-changed', 'get', false, true), { action: 'resolve', checked: undefined, status: STATUS.localNewer });
    assert.equal(decide('first-sync-remote-newer', 'put', false, true)?.action, 'resolve');
    assert.equal(decide('first-sync-local-newer', 'get', false, true)?.action, 'resolve');
  });
});
