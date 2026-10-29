import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CancelledError } from '../../../src/cli/errors.ts';
import { Prompter } from '../../../src/cli/prompt.ts';
import { Capture } from '../../helpers/cli.ts';

function prompter(input: string, tty = false): { ask: Prompter; output: Capture; rawModes: boolean[] } {
  const stream = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (mode: boolean) => void };
  const rawModes: boolean[] = [];
  if (tty) {
    stream.isTTY = true;
    stream.setRawMode = (mode) => {
      rawModes.push(mode);
    };
  }
  stream.end(input);
  const output = new Capture();
  return { ask: new Prompter(stream, output), output, rawModes };
}

test('answers typed ahead are kept for later questions', async () => {
  const { ask } = prompter('My Site\r\n/var/www\nyes\n');
  assert.equal(await ask.ask('Site name'), 'My Site');
  assert.equal(await ask.ask('Root'), '/var/www');
  assert.equal(await ask.confirm('Continue?'), true);
  ask.close();
});

test('an empty answer takes the default, shown in brackets', async () => {
  const { ask, output } = prompter('\n');
  assert.equal(await ask.ask('Port', '22'), '22');
  assert.equal(output.text, 'Port [22]: ');
  ask.close();
});

test('askValid repeats the question until the answer is accepted', async () => {
  const { ask, output } = prompter('abc\n70000\n2222\n');
  const port = await ask.askValid('Port', (answer) => (/^\d+$/.test(answer) && Number(answer) <= 65535 ? undefined : 'Enter a port.'));
  assert.equal(port, '2222');
  assert.equal(output.text.split('Enter a port.').length - 1, 2);
  ask.close();
});

test('choose offers numbered choices', async () => {
  const { ask, output } = prompter('9\n2\n');
  const value = await ask.choose('Connect using', [
    { label: 'SFTP', value: 'sftp' },
    { label: 'FTPS', value: 'ftps' },
  ]);
  assert.equal(value, 'ftps');
  assert.match(output.text, /1\. SFTP\n {2}2\. FTPS\n/);
  ask.close();
});

test('end of input cancels a question', async () => {
  const { ask } = prompter('');
  await assert.rejects(ask.ask('Site name'), CancelledError);
  ask.close();
});

test('a secret is read with raw mode on, never echoed, and edited with backspace', async () => {
  const { ask, output, rawModes } = prompter('hunterX\u007f2\r', true);
  assert.equal(await ask.secret('Password: '), 'hunter2');
  assert.deepEqual(rawModes, [true, false]);
  assert.equal(output.text, 'Password: \n');
  ask.close();
});

test('arrow keys are ignored in a secret', async () => {
  const { ask } = prompter('ab\u001b[Dc\r', true);
  assert.equal(await ask.secret('Password: '), 'abc');
  ask.close();
});

test('Ctrl+C cancels a secret and restores the terminal', async () => {
  const { ask, rawModes } = prompter('abc\u0003', true);
  await assert.rejects(ask.secret('Password: '), CancelledError);
  assert.deepEqual(rawModes, [true, false]);
  ask.close();
});
