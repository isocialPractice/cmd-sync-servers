import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { checkCoverage, parseLcov } from '../../../scripts/lib/coverage.ts';

const root = path.resolve('/repo');
const lcov = [
  `SF:${path.join(root, 'src', 'sync', 'paths.ts')}`,
  'BRDA:10,0,0,1',
  'BRDA:12,0,1,0',
  'BRF:2',
  'BRH:1',
  'LF:10',
  'LH:9',
  'end_of_record',
  `SF:${path.join(root, 'src', 'other.ts')}`,
  'BRF:0',
  'BRH:0',
  'LF:10',
  'LH:6',
  'end_of_record',
  '',
].join('\n');

test('parseLcov reads files, lines, branches and the lines of missed branches', () => {
  assert.deepEqual(parseLcov(lcov, root), [
    { file: 'src/sync/paths.ts', linesFound: 10, linesHit: 9, branchesFound: 2, branchesHit: 1, missedBranchLines: [12] },
    { file: 'src/other.ts', linesFound: 10, linesHit: 6, branchesFound: 0, branchesHit: 0, missedBranchLines: [] },
  ]);
});

test('checkCoverage names each shortfall', () => {
  const report = parseLcov(lcov, root);
  assert.deepEqual(checkCoverage(report, { fullBranches: ['src/sync/paths.ts', 'src/sync/classify.ts'], minimumLines: 0.85, include: 'src/' }), [
    'src/sync/paths.ts: 1 of 2 branches covered; missed on line(s) 12',
    'src/sync/classify.ts is not in the report',
    '75.0 % of lines covered in src/; the bar is 85 %',
  ]);
  assert.deepEqual(checkCoverage(report, { fullBranches: [], minimumLines: 0.7, include: 'src/' }), []);
});
