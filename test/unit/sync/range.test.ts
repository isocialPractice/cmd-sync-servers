import assert from 'node:assert/strict';
import { statSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { after, before, describe, test } from 'node:test';
import { isSyncError } from '../../../src/errors.ts';
import { noRecentFiles, RANGE_TEXT, rangeTitle, rangeWords } from '../../../src/sync/messages.ts';
import { DEFAULT_RANGE, fileChangedSince, formatRange, parseRange, rangeStart, type RangeUnit, type TimeRange } from '../../../src/sync/range.ts';
import { RANGE_TITLE } from '../../../src/sync/types.ts';
import { tempDir } from '../../helpers/cli.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Every form a range takes, with what it reads as and how it is written back. */
const ACCEPTED: readonly (readonly [text: string, value: number, unit: RangeUnit, written: string])[] = [
  ['90m', 90, 'm', '90m'],
  ['24h', 24, 'h', '24h'],
  ['2d', 2, 'd', '2d'],
  ['1w', 1, 'w', '1w'],
  ['1.5h', 1.5, 'h', '1.5h'],
  ['0.5d', 0.5, 'd', '0.5d'],
  ['100000w', 100_000, 'w', '100000w'],
  ['0.000001m', 0.000001, 'm', '0.000001m'],
  [' 2d ', 2, 'd', '2d'],
  ['\t1w\n', 1, 'w', '1w'],
  ['007d', 7, 'd', '7d'],
  ['1.50h', 1.5, 'h', '1.5h'],
];

const REFUSED: readonly string[] = [
  '',
  ' ',
  '2',
  'd',
  '2D',
  '2M',
  '2s',
  '2y',
  '2q',
  '0d',
  '0.0h',
  '-2d',
  '+2d',
  '2 d',
  '1d12h',
  '1d 12h',
  'lm',
  '12:00',
  '1e3d',
  '100001w',
  '100000.5w',
  '0.0000001d',
  '.5d',
  '2.d',
  '2d\n3d',
  '-h',
  '--help',
  '/?',
];

/** Range objects no text reads as, as a program without type checks could build them. */
const BY_HAND: readonly TimeRange[] = [
  { value: 2, unit: 'M' },
  { value: 2, unit: 's' },
  { value: -2, unit: 'd' },
  { value: 0, unit: 'd' },
  { value: Number.NaN, unit: 'd' },
  { value: Number.POSITIVE_INFINITY, unit: 'w' },
  { value: 100_001, unit: 'w' },
  { value: 1e-7, unit: 'd' },
  { value: '-h', unit: '' },
  { value: '--help', unit: '' },
  { value: '/?', unit: '' },
  { value: '', unit: '' },
  { value: '2d 12', unit: 'h' },
] as unknown as readonly TimeRange[];

describe('parseRange and formatRange', () => {
  test('a number and one of the four units is a range, written back as it is typed', () => {
    for (const [text, value, unit, written] of ACCEPTED) {
      const range = parseRange(text);
      assert.deepEqual(range, { value, unit }, JSON.stringify(text));
      assert.equal(formatRange({ value, unit }), written, JSON.stringify(text));
      assert.deepEqual(parseRange(written), { value, unit }, written);
    }
  });

  test('anything else is not a range', () => {
    for (const text of REFUSED) {
      assert.equal(parseRange(text), undefined, JSON.stringify(text));
    }
  });

  test('the range a question offers is a range of one day', () => {
    assert.deepEqual(parseRange(DEFAULT_RANGE), { value: 1, unit: 'd' });
    assert.equal(DEFAULT_RANGE, '1d');
  });
});

describe('rangeStart', () => {
  const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

  test('a range starts that long before the clock of this computer, for every unit', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const cases: readonly (readonly [text: string, before: number])[] = [
      ['90m', 90 * MINUTE],
      ['1m', MINUTE],
      ['24h', DAY],
      ['2d', 2 * DAY],
      ['1w', WEEK],
      ['1.5h', 90 * MINUTE],
      ['0.5d', 12 * HOUR],
      ['100000w', 100_000 * WEEK],
    ];
    for (const [text, before] of cases) {
      const range = parseRange(text);
      assert.ok(range !== undefined, text);
      const start = rangeStart(range);
      assert.ok(start instanceof Date, text);
      assert.equal(start.getTime(), NOW - before, text);
    }
  });

  test('the start follows the clock', (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    assert.equal(rangeStart({ value: 1, unit: 'd' }).getTime(), NOW - DAY);
    t.mock.timers.setTime(NOW + WEEK);
    assert.equal(rangeStart({ value: 1, unit: 'd' }).getTime(), NOW + WEEK - DAY);
  });

  test('no text ends the process or prints a help page, accepted or refused', (t) => {
    const exit = t.mock.method(process, 'exit', () => undefined as never);
    const log = t.mock.method(console, 'log', () => undefined);
    for (const text of [...ACCEPTED.map(([accepted]) => accepted), ...REFUSED]) {
      const range = parseRange(text);
      if (range !== undefined) {
        assert.ok(!Number.isNaN(rangeStart(range).getTime()), JSON.stringify(text));
      }
    }
    assert.equal(exit.mock.callCount(), 0);
    assert.equal(log.mock.callCount(), 0);
  });

  test('a range built by hand that no text reads as is refused before it is counted', (t) => {
    const exit = t.mock.method(process, 'exit', () => undefined as never);
    const log = t.mock.method(console, 'log', () => undefined);
    for (const range of BY_HAND) {
      assert.throws(
        () => rangeStart(range),
        (error) => isSyncError(error, 'E_PLAN_INVALID') && error.message === `A time range is ${RANGE_TEXT.format}.`,
        JSON.stringify(range),
      );
    }
    assert.equal(exit.mock.callCount(), 0);
    assert.equal(log.mock.callCount(), 0);
  });

  test('a start no date can hold is refused', () => {
    const SystemDate = Date;
    // A clock standing at the earliest moment a date can hold: anything before it is not a date.
    class EarliestDate extends SystemDate {
      constructor(...values: unknown[]) {
        if (values.length === 0) {
          super(-8.64e15);
        } else {
          super(...(values as [number]));
        }
      }
    }
    globalThis.Date = EarliestDate as DateConstructor;
    try {
      assert.throws(
        () => rangeStart({ value: 1, unit: 'm' }),
        (error) => isSyncError(error, 'E_PLAN_INVALID') && error.message === 'The time range 1m starts before any date this computer can tell.',
      );
    } finally {
      globalThis.Date = SystemDate;
    }
  });
});

