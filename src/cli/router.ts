import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { isSyncError } from '../errors.ts';
import { VERSION } from '../version.ts';
import { stringOption, type CommandSpec, type OptionSpecs, type OptionValues } from './command.ts';
import { cloakCommand, uncloakCommand } from './commands/cloak.ts';
import { configPathCommand, doctorCommand } from './commands/config.ts';
import { passwordForgetCommand, passwordSetCommand } from './commands/password.ts';
import {
  serverAddCommand,
  serverEditCommand,
  serverListCommand,
  serverRemoveCommand,
  serverSetRemoteCommand,
  serverSetTestingCommand,
} from './commands/server.ts';
import { folderProblem } from './commands/shared.ts';
import { shellInitCommand } from './commands/shell.ts';
import { siteAddCommand, siteEditCommand, sitePathCommand, siteRemoveCommand, siteShowCommand, sitesCommand } from './commands/site.ts';
import { CommandContext, type GlobalFlags } from './context.ts';
import { CancelledError, exitCodeFor, UsageError } from './errors.ts';
import { ExitCode } from './exit-codes.ts';
import { commandHelp, commandSignature, globalHelp } from './help.ts';
import type { CliIo } from './io.ts';
import { jsonDocument } from './output.ts';

export const GLOBAL_OPTIONS: OptionSpecs = {
  site: { type: 'string', value: '<name>', description: 'The site to work on, by name or id' },
  server: { type: 'string', value: '<name>', description: 'The server to work on, by name or id' },
  'config-dir': { type: 'string', value: '<folder>', description: 'Use this settings folder' },
  'state-dir': { type: 'string', value: '<folder>', description: 'Use this state folder' },
  json: { type: 'boolean', description: 'Write one JSON document to stdout' },
  plain: { type: 'boolean', description: 'Use numbered line prompts, never a full-screen interface' },
  ascii: { type: 'boolean', description: 'Use ASCII symbols only' },
  color: { type: 'boolean', display: '--no-color', description: 'Turn colour off (NO_COLOR does too)' },
  debug: { type: 'boolean', description: 'Also log details to stderr, with secrets removed' },
  'cd-file': { type: 'string', value: '<file>', description: 'Write the chosen site folder here, for shell integration' },
  version: { type: 'boolean', description: 'Print the version and exit' },
  help: { type: 'boolean', short: 'h', description: 'Print help and exit' },
};

const helpCommand: CommandSpec = {
  path: ['help'],
  args: '[<command>]',
  summary: 'Show help for a command',
  examples: ['sync-servers help server add'],
  run(ctx, { args }) {
    const command = matchCommand(args);
    ctx.out(
      command === undefined || command === helpCommand
        ? globalHelp(COMMANDS, GLOBAL_OPTIONS, ctx.io.platform)
        : commandHelp(command, GLOBAL_OPTIONS, ctx.io.platform),
    );
    return Promise.resolve(undefined);
  },
};

/** Every command, in the order `--help` lists them. */
export const COMMANDS: readonly CommandSpec[] = [
  sitesCommand,
  siteAddCommand,
  siteEditCommand,
  siteShowCommand,
  siteRemoveCommand,
  sitePathCommand,
  serverListCommand,
  serverAddCommand,
  serverEditCommand,
  serverRemoveCommand,
  serverSetRemoteCommand,
  serverSetTestingCommand,
  passwordSetCommand,
  passwordForgetCommand,
  cloakCommand,
  uncloakCommand,
  configPathCommand,
  doctorCommand,
  shellInitCommand,
  helpCommand,
];

function matchCommand(words: readonly string[]): CommandSpec | undefined {
  return [...COMMANDS]
    .sort((a, b) => b.path.length - a.path.length)
    .find((command) => command.path.every((word, index) => words[index] === word));
}

function parseConfig(specs: OptionSpecs): ParseArgsOptionsConfig {
  return Object.fromEntries(
    Object.entries(specs).map(([name, spec]) => [
      name,
      spec.short === undefined ? { type: spec.type } : { type: spec.type, short: spec.short },
    ]),
  );
}

/** Every option of every command, to find the command words before the strict parse. */
function allOptions(): OptionSpecs {
  return Object.assign({}, GLOBAL_OPTIONS, ...COMMANDS.map((command) => command.options ?? {})) as OptionSpecs;
}

function usageFailure(io: CliIo, message: string, command?: CommandSpec): ExitCode {
  const help = command === undefined ? 'sync-servers --help' : `sync-servers ${command.path.join(' ')} --help`;
  io.stderr.write(`sync-servers: ${message}\nRun "${help}" for usage.\n`);
  return ExitCode.usage;
}

