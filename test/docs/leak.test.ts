// The leak scan: public files must hold placeholder data only. It reads the
// project documents, the docs site, every source and test file, the help
// output and the workflows, and fails on an email address outside the
// example domains, a user profile path naming anyone but <user>, an IPv4
// address outside loopback and the documentation ranges, and every entry of
// the git-ignored .claude/leak-denylist.txt when this machine has one.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { commandHelp, globalHelp } from '../../src/cli/help.ts';
import { COMMANDS, GLOBAL_OPTIONS } from '../../src/cli/router.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

const FOLDERS = ['docs', 'src', 'test', 'scripts', 'schema', 'sandbox', '.github/workflows'];
const FILES = ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'DESIGN_LANGUAGE.md', 'THIRD_PARTY_NOTICES.md', 'TODO.md', 'package.json', 'typedoc.json'];
const TEXT = /\.(?:ts|js|mjs|json|md|html|css|txt|ya?ml|sh|cmd|bat)$|Dockerfile$/;

function walk(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((name) => path.join(dir, name))
    .filter((file) => statSync(file).isFile() && TEXT.test(file));
}

function sources(): { name: string; text: string }[] {
  const files = [...FILES.map((name) => path.join(root, name)).filter((file) => existsSync(file)), ...FOLDERS.flatMap((folder) => walk(path.join(root, folder)))];
  const help = ['linux', 'win32'].flatMap((platform) => [
    globalHelp(COMMANDS, GLOBAL_OPTIONS, platform as NodeJS.Platform),
    ...COMMANDS.map((command) => commandHelp(command, GLOBAL_OPTIONS, platform as NodeJS.Platform)),
  ]);
  // Pages are read as a browser shows them, so &lt;user&gt; is <user>.
  const decode = (text: string): string => text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  return [
    ...files.map((file) => ({ name: path.relative(root, file), text: decode(readFileSync(file, 'utf8')) })),
    { name: '(help output)', text: help.join('\n') },
  ];
}

const SOURCES = sources();

function findings(pattern: RegExp, allowed: (match: RegExpMatchArray, text: string) => boolean): string[] {
  const found: string[] = [];
  for (const { name, text } of SOURCES) {
    for (const match of text.matchAll(pattern)) {
      if (!allowed(match, text)) {
        found.push(`${name}: ${match[0]}`);
      }
    }
  }
  return found;
}

/** SSH algorithm and extension names look like email addresses. */
const NAMESPACES = new Set(['openssh.com', 'libssh.org']);

test('email addresses use example domains only', () => {
  const found = findings(/[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g, (match) => {
    const domain = (match[1] ?? '').toLowerCase();
    return /(?:^|\.)example\.(?:com|org|net)$/.test(domain) || NAMESPACES.has(domain);
  });
  assert.deepEqual(found, []);
});

test('user profile paths name no one but <user>', () => {
  const found = findings(/(?:[A-Za-z]:\\{1,2}Users\\{1,2}|\/Users\/|\/home\/)([^\\/\s"'`,;)]+)/g, (match) => {
    const name = match[1] ?? '';
    // A variable such as ${user}, $SANDBOX_USER or %USERNAME% is filled in at run time.
    return name === '<user>' || /^(?:\$|%)/.test(name);
  });
  assert.deepEqual(found, []);
});

function allowedAddress(octets: number[]): boolean {
  const [a, b, c] = octets;
  return (
    a === 127 ||
    octets.every((octet) => octet === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

test('IPv4 addresses are loopback or documentation addresses only', () => {
  const found = findings(/(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g, (match, text) => {
    const octets = match.slice(1, 5).map(Number);
    if (octets.some((octet) => octet > 255)) {
      return true;
    }
    // Certificate object identifiers, written objectId('...'), are not addresses.
    const before = text.slice(Math.max(0, (match.index ?? 0) - 10), match.index);
    return allowedAddress(octets) || before.endsWith("objectId('");
  });
  assert.deepEqual(found, []);
});

test('nothing on the local denylist appears', (context) => {
  const file = path.join(root, '.claude', 'leak-denylist.txt');
  if (!existsSync(file)) {
    context.skip('no .claude/leak-denylist.txt on this machine');
    return;
  }
  const entries = readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.toLowerCase());
  const found: string[] = [];
  for (const { name, text } of SOURCES) {
    const lower = text.toLowerCase();
    for (const entry of entries) {
      if (lower.includes(entry)) {
        // The entry itself is never printed: it is private by definition.
        found.push(`${name}: denylist entry ${String(entries.indexOf(entry) + 1)}`);
      }
    }
  }
  assert.deepEqual(found, []);
});
