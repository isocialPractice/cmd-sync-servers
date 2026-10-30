import { sealSecret } from '../credentials/binding.ts';
import { secretQuestion } from '../credentials/prompt.ts';
import type { CredentialStore } from '../credentials/types.ts';
import { SyncError } from '../errors.ts';
import type { CertificateDecision, HostAdapter, HostKeyDecision } from '../host.ts';
import { certificateQuestion, certificateSummary } from '../transport/certificates.ts';
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
 * The CLI's {@link HostAdapter}: secrets in the OS credential store; new host
 * keys, unverified certificates and secrets asked about in the terminal; and
 * none of them when nobody is there to answer.
 */
export async function cliHostAdapter(ctx: CommandContext): Promise<HostAdapter> {
  const saved = await ctx.credentialStore();
  const store = saved ?? unavailableStore(ctx.credentialStoreProblem());
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
    async confirmCertificate(info): Promise<CertificateDecision> {
      ctx.err(`${certificateSummary(info)}\n`);
      const { question, choices, initial } = certificateQuestion(info);
      return ctx.prompter.choose<CertificateDecision>(question, choices, initial);
    },
    async promptSecret(request) {
      if (!ctx.interactive) {
        return undefined;
      }
      if (request.note !== undefined) {
        ctx.err(`${request.note}\n`);
      }
      return ctx.prompter.secret(secretQuestion(request));
    },
    async secretAccepted(request, secret): Promise<void> {
      if (!ctx.interactive || ctx.flags.json || saved === undefined) {
        return;
      }
      const registry = await ctx.registry();
      const server = registry.get(request.ref.siteId)?.servers.find((candidate) => candidate.id === request.ref.serverId);
      if (server === undefined) {
        return;
      }
      const what = request.ref.kind === 'password' ? 'password' : 'key passphrase';
      if (!(await ctx.prompter.confirm(`Save the ${what} in the ${saved.name}?`, true))) {
        return;
      }
      await saved.set(request.ref, sealSecret(secret, server));
      await registry.updateServer(request.ref.siteId, server.id, (draft) => {
        draft.auth ??= { method: 'password', savePassword: true };
        draft.auth.savePassword = true;
      });
      ctx.logger.info('Secret saved', { siteId: request.ref.siteId, serverId: server.id, kind: request.ref.kind, store: saved.name });
      ctx.err(`Saved the ${what} in the ${saved.name}.\n`);
    },
  };
}
