// Reads an lcov report and checks it against the coverage bar.
import path from 'node:path';

export interface FileCoverage {
  /** Repository-relative, `/`-separated. */
  readonly file: string;
  readonly linesFound: number;
  readonly linesHit: number;
  readonly branchesFound: number;
  readonly branchesHit: number;
  /** Lines with a branch that never ran. */
  readonly missedBranchLines: readonly number[];
}

export function parseLcov(text: string, root: string): FileCoverage[] {
  const files: FileCoverage[] = [];
  for (const block of text.split('end_of_record')) {
    const lines = block.split(/\r?\n/);
    const value = (key: string): number => Number(lines.find((line) => line.startsWith(`${key}:`))?.slice(key.length + 1) ?? 0);
    const source = lines.find((line) => line.startsWith('SF:'))?.slice(3);
    if (source === undefined) {
      continue;
    }
    const missed = lines
      .filter((line) => line.startsWith('BRDA:'))
      .map((line) => line.slice(5).split(','))
      .filter((parts) => parts[3] === '0' || parts[3] === '-')
      .map((parts) => Number(parts[0]));
    files.push({
      file: path.relative(root, path.resolve(root, source)).split(path.sep).join('/'),
      linesFound: value('LF'),
      linesHit: value('LH'),
      branchesFound: value('BRF'),
      branchesHit: value('BRH'),
      missedBranchLines: [...new Set(missed)].sort((a, b) => a - b),
    });
  }
  return files;
}

export interface CoverageBar {
  /** Files that must have every branch covered. */
  readonly fullBranches: readonly string[];
  /** The share of lines, 0 to 1, that must run across `include`. */
  readonly minimumLines: number;
  readonly include: string;
}

/** One message per way the report falls short; empty when it meets the bar. */
export function checkCoverage(report: readonly FileCoverage[], bar: CoverageBar): string[] {
  const problems: string[] = [];
  for (const required of bar.fullBranches) {
    const entry = report.find((item) => item.file === required);
    if (entry === undefined) {
      problems.push(`${required} is not in the report`);
    } else if (entry.branchesHit < entry.branchesFound) {
      problems.push(
        `${required}: ${String(entry.branchesHit)} of ${String(entry.branchesFound)} branches covered; missed on line(s) ${entry.missedBranchLines.join(', ')}`,
      );
    }
  }
  const included = report.filter((entry) => entry.file.startsWith(bar.include));
  const found = included.reduce((sum, entry) => sum + entry.linesFound, 0);
  const hit = included.reduce((sum, entry) => sum + entry.linesHit, 0);
  if (found > 0 && hit / found < bar.minimumLines) {
    problems.push(`${(100 * hit / found).toFixed(1)} % of lines covered in ${bar.include}; the bar is ${String(bar.minimumLines * 100)} %`);
  }
  return problems;
}
