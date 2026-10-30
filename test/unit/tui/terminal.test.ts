import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate as tick } from 'node:timers/promises';
import { test } from 'node:test';
import type { App, Hint, View, ViewBody } from '../../../src/tui/app.ts';
import { isKey, type Key } from '../../../src/tui/keys.ts';
import { runTui } from '../../../src/tui/run.ts';
import { span } from '../../../src/tui/style.ts';
import { Terminal } from '../../../src/tui/terminal.ts';
import { ASCII } from '../../helpers/tui.ts';

const ENTER = '\u001b[?1049h';
const LEAVE = '\u001b[0m\u001b[?25h\u001b[?1049l';

class FakeInput extends EventEmitter {
  readonly isTTY: boolean;
  raw = false;
  paused = true;
  constructor(isTTY = true) {
    super();
    this.isTTY = isTTY;
  }
  setRawMode(mode: boolean): void {
    this.raw = mode;
  }
  resume(): void {
    this.paused = false;
  }
  pause(): void {
    this.paused = true;
  }
  press(text: string | undefined, name: string, extra: Record<string, boolean> = {}): void {
    this.emit('keypress', text, { name, sequence: text, ...extra });
  }
}

class FakeOutput extends EventEmitter {
  columns = 80;
  rows = 24;
  text = '';
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

/** A screen that counts keys, closes on Esc, and fails to draw once `fail` is set. */
class CounterView implements View {
  count = 0;
  fail = false;
  title(): string {
    return 'Counter';
  }
  hints(): readonly Hint[] {
    return [{ key: 'Esc', label: 'Back' }];
  }
  body(): ViewBody {
    if (this.fail) {
      throw new Error('drawing failed');
    }
    return { lines: [[span(`Pressed ${String(this.count)}`)]] };
  }
  key(press: Key, app: App): void {
    if (isKey(press, 'escape')) {
      app.pop();
    } else if (press.text === 'x') {
      this.fail = true;
    } else {
      this.count += 1;
    }
  }
}

test('the terminal enters raw mode and the alternate screen, and stop restores both once', () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const terminal = new Terminal(input, output);
  const keys: Key[] = [];
  let resized = 0;
  terminal.start(
    (press) => keys.push(press),
    () => (resized += 1),
  );
  assert.ok(terminal.started);
  assert.ok(input.raw);
  assert.ok(!input.paused);
  assert.ok(output.text.startsWith(ENTER));
  input.press('a', 'a');
  input.press('\r', 'return');
  output.emit('resize');
  assert.deepEqual(keys.map((press) => press.name), ['a', 'enter']);
  assert.equal(resized, 1);
  assert.deepEqual(terminal.size(), { columns: 80, rows: 24 });

  terminal.stop();
  terminal.stop();
  assert.ok(!terminal.started);
  assert.ok(!input.raw);
  assert.ok(input.paused);
  assert.ok(output.text.endsWith(LEAVE));
  assert.equal(output.text.split(LEAVE).length, 2);
  assert.equal(input.listenerCount('keypress'), 0);
  assert.equal(output.listenerCount('resize'), 0);
  input.press('b', 'b');
  assert.equal(keys.length, 2);
});

test('the terminal refuses to start without an interactive terminal, leaving it untouched', () => {
  const input = new FakeInput(false);
  const output = new FakeOutput();
  const terminal = new Terminal(input, output);
  assert.throws(() => {
    terminal.start(
      () => undefined,
      () => undefined,
    );
  }, /needs an interactive terminal/);
  assert.equal(output.text, '');
  assert.ok(!input.raw);
  terminal.stop();
  assert.equal(output.text, '');
});

test('a tiny terminal still gets a usable size', () => {
  const output = new FakeOutput();
  output.columns = 5;
  output.rows = 2;
  assert.deepEqual(new Terminal(new FakeInput(), output).size(), { columns: 20, rows: 8 });
});

test('the UI draws frames, takes keys, and restores the terminal when its last screen closes', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const view = new CounterView();
  const running = runTui({ input, output, theme: ASCII, views: [view], hookProcess: false, spinnerMs: 5 });
  await tick();
  assert.match(output.text, /Pressed 0/);
  input.press('a', 'a');
  input.press('b', 'b');
  await tick();
  assert.match(output.text, /Pressed 2/);
  const before = output.text.length;
  output.emit('resize');
  await tick();
  assert.ok(output.text.slice(before).includes('\u001b[1;1H\u001b[1m Counter'));
  input.press('\u001b', 'escape');
  const app = await running;
  assert.equal(app.depth, 0);
  assert.ok(output.text.endsWith(LEAVE));
  assert.ok(!input.raw);
  assert.equal(input.listenerCount('keypress'), 0);
});

test('an error mid-frame restores the terminal and is passed on', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const view = new CounterView();
  const running = runTui({ input, output, theme: ASCII, views: [view], hookProcess: false });
  await tick();
  input.press('x', 'x');
  await assert.rejects(running, /drawing failed/);
  assert.ok(output.text.endsWith(LEAVE));
  assert.ok(!input.raw);
  assert.ok(input.paused);
});

test('Ctrl+C quits from any screen', async () => {
  const input = new FakeInput();
  const output = new FakeOutput();
  const running = runTui({ input, output, theme: ASCII, views: [new CounterView(), new CounterView()], hookProcess: false });
  await tick();
  input.press('\u0003', 'c', { ctrl: true });
  const app = await running;
  assert.equal(app.depth, 2);
  assert.ok(output.text.endsWith(LEAVE));
});
