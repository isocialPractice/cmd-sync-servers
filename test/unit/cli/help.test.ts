import assert from 'node:assert/strict';
import { test } from 'node:test';
import { helpText } from '../../../src/cli/help.ts';
import { VERSION } from '../../../src/version.ts';

test('help names the program and its version', () => {
  assert.ok(helpText().startsWith(`sync-servers ${VERSION}\n`));
});

test('help lists every global option', () => {
  const text = helpText();
  for (const option of ['--version', '--help', '-h']) {
    assert.ok(text.includes(option), `help does not mention ${option}`);
  }
});

test('help carries a usage line and an example', () => {
  const text = helpText();
  assert.match(text, /^Usage:\n {2}sync-servers /m);
  assert.match(text, /^Example:\n {2}sync-servers /m);
});
