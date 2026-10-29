import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrateSitesFile } from '../../../src/config/migrate.ts';
import { isSyncError } from '../../../src/errors.ts';

test('a current file passes through unchanged', () => {
  const file = { schemaVersion: 1, sites: [] };
  assert.deepEqual(migrateSitesFile(file, 'sites.json'), { file, fromVersion: 1, migrated: false });
});

test('a file from a newer release is refused, never rewritten', () => {
  assert.throws(
    () => migrateSitesFile({ schemaVersion: 2, sites: [] }, 'sites.json'),
    (error) => isSyncError(error, 'E_CONFIG_INVALID') && error.message.includes('newer sync-servers'),
  );
});

test('a missing or broken schemaVersion is refused', () => {
  for (const raw of [{ sites: [] }, { schemaVersion: '1' }, { schemaVersion: 0 }, [], null, 'text']) {
    assert.throws(() => migrateSitesFile(raw, 'sites.json'), (error) => isSyncError(error, 'E_CONFIG_INVALID'));
  }
});

test('each step runs in order and stamps the next version', () => {
  const steps = {
    1: (file: Record<string, unknown>) => ({ ...file, renamed: file.old, old: undefined }),
    2: (file: Record<string, unknown>) => ({ ...file, added: true }),
  };
  const result = migrateSitesFile({ schemaVersion: 1, old: 'value' }, 'sites.json', steps, 3);
  assert.equal(result.migrated, true);
  assert.equal(result.fromVersion, 1);
  assert.deepEqual(result.file, { schemaVersion: 3, renamed: 'value', old: undefined, added: true });
});

test('a gap in the steps is an error', () => {
  assert.throws(
    () => migrateSitesFile({ schemaVersion: 1 }, 'sites.json', {}, 2),
    (error) => isSyncError(error, 'E_CONFIG_INVALID') && error.message.includes('No migration from version 1'),
  );
});
