import { VERSION } from '../version.ts';
import type { CommandSpec, OptionSpec, OptionSpecs } from './command.ts';
import { exampleRoot } from './commands/shared.ts';

function optionLabel(name: string, spec: OptionSpec): string {
  const long = spec.display ?? `--${name}`;
  const withValue = spec.value === undefined ? long : `${long} ${spec.value}`;
  return spec.short === undefined ? withValue : `-${spec.short}, ${withValue}`;
}

function columns(rows: readonly (readonly [string, string])[]): string[] {
  const width = Math.max(0, ...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`.trimEnd());
}

function optionLines(specs: OptionSpecs): string[] {
  return columns(Object.entries(specs).map(([name, spec]) => [optionLabel(name, spec), spec.description]));
}

/** `site edit [<site>]`. */
export function commandSignature(command: CommandSpec): string {
  return [...command.path, ...(command.args === undefined ? [] : [command.args])].join(' ');
}

function examples(list: readonly string[], platform: NodeJS.Platform): string[] {
  return list.map((example) => `  ${example.replaceAll('{root}', exampleRoot(platform))}`);
}

/** The text printed by `sync-servers --help`. */
export function globalHelp(commands: readonly CommandSpec[], globalOptions: OptionSpecs, platform: NodeJS.Platform): string {
  return [
    `sync-servers ${VERSION}`,
    'Synchronize a local site folder with its servers.',
    '',
    'Usage:',
    ...columns([
      ['sync-servers', 'Open the sites in the terminal UI, or numbered prompts with --plain'],
      ['sync-servers <command> [options]', 'Run one command'],
    ]),
    '',
    'Commands:',
    ...columns(commands.map((command) => [commandSignature(command), command.summary])),
    '',
    'Global options:',
    ...optionLines(globalOptions),
    '',
    'Examples:',
    ...examples(
      [
        'sync-servers site add --name "My Site" --local-root {root}',
        'sync-servers server add --name Production --host sftp.example.com --user demo-user --remote-root /var/www/my-site',
        'sync-servers sites',
      ],
      platform,
    ),
    '',
    'Run "sync-servers <command> --help" for the options of a command.',
    '',
  ].join('\n');
}

/** The text printed by `sync-servers <command> --help`. */
export function commandHelp(command: CommandSpec, globalOptions: OptionSpecs, platform: NodeJS.Platform): string {
  const options = command.options ?? {};
  return [
    'Usage:',
    `  sync-servers ${commandSignature(command)}${Object.keys(options).length > 0 ? ' [options]' : ''}`,
    '',
    `${command.summary}.`,
    '',
    ...(Object.keys(options).length > 0 ? ['Options:', ...optionLines(options), ''] : []),
    'Global options:',
    `  ${Object.entries(globalOptions)
      .map(([name, spec]) => spec.display ?? `--${name}`)
      .join(', ')}`,
    '  See "sync-servers --help".',
    '',
    'Examples:',
    ...examples(command.examples, platform),
    '',
  ].join('\n');
}
