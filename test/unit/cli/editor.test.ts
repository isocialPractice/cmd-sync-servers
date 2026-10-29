import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { editJsonUntilValid, editorChoices, findExecutable, splitCommand } from '../../../src/cli/editor.ts';
import { tempDir, testEnv } from '../../helpers/cli.ts';

let temp: ReturnType<typeof tempDir>;

beforeEach(() => {
  temp = tempDir();
});

afterEach(() => {
  temp.cleanup();
});

/**
 * A fake editor: a Node script that applies the edits listed in a JSON file,
 * one per run, recording what it was shown.
 */
function fakeEditor(edits: readonly string[]): { env: Record<string, string | undefined>; seen: string } {
  const plan = path.join(temp.dir, 'edits.json');
  const seen = path.join(temp.dir, 'seen.json');
  writeFileSync(plan, JSON.stringify(edits));
  writeFileSync(seen, '[]');
  const script = path.join(temp.dir, 'fake-editor.mjs');
  writeFileSync(
    script,
    [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      `const plan = ${JSON.stringify(plan)};`,
      `const seen = ${JSON.stringify(seen)};`,
      'const file = process.argv.at(-1);',
      "const edits = JSON.parse(readFileSync(plan, 'utf8'));",
      "const shown = JSON.parse(readFileSync(seen, 'utf8'));",
      "shown.push(readFileSync(file, 'utf8'));",
      'writeFileSync(seen, JSON.stringify(shown));',
      'const next = edits.shift();',
      'writeFileSync(plan, JSON.stringify(edits));',
      'if (next === "__exit1__") process.exit(1);',
      'if (next !== "__keep__") writeFileSync(file, next);',
    ].join('\n'),
  );
  return { env: testEnv(temp.dir, { SYNC_SERVERS_EDITOR: `"${process.execPath}" "${script}"` }), seen };
}

const validate = (parsed: unknown) =>
  typeof parsed === 'object' && parsed !== null && 'name' in parsed && typeof parsed.name === 'string' && parsed.name !== ''
    ? ({ ok: true, value: parsed as { name: string } } as const)
    : ({ ok: false, errors: ['name: Enter a name.'] } as const);

test('splitCommand honours quotes and keeps backslashes', () => {
  assert.deepEqual(splitCommand('code --wait'), ['code', '--wait']);
  assert.deepEqual(splitCommand('"C:\\Program Files\\Vim\\vim.exe" -n'), ['C:\\Program Files\\Vim\\vim.exe', '-n']);
  assert.deepEqual(splitCommand(" 'my editor'  a\tb "), ['my editor', 'a', 'b']);
});

test('the editor comes from SYNC_SERVERS_EDITOR, VISUAL, EDITOR, then the platform default', () => {
  assert.deepEqual(editorChoices({ env: { VISUAL: 'vim', EDITOR: 'nano' }, platform: 'linux' }), [{ words: ['vim'], source: 'VISUAL' }]);
  assert.deepEqual(editorChoices({ env: { SYNC_SERVERS_EDITOR: 'code --wait', VISUAL: 'vim' }, platform: 'linux' })[0]?.words, ['code', '--wait']);
  assert.deepEqual(
    editorChoices({ env: {}, platform: 'linux' }).map((choice) => choice.words[0]),
    ['nano', 'vi'],
  );
  assert.deepEqual(
    editorChoices({ env: { EDITOR: ' ' }, platform: 'win32' }).map((choice) => choice.words[0]),
    ['notepad'],
  );
});

test('findExecutable finds node on PATH', () => {
  const env = { PATH: path.dirname(process.execPath), PATHEXT: '.EXE;.CMD' };
  const found = findExecutable('node', { env, platform: process.platform });
  assert.ok(found !== undefined && path.basename(found).toLowerCase().startsWith('node'));
  assert.equal(findExecutable('no-such-editor', { env, platform: process.platform }), undefined);
});

test('a valid edit is returned', async () => {
  const { env } = fakeEditor(['{ "name": "Sample App" }']);
  const result = await editJsonUntilValid({ name: 'My Site' }, ['Edit the site.'], validate, { env, platform: process.platform });
  assert.deepEqual(result, { name: 'Sample App' });
});

test('an invalid edit reopens with the problems as comments, keeping what was typed', async () => {
  const { env, seen } = fakeEditor(['{ "name": "" }', '{ "name": "Sample App" }']);
  const result = await editJsonUntilValid({ name: 'My Site' }, ['Edit the site.'], validate, { env, platform: process.platform });
  assert.deepEqual(result, { name: 'Sample App' });
  const shown = JSON.parse((await import('node:fs')).readFileSync(seen, 'utf8')) as string[];
  assert.equal(shown.length, 2);
  assert.match(shown[0] ?? '', /^\/\/ Edit the site\.\n\{\n {2}"name": "My Site"\n\}\n$/);
  assert.match(shown[1] ?? '', /^\/\/ Fix these problems/);
  assert.match(shown[1] ?? '', /\/\/ {3}name: Enter a name\./);
  assert.match(shown[1] ?? '', /\{ "name": "" \}/);
});

test('broken JSON is reported and reopened', async () => {
  const { env, seen } = fakeEditor(['{ "name": ', '{ "name": "Sample App" }']);
  await editJsonUntilValid({ name: 'My Site' }, [], validate, { env, platform: process.platform });
  const shown = JSON.parse((await import('node:fs')).readFileSync(seen, 'utf8')) as string[];
  assert.match(shown[1] ?? '', /Not valid JSON/);
});

test('an emptied or unchanged file cancels', async () => {
  const emptied = fakeEditor(['  \n']);
  assert.equal(await editJsonUntilValid({ name: 'My Site' }, [], validate, { env: emptied.env, platform: process.platform }), undefined);
  const kept = fakeEditor(['__keep__']);
  assert.equal(await editJsonUntilValid({ name: 'My Site' }, ['header'], validate, { env: kept.env, platform: process.platform }), undefined);
});

test('an editor that exits with an error cancels', async () => {
  const { env } = fakeEditor(['__exit1__']);
  await assert.rejects(
    editJsonUntilValid({ name: 'My Site' }, [], validate, { env, platform: process.platform }),
    (error: Error) => error.name === 'CancelledError',
  );
});

test('an editor that cannot be found is named in the error', async () => {
  const env = testEnv(temp.dir, { SYNC_SERVERS_EDITOR: 'no-such-editor-xyz' });
  await assert.rejects(
    editJsonUntilValid({ name: 'My Site' }, [], validate, { env, platform: process.platform }),
    /SYNC_SERVERS_EDITOR names "no-such-editor-xyz"/,
  );
});
