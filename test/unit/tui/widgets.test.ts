import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { App, Hint, View, ViewBody } from '../../../src/tui/app.ts';
import { isKey, key, type Key } from '../../../src/tui/keys.ts';
import { span, type Line } from '../../../src/tui/style.ts';
import { hintLine, progressBar } from '../../../src/tui/widgets/chrome.ts';
import { choiceDialog, confirmDialog, inputDialog, messageDialog, wrap } from '../../../src/tui/widgets/dialog.ts';
import { folderPickerDialog } from '../../../src/tui/widgets/folder-picker.ts';
import { field, Form } from '../../../src/tui/widgets/form.ts';
import { ListState } from '../../../src/tui/widgets/list.ts';
import { ASCII, frameText, matchSnapshot, press, screen, testApp, type, UNICODE } from '../../helpers/tui.ts';

const FRUIT = ['apple', 'banana', 'cherry', 'date', 'elderberry', 'fig', 'grape'];

test('a list moves, pages and scrolls to keep the selection in view', () => {
  const list = new ListState(FRUIT, (item) => item);
  assert.equal(list.selected, 'apple');
  list.key(key('down'), 3);
  list.key(key('j'), 3);
  assert.equal(list.selected, 'cherry');
  assert.deepEqual(list.window(2), { start: 1, items: ['banana', 'cherry'] });
  list.key(key('pagedown'), 3);
  assert.equal(list.selected, 'elderberry');
  list.key(key('end'), 3);
  assert.equal(list.selected, 'grape');
  assert.deepEqual(list.window(3), { start: 4, items: ['elderberry', 'fig', 'grape'] });
  list.key(key('down'), 3);
  assert.equal(list.selected, 'grape');
  list.key(key('home'), 3);
  list.key(key('k'), 3);
  assert.equal(list.selected, 'apple');
  list.key(key('pageup'), 3);
  assert.equal(list.index, 0);
  assert.equal(list.key(key('x'), 3), false);
});

test('a list filters as you type after /, and Esc clears the filter', () => {
  const list = new ListState(FRUIT, (item) => item);
  assert.ok(list.key(key('/'), 5));
  assert.ok(list.filtering);
  for (const char of 'RR') {
    list.key(key(`text:${char}`), 5);
  }
  assert.deepEqual(list.visible, ['cherry', 'elderberry']);
  assert.equal(list.filterText(), '/RR');
  list.key(key('down'), 5);
  assert.ok(!list.filtering);
  assert.equal(list.selected, 'elderberry');
  list.key(key('escape'), 5);
  assert.equal(list.filterText(), undefined);
  assert.equal(list.visible.length, FRUIT.length);
  list.key(key('/'), 5);
  list.key(key('text:z'), 5);
  assert.equal(list.selected, undefined);
  list.key(key('escape'), 5);
  assert.ok(!list.filtering);
  assert.equal(list.selected, 'apple');
  list.key(key('/'), 5);
  list.key(key('text:g'), 5);
  list.key(key('text:r'), 5);
  assert.ok(list.key(key('enter'), 5));
  assert.equal(list.selected, 'grape');
  list.select((item) => item === 'nothing');
  list.items = ['one'];
  assert.equal(list.selected, undefined);
});

