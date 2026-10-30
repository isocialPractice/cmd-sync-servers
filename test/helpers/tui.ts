import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { App } from '../../src/tui/app.ts';
import { key } from '../../src/tui/keys.ts';
import { plain, type Frame, type Theme } from '../../src/tui/style.ts';
import { sliceColumns } from '../../src/tui/text.ts';

export const ASCII: Theme = { color: false, ascii: true };
export const UNICODE: Theme = { color: true, ascii: false };

/** An app whose clock stands still, so messages never expire mid-test. */
export function testApp(theme: Theme = ASCII): App {
  return new App(theme, () => 0);
}

/**
 * A frame as plain text, as the terminal shows it: one line per row cut at
 * `columns`, trailing spaces removed, the cursor marked with `▏` when shown.
 */
export function frameText(frame: Frame, columns = 80): string {
  const rows = frame.lines.map((line) => sliceColumns(plain(line), 0, columns));
  const cursor = frame.cursor;
  if (cursor !== undefined) {
    const row = rows[cursor.row] ?? '';
    const chars = Array.from(row.padEnd(cursor.col));
    chars.splice(cursor.col, 0, '▏');
    rows[cursor.row] = chars.join('');
  }
  return `${rows.map((row) => row.trimEnd()).join('\n')}\n`;
}

/** The app's screen at `columns` x `rows` as plain text. */
export function screen(app: App, columns = 80, rows = 24): string {
  return frameText(app.render(columns, rows), columns);
}

/** Presses keys one by one, each given as for {@link key}, waiting for the work each starts. */
export async function press(app: App, ...specs: string[]): Promise<void> {
  for (const spec of specs) {
    app.key(key(spec));
    await app.idle();
  }
}

/** Types text into the focused field, one character at a time. */
export async function type(app: App, text: string): Promise<void> {
  for (const char of text) {
    app.key(key(`text:${char}`));
    await app.idle();
  }
}

const SNAPSHOTS = path.join(import.meta.dirname, '..', 'unit', 'tui', 'snapshots');

/**
 * Compares `text` with `test/unit/tui/snapshots/<name>.txt`. A missing or
 * empty snapshot is written and passes locally, and fails in CI so it cannot
 * be forgotten. `UPDATE_SNAPSHOTS=1` rewrites every snapshot a run touches.
 */
export function matchSnapshot(name: string, text: string): void {
  const file = path.join(SNAPSHOTS, `${name}.txt`);
  const update = process.env.UPDATE_SNAPSHOTS === '1';
  if (update || !existsSync(file) || readFileSync(file, 'utf8') === '') {
    if (!update && process.env.CI !== undefined) {
      assert.fail(`The snapshot ${name}.txt is missing. Run the tests locally and commit test/unit/tui/snapshots/${name}.txt.`);
    }
    mkdirSync(SNAPSHOTS, { recursive: true });
    writeFileSync(file, text);
    return;
  }
  assert.equal(text, readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), `The screen differs from snapshots/${name}.txt. If the change is intended, rerun with UPDATE_SNAPSHOTS=1.`);
}
