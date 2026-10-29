import { VERSION } from '../version.ts';

/** The text printed by `sync-servers --help`. */
export function helpText(): string {
  return [
    `sync-servers ${VERSION}`,
    'Synchronize a local site folder with its servers.',
    '',
    'Usage:',
    '  sync-servers [options]',
    '',
    'Options:',
    '  --version   Print the version and exit',
    '  -h, --help  Print this help and exit',
    '',
    'Example:',
    '  sync-servers --version',
    '',
  ].join('\n');
}