test('a form moves between fields, edits, toggles, cycles choices and runs actions', () => {
  const form = new Form([
    field.note('intro', 'About', 'Fill this in.'),
    field.text('name', 'Name', 'My Site', { help: 'The site name.' }),
    field.toggle('on', 'Enabled', false, 'Turns it on.'),
    field.choice('mode', 'Compare by', [
      { label: 'Size and time', value: 'metadata' },
      { label: 'Checksum', value: 'checksum' },
    ], 'checksum'),
    field.lines('patterns', 'Patterns', '.psd\n/drafts/', 2),
    field.action('go', 'Go'),
  ]);
  const focus = (): string | undefined => form.focused?.id;
  assert.equal(focus(), 'name');
  assert.equal(form.status(), 'The site name.');
  assert.ok(form.capturesText());
  assert.deepEqual(form.key(key('text:!')), { handled: true, changed: true });
  assert.equal(form.text('name'), 'My Site!');
  assert.deepEqual(form.key(key('left')), { handled: true, changed: false });
  assert.deepEqual(form.key(key('up')), { handled: false });
  form.key(key('enter'));
  assert.equal(focus(), 'on');
  assert.ok(!form.capturesText());
  assert.deepEqual(form.key(key('space')), { handled: true, changed: true });
  assert.ok(form.toggle('on'));
  assert.deepEqual(form.key(key('text:z')), { handled: false });
  form.key(key('down'));
  assert.equal(form.choice('mode'), 'checksum');
  form.key(key('right'));
  assert.equal(form.choice('mode'), 'metadata');
  form.key(key('left'));
  assert.equal(form.choice('mode'), 'checksum');
  form.key(key('down'));
  assert.equal(focus(), 'patterns');
  form.key(key('end'));
  form.key(key('enter'));
  form.key(key('text:x'));
  assert.equal(form.text('patterns'), '.psd\nx\n/drafts/');
  form.key(key('down'));
  form.key(key('down'));
  assert.equal(focus(), 'go');
  assert.deepEqual(form.key(key('enter')), { handled: true, action: 'go' });
  assert.deepEqual(form.key(key('down')), { handled: false });
  form.focusOn('name');
  form.setError('name', 'Another site is named "My Site!".');
  assert.equal(form.status(), 'Another site is named "My Site!".');
  form.setError('name', undefined);
  assert.equal(form.errors.size, 0);
  assert.equal(form.toggle('mode'), false);
  assert.equal(form.choice('name'), '');
  assert.equal(form.text('nothing'), '');
});

test('a form draws labels, values, problems and the cursor, scrolling to the focused field', () => {
  const form = new Form([
    field.text('host', 'Address', 'sftp.example.com'),
    field.toggle('save', 'Save password', true),
    field.choice('ip', 'IP version', [{ label: 'Either', value: 'any' }], 'any'),
    field.note('note', 'Passive mode', 'Always on.'),
    field.action('test', 'Test'),
  ]);
  form.setError('host', 'Enter the server address.');
  const lines = (body: ViewBody): string => body.lines.map((line) => line.map((part) => part.text).join('').trimEnd()).join('\n');
  const full = form.render(60, 10, ASCII, true);
  assert.equal(
    lines(full),
    [
      '  Address        sftp.example.com',
      '                 ! Enter the server address.',
      '  Save password  [x]',
      '  IP version     < Either >',
      '  Passive mode   Always on.',
      '  [ Test ]',
    ].join('\n'),
  );
  assert.deepEqual(full.cursor, { row: 0, col: 33 });
  form.focusOn('test');
  const scrolled = form.render(60, 2, ASCII, true);
  assert.equal(lines(scrolled), '  Passive mode   Always on.\n  [ Test ]');
  assert.equal(scrolled.cursor, undefined);
  assert.equal(form.render(60, 10, ASCII, false).cursor, undefined);
});

