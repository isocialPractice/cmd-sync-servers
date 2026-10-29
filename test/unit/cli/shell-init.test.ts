import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findExecutable } from '../../../src/cli/editor.ts';
import { shellInitScript, SHELLS } from '../../../src/cli/shell-init.ts';
import { cli, makeFolder, tempDir, testEnv } from '../../helpers/cli.ts';

// The function scripts run the real CLI from source through a stub named
// sync-servers on PATH, against a temp master list holding one site.
const main = fileURLToPath(new URL('../../../src/cli/main.ts', import.meta.url));
let temp: ReturnType<typeof tempDir>;
let siteRoot: string;
let siteId: string;
let bin: string;

before(async () => {
  temp = tempDir();
  siteRoot = realpathSync(makeFolder(temp.dir, 'sites', 'my-site'));
  const added = await cli({ home: temp.dir }, 'site', 'add', '--name', 'My Site', '--local-root', siteRoot, '--json');
  siteId = (JSON.parse(added.stdout) as { site: { id: string } }).site.id;
  bin = makeFolder(temp.dir, 'bin');
  const stub = path.join(bin, 'sync-servers');
  writeFileSync(stub, `#!/bin/sh\nexec "${process.execPath}" "${main}" "$@"\n`);
  chmodSync(stub, 0o755);
  writeFileSync(path.join(bin, 'sync-servers.cmd'), `@"${process.execPath}" "${main}" %*\r\n`);
});

after(() => {
  temp.cleanup();
});

function shellEnv(): Record<string, string | undefined> {
  const env = testEnv(temp.dir);
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = `${bin}${path.delimiter}${env[pathKey] ?? ''}`;
  return env;
}

/** The working folder a shell reports after running `ssv`, printed by Node so paths compare on every OS. */
const PRINT_CWD = `"${process.execPath}" -e "process.stdout.write(process.cwd())"`;

test('every shell has a script, and each wraps --cd-file', () => {
  for (const shell of SHELLS) {
    const script = shellInitScript(shell);
    assert.ok(script.includes('--cd-file'), `${shell} script does not use --cd-file`);
    assert.ok(/\bssv\b/.test(script), `${shell} script does not define ssv`);
  }
  assert.ok(shellInitScript('cmd').includes('\r\n'));
  assert.ok(!shellInitScript('bash').includes('\r'));
});

test('shell-init prints the script and rejects unknown shells', async () => {
  const printed = await cli({ home: temp.dir }, 'shell-init', 'zsh');
  assert.equal(printed.code, 0);
  assert.equal(printed.stdout, shellInitScript('zsh'));
  const unknown = await cli({ home: temp.dir }, 'shell-init', 'tcsh');
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown shell "tcsh"/);
});

const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
const bash = process.platform === 'win32' ? (existsSync(gitBash) ? gitBash : undefined) : findExecutable('bash', { env: process.env, platform: process.platform });

test('the bash function changes to the chosen site folder', { skip: bash === undefined ? 'bash not found' : false }, () => {
  const script = `${shellInitScript('bash')}\nssv site path ${siteId} >/dev/null || exit 9\n${PRINT_CWD}\n`;
  const result = spawnSync(bash ?? 'bash', ['--noprofile', '--norc', '-c', script], { cwd: temp.dir, env: shellEnv(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(realpathSync(result.stdout), siteRoot);
});

test('the bash function keeps the folder and passes the exit code when nothing is chosen', { skip: bash === undefined ? 'bash not found' : false }, () => {
  const script = `${shellInitScript('bash')}\nssv site path "Sample App" 2>/dev/null; echo "rc=$?"\n${PRINT_CWD}\n`;
  const result = spawnSync(bash ?? 'bash', ['--noprofile', '--norc', '-c', script], { cwd: temp.dir, env: shellEnv(), encoding: 'utf8' });
  assert.match(result.stdout, /^rc=2\n/);
  assert.equal(realpathSync(result.stdout.replace(/^rc=2\n/, '')), realpathSync(temp.dir));
});

const pwsh = findExecutable('pwsh', { env: process.env, platform: process.platform });
const powershell = process.platform === 'win32' ? findExecutable('powershell', { env: process.env, platform: process.platform }) : undefined;

for (const [name, program] of [
  ['pwsh', pwsh],
  ['Windows PowerShell', powershell],
] as const) {
  test(`the PowerShell function changes to the chosen site folder (${name})`, { skip: program === undefined ? `${name} not found` : false }, () => {
    const script = `${shellInitScript('pwsh')}\nssv site path ${siteId} | Out-Null\nif ($LASTEXITCODE -ne 0) { exit 9 }\n[Console]::Out.Write((Get-Location).ProviderPath)\n`;
    const result = spawnSync(program ?? 'pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], {
      cwd: temp.dir,
      env: shellEnv(),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(realpathSync(result.stdout.trim()), siteRoot);
  });
}

test('the cmd batch file changes to the chosen site folder', { skip: process.platform !== 'win32' ? 'Windows only' : false }, () => {
  writeFileSync(path.join(bin, 'ssv.cmd'), shellInitScript('cmd'));
  const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"call ssv.cmd site path ${siteId} >nul && cd"`], {
    cwd: temp.dir,
    env: shellEnv(),
    encoding: 'utf8',
    windowsVerbatimArguments: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(realpathSync(result.stdout.trim()), siteRoot);
});
