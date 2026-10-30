import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type * as Keyring from '../../src/credentials/keyring.ts';
import type * as Api from '../../src/index.ts';

// Imports the built package through its own name, so the `exports` map is
// resolved exactly as it is for a program that installed it. The names are
// variables so type checking never needs the build output.
const NAME = '@isocialpractice/cmd-sync-servers';
const root = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as {
  version: string;
  exports: Record<string, string | { types: string; default: string }>;
};

function load<T>(subpath: string, json = false): Promise<T> {
  const specifier = subpath === '' ? NAME : `${NAME}/${subpath}`;
  return (json ? import(specifier, { with: { type: 'json' } }) : import(specifier)) as Promise<T>;
}

test('every entry of the exports map points at a file that exists, with its types', () => {
  for (const [entry, target] of Object.entries(manifest.exports)) {
    const files = typeof target === 'string' ? [target] : [target.types, target.default];
    for (const file of files) {
      assert.ok(existsSync(`${root}${file}`), `${entry}: ${file} is missing; run npm run build`);
    }
  }
});

test('the library loads through the package name', async () => {
  const api = await load<typeof Api>('');
  assert.equal(api.VERSION, manifest.version);
  assert.equal(typeof api.SyncSession.open, 'function');
  assert.equal(typeof api.SiteRegistry.open, 'function');
});

test('the keyring store, the JSON Schema and the manifest load through their subpaths', async () => {
  const keyring = await load<typeof Keyring>('credentials/keyring');
  assert.equal(typeof keyring.openKeyringStore, 'function');
  assert.equal(typeof keyring.createKeyringStore, 'function');
  const schema = await load<{ default: { $id: string } }>('schema/site.schema.json', true);
  assert.equal(schema.default.$id, 'https://isocialpractice.github.io/cmd-sync-servers/schema/site.schema.json');
  const pkg = await load<{ default: { version: string } }>('package.json', true);
  assert.equal(pkg.default.version, manifest.version);
});

test('internal modules are not reachable from outside the package', async () => {
  await assert.rejects(load('out/sync/plan.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});
