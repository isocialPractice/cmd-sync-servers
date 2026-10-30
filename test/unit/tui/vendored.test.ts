import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../../../', import.meta.url);
const read = (file: string): Buffer => readFileSync(new URL(file, root));

test('the vendored kilo files match the checksums in VENDORED.md', () => {
  const vendored = read('vendor/kilo/VENDORED.md').toString('utf8');
  const rows = [...vendored.matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm)];
  assert.deepEqual(rows.map((row) => row[1]), ['kilo.c', 'LICENSE']);
  for (const [, file, expected] of rows) {
    const actual = createHash('sha256').update(read(`vendor/kilo/${file ?? ''}`)).digest('hex');
    assert.equal(actual, expected, `vendor/kilo/${file ?? ''} has changed`);
  }
});

test('the pinned commit is the one the vendoring script fetches', () => {
  const commit = /\| Commit \| `([0-9a-f]{40})` \|/.exec(read('vendor/kilo/VENDORED.md').toString('utf8'))?.[1];
  assert.ok(commit !== undefined);
  assert.ok(read('scripts/vendor-kilo.ts').toString('utf8').includes(`'${commit}'`));
});

test('the kilo licence notice travels with the package', () => {
  const notices = read('THIRD_PARTY_NOTICES.md').toString('utf8');
  assert.ok(notices.includes('Copyright (c) 2016, Salvatore Sanfilippo'));
  assert.ok(notices.includes('Redistributions of source code must retain the above copyright notice'));
});
