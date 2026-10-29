import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPackPaths } from '../../../scripts/lib/pack-rules.ts';

const minimal = ['package.json', 'LICENSE', 'README.md', 'out/index.js', 'out/index.d.ts', 'out/cli/main.js'];

test('the minimal package passes', () => {
  assert.deepEqual(checkPackPaths(minimal), []);
});

test('documents, built files and schemas are allowed', () => {
  const paths = [...minimal, 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md', 'out/sync/plan.js', 'schema/site.schema.json'];
  assert.deepEqual(checkPackPaths(paths), []);
});

test('Windows separators are normalized', () => {
  assert.deepEqual(checkPackPaths(minimal.map((path) => path.replaceAll('/', '\\'))), []);
});

test('a missing required file is reported', () => {
  assert.deepEqual(checkPackPaths(minimal.filter((path) => path !== 'out/cli/main.js')), ['missing: out/cli/main.js']);
});

for (const path of [
  'src/index.ts',
  'test/unit/version.test.ts',
  'out/test/fixtures/site.json',
  'out/sandbox/server.js',
  '.claude/settings.local.json',
  '.support/notes.md',
  '.env',
  'out/keys/id_ed25519',
  'out/index.js.map',
  'server.pem',
  'task.bat',
  'my-site.code-workspace',
  'vendor/kilo/kilo.c',
]) {
  test(`${path} is rejected`, () => {
    const problems = checkPackPaths([...minimal, path]);
    assert.ok(problems.length > 0, `${path} was accepted`);
    assert.ok(problems.every((problem) => problem.endsWith(path)));
  });
}
