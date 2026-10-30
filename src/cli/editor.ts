import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CancelledError } from './errors.ts';

export interface EditorEnvironment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
}

function nonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

/** Splits an editor setting such as `code --wait` into words, honouring quotes. Backslashes are literal. */
export function splitCommand(text: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let started = false;
  for (const char of text) {
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) {
        words.push(current);
        current = '';
        started = false;
      }
    } else {
      current += char;
      started = true;
    }
  }
  if (started) {
    words.push(current);
  }
  return words;
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Finds a program on `PATH`, trying each `PATHEXT` extension on Windows. */
export function findExecutable(name: string, environment: EditorEnvironment): string | undefined {
  const p = environment.platform === 'win32' ? path.win32 : path.posix;
  const extensions =
    environment.platform === 'win32'
      ? (environment.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext !== '')
      : [];
  const hasExtension = extensions.some((ext) => name.toLowerCase().endsWith(ext.toLowerCase()));
  const variants = environment.platform === 'win32' && !hasExtension ? extensions.map((ext) => name + ext) : [name];
  if (name.includes('/') || (environment.platform === 'win32' && name.includes('\\'))) {
    return variants.find(isFile);
  }
  const dirs = (environment.env.PATH ?? environment.env.Path ?? '').split(environment.platform === 'win32' ? ';' : ':');
  for (const dir of dirs.filter((entry) => entry !== '')) {
    const found = variants.map((variant) => p.join(dir.replace(/^"(.*)"$/, '$1'), variant)).find(isFile);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

interface EditorChoice {
  readonly words: string[];
  readonly source: string;
}

/** The editors to try, first `SYNC_SERVERS_EDITOR`, `VISUAL` and `EDITOR`, then the platform's own. */
export function editorChoices(environment: EditorEnvironment): EditorChoice[] {
  for (const name of ['SYNC_SERVERS_EDITOR', 'VISUAL', 'EDITOR']) {
    const value = environment.env[name];
    if (nonEmpty(value)) {
      return [{ words: splitCommand(value), source: name }];
    }
  }
  const fallbacks = environment.platform === 'win32' ? ['notepad'] : ['nano', 'vi'];
  return fallbacks.map((name) => ({ words: [name], source: 'default' }));
}

/** Characters cmd.exe would interpret even inside quotes. */
const CMD_UNSAFE = /["%^&|<>!\r\n]/;

function runProcess(command: string, args: string[], verbatim: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false, windowsVerbatimArguments: verbatim });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      resolve(code ?? (signal === null ? 1 : 128));
    });
  });
}

/**
 * Opens `file` in the user's editor and waits for it to close. Batch-file
 * editors on Windows (such as `code`) run through `cmd.exe /d /s /c` with
 * every argument quoted; every other editor is spawned with no shell.
 */
export async function runEditor(file: string, environment: EditorEnvironment): Promise<void> {
  const choices = editorChoices(environment);
  for (const choice of choices) {
    const [program, ...args] = choice.words;
    if (program === undefined) {
      continue;
    }
    const resolved = findExecutable(program, environment);
    if (resolved === undefined) {
      if (choice.source !== 'default') {
        throw new Error(`${choice.source} names "${program}", which was not found on PATH.`);
      }
      continue;
    }
    let code: number;
    if (environment.platform === 'win32' && /\.(?:cmd|bat)$/i.test(resolved)) {
      const words = [resolved, ...args, file];
      if (words.some((word) => CMD_UNSAFE.test(word))) {
        throw new Error(`The editor command or the temp file path contains characters cmd.exe would interpret: ${words.join(' ')}`);
      }
      const line = `"${words.map((word) => `"${word}"`).join(' ')}"`;
      code = await runProcess(environment.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', line], true);
    } else {
      code = await runProcess(resolved, [...args, file], false);
    }
    if (code !== 0) {
      throw new CancelledError(`The editor exited with code ${String(code)}. Nothing was changed.`);
    }
    return;
  }
  throw new Error('No editor was found. Set SYNC_SERVERS_EDITOR, VISUAL or EDITOR.');
}

/** Writes `text` to a private temp file, opens it in the editor, and returns what was saved. */
export async function editText(text: string, fileName: string, environment: EditorEnvironment): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sync-servers-'));
  try {
    const file = path.join(dir, fileName);
    await writeFile(file, text, { mode: 0o600, flag: 'wx' });
    await runEditor(file, environment);
    return await readFile(file, 'utf8');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export type Validation<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: readonly string[] };

function stripLeadingComments(text: string): string {
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/);
  let index = 0;
  while (index < lines.length && /^\s*(?:\/\/.*)?$/.test(lines[index] ?? '')) {
    index += 1;
  }
  return lines.slice(index).join('\n');
}

function problemComments(errors: readonly string[]): string[] {
  return [
    '// Fix these problems, then save and close the editor. Delete everything to cancel.',
    ...errors.map((error) => `//   ${error.replace(/\r?\n/g, ' ')}`),
  ];
}

/**
 * Opens `text` in the editor and reopens it, with the problems as comments
 * at the top, until `validate` accepts what was saved. Starts with
 * `problems` shown when the text already has some. Resolves `undefined`
 * when the person empties the file or saves it unchanged.
 */
export async function editTextUntilValid<T>(
  text: string,
  header: readonly string[],
  validate: (saved: string) => Validation<T>,
  environment: EditorEnvironment,
  fileName = 'edit.json',
  problems: readonly string[] = [],
): Promise<T | undefined> {
  const original = text.endsWith('\n') ? text : `${text}\n`;
  let body = original;
  let comments = [...header.map((line) => `// ${line}`), ...(problems.length === 0 ? [] : problemComments(problems))];
  for (;;) {
    const saved = stripLeadingComments(await editText(`${comments.join('\n')}\n${body}`, fileName, environment));
    if (saved.trim() === '' || saved.trim() === original.trim()) {
      return undefined;
    }
    const result = validate(saved);
    if (result.ok) {
      return result.value;
    }
    body = saved.endsWith('\n') ? saved : `${saved}\n`;
    comments = problemComments(result.errors);
  }
}

/**
 * Opens `value` as JSON in the editor and reopens it, with the problems as
 * comments at the top, until `validate` accepts it. Resolves `undefined`
 * when the person empties the file or saves it unchanged.
 */
export function editJsonUntilValid<T>(
  value: unknown,
  header: readonly string[],
  validate: (parsed: unknown) => Validation<T>,
  environment: EditorEnvironment,
  fileName = 'edit.json',
): Promise<T | undefined> {
  return editTextUntilValid(
    `${JSON.stringify(value, null, 2)}\n`,
    header,
    (saved) => {
      try {
        return validate(JSON.parse(saved));
      } catch (error) {
        return { ok: false, errors: [`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
      }
    },
    environment,
    fileName,
  );
}
