import { homedir } from 'node:os';
import type { CredentialStore } from '../credentials/types.ts';

export interface CliOutput {
  write(text: string): unknown;
  readonly isTTY?: boolean | undefined;
  readonly columns?: number | undefined;
}

export interface CliInput {
  readonly isTTY?: boolean | undefined;
  setRawMode?(mode: boolean): unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  off(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  off(event: 'end', listener: () => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/** Everything the CLI takes from its process, injected in tests. */
export interface CliIo {
  readonly stdin: CliInput;
  readonly stdout: CliOutput;
  readonly stderr: CliOutput;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  /** A credential store to use instead of the OS one, when embedding the CLI or testing it. */
  readonly credentialStore?: CredentialStore | undefined;
  /** Aborted when the person cancels, as with Ctrl+C. */
  readonly signal?: AbortSignal | undefined;
}

export function processIo(): CliIo {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
    homedir: homedir(),
  };
}
