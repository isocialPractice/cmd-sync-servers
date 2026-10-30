import type { SiteRegistry } from '../config/registry.ts';
import { secretQuestion } from '../credentials/prompt.ts';
import type { CredentialStore } from '../credentials/types.ts';
import { SyncError } from '../errors.ts';
import type { HostAdapter, HostKeyDecision } from '../host.ts';
import type { Logger } from '../log/logger.ts';
import { SyncSession } from '../sync/session.ts';
import type { App } from './app.ts';
import { choiceDialog, inputDialog } from './widgets/dialog.ts';

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

/** A {@link HostAdapter} that asks in dialogs: the host key fingerprint, and secrets in a masked field. */
export async function tuiHost(app: App, services: TuiServices): Promise<HostAdapter> {
  return {
    credentials: (await services.credentialStore()) ?? emptyStore(),
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
    promptSecret: (request) => app.dialog(inputDialog(request.ref.kind === 'password' ? 'Password' : 'Key passphrase', secretQuestion(request).trim(), { masked: true })),
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
