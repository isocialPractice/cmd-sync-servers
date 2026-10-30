import { homedir } from 'node:os';
import path from 'node:path';
import type { SiteRegistry } from '../config/registry.ts';
import type { Server } from '../config/schema.ts';
import { sealSecret } from '../credentials/binding.ts';
import { PASSWORD_ENV } from '../credentials/env.ts';
import { secretQuestion } from '../credentials/prompt.ts';
import type { CredentialStore, SecretKind } from '../credentials/types.ts';
import { SyncError } from '../errors.ts';
import type { CertificateDecision, HostAdapter, HostKeyDecision } from '../host.ts';
import type { Logger } from '../log/logger.ts';
import { SyncSession } from '../sync/session.ts';
import { certificateQuestion, certificateSummary } from '../transport/certificates.ts';
import { ServerProbe } from '../transport/probe.ts';
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
  /** The home folder a leading `~` in a typed path stands for. Default: this user's. */
  readonly homedir?: string;
  readonly platform: NodeJS.Platform;
}

/** A typed local path: `~` expanded, then made absolute against the working folder. */
export function typedPath(services: TuiServices, text: string): string {
  const home = services.homedir ?? homedir();
  const expanded = text === '~' ? home : /^~[\\/]/.test(text) ? path.join(home, text.slice(2)) : text;
  return path.resolve(services.cwd, expanded);
}

/** What connecting with settings that are not saved yet gave: the result, or the error, and the settings with every decision applied. */
export type ProbeOutcome<T> =
  | { readonly ok: true; readonly value: T; readonly server: Server; readonly typed: { readonly kind: SecretKind; readonly secret: string } | undefined }
  | { readonly ok: false; readonly error: unknown; readonly server: Server };

/**
 * Connects with `server` as a person filled it in, without saving it, and
 * runs `use` on the connection, with a spinner. Host key and certificate
 * decisions are asked in dialogs and applied to the returned settings only;
 * nothing is written to `sites.json` or the credential store. `password`,
 * when given, answers the password question.
 */
export async function probeUnsaved<T>(
  app: App,
  services: TuiServices,
  options: {
    readonly site: { readonly id: string; readonly name: string };
    readonly server: Server;
    readonly password?: string | undefined;
    readonly label: string;
    readonly use: (probe: ServerProbe) => Promise<T>;
  },
): Promise<ProbeOutcome<T>> {
  const working = structuredClone(options.server);
  const base = await tuiHost(app, services);
  let typed: { kind: SecretKind; secret: string } | undefined;
  const promptSecret = base.promptSecret.bind(base);
  const confirmCertificate = base.confirmCertificate?.bind(base);
  const host: HostAdapter = {
    credentials: base.credentials,
    interactive: true,
    logger: services.logger,
    confirmHostKey: base.confirmHostKey.bind(base),
    ...(confirmCertificate === undefined ? {} : { confirmCertificate }),
    promptSecret: async (request) => {
      if (request.ref.kind === 'password' && options.password !== undefined && options.password !== '') {
        typed = { kind: 'password', secret: options.password };
        return options.password;
      }
      const answer = await promptSecret(request);
      if (answer !== undefined && answer !== '') {
        typed = { kind: request.ref.kind, secret: answer };
      }
      return answer;
    },
  };
  const outcome = await app.task(options.label, async (signal): Promise<ProbeOutcome<T>> => {
    try {
      const probe = await ServerProbe.open({
        site: options.site,
        server: options.server,
        host,
        updateServer: (change) => {
          change(working);
          return Promise.resolve();
        },
        env: options.password === undefined || options.password === '' ? services.env : { ...services.env, [PASSWORD_ENV]: undefined },
        logger: services.logger,
        signal,
      });
      try {
        return { ok: true, value: await options.use(probe), server: working, typed };
      } finally {
        await probe.close();
      }
    } catch (error) {
      return { ok: false, error, server: working };
    }
  });
  return outcome ?? { ok: false, error: new SyncError('E_CANCELLED', 'Cancelled.'), server: working };
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
