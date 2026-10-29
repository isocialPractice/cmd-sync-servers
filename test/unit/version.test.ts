import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { VERSION } from '../../src/index.ts';

function readRepoFile(name: string): string {
  return readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8');
}

const manifest = JSON.parse(readRepoFile('package.json')) as { version: string };

test('VERSION equals the version in package.json', () => {
  assert.equal(VERSION, manifest.version);
});

test('VERSION is a valid semver version', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
});

test('CHANGELOG.md has a heading for VERSION', () => {
  const heading = `## [${VERSION}] - `;
  assert.ok(readRepoFile('CHANGELOG.md').includes(heading), `CHANGELOG.md has no "${heading}" heading`);
});
