import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommandContext } from '../../../src/cli/context.ts';
import { chooseRemoteRoot, folderLines } from '../../../src/cli/remote-root.ts';
import { sortFolderNames } from '../../../src/transport/common.ts';
import type { FolderListing } from '../../../src/transport/probe.ts';
import { Capture, fakeIo, tempDir } from '../../helpers/cli.ts';

const VISIBLE = ['access-logs', 'bin', 'etc', 'logs', 'mail', 'public_ftp', 'public_html', 'tmp'];
const DOTTED = ['.cache', '.config', '.local', '.ssh', '.trash'];

/** A terminal's stderr: what is written, and a width. */
class Terminal {
  text = '';
  readonly isTTY = true;
  readonly columns: number;
  constructor(columns: number) {
    this.columns = columns;
  }
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

/** A probe over fixed listings; any other folder exists only if it is listed. */
function probe(listings: Record<string, readonly string[]>): { folders(folder: string): Promise<FolderListing>; exists(folder: string): Promise<boolean> } {
  return {
    folders: (folder) => {
      const found = listings[folder];
      return found === undefined ? Promise.reject(new Error('No such folder.')) : Promise.resolve({ path: folder, folders: found, files: 23 });
    },
    exists: (folder) => Promise.resolve(listings[folder] !== undefined),
  };
}

function context(home: string, answers: readonly string[], stderr: { write(text: string): unknown; readonly isTTY?: boolean; readonly columns?: number }, plain = false): CommandContext {
  const { io } = fakeIo({ home, tty: true, input: `${answers.join('\n')}\n` });
  return new CommandContext({ ...io, stderr }, { json: false, plain, debug: false });
}

test('folder names sort with the ones that start with a dot last, each group ignoring case', () => {
  assert.deepEqual(sortFolderNames(['.ssh', 'tmp', 'Backups', '.cache', 'access-logs', 'bin']), ['access-logs', 'Backups', 'bin', 'tmp', '.cache', '.ssh']);
  assert.deepEqual(sortFolderNames([]), []);
});

test('folder lines are one per line without a width, and fill the columns of a terminal down, then across', () => {
  const names = [...VISIBLE, ...DOTTED];
  assert.deepEqual(folderLines(['css', 'js']), ['  1. css/', '  2. js/']);
  assert.deepEqual(folderLines(names, 80), [
    '   1. access-logs/   5. mail/          9. .cache/       13. .trash/',
    '   2. bin/           6. public_ftp/   10. .config/',
    '   3. etc/           7. public_html/  11. .local/',
    '   4. logs/          8. tmp/          12. .ssh/',
  ]);
  for (const width of [80, 40, 24]) {
    for (const line of folderLines(names, width)) {
      assert.ok(line.length <= width - 1, `${line} fits ${String(width)} columns`);
    }
  }
  const long = `a-folder-name-${'x'.repeat(40)}`;
  assert.deepEqual(folderLines([long, 'css'], 60), [`  1. ${long}/`, '  2. css/'], 'a cell that does not fit twice keeps one per line');
  assert.deepEqual(folderLines(['css'], 80), ['  1. css/']);
});

test('the setup list numbers every folder, so the last one opens by number', async () => {
  const temp = tempDir();
  try {
    const many = Array.from({ length: 50 }, (_, index) => `folder-${String(index + 1).padStart(2, '0')}`);
    const top = sortFolderNames([...many, '.cache', '.config', '.local', '.ssh', '.trash']);
    const stderr = new Terminal(80);
    const ctx = context(temp.dir, ['55', ''], stderr);
    const chosen = await chooseRemoteRoot(ctx, probe({ '/': top, '/.trash': [] }), '/', 'Signed in as demo-user.');
    assert.equal(chosen, '/.trash');
    assert.match(stderr.text, /^Signed in as demo-user\. The account opens in "\/", which holds:\n/);
    assert.doesNotMatch(stderr.text, /more; type a name/);
    for (let number = 1; number <= 55; number += 1) {
      assert.match(stderr.text, new RegExp(`(^| )${String(number)}\\. `, 'm'), `folder ${String(number)} is listed`);
    }
    assert.match(stderr.text, /^ {3}1\. folder-01\/ +15\. folder-15\/ +29\. folder-29\/ +43\. folder-43\/$/m, 'numbered down each column');
    assert.match(stderr.text, / 50\. folder-50\/$/m);
    assert.match(stderr.text, / 51\. \.cache\/$/m, 'dot-folders come after the others');
    assert.match(stderr.text, / 55\. \.trash\/$/m);
    assert.match(stderr.text, /^ {2}and 23 files$/m);
    assert.match(stderr.text, /"\/\.trash" holds no folders and 23 files\./);
  } finally {
    temp.cleanup();
  }
});

test('the setup list stays one folder per line in plain mode and without a terminal, and refuses a number past the last', async () => {
  const temp = tempDir();
  try {
    const listings = { '/': [...VISIBLE, ...DOTTED], '/public_html': [] };
    const plain = new Terminal(80);
    assert.equal(await chooseRemoteRoot(context(temp.dir, ['14', '7', ''], plain, true), probe(listings), '/'), '/public_html');
    assert.match(plain.text, /^ {2}1\. access-logs\/\n {2}2\. bin\/\n/m);
    assert.match(plain.text, /^ {2}13\. \.trash\/$/m);
    assert.match(plain.text, /\[\/\]: Enter a number from 1 to 13\.\n/);

    const piped = new Capture();
    assert.equal(await chooseRemoteRoot(context(temp.dir, ['7', ''], piped), probe(listings), '/'), '/public_html');
    assert.match(piped.text, /^ {2}7\. public_html\/$/m);
  } finally {
    temp.cleanup();
  }
});
