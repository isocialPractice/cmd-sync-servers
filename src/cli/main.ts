#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { VERSION } from '../version.ts';
import { ExitCode } from './exit-codes.ts';
import { helpText } from './help.ts';

function usageError(message: string): ExitCode {
  process.stderr.write(`sync-servers: ${message}\nRun "sync-servers --help" for usage.\n`);
  return ExitCode.usage;
}

function run(argv: string[]): ExitCode {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        version: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }

  if (parsed.values.help === true) {
    process.stdout.write(helpText());
    return ExitCode.ok;
  }
  if (parsed.values.version === true) {
    process.stdout.write(`${VERSION}\n`);
    return ExitCode.ok;
  }
  const [command] = parsed.positionals;
  if (command !== undefined) {
    return usageError(`unknown command ${JSON.stringify(command)}.`);
  }
  process.stdout.write(helpText());
  return ExitCode.ok;
}

process.exitCode = run(process.argv.slice(2));
