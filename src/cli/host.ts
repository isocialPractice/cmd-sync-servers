import { secretQuestion } from '../credentials/prompt.ts';
import type { CredentialStore } from '../credentials/types.ts';
import { SyncError } from '../errors.ts';
import type { HostAdapter, HostKeyDecision } from '../host.ts';
import type { CommandContext } from './context.ts';

/** A credential store that holds nothing and saves nothing, for when the OS store is unavailable. */
export function unavailableStore(reason: string): CredentialStore {
  return {
    name: 'no credential store',
    get: () => Promise.resolve(undefined),
    set: () => Promise.reject(new SyncError('E_CREDENTIAL_STORE', `Passwords cannot be saved: ${reason}.`)),
    delete: () => Promise.resolve(false),
  };
}

/**
 * The CLI's {@link HostAdapter}: secrets in the OS credential store, new host
 * keys confirmed and secrets asked for in the terminal, and neither when
 * nobody is there to answer.
 */
export async function cliHostAdapter(ctx: CommandContext): Promise<HostAdapter> {
  const store = (await ctx.credentialStore()) ?? unavailableStore(ctx.credentialStoreProblem());
  return {
    credentials: store,
    interactive: ctx.interactive,
    logger: ctx.logger,
    async confirmHostKey(info): Promise<HostKeyDecision> {
      ctx.err(
        [
          `The host key of ${info.host}:${String(info.port)} is not known yet.`,
          `  ${info.algorithm} key fingerprint: ${info.fingerprint}`,
          "Check this fingerprint with the server's administrator before you trust it.",
          '',
        ].join('\n'),
      );
      return ctx.prompter.choose<HostKeyDecision>(
        'Trust this host key?',
        [
          { label: 'Yes, and remember it for this server', value: 'accept-and-pin' },
          { label: 'Yes, for this connection only', value: 'accept-once' },
          { label: 'No', value: 'reject' },
        ],
        2,
      );
    },
    async promptSecret(request) {
      if (!ctx.interactive) {
        return undefined;
      }
      return ctx.prompter.secret(secretQuestion(request));
    },
  };
}
