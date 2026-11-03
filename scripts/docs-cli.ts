// Rewrites the command reference in docs/cli.html and the option index in
// docs/options.html from the command definitions. test/docs fails when
// either page is out of date.
import { readFileSync, writeFileSync } from 'node:fs';
import { commandReference, optionIndex, replaceGenerated } from './lib/cli-reference.ts';

const pages = [
  ['docs/cli.html', commandReference(), 'command reference'],
  ['docs/options.html', optionIndex(), 'option index'],
] as const;

for (const [file, section, what] of pages) {
  const page = readFileSync(file, 'utf8');
  const updated = replaceGenerated(page, section, file);
  if (updated === page) {
    process.stdout.write(`${file} is up to date.\n`);
  } else {
    writeFileSync(file, updated);
    process.stdout.write(`Updated the ${what} in ${file}.\n`);
  }
}
