import path from 'node:path';
import type { FolderListing, ServerProbe } from '../transport/probe.ts';
import { safeLine } from '../terminal-text.ts';
import type { CommandContext } from './context.ts';

/** The most folders listed at once; more are opened by typing their name. */
const SHOWN = 30;

function plural(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}

/** An absolute folder on the server from what was typed: absolute, or relative to `current`. */
export function resolveRemoteFolder(typed: string, current: string): string {
  const joined = typed.startsWith('/') ? typed : path.posix.join(current, typed);
  const normalized = path.posix.normalize(joined).replace(/(.)\/+$/, '$1');
  return normalized === '' ? '/' : normalized;
}

function describe(listing: FolderListing, intro: string | undefined): string[] {
  const where = intro === undefined ? `"${safeLine(listing.path)}"` : `${intro} The account opens in "${safeLine(listing.path)}", which`;
  const files = listing.files === 0 ? '' : plural(listing.files, 'file', 'files');
  if (listing.folders.length === 0) {
    return [files === '' ? `${where} is empty.` : `${where} holds no folders and ${files}.`];
  }
  const lines = [`${where} holds:`];
  listing.folders.slice(0, SHOWN).forEach((name, index) => {
    lines.push(`  ${String(index + 1)}. ${safeLine(name)}/`);
  });
  if (listing.folders.length > SHOWN) {
    lines.push(`  and ${String(listing.folders.length - SHOWN)} more; type a name`);
  }
  if (files !== '') {
    lines.push(`  and ${files}`);
  }
  return lines;
}

/**
 * Lets a person pick the site root from what the server shows, starting at
 * `start`, usually the folder the account opens in. Enter accepts the folder
 * shown, a number opens one of its folders, `..` goes up, and a typed path,
 * absolute or relative to the folder shown, is accepted once it exists.
 * `intro` opens the first listing, such as `Signed in as demo-user.`.
 */
export async function chooseRemoteRoot(ctx: CommandContext, probe: ServerProbe, start: string, intro?: string): Promise<string> {
  let current = start;
  let first: string | undefined = intro;
  for (;;) {
    let listing: FolderListing;
    try {
      listing = await probe.folders(current);
    } catch (error) {
      ctx.err(`"${safeLine(current)}" cannot be listed: ${error instanceof Error ? safeLine(error.message) : String(error)}\n`);
      if (current === '/') {
        throw error;
      }
      current = '/';
      continue;
    }
    ctx.err(`${describe(listing, first).join('\n')}\n`);
    first = undefined;
    const shown = listing.folders.slice(0, SHOWN);
    for (;;) {
      const answer = await ctx.prompter.ask(`Site root on the server: Enter for "${safeLine(current)}", a number to open a folder, or a path`, current);
      if (answer === current) {
        return current;
      }
      if (/^\d+$/.test(answer)) {
        const name = shown[Number(answer) - 1];
        if (name === undefined) {
          ctx.err(shown.length === 0 ? 'There is no folder to open here. Press Enter, or type a path.\n' : `Enter a number from 1 to ${String(shown.length)}.\n`);
          continue;
        }
        current = resolveRemoteFolder(name, current);
        break;
      }
      if (answer === '..') {
        current = resolveRemoteFolder('..', current);
        break;
      }
      const target = resolveRemoteFolder(answer, current);
      if (await probe.exists(target)) {
        return target;
      }
      ctx.err(`"${safeLine(target)}" was not found on the server.\n`);
    }
  }
}
