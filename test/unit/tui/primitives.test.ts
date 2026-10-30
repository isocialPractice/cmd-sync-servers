import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fromKeypress, isKey, key } from '../../../src/tui/keys.ts';
import { encodeLine, Renderer } from '../../../src/tui/screen.ts';
import { span } from '../../../src/tui/style.ts';
import { TextArea } from '../../../src/tui/textarea.ts';
import { TextField } from '../../../src/tui/textfield.ts';
import { charWidth, padEnd, printable, sliceColumns, textWidth, truncate, truncatePath } from '../../../src/tui/text.ts';
import { ASCII, UNICODE } from '../../helpers/tui.ts';

test('text widths count wide characters as two columns and combining marks as none', () => {
  assert.equal(charWidth('a'.codePointAt(0) ?? 0), 1);
  assert.equal(charWidth('界'.codePointAt(0) ?? 0), 2);
  assert.equal(charWidth(0x0301), 0);
  assert.equal(textWidth('ab界'), 4);
  assert.equal(textWidth('é'), 1);
});

test('slicing, padding and truncating never split a wide character', () => {
  assert.equal(sliceColumns('a界b', 0, 2), 'a');
  assert.equal(sliceColumns('a界b', 1, 3), '界b');
  assert.equal(padEnd('ab', 4), 'ab  ');
  assert.equal(padEnd('abcdef', 3), 'abc');
  assert.equal(padEnd('界界', 3), '界 ');
  assert.equal(truncate('short', 10, '...'), 'short');
  assert.equal(truncate('a long status line', 10, '...'), 'a long ...');
  assert.equal(truncate('abc', 2, '...'), '..');
  assert.equal(truncate('a long status line', 8, '…'), 'a long …');
});

test('long paths are cut in the middle so the file name stays readable', () => {
  assert.equal(truncatePath('css/site.css', 20, '…'), 'css/site.css');
  assert.equal(truncatePath('assets/images/gallery/2026/hero.svg', 20, '…'), 'assets/ima…/hero.svg');
  assert.equal(textWidth(truncatePath('assets/images/gallery/2026/hero.svg', 20, '…')), 20);
  assert.equal(truncatePath('a-very-long-file-name-without-folders.html', 12, '...'), 'a-very-lo...');
  assert.equal(truncatePath('folder/a-very-long-file-name.html', 12, '...'), 'folder/a-...');
});

test('control characters never reach the terminal', () => {
  assert.equal(printable('a\u001b[31mb\u0007c\u009b'), 'a?[31mb?c?');
});

test('keys normalize Node keypress events and compare by name and modifiers', () => {
  assert.deepEqual(fromKeypress('\r', { name: 'return', sequence: '\r' }), { name: 'enter', ctrl: false, meta: false, shift: false, text: undefined });
  assert.deepEqual(fromKeypress('a', { name: 'a', sequence: 'a' }), { name: 'a', ctrl: false, meta: false, shift: false, text: 'a' });
  assert.deepEqual(fromKeypress('?', undefined), { name: '?', ctrl: false, meta: false, shift: false, text: '?' });
  const ctrlS = fromKeypress('\u0013', { name: 's', ctrl: true });
  assert.equal(ctrlS.text, undefined);
  assert.ok(isKey(ctrlS, 'ctrl+s'));
  assert.ok(!isKey(ctrlS, 's'));
  assert.ok(isKey(fromKeypress('\u001b[Z', { name: 'tab', shift: true }), 'shift+tab'));
  assert.ok(isKey(fromKeypress(' ', { name: 'space', sequence: ' ' }), 'space'));
  assert.deepEqual(key('T'), { name: 't', ctrl: false, meta: false, shift: true, text: 'T' });
  assert.deepEqual(key('text:é'), { name: 'é', ctrl: false, meta: false, shift: false, text: 'é' });
});

test('lines encode to SGR styles, colour only when on, cut at the width', () => {
  const line = [span('ok '), span('warn', 'warning'), span(' x', 'focus')];
  assert.equal(encodeLine(line, 80, UNICODE), 'ok \u001b[33mwarn\u001b[0m\u001b[7m x\u001b[0m');
  assert.equal(encodeLine(line, 80, ASCII), 'ok warn\u001b[7m x\u001b[0m');
  assert.equal(encodeLine([span('accent', 'accent')], 80, ASCII), '\u001b[1maccent\u001b[0m');
  assert.equal(encodeLine(line, 5, ASCII), 'ok wa');
  assert.equal(encodeLine([span('界界界')], 5, ASCII), '界界');
  assert.equal(encodeLine([span('a\u001b]0;title\u0007')], 80, ASCII), 'a?]0;title?');
});

