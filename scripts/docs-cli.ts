// Rewrites the command reference in docs/cli.html from the command
// definitions. test/docs fails when the page is out of date.
import { readFileSync, writeFileSync } from 'node:fs';
import { commandReference, replaceGenerated } from './lib/cli-reference.ts';

const file = 'docs/cli.html';
const page = readFileSync(file, 'utf8');
const updated = replaceGenerated(page, commandReference());
if (updated === page) {
  process.stdout.write(`${file} is up to date.\n`);
} else {
  writeFileSync(file, updated);
  process.stdout.write(`Updated the command reference in ${file}.\n`);
}
