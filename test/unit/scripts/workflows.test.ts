// The rules every GitHub Actions workflow of this repository follows, checked
// line by line so a careless edit fails CI instead of weakening the pipeline.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const dir = new URL('../../../.github/workflows/', import.meta.url);
const workflows = readdirSync(dir)
  .filter((name) => name.endsWith('.yml'))
  .map((name) => ({ name, lines: readFileSync(new URL(name, dir), 'utf8').split(/\r?\n/) }));

function indent(line: string): number {
  return line.length - line.trimStart().length;
}

test('there are workflows to check', () => {
  assert.deepEqual(workflows.map((workflow) => workflow.name).sort(), [
    'ci.yml',
    'codeql.yml',
    'dependency-review.yml',
    'pages.yml',
    'release.yml',
    'scorecard.yml',
  ]);
});

for (const { name, lines } of workflows) {
  test(`${name} grants nothing by default and never runs on pull_request_target`, () => {
    assert.ok(lines.includes('permissions: {}'), 'top-level permissions: {}');
    assert.ok(!lines.some((line) => line.includes('pull_request_target')));
    assert.ok(!lines.some((line) => /permissions:\s*write-all|:\s*write-all/.test(line)));
  });

  test(`${name} pins every action to a full commit with its version in a comment`, () => {
    for (const line of lines.filter((candidate) => /^\s*(?:-\s+)?uses:/.test(candidate))) {
      assert.match(line, /uses: [\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+(?:\.\d+){0,2}$/, line.trim());
    }
  });

  test(`${name} checks out without keeping credentials`, () => {
    lines.forEach((line, index) => {
      if (/uses: actions\/checkout@/.test(line)) {
        const block = lines.slice(index + 1, index + 6).join('\n');
        assert.match(block, /persist-credentials: false/, `${name}:${String(index + 1)}`);
      }
    });
  });

  test(`${name} passes no expression into a script; values reach run steps through env`, () => {
    lines.forEach((line, index) => {
      const match = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(line);
      if (match === null) {
        return;
      }
      const runIndent = (match[1] ?? '').length;
      const inline = match[2] ?? '';
      assert.ok(!inline.includes('${{'), `${name}:${String(index + 1)}: ${inline}`);
      if (inline === '|' || inline === '>') {
        for (let next = index + 1; next < lines.length; next += 1) {
          const body = lines[next] ?? '';
          if (body.trim() !== '' && indent(body) <= runIndent + 2) {
            break;
          }
          assert.ok(!body.includes('${{'), `${name}:${String(next + 1)}: ${body.trim()}`);
        }
      }
    });
  });
}

test('installs use the lock file and never run dependency scripts', () => {
  for (const { name, lines } of workflows) {
    for (const line of lines.filter((candidate) => /\bnpm (?:ci|install|i)\b/.test(candidate))) {
      assert.match(line, /npm ci --ignore-scripts/, `${name}: ${line.trim()}`);
    }
  }
});

test('only the release workflow can write contents or publish, and only from its own jobs', () => {
  for (const { name, lines } of workflows) {
    const writes = lines.filter((line) => /^\s+(?:contents|packages): write$/.test(line));
    if (name === 'release.yml') {
      assert.equal(writes.length, 1, 'the build job alone writes contents');
    } else {
      assert.deepEqual(writes, [], name);
    }
    if (lines.some((line) => /\bnpm publish\b/.test(line))) {
      assert.equal(name, 'release.yml');
      assert.ok(lines.some((line) => line.trim() === 'environment: npm'), 'publishing needs the npm environment');
      assert.ok(lines.some((line) => line.includes("if: vars.NPM_PUBLISH == 'true'")), 'publishing is switched on by NPM_PUBLISH');
    }
  }
});