test('the renderer rewrites only the rows that changed, and everything after a resize', () => {
  const renderer = new Renderer();
  const frame = (second: string) => ({ lines: [[span('title')], [span(second)], [span('footer')]] });
  const all = '\u001b[?25l\u001b[1;1Htitle\u001b[0K\u001b[2;1Htwo\u001b[0K\u001b[3;1Hfooter\u001b[0K';
  assert.equal(renderer.render(frame('one'), 20, 3, ASCII), all.replace('two', 'one'));
  const same = renderer.render(frame('one'), 20, 3, ASCII);
  assert.equal(same, '\u001b[?25l');
  const changed = renderer.render(frame('two'), 20, 3, ASCII);
  assert.equal(changed, '\u001b[?25l\u001b[2;1Htwo\u001b[0K');
  assert.equal(renderer.render(frame('two'), 30, 3, ASCII), all);
  renderer.invalidate();
  assert.equal(renderer.render(frame('two'), 30, 3, ASCII), all);
  const withCursor = renderer.render({ ...frame('two'), cursor: { row: 1, col: 4 } }, 30, 3, ASCII);
  assert.equal(withCursor, '\u001b[?25l\u001b[2;5H\u001b[?25h');
});

test('a text field edits at the cursor, scrolls long values and masks secrets', () => {
  const field = new TextField('hello');
  assert.equal(field.cursor, 5);
  field.key(key('left'));
  field.key(key('left'));
  field.key(key('text:X'));
  assert.equal(field.value, 'helXlo');
  field.key(key('backspace'));
  field.key(key('delete'));
  assert.equal(field.value, 'helo');
  field.key(key('home'));
  field.key(key('text:>'));
  field.key(key('end'));
  assert.equal(field.value, '>helo');
  assert.equal(field.cursor, 5);
  assert.equal(field.key(key('ctrl+x')), false);
  field.key(key('ctrl+u'));
  assert.equal(field.value, '');

  const long = new TextField('abcdefghijklmnopqrstuvwxyz');
  assert.deepEqual(long.view(10), { text: 'rstuvwxyz', cursor: 9 });
  long.key(key('home'));
  assert.deepEqual(long.view(10), { text: 'abcdefghij', cursor: 0 });

  const secret = new TextField('', { masked: true, maxLength: 4 });
  secret.insert('p4ssword');
  assert.equal(secret.value, 'p4ss');
  assert.deepEqual(secret.view(10), { text: '****', cursor: 4 });
  secret.value = 'new';
  assert.equal(secret.cursor, 3);
});

test('a text area splits and joins rows, moves across them and scrolls', () => {
  const area = new TextArea('.psd\nnode_modules/');
  assert.deepEqual(area.lines, ['.psd', 'node_modules/']);
  area.key(key('end'));
  area.key(key('enter'));
  area.insert('/drafts/');
  assert.equal(area.value, '.psd\n/drafts/\nnode_modules/');
  area.move('home');
  area.key(key('backspace'));
  assert.equal(area.value, '.psd/drafts/\nnode_modules/');
  assert.deepEqual(area.position, { row: 0, col: 4 });
  area.key(key('down'));
  assert.deepEqual(area.position, { row: 1, col: 4 });
  area.key(key('end'));
  area.key(key('right'));
  assert.deepEqual(area.position, { row: 1, col: 13 });
  area.key(key('home'));
  area.key(key('left'));
  assert.deepEqual(area.position, { row: 0, col: 12 });
  assert.equal(area.key(key('ctrl+s')), false);

  const tall = new TextArea('1\n2\n3\n4\n5');
  for (let index = 0; index < 4; index += 1) {
    tall.key(key('down'));
  }
  const view = tall.view(10, 2);
  assert.deepEqual(view.lines, ['4', '5']);
  assert.deepEqual(view.cursor, { row: 1, col: 0 });
  assert.equal(new TextArea('').value, '');
  const trailing = new TextArea('a');
  trailing.key(key('end'));
  trailing.key(key('enter'));
  assert.equal(trailing.value, 'a');
});
