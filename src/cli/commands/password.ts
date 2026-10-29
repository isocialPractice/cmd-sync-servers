import type { Server, Site } from '../../config/schema.ts';
import type { CredentialStore, SecretKind } from '../../credentials/types.ts';
import { SyncError } from '../../errors.ts';
import { choiceOption, flag, type CommandSpec } from '../command.ts';
import type { CommandContext } from '../context.ts';
import { UsageError } from '../errors.ts';
import type { CliInput } from '../io.ts';
import { SECRET_KINDS } from './shared.ts';

const MAX_STDIN_BYTES = 64 * 1024;

function label(kind: SecretKind): string {
  return kind === 'password' ? 'password' : 'key passphrase';
}

/** Reads all of stdin, for `--stdin`, up to 64 KiB. */
function readAllInput(input: CliInput): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer | string): void => {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      size += buffer.length;
      if (size > MAX_STDIN_BYTES) {
        finish();
        reject(new UsageError('Standard input is longer than a password can be.'));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      finish();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const finish = (): void => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.pause();
    };
    input.on('data', onData);
    input.on('end', onEnd);
    input.resume();
  });
}

async function readSecret(ctx: CommandContext, kind: SecretKind, fromStdin: boolean): Promise<string> {
  if (fromStdin) {
    const secret = (await readAllInput(ctx.io.stdin)).replace(/\r?\n$/, '');
    if (secret === '') {
      throw new UsageError('Standard input was empty. Nothing was saved.');
    }
    return secret;
  }
  if (!ctx.interactive) {
    throw new UsageError(`Run in a terminal to be asked for the ${label(kind)}, or pipe it in with --stdin.`);
  }
  const Label = kind === 'password' ? 'Password' : 'Key passphrase';
  const first = await ctx.prompter.secret(`${Label}: `);
  if (first === '') {
    throw new UsageError(`An empty ${label(kind)} cannot be saved.`);
  }
  ctx.logger.redactor.addSecret(first);
  const second = await ctx.prompter.secret(`Confirm ${label(kind)}: `);
  if (second !== first) {
    throw new UsageError('The two entries did not match. Nothing was saved.');
  }
  return first;
}

function kindFor(server: Server, requested: SecretKind | undefined): SecretKind {
  if (server.protocol === 'local') {
    throw new UsageError(`"${server.name}" is a folder and needs no password.`);
  }
  const method = server.auth?.method ?? 'password';
  const kind = requested ?? (method === 'key' ? 'passphrase' : 'password');
  if (method === 'agent') {
    throw new UsageError(`"${server.name}" signs in through the SSH agent and needs no saved secret.`);
  }
  if (kind === 'password' && method === 'key') {
    throw new UsageError(`"${server.name}" signs in with a private key. Save its passphrase with --kind passphrase.`);
  }
  if (kind === 'passphrase' && method !== 'key') {
    throw new UsageError(`"${server.name}" signs in with a password, not a private key.`);
  }
  return kind;
}

async function requireStore(ctx: CommandContext): Promise<CredentialStore> {
  const store = await ctx.credentialStore();
  if (store === undefined) {
    throw new SyncError(
      'E_CREDENTIAL_STORE',
      `Passwords cannot be saved: ${ctx.credentialStoreProblem()}. They are never written to a file. Set SYNC_SERVERS_PASSWORD, or enter the password when asked.`,
    );
  }
  return store;
}

/** Reads a secret, keeps it in the OS credential store, and marks the server as saving it. */
async function saveSecret(
  ctx: CommandContext,
  site: Site,
  server: Server,
  kind: SecretKind,
  store: CredentialStore,
  fromStdin: boolean,
): Promise<void> {
  const secret = await readSecret(ctx, kind, fromStdin);
  ctx.logger.redactor.addSecret(secret);
  await store.set({ siteId: site.id, serverId: server.id, kind }, secret);
  await (await ctx.registry()).updateServer(site.id, server.id, (draft) => {
    draft.auth ??= { method: 'password', savePassword: true };
    draft.auth.savePassword = true;
  });
  ctx.logger.info('Secret saved', { siteId: site.id, serverId: server.id, kind, store: store.name });
}

/** After adding a server in a terminal, offers to save its password. */
export async function offerToSaveSecret(ctx: CommandContext, site: Site, server: Server): Promise<void> {
  if (server.protocol === 'local' || server.auth?.method === 'agent') {
    return;
  }
  const kind: SecretKind = server.auth?.method === 'key' ? 'passphrase' : 'password';
  const store = await ctx.credentialStore();
  if (store === undefined) {
    ctx.out(`The ${label(kind)} is asked for when connecting (${ctx.credentialStoreProblem()}).\n`);
    return;
  }
  if (await ctx.prompter.confirm(`Save the ${label(kind)} in the ${store.name}?`, false)) {
    await saveSecret(ctx, site, server, kind, store, false);
    ctx.out(`Saved the ${label(kind)} in the ${store.name}.\n`);
  }
}

export const passwordSetCommand: CommandSpec = {
  path: ['password', 'set'],
  args: '[<server>]',
  maxArgs: 1,
  summary: 'Save a password or key passphrase in the OS credential store',
  options: {
    kind: { type: 'string', value: '<kind>', description: 'password (default) or passphrase, for a private key' },
    stdin: { type: 'boolean', description: 'Read it from standard input instead of asking' },
  },
  examples: ['sync-servers password set Production', 'printf %s "$SECRET" | sync-servers password set Production --stdin'],
  async run(ctx, { values, args }) {
    const site = await ctx.chooseSite();
    const server = await ctx.chooseServer(site, args[0]);
    const kind = kindFor(server, choiceOption(values, 'kind', SECRET_KINDS));
    const store = await requireStore(ctx);
    await saveSecret(ctx, site, server, kind, store, flag(values, 'stdin'));
    ctx.out(`Saved the ${label(kind)} for "${site.name}: ${server.name}" in the ${store.name}.\n`);
    return undefined;
  },
};

export const passwordForgetCommand: CommandSpec = {
  path: ['password', 'forget'],
  args: '[<server>]',
  maxArgs: 1,
  summary: 'Remove a saved password or key passphrase',
  options: {
    kind: { type: 'string', value: '<kind>', description: 'password or passphrase; both when not given' },
  },
  examples: ['sync-servers password forget Production'],
  async run(ctx, { values, args }) {
    const site = await ctx.chooseSite();
    const server = await ctx.chooseServer(site, args[0]);
    const requested = choiceOption(values, 'kind', SECRET_KINDS);
    const store = await ctx.credentialStore();
    let removed = false;
    if (store !== undefined) {
      for (const kind of requested === undefined ? SECRET_KINDS : [requested]) {
        removed = (await store.delete({ siteId: site.id, serverId: server.id, kind })) || removed;
      }
    }
    if (server.auth?.savePassword === true) {
      await (await ctx.registry()).updateServer(site.id, server.id, (draft) => {
        if (draft.auth !== undefined) {
          draft.auth.savePassword = false;
        }
      });
    }
    if (store === undefined) {
      ctx.out(`Nothing to forget: ${ctx.credentialStoreProblem()}.\n`);
    } else {
      ctx.out(
        removed
          ? `Removed the saved secret of "${site.name}: ${server.name}" from the ${store.name}.\n`
          : `"${site.name}: ${server.name}" had no saved secret.\n`,
      );
    }
    return undefined;
  },
};
