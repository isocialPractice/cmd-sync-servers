import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandHelp, commandSignature, globalHelp } from '../../../src/cli/help.ts';
import { COMMANDS, GLOBAL_OPTIONS } from '../../../src/cli/router.ts';
import { VERSION } from '../../../src/version.ts';

const help = globalHelp(COMMANDS, GLOBAL_OPTIONS, 'linux');

test('help names the program and its version', () => {
  assert.ok(help.startsWith(`sync-servers ${VERSION}\n`));
});

test('help lists every command and every global option', () => {
  for (const command of COMMANDS) {
    assert.ok(help.includes(`  ${commandSignature(command)}  `), `help does not list ${commandSignature(command)}`);
  }
  for (const option of ['--site', '--server', '--config-dir', '--state-dir', '--json', '--plain', '--ascii', '--no-color', '--debug', '--cd-file', '--version', '-h, --help']) {
    assert.ok(help.includes(option), `help does not mention ${option}`);
  }
});

test('help carries a usage line and examples', () => {
  assert.match(help, /^Usage:\n {2}sync-servers /m);
  assert.match(help, /^Examples:\n {2}sync-servers /m);
});

test('every command has help with its options and an example', () => {
  for (const command of COMMANDS) {
    const text = commandHelp(command, GLOBAL_OPTIONS, 'linux');
    assert.match(text, new RegExp(`^ {2}sync-servers ${command.path.join(' ')}`, 'm'));
    assert.ok(command.examples.length > 0, `${command.path.join(' ')} has no example`);
    for (const name of Object.keys(command.options ?? {})) {
      assert.ok(text.includes(`--${name}`), `${command.path.join(' ')} help does not mention --${name}`);
    }
  }
});

test('examples use placeholder data and a path that fits the platform', () => {
  assert.ok(help.includes('--local-root ~/sites/my-site'));
  assert.ok(globalHelp(COMMANDS, GLOBAL_OPTIONS, 'win32').includes('--local-root C:\\Users\\<user>\\Sites\\my-site'));
  const all = [help, ...COMMANDS.map((command) => commandHelp(command, GLOBAL_OPTIONS, 'linux'))].join('\n');
  const emails = all.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? [];
  assert.deepEqual(emails.filter((email) => !/@(?:[\w-]+\.)*example\.(?:com|org|net)$/.test(email)), []);
  const hosts = all.match(/\b[\w-]+(?:\.[\w-]+)*\.(?:com|org|net|io)\b/g) ?? [];
  assert.deepEqual(hosts.filter((host) => !/(?:^|\.)example\.(?:com|org|net)$/.test(host)), []);
});
