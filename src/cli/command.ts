import type { CommandContext } from './context.ts';
import { UsageError } from './errors.ts';
import type { ExitCode } from './exit-codes.ts';

export interface OptionSpec {
  readonly type: 'string' | 'boolean';
  readonly short?: string;
  /** The value placeholder shown in help, such as `<name>`. */
  readonly value?: string;
  /** How help shows the option, when not `--<name>`, such as `--no-color`. */
  readonly display?: string;
  readonly description: string;
}

export type OptionSpecs = Readonly<Record<string, OptionSpec>>;

export type OptionValues = Readonly<Record<string, string | boolean | (string | boolean)[] | undefined>>;

export interface ParsedCommand {
  readonly values: OptionValues;
  /** Positional arguments after the command words. */
  readonly args: readonly string[];
}

export interface CommandSpec {
  /** The command words, such as `['site', 'add']`. */
  readonly path: readonly string[];
  /** Positional arguments for help, such as `[<site>]`. */
  readonly args?: string;
  readonly minArgs?: number;
  readonly maxArgs?: number;
  readonly summary: string;
  readonly options?: OptionSpecs;
  /** Every example uses placeholder names. */
  readonly examples: readonly string[];
  run(ctx: CommandContext, parsed: ParsedCommand): Promise<ExitCode | undefined>;
}

export function stringOption(values: OptionValues, name: string): string | undefined {
  const value = values[name];
  return typeof value === 'string' ? value : undefined;
}

export function booleanOption(values: OptionValues, name: string): boolean | undefined {
  const value = values[name];
  return typeof value === 'boolean' ? value : undefined;
}

export function flag(values: OptionValues, name: string): boolean {
  return values[name] === true;
}

/** Parses a whole number option within a range, or throws a usage error naming the option. */
export function integerOption(values: OptionValues, name: string, min: number, max: number): number | undefined {
  const text = stringOption(values, name);
  if (text === undefined) {
    return undefined;
  }
  const value = Number(text);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new UsageError(`--${name} must be a whole number from ${String(min)} to ${String(max)}.`);
  }
  return value;
}

/** Checks a string option against a list of allowed values. */
export function choiceOption<T extends string>(values: OptionValues, name: string, choices: readonly T[]): T | undefined {
  const text = stringOption(values, name);
  if (text === undefined) {
    return undefined;
  }
  if (!(choices as readonly string[]).includes(text)) {
    throw new UsageError(`--${name} must be one of: ${choices.join(', ')}.`);
  }
  return text as T;
}
