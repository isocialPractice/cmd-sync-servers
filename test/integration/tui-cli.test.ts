import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { CliIo } from '../../src/cli/io.ts';
import { runCli } from '../../src/cli/router.ts';
import { cli, testEnv } from '../helpers/cli.ts';
import { startSiteRig, type SiteRig } from '../sandbox/site-rig.ts';

interface Step {
  /** Text the screen shows before the keys are pressed. */
  readonly when: string;
  /** Keys as [typed text, key name, modifiers]. */
  readonly keys: readonly (readonly [string | undefined, string, Readonly<Record<string, boolean>>?])[];
}

/** A terminal with raw mode that presses scripted keys once the screen shows the text each step waits for. */
class ScriptedTerminal {
  readonly stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: (mode: boolean): void => {
      this.raw = mode;
    },
    resume: (): void => undefined,
    pause: (): void => undefined,
  });
  readonly stdout = {
    isTTY: true,
    columns: 80,
    rows: 24,
    write: (text: string): boolean => {
      this.text += text;
      this.#advance();
      return true;
    },
    on: (): void => undefined,
    off: (): void => undefined,
  };
  readonly stderr = {
    isTTY: false,
    text: '',
    write: (text: string): boolean => {
      this.stderr.text += text;
      return true;
    },
  };
  raw = false;
  text = '';
  #seen = 0;
  readonly #steps: Step[];

  constructor(steps: readonly Step[]) {
    this.#steps = [...steps];
  }

  #advance(): void {
    const step = this.#steps[0];
    if (step === undefined || !this.text.slice(this.#seen).includes(step.when)) {
      return;
    }
    this.#steps.shift();
    this.#seen = this.text.length;
    setImmediate(() => {
      for (const [text, name, modifiers] of step.keys) {
        this.stdin.emit('keypress', text, { name, sequence: text, ...modifiers });
      }
    });
  }

  get pending(): number {
    return this.#steps.length;
  }

  io(rig: SiteRig, cwd: string, env: Record<string, string> = {}): CliIo {
    return {
      stdin: this.stdin,
      stdout: this.stdout,
      stderr: this.stderr,
      env: testEnv(rig.home, env),
      cwd,
      platform: process.platform,
      homedir: rig.home,
    };
  }
}

const ENTER = ['\r', 'return'] as const;
const ESC = ['\u001b', 'escape'] as const;

async function withRig(run: (rig: SiteRig) => Promise<void>): Promise<void> {
  const rig = await startSiteRig('local');
  try {
    await run(rig);
  } finally {
    await rig.close();
  }
}

test('in a terminal, sync previews in the full-screen UI, runs from it, and prints the result after leaving it', async () => {
  await withRig(async (rig) => {
    rig.write('local', 'a.html', 'a');
    const terminal = new ScriptedTerminal([
      { when: 'a.html', keys: [ENTER] },
      { when: 'Synchronize 1 file(s) now?', keys: [ENTER] },
      { when: 'Results: My Site', keys: [ESC] },
    ]);
    const code = await runCli(['--ascii', 'sync', '--put'], terminal.io(rig, rig.localDir));
    assert.equal(code, 0, terminal.stderr.text);
    assert.equal(terminal.pending, 0);
    assert.ok(!terminal.raw);
    const after = terminal.text.slice(terminal.text.lastIndexOf('\u001b[?1049l'));
    assert.match(after, /Synchronized 1 file\. 0 failed\. 0 skipped\.\n$/);
    assert.equal(rig.read('remote', 'a.html'), 'a');
  });
});

test('leaving the full-screen preview with Esc changes nothing and exits 4', async () => {
  await withRig(async (rig) => {
    rig.write('local', 'a.html', 'a');
    const terminal = new ScriptedTerminal([{ when: 'a.html', keys: [ESC] }]);
    const code = await runCli(['--ascii', 'sync', '--put'], terminal.io(rig, rig.localDir));
    assert.equal(code, 4);
    assert.match(terminal.stderr.text, /Nothing was changed\./);
    assert.equal(rig.read('remote', 'a.html'), undefined);
  });
});

