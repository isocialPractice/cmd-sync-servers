import assert from 'node:assert/strict';
import { test } from 'node:test';
import { errorMessage } from '../../src/transport/common.ts';
import { safeLine, safeText } from '../../src/terminal-text.ts';
import { textSink } from '../../src/log/logger.ts';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI = String.fromCharCode(0x9b);
const RLO = String.fromCharCode(0x202e);

test('a line escapes every C0, DEL, C1 and bidi character, newlines and tabs included', () => {
  assert.equal(safeLine(`a${ESC}]52;c;b3du${BEL}b`), 'a\\u001b]52;c;b3du\\u0007b');
  assert.equal(safeLine(`csi${CSI}2J`), 'csi\\u009b2J');
  assert.equal(safeLine(`photo${RLO}gpj.exe`), 'photo\\u202egpj.exe');
  assert.equal(safeLine('line\nbreak\ttab\rreturn'), 'line\\u000abreak\\u0009tab\\u000dreturn');
  assert.equal(safeLine('plain café.html'), 'plain café.html');
});

test('text keeps its lines and tabs, turns CRLF into LF, and escapes the rest', () => {
  assert.equal(safeText(`one\r\ntwo\tthree\n${ESC}[2Jfour\rfive`), 'one\ntwo\tthree\n\\u001b[2Jfour\\u000dfive');
});

test('a server reply inside an error message cannot reach the terminal raw', () => {
  const reply = new Error(`550 ${ESC}]52;c;ZXZpbA==${BEL}${ESC}[2KNo such file`);
  const message = errorMessage(reply);
  assert.ok(!message.includes(ESC) && !message.includes(BEL), message);
  assert.match(message, /^550 \\u001b\]52;c;ZXZpbA==\\u0007\\u001b\[2KNo such file$/);
});

test('debug lines on stderr are escaped too', () => {
  let written = '';
  textSink({ write: (text: string) => (written += text) }).write({ time: '2026-10-29T12:00:00.000Z', level: 'debug', message: `< 220 ${ESC}[31mwelcome` });
  assert.equal(written, 'debug: < 220 \\u001b[31mwelcome\n');
});