describe('fileChangedSince', () => {
  let temp: ReturnType<typeof tempDir>;
  let older: string;
  let newer: string;
  let copied: string;
  let since: Date;
  /** False where the file system gives no creation time of its own. */
  let keepsCreation = true;

  before(async () => {
    temp = tempDir();
    older = path.join(temp.dir, 'about.html');
    newer = path.join(temp.dir, 'index.html');
    copied = path.join(temp.dir, 'hero.svg');
    writeFileSync(older, '<h1>About</h1>');
    await wait(50);
    since = new Date();
    await wait(50);
    writeFileSync(newer, '<h1>Home</h1>');
    // A file copied into the folder keeps the modification time it came with.
    writeFileSync(copied, '<svg/>');
    const years = new Date(Date.UTC(2020, 0, 1));
    utimesSync(copied, years, years);
    keepsCreation = statSync(copied).birthtimeMs >= since.getTime();
  });

  after(() => {
    temp.cleanup();
  });

  test('a file written after the moment has changed since', async () => {
    assert.equal(await fileChangedSince(newer, since), true);
  });

  test('a file created after the moment counts, however old its modification time', async (t) => {
    if (!keepsCreation) {
      t.skip('this file system keeps no creation time');
      return;
    }
    assert.ok(statSync(copied).mtimeMs < since.getTime());
    assert.equal(await fileChangedSince(copied, since), true);
  });

  test('a file written before the moment has not', async () => {
    assert.equal(await fileChangedSince(older, since), false);
  });

  test('a file changed at the very moment counts', async () => {
    assert.equal(await fileChangedSince(older, statSync(older).mtime), true);
  });

  test('a path that does not exist has not changed', async () => {
    assert.equal(await fileChangedSince(path.join(temp.dir, 'missing.html'), since), false);
    assert.equal(await fileChangedSince(path.join(temp.dir, 'missing', 'index.html'), new Date(0)), false);
  });
});

describe('the sentences of a time range', () => {
  test('one of a unit is the unit alone, and more are counted', () => {
    assert.equal(rangeWords({ value: 1, unit: 'm' }), 'minute');
    assert.equal(rangeWords({ value: 1, unit: 'h' }), 'hour');
    assert.equal(rangeWords({ value: 1, unit: 'd' }), 'day');
    assert.equal(rangeWords({ value: 1, unit: 'w' }), 'week');
    assert.equal(rangeWords({ value: 90, unit: 'm' }), '90 minutes');
    assert.equal(rangeWords({ value: 1.5, unit: 'h' }), '1.5 hours');
    assert.equal(rangeWords({ value: 2, unit: 'd' }), '2 days');
    assert.equal(rangeWords({ value: 0.5, unit: 'w' }), '0.5 weeks');
  });

  test('the title of a preview names the range', () => {
    assert.equal(rangeTitle({ value: 1, unit: 'd' }), 'Put files from the last day');
    assert.equal(rangeTitle({ value: 2, unit: 'd' }), 'Put files from the last 2 days');
    assert.equal(rangeTitle({ value: 90, unit: 'm' }), 'Put files from the last 90 minutes');
  });

  test('a site without a recent file is told so', () => {
    assert.equal(noRecentFiles({ value: 1, unit: 'w' }, 'My Site'), 'No file of "My Site" was created or modified in the last week.');
    assert.equal(noRecentFiles({ value: 2, unit: 'd' }, 'My Site'), 'No file of "My Site" was created or modified in the last 2 days.');
  });

  test('the label and the shared text read the same for every front end', () => {
    assert.equal(RANGE_TITLE, 'Put files from a time range');
    assert.equal(RANGE_TEXT.format, 'a number and a unit: m for minutes, h for hours, d for days or w for weeks, such as 90m, 24h, 2d or 1w');
    assert.equal(RANGE_TEXT.question, 'Put files created or modified in the last');
  });
});
