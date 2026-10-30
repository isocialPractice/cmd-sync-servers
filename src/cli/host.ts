import { sealSecret } from '../credentials/binding.ts';
import { secretQuestion } from '../credentials/prompt.ts';
import type { CredentialStore, SecretRequest } from '../credentials/types.ts';
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

/** A host adapter that can be told to forget the secrets typed so far. */
export interface RememberingAdapter extends HostAdapter {
  /** Forgets every secret typed so far, as after the server refused one. */
  forget(): void;
}

/**
 * Wraps `base` so a secret typed once in a command answers the same question
 * again without asking, for the next connection to the same account, until
 * {@link RememberingAdapter.forget}; and so saving it is offered once.
 */
export function rememberTypedSecrets(base: HostAdapter): RememberingAdapter {
  const typed = new Map<string, string>();
  const offered = new Set<string>();
  const key = (request: SecretRequest): string =>
    JSON.stringify([request.ref.siteId, request.ref.serverId, request.ref.kind, request.host ?? '', request.username ?? '']);
  const confirmCertificate = base.confirmCertificate?.bind(base);
  const secretAccepted = base.secretAccepted?.bind(base);
  const promptSecret = base.promptSecret.bind(base);
  return {
    credentials: base.credentials,
    ...(base.interactive === undefined ? {} : { interactive: base.interactive }),
    ...(base.logger === undefined ? {} : { logger: base.logger }),
    confirmHostKey: base.confirmHostKey.bind(base),
    ...(confirmCertificate === undefined ? {} : { confirmCertificate }),
    async promptSecret(request) {
      const known = typed.get(key(request));
      if (known !== undefined) {
        return known;
      }
      const answer = await promptSecret(request);
      if (answer !== undefined && answer !== '') {
        typed.set(key(request), answer);
      }
      return answer;
    },
    ...(secretAccepted === undefined
      ? {}
      : {
          async secretAccepted(request: SecretRequest, secret: string): Promise<void> {
            if (offered.has(key(request))) {
              return;
            }
            offered.add(key(request));
            await secretAccepted(request, secret);
          },
        }),
    forget() {
      typed.clear();
      offered.clear();
    },
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
