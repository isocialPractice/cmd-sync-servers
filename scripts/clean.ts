// Removes the build folders named on the command line. Refuses any path
// outside the current folder.
import { rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';

const root = process.cwd();
for (const name of process.argv.slice(2)) {
  const target = resolve(root, name);
  if (!target.startsWith(root + sep)) {
    process.stderr.write(`clean: refusing to remove ${JSON.stringify(name)}: outside ${root}\n`);
    process.exit(2);
  }
  rmSync(target, { recursive: true, force: true });
}
