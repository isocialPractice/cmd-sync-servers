import timecal from '@jhauga/timecal';
import getfiledate from 'getfiledate';
import { SyncError } from '../errors.ts';
import { RANGE_TEXT } from './messages.ts';

const { calculate, parseArguments } = timecal;
const { getFileDates } = getfiledate;

/**
 * The units of a time range: minutes, hours, days and weeks.
 *
 * @experimental
 */
export type RangeUnit = 'm' | 'h' | 'd' | 'w';

/**
 * A span of time counted back from now, such as two days.
 *
 * @experimental
 */
export interface TimeRange {
  /** How many of the unit: above 0 and at most 100000. */
  readonly value: number;
  /** The unit the value counts. */
  readonly unit: RangeUnit;
}

/**
 * The range a question offers when nothing is typed.
 *
 * @experimental
 */
export const DEFAULT_RANGE = '1d';

const RANGE = /^(\d+(?:\.\d+)?)([mhdw])$/;
const MAX_VALUE = 100_000;

/**
 * Reads a range such as `90m`, `24h`, `2d` or `1w`: a number, with an
 * optional decimal part, and one lower-case unit, with nothing between them.
 * The number is above 0 and at most 100000. `undefined` when the text is not
 * one: a capital unit, another unit, a sign, two expressions, a clock time,
 * a flag, or a number below a millionth.
 *
 * @experimental
 */
export function parseRange(text: string): TimeRange | undefined {
  const match = RANGE.exec(text.trim());
  if (match === null) {
    return undefined;
  }
  const value = Number(match[1]);
  const unit = match[2] as RangeUnit;
  // A number below a millionth is written with an exponent, so the range could not be written back as one.
  if (!(value > 0) || value > MAX_VALUE || !RANGE.test(`${String(value)}${unit}`)) {
    return undefined;
  }
  return { value, unit };
}

/**
 * A range as it is typed: `2d`.
 *
 * @experimental
 */
export function formatRange(range: TimeRange): string {
  return `${String(range.value)}${range.unit}`;
}

/**
 * The moment a range starts: that long before this computer's clock.
 *
 * @throws {@link SyncError} `E_PLAN_INVALID` when `range` is not one
 * {@link parseRange} gives, or its start is not a date.
 *
 * @experimental
 */
export function rangeStart(range: TimeRange): Date {
  // timecal's parser prints its help and ends the process on a help flag, so it is only given text that reads as a range.
  const checked = parseRange(formatRange(range));
  if (checked === undefined) {
    throw new SyncError('E_PLAN_INVALID', `A time range is ${RANGE_TEXT.format}.`);
  }
  const text = formatRange(checked);
  const start: unknown = calculate(parseArguments([text])).date;
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) {
    throw new SyncError('E_PLAN_INVALID', `The time range ${text} starts before any date this computer can tell.`);
  }
  return start;
}

/**
 * True when the file was created or last modified at or after `since`, by
 * the dates the file system keeps for it. A link is judged by the file it
 * leads to. `false` for a file that cannot be read, such as one that is
 * gone.
 *
 * @experimental
 */
export async function fileChangedSince(file: string, since: Date): Promise<boolean> {
  try {
    const { created, modified } = await getFileDates(file);
    return modified.getTime() >= since.getTime() || created.getTime() >= since.getTime();
  } catch {
    return false;
  }
}