function globalFlags(values: OptionValues): GlobalFlags {
  const bool = (name: string): boolean | undefined => (typeof values[name] === 'boolean' ? values[name] : undefined);
  return {
    site: stringOption(values, 'site'),
    server: stringOption(values, 'server'),
    configDir: stringOption(values, 'config-dir'),
    stateDir: stringOption(values, 'state-dir'),
    json: bool('json') === true,
    plain: bool('plain') === true,
    ascii: bool('ascii'),
    color: bool('color'),
    debug: bool('debug') === true,
    cdFile: stringOption(values, 'cd-file'),
  };
}

/**
 * Writes the chosen site folder to `--cd-file` for the shell function of
 * `sync-servers shell-init`: only an absolute path of an existing folder that
 * is a configured site's local root, with no trailing newline.
 */
async function writeCdFile(ctx: CommandContext): Promise<void> {
  const target = ctx.cdTarget;
  const file = ctx.flags.cdFile;
  if (target === undefined || file === undefined) {
    return;
  }
  const sites = (await ctx.registry()).list();
  const problem =
    !path.isAbsolute(target) || /[\r\n\0]/.test(target)
      ? 'not an absolute path'
      : (folderProblem(target) ?? (sites.some((site) => site.localRoot === target) ? undefined : 'not a site folder'));
  if (problem !== undefined) {
    ctx.err(`warning: not changing folder: ${problem}\n`);
    return;
  }
  await writeFile(path.resolve(ctx.io.cwd, file), target, 'utf8');
}

function errorCode(error: unknown): string {
  if (isSyncError(error)) {
    return error.code;
  }
  if (error instanceof UsageError) {
    return 'E_USAGE';
  }
  return error instanceof CancelledError ? 'E_CANCELLED' : 'E_ERROR';
}

function report(ctx: CommandContext, command: CommandSpec, error: unknown): void {
  const redact = (text: string): string => ctx.logger.redactor.redact(text);
  const message = redact(error instanceof Error ? error.message : String(error));
  ctx.logger.error(message, { code: errorCode(error) });
  if (ctx.flags.json) {
    ctx.out(jsonDocument('error', { error: { code: errorCode(error), message } }));
  }
  if (error instanceof UsageError) {
    ctx.err(`sync-servers: ${message}\nRun "sync-servers ${command.path.join(' ')} --help" for usage.\n`);
  } else if (error instanceof CancelledError) {
    ctx.err(`${message}\n`);
  } else {
    ctx.err(`sync-servers: ${message}\n`);
    if (ctx.flags.debug && error instanceof Error && error.stack !== undefined) {
      ctx.err(`${redact(error.stack)}\n`);
    }
  }
}

/** Runs one `sync-servers` invocation and resolves its exit code. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<ExitCode> {
  let words: string[];
  try {
    words = parseArgs({
      args: [...argv],
      options: parseConfig(allOptions()),
      strict: false,
      allowPositionals: true,
      allowNegative: true,
    }).positionals;
  } catch (error) {
    return usageFailure(io, error instanceof Error ? error.message : String(error));
  }

  const command = matchCommand(words);
  if (command === undefined && words.length > 0) {
    const known = COMMANDS.some((candidate) => candidate.path[0] === words[0]);
    const shown = known ? words.slice(0, 2).join(' ') : (words[0] ?? '');
    return usageFailure(io, `unknown command ${JSON.stringify(shown)}.`);
  }

  const specs: OptionSpecs = { ...GLOBAL_OPTIONS, ...(command?.options ?? {}) };
  let values: OptionValues;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: [...argv],
      options: parseConfig(specs),
      strict: true,
      allowPositionals: true,
      allowNegative: true,
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (error) {
    return usageFailure(io, error instanceof Error ? error.message : String(error), command);
  }

  if (values.help === true) {
    io.stdout.write(
      command === undefined || command === helpCommand
        ? globalHelp(COMMANDS, GLOBAL_OPTIONS, io.platform)
        : commandHelp(command, GLOBAL_OPTIONS, io.platform),
    );
    return ExitCode.ok;
  }
  if (values.version === true) {
    io.stdout.write(`${VERSION}\n`);
    return ExitCode.ok;
  }
  if (command === undefined) {
    io.stdout.write(globalHelp(COMMANDS, GLOBAL_OPTIONS, io.platform));
    return ExitCode.ok;
  }

  const args = positionals.slice(command.path.length);
  if (args.length < (command.minArgs ?? 0) || args.length > (command.maxArgs ?? Number.POSITIVE_INFINITY)) {
    return usageFailure(io, `expected: sync-servers ${commandSignature(command)}`, command);
  }

  const ctx = new CommandContext(io, globalFlags(values));
  try {
    const code = (await command.run(ctx, { values, args })) ?? ExitCode.ok;
    await writeCdFile(ctx);
    return code;
  } catch (error) {
    report(ctx, command, error);
    return exitCodeFor(error);
  } finally {
    ctx.close();
  }
}