test('dialogs answer with keys: confirm, choose, type, read', () => {
  let answer: unknown = 'none';
  const close = (value: unknown): void => {
    answer = value;
  };
  const confirm = confirmDialog('Remove', 'Remove it?');
  confirm.key(key('enter'), close);
  assert.equal(answer, false);
  confirm.key(key('left'), close);
  confirm.key(key('enter'), close);
  assert.equal(answer, true);
  confirmDialog('Remove', 'Remove it?').key(key('y'), close);
  assert.equal(answer, true);
  confirmDialog('Go', 'Go now?', { defaultYes: true }).key(key('escape'), close);
  assert.equal(answer, false);

  const choice = choiceDialog('Delete', 'Where?', [
    { label: 'Server', value: 'remote' },
    { label: 'Here', value: 'local' },
  ], 'none');
  choice.key(key('down'), close);
  choice.key(key('down'), close);
  choice.key(key('enter'), close);
  assert.equal(answer, 'local');
  choice.key(key('escape'), close);
  assert.equal(answer, 'none');

  const input = inputDialog('Count', 'Type 3.', { check: (value) => (value === '3' ? undefined : 'Type 3 exactly.') });
  input.key(key('text:4'), close);
  input.key(key('enter'), close);
  assert.equal(answer, 'none');
  assert.match(input.render(40, ASCII).lines.map((line) => line.map((part) => part.text).join('')).join('\n'), /! Type 3 exactly\./);
  input.key(key('backspace'), close);
  input.key(key('text:3'), close);
  input.key(key('enter'), close);
  assert.equal(answer, '3');
  const secret = inputDialog('Password', 'Password for demo-user', { masked: true });
  secret.key(key('text:s'), close);
  secret.key(key('text:3'), close);
  assert.ok(!JSON.stringify(secret.render(40, ASCII)).includes('s3'));
  secret.key(key('escape'), close);
  assert.equal(answer, undefined);
  messageDialog('Done', 'All done.').key(key('enter'), close);
  assert.equal(answer, undefined);
  assert.deepEqual(wrap('one two three four', 9), ['one two', 'three', 'four']);
});

/** A screen with rows, a summary and a status, for the chrome. */
class SampleView implements View {
  rows: string[] = ['  [x] ^ Put      index.html', '  [ ] ? Resolve  css/site.css   Changed locally and on the server since the last sync.'];
  title(): string {
    return 'Synchronize: My Site -> Production (SFTP)';
  }
  primary(): string {
    return 'Put newer files to remote';
  }
  summary(): Line {
    return [span('Files: 1 will be updated, 3 will be skipped, 1 need a decision')];
  }
  hints(): readonly Hint[] {
    return [
      { key: 'Space', label: 'Check' },
      { key: 'p', label: 'Put' },
      { key: 'g', label: 'Get' },
      { key: 's', label: 'Skip' },
      { key: 'd', label: 'Diff' },
      { key: 'a', label: 'All' },
      { key: 'Enter', label: 'Synchronize' },
      { key: 'x', label: 'Never shown: an eighth hint' },
    ];
  }
  status(): string {
    return 'css/site.css: Changed locally and on the server since the last sync.';
  }
  body(): ViewBody {
    return { lines: this.rows.map((row) => [span(row)]) };
  }
  key(input: Key, app: App): void {
    if (isKey(input, 'escape')) {
      app.pop();
    }
  }
}