test('q in the full-screen preview quits as Ctrl+C does: nothing changes and it exits 4', async () => {
  await withRig(async (rig) => {
    rig.write('local', 'a.html', 'a');
    const terminal = new ScriptedTerminal([
      { when: 'a.html', keys: [['/', '/'], ['q', 'q']] },
      { when: '/q', keys: [ESC, ['q', 'q']] },
    ]);
    const code = await runCli(['--ascii', 'sync', '--put'], terminal.io(rig, rig.localDir));
    assert.equal(code, 4, terminal.stderr.text);
    assert.equal(terminal.pending, 0);
    assert.ok(!terminal.raw, 'the terminal is restored');
    assert.ok(terminal.text.includes('\u001b[?1049l'), 'the alternate screen is left');
    assert.match(terminal.stderr.text, /Nothing was changed\./);
    assert.equal(rig.read('remote', 'a.html'), undefined);
  });
});

test('with no command, the full-screen UI opens at the sites, and the chosen site lands in --cd-file', async () => {
  await withRig(async (rig) => {
    const cdFile = path.join(rig.home, 'cd.txt');
    // Each step waits for text that shows only once the screen's background work is done.
    const terminal = new ScriptedTerminal([
      { when: 'My Site', keys: [ENTER] },
      { when: 'on the server', keys: [['q', 'q']] },
    ]);
    const code = await runCli(['--ascii', '--cd-file', cdFile], terminal.io(rig, rig.home));
    assert.equal(code, 0, terminal.stderr.text);
    assert.equal(readFileSync(cdFile, 'utf8'), rig.localDir);

    const here = new ScriptedTerminal([
      { when: 'on the server', keys: [ESC] },
      { when: 'Enter Open', keys: [['\u0003', 'c', { ctrl: true }]] },
    ]);
    assert.equal(await runCli(['--ascii'], here.io(rig, rig.localDir)), 0, here.stderr.text);
    assert.equal(here.pending, 0);
  });
});

test('plain mode takes every preview command: numbers, ranges, actions, deletes, diffs and help', async () => {
  await withRig(async (rig) => {
    rig.write('local', 'a.html', 'a');
    rig.write('local', 'b.html', 'local b');
    rig.write('remote', 'b.html', 'remote b');
    rig.write('remote', 'c.html', 'c');
    const input = [
      'help',
      'list',
      'none',
      'all',
      '',
      '2',
      '9',
      'g 1',
      'm 1',
      'p 2',
      'x 3',
      's 3',
      'x 2',
      '2',
      'p 2',
      'p',
      'x zz',
      'diff 2',
      'diff 1',
      'diff',
      'zz',
      'go',
      'n',
      'go',
      'y',
      '',
    ].join('\n');
    const result = await cli({ home: rig.home, cwd: rig.localDir, input, tty: true }, '--ascii', 'sync', '--both');
    assert.equal(result.code, 0, result.stderr);
    const out = result.stdout;
    assert.match(out, /^ {2}1 \[x\] \^ Put +a\.html$/m);
    assert.match(out, /^ {2}2 \[ \] \? Resolve +b\.html +Differs/m);
    assert.match(out, /^ {2}3 \[x\] v Get +c\.html$/m);
    assert.match(out, /^Commands:\n {2}<n>\.\.\./m);
    assert.match(out, /^2: choose an action first: p Put, g Get, s Skip or m Synchronized\.$/m);
    assert.match(out, /^No row 9\. Rows go from 1 to 3\.$/m);
    assert.match(out, /^1: a\.html cannot take Get; it can take put, skip, delete-local\.$/m);
    assert.match(out, /^1: a\.html cannot take Synchronized; it can take put, skip, delete-local\.$/m);
    assert.match(out, /^Name rows after "p", such as "p 3" or "p 2-6"\.$/m);
    assert.match(out, /^Name rows after "x", such as "x 3" or "x 2-6"\.$/m);
    assert.match(out, /^-local b$/m);
    assert.match(out, /^\+remote b$/m);
    assert.match(out, /^Name one row, such as "diff 3"\.$/m);
    assert.match(out, /^Unknown command "zz"\. Type "help" for commands\.$/m);
    assert.match(result.stderr, /Delete b\.html where\?/);
    assert.match(out, /^Synchronized 2 files\. 0 failed\. 1 skipped\.$/m);
    assert.equal(rig.read('remote', 'a.html'), 'a');
    assert.equal(rig.read('remote', 'b.html'), 'local b');
    assert.equal(rig.read('local', 'c.html'), undefined);
  });
});
