import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { CliIo } from '../../src/cli/io.ts';
import { runCli } from '../../src/cli/router.ts';
import type { CredentialStore } from '../../src/credentials/types.ts';

/** A temp folder removed by `cleanup()`. */
export function tempDir(prefix = 'sync-servers-test-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return {
    dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export class Capture {
  text = '';
  readonly isTTY = false;
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

export interface FakeIoOptions {
  readonly home: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Everything typed or piped in; the stream ends after it. */
  readonly input?: string;
  readonly tty?: boolean;
  readonly credentialStore?: CredentialStore;
}

/** The process environment without any sync-servers setting, plus `SYNC_SERVERS_HOME` and the keyring off. */
export function testEnv(home: string, extra: Readonly<Record<string, string | undefined>> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('SYNC_SERVERS_') && !['VISUAL', 'EDITOR', 'NO_COLOR'].includes(key)) {
      env[key] = value;
    }
  }
  return { ...env, SYNC_SERVERS_HOME: home, SYNC_SERVERS_KEYRING: 'off', ...extra };
}

export function fakeIo(options: FakeIoOptions): { io: CliIo; stdout: Capture; stderr: Capture } {
  const stdout = new Capture();
  const stderr = new Capture();
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean };
  if (options.tty === true) {
    stdin.isTTY = true;
  }
  stdin.end(options.input ?? '');
  return {
    stdout,
    stderr,
    io: {
      stdin,
      stdout,
      stderr,
      env: testEnv(options.home, options.env),
      cwd: options.cwd ?? options.home,
      platform: process.platform,
      homedir: options.home,
      credentialStore: options.credentialStore,
    },
  };
}

/** Runs the CLI in this process. */
export async function cli(
  options: FakeIoOptions,
  ...argv: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { io, stdout, stderr } = fakeIo(options);
  const code = await runCli(argv, io);
  return { code, stdout: stdout.text, stderr: stderr.text };
}

/** Creates `<root>/<name>` and returns it. */
export function makeFolder(root: string, ...parts: string[]): string {
  const dir = path.join(root, ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Every file under `dir` whose content contains `needle`. Links and
 * junctions are not followed, so a link back into the folder cannot loop; a
 * file a link reaches inside `dir` is searched where it is.
 */
export function filesContaining(dir: string, needle: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir, { encoding: 'utf8' })) {
    const file = path.join(dir, name);
    const info = lstatSync(file);
    if (info.isDirectory()) {
      found.push(...filesContaining(file, needle));
    } else if (info.isFile() && readFileSync(file).includes(needle)) {
      found.push(file);
    }
  }
  return found;
}