test('the folder picker lists, scrolls, counts files, opens and goes up, and shows a folder it cannot open', async () => {
  const folders = Array.from({ length: 15 }, (_, index) => `folder-${String(index + 1).padStart(2, '0')}`);
  const listings: Record<string, { folders: string[]; files: number }> = {
    '/': { folders: ['site', ...folders], files: 2 },
    '/site': { folders: [], files: 0 },
  };
  const probe = {
    folders: (folder: string) => {
      const found = listings[folder];
      return found === undefined ? Promise.reject(new Error('No such folder.')) : Promise.resolve({ path: folder, ...found });
    },
  };
  const app = testApp();
  const chosen = app.dialog(folderPickerDialog(probe, '/', (work) => app.background(work)));
  await app.idle();
  let text = screen(app);
  assert.match(text, /Choose the site's folder: \//);
  assert.match(text, /> Use this folder/);
  assert.match(text, /site\//);
  assert.match(text, /and 5 more below/);
  assert.match(text, /and 2 files/);
  await press(app, 'backspace');
  assert.match(screen(app), /Choose the site's folder: \/ /, 'there is nothing above "/"');
  await press(app, 'down', 'enter');
  text = screen(app);
  assert.match(text, /Choose the site's folder: \/site/);
  assert.match(text, /> Use this folder[^\n]*\n[^\n]*\| {3}\.\. /);
  assert.doesNotMatch(text, /files?$/m);
  await press(app, 'down', 'enter');
  assert.match(screen(app), /Choose the site's folder: \/ /);
  await press(app, 'end');
  assert.match(screen(app), /> folder-15\//);
  await press(app, 's');
  assert.equal(await chosen, '/');

  const broken = app.dialog(folderPickerDialog(probe, '/gone', (work) => app.background(work)));
  await app.idle();
  assert.match(screen(app), /! \/gone cannot be opened: No such folder\./);
  await press(app, 'escape');
  assert.equal(await broken, undefined);
});

test('the chrome lays out title, summary, rules, body, message bar and at most seven hints', () => {
  const app = testApp(ASCII);
  app.push(new SampleView());
  matchSnapshot('chrome-ascii-80x24', screen(app));
  const unicode = testApp(UNICODE);
  unicode.push(new SampleView());
  matchSnapshot('chrome-unicode-80x24', screen(unicode));
  matchSnapshot('chrome-ascii-narrow-40x12', screen(app, 40, 12));
  assert.equal(hintLine([{ key: 'q', label: 'Quit' }]).map((part) => part.text).join(''), '  q Quit');
  assert.equal(progressBar(1, 4, 8, ASCII), '##......');
  assert.equal(progressBar(0, 0, 4, UNICODE), '████');
});

test('messages, the busy spinner and dialogs draw over the screen; ? opens every key', async () => {
  const app = testApp(ASCII);
  app.push(new SampleView());
  app.message('Could not connect: timed out.', 'error');
  assert.match(screen(app), /^ x Could not connect: timed out\.$/m);
  app.message('2 problems to fix before saving.', 'warning');
  assert.match(screen(app), /^ ! 2 problems to fix before saving\.$/m);

  const fresh = testApp(ASCII);
  fresh.push(new SampleView());
  const busy = fresh.task('Connecting', () => new Promise<void>(() => undefined));
  assert.match(screen(fresh), /^ \| Connecting {2}Esc Cancel$/m);
  fresh.tick();
  assert.match(screen(fresh), /^ \/ Connecting/m);
  fresh.key(key('escape'));
  assert.ok(fresh.busy);
  assert.match(screen(fresh), /^ Cancelling\.\.\.$/m);
  void busy;

  const answer = app.dialog(confirmDialog('Synchronize', 'Synchronize 1 file(s) now?', { yes: 'Synchronize', defaultYes: true }));
  matchSnapshot('dialog-confirm-80x24', screen(app));
  await press(app, 'enter');
  assert.equal(await answer, true);

  await press(app, '?');
  const help = screen(app);
  assert.match(help, /Keys: Synchronize: My Site/);
  assert.match(help, /Never shown: an eighth hint/);
  await press(app, 'escape');
  assert.equal(app.topDialog, undefined);

  const typed = app.dialog(inputDialog('Many deletes', 'Type 12 to go ahead.'));
  await type(app, '12');
  const frame = app.render(80, 24);
  assert.ok(frame.cursor !== undefined);
  assert.match(frameText(frame), /> 12▏/);
  await press(app, 'enter');
  assert.equal(await typed, '12');
});

test('quitting answers open dialogs with Esc and aborts the running task', async () => {
  const app = testApp(ASCII);
  app.push(new SampleView());
  let aborted = false;
  const task = app.task('Synchronizing', (signal) => new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => {
      aborted = true;
      resolve();
    });
  }));
  const pending = app.dialog(confirmDialog('Go', 'Go?', { defaultYes: true }));
  app.quit();
  assert.equal(await pending, false);
  await task;
  assert.ok(aborted);
  assert.equal(await app.dialog(choiceDialog('Late', 'Too late?', [{ label: 'Yes', value: 1 }], 0)), 0);
  await app.finished;
});
