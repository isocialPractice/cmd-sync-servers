import type { SiteRegistry } from '../config/registry.ts';
import { sealSecret } from '../credentials/binding.ts';
import { secretQuestion } from '../credentials/prompt.ts';
import type { CredentialStore } from '../credentials/types.ts';
import { SyncError } from '../errors.ts';
import type { CertificateDecision, HostAdapter, HostKeyDecision } from '../host.ts';
import type { Logger } from '../log/logger.ts';
import { SyncSession } from '../sync/session.ts';
import { certificateQuestion, certificateSummary } from '../transport/certificates.ts';
import type { App } from './app.ts';
import { choiceDialog, confirmDialog, inputDialog } from './widgets/dialog.ts';

/** What the screens need from outside: the master list, secrets, the log and the environment. */
export interface TuiServices {
  registry(): Promise<SiteRegistry>;
  /** The OS credential store, or `undefined` when there is none. */
  credentialStore(): Promise<CredentialStore | undefined>;
  readonly logger: Logger;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
}

function emptyStore(): CredentialStore {
  return {
    name: 'no credential store',
    get: () => Promise.resolve(undefined),
    set: () => Promise.reject(new SyncError('E_CREDENTIAL_STORE', 'No credential store is available. Passwords are never written to a file.')),
    delete: () => Promise.resolve(false),
  };
}

/**
 * A {@link HostAdapter} that asks in dialogs: the host key fingerprint, what
 * to do about an unverified certificate, secrets in a masked field, and
 * whether to save a typed password once the server accepted it.
 */
export async function tuiHost(app: App, services: TuiServices): Promise<HostAdapter> {
  const saved = await services.credentialStore();
  return {
    credentials: saved ?? emptyStore(),
    interactive: true,
    logger: services.logger,
    confirmHostKey: (info) =>
      app.dialog(
        choiceDialog<HostKeyDecision>(
          'New host key',
          `The host key of ${info.host}:${String(info.port)} is not known yet.\n${info.algorithm} ${info.fingerprint}\nCheck this fingerprint with the server's administrator before you trust it.`,
          [
            { label: 'Trust and remember it for this server', value: 'accept-and-pin' },
            { label: 'Trust it for this connection only', value: 'accept-once' },
            { label: 'Do not trust it', value: 'reject' },
          ],
          'reject',
          2,
        ),
      ),
    confirmCertificate: (info) => {
      const { question, choices, initial } = certificateQuestion(info);
      return app.dialog(
        choiceDialog<CertificateDecision>(
          info.problem === 'changed' ? 'Certificate changed' : 'Certificate not verified',
          `${certificateSummary(info)}\n${question}`,
          choices,
          { action: 'reject' },
          initial,
        ),
      );
    },
    promptSecret: (request) =>
      app.dialog(
        inputDialog(
          request.ref.kind === 'password' ? 'Password' : 'Key passphrase',
          `${request.note === undefined ? '' : `${request.note}\n`}${secretQuestion(request).trim()}`,
          { masked: true },
        ),
      ),
    secretAccepted: async (request, secret) => {
      if (saved === undefined) {
        return;
      }
      const registry = await services.registry();
      const server = registry.get(request.ref.siteId)?.servers.find((candidate) => candidate.id === request.ref.serverId);
      if (server === undefined) {
        return;
      }
      const what = request.ref.kind === 'password' ? 'password' : 'key passphrase';
      if (!(await app.dialog(confirmDialog(`Save ${what}`, `Save the ${what} in the ${saved.name}?`, { yes: 'Save', no: 'Not now', defaultYes: true })))) {
        return;
      }
      await saved.set(request.ref, sealSecret(secret, server));
      await registry.updateServer(request.ref.siteId, server.id, (draft) => {
        draft.auth ??= { method: 'password', savePassword: true };
        draft.auth.savePassword = true;
      });
      services.logger.info('Secret saved', { siteId: request.ref.siteId, serverId: server.id, kind: request.ref.kind, store: saved.name });
    },
  };
}

/** Opens a session for a site and server, asking for host keys and secrets in dialogs. */
export async function openSession(app: App, services: TuiServices, siteId: string, serverId?: string): Promise<SyncSession> {
  return SyncSession.open({
    registry: await services.registry(),
    siteId,
    serverId,
    host: await tuiHost(app, services),
    logger: services.logger,
    env: services.env,
  });
}
