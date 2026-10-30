// Fails when coverage falls below the bar: every branch of the path-safety
// and classification modules, and 85 % of the engine's lines.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { checkCoverage, parseLcov } from './lib/coverage.ts';

const file = process.argv[2] ?? 'coverage/lcov.info';
const report = parseLcov(readFileSync(file, 'utf8'), process.cwd());
const problems = checkCoverage(report, {
  fullBranches: ['src/sync/paths.ts', 'src/sync/classify.ts'],
  minimumLines: 0.85,
  include: 'src/',
});
const lines = report.reduce((sum, entry) => sum + entry.linesHit, 0) / Math.max(1, report.reduce((sum, entry) => sum + entry.linesFound, 0));
process.stdout.write(`coverage: ${(lines * 100).toFixed(1)} % of lines in ${String(report.length)} files (${path.relative(process.cwd(), file)})\n`);
if (problems.length > 0) {
  for (const problem of problems) {
    process.stderr.write(`coverage: ${problem}\n`);
  }
  process.exit(1);
}
