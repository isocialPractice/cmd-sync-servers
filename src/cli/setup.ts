import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseServerAddress } from '../config/address.ts';
import { defaultPort, formatIssues, PROTOCOLS, serverSchema, type Protocol, type Server, type Site } from '../config/schema.ts';
import { openSecret, sealSecret } from '../credentials/binding.ts';
import { PASSWORD_ENV } from '../credentials/env.ts';
import type { SecretKind } from '../credentials/types.ts';
import { isSyncError } from '../errors.ts';
import type { CertificateDecision, HostAdapter, HostKeyDecision } from '../host.ts';
import { remoteRootIsTop } from '../sync/session.ts';
import { safeLine } from '../terminal-text.ts';
import { ServerProbe } from '../transport/probe.ts';
import { booleanOption, choiceOption, integerOption, stringOption, type OptionSpecs, type OptionValues } from './command.ts';
import { localPath, normalizeWebUrl, protocolLabel } from './commands/shared.ts';
import type { CommandContext } from './context.ts';
import { CancelledError, UsageError } from './errors.ts';
import { cliHostAdapter } from './host.ts';
import { chooseRemoteRoot, resolveRemoteFolder } from './remote-root.ts';

/** The server fields every `server add` and `server edit` option sets. */
export const SERVER_FIELD_OPTIONS: OptionSpecs = {
  name: { type: 'string', value: '<name>', description: 'The server name, unique within the site (default: the host)' },
  protocol: { type: 'string', value: '<protocol>', description: 'sftp (default), ftps, ftps-implicit, ftp or local' },
  host: { type: 'string', value: '<host>', description: 'The host name or IP address; host:port and sftp://, ftps:// and ftpes:// addresses work too' },
  port: { type: 'string', value: '<port>', description: 'The port, when not the protocol default' },
  user: { type: 'string', value: '<name>', description: 'The user name' },
  auth: { type: 'string', value: '<method>', description: 'password, key or agent (key and agent are SFTP only)' },
  'key-path': { type: 'string', value: '<file>', description: 'The private key file for --auth key' },
  'save-password': { type: 'boolean', description: 'Keep the password in the OS credential store (--no-save-password to stop)' },
  'remote-root': { type: 'string', value: '<path>', description: 'The site root on the server; for local, a folder' },
  'web-url': { type: 'string', value: '<url>', description: 'The web address of the site on this server' },
  timeout: { type: 'string', value: '<seconds>', description: 'Seconds to wait for the server (default 30)' },
  'ip-family': { type: 'string', value: '<4|6>', description: 'Connect over IPv4 or IPv6 only' },
  'allow-insecure': { type: 'boolean', description: 'Allow plain FTP, which sends the password in clear text' },
  'allow-root-deletes': { type: 'boolean', description: 'Allow deletes when the remote root is "/" or a drive root' },
  'legacy-algorithms': { type: 'boolean', description: 'SFTP: allow older algorithms for an old server' },
  'upload-on-save': { type: 'boolean', description: 'Upload files when they are saved in the VS Code extension' },
  'ca-file': { type: 'string', value: '<file>', description: 'FTPS: a PEM file of extra certificate authorities' },
  'tls-servername': { type: 'string', value: '<host>', description: 'FTPS: the name to verify the certificate against' },
  'tls-min-version': { type: 'string', value: '<version>', description: 'FTPS: TLSv1.2 (default) or TLSv1.3' },
  'file-mode': { type: 'string', value: '<mode>', description: 'Permissions for uploaded files, such as 644' },
  'dir-mode': { type: 'string', value: '<mode>', description: 'Permissions for created folders, such as 755' },
};

export type AuthMethod = 'password' | 'key' | 'agent';

/** A server being built or edited from options and answers. */
export interface ServerDraft {
  name?: string;
  protocol?: Protocol;
  host?: string;
  port?: number;
  username?: string;
  auth?: { method: AuthMethod; keyPath?: string; savePassword?: boolean };
  remoteRoot?: string;
  webUrl?: string;
  options: {
    ipFamily?: 4 | 6;
    timeoutSeconds?: number;
    allowInsecure?: boolean;
    allowRootDeletes?: boolean;
    legacyAlgorithms?: boolean;
    tls?: { caFile?: string; servername?: string; minVersion?: 'TLSv1.2' | 'TLSv1.3'; trustedCertificate?: unknown };
    hostKey?: unknown;
    uploadOnSave?: boolean;
    remoteFileMode?: string;
    remoteDirMode?: string;
  };
}

export const PROTOCOL_CHOICES: readonly { label: string; value: Protocol }[] = [
  { label: 'SFTP (recommended)', value: 'sftp' },
  { label: 'FTPS, explicit TLS', value: 'ftps' },
  { label: 'FTPS, implicit TLS', value: 'ftps-implicit' },
  { label: 'FTP, insecure: sends the password in clear text', value: 'ftp' },
  { label: 'Local or network folder', value: 'local' },
];

export function hasServerFieldOptions(values: OptionValues): boolean {
  return Object.keys(SERVER_FIELD_OPTIONS).some((name) => values[name] !== undefined);
}

function sameName(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
}

/** Why `name` cannot name a server among `others`, or `undefined` when it can. */
export function serverNameProblem(siteName: string, others: readonly Pick<Server, 'id' | 'name'>[], name: string, exceptId?: string): string | undefined {
  if (name.trim() === '') {
    return 'Enter a name.';
  }
  const clash = others.find((server) => server.id !== exceptId && sameName(server.name, name.trim()));
  return clash === undefined ? undefined : `Site "${siteName}" already has a server named "${clash.name}".`;
}

/** `host`, `host:port` or `[v6]:port`, as the Host question shows a server. */
export function hostText(draft: Pick<ServerDraft, 'host' | 'port' | 'protocol'>): string {
  const host = draft.host ?? '';
  if (draft.port === undefined || draft.protocol === undefined || draft.protocol === 'local' || draft.port === defaultPort(draft.protocol)) {
    return host;
  }
  return `${host.includes(':') ? `[${host}]` : host}:${String(draft.port)}`;
}

/** What applying options found worth telling or asking: notes, and warnings that need a yes. */
export interface AppliedOptions {
  readonly notes: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Copies the server options that were given onto `draft`. `--host` is read
 * like the Host field: its protocol, port, user and folder fill their fields,
 * and one that disagrees with its own option is a usage error naming both.
 */
export function applyServerOptions(draft: ServerDraft, values: OptionValues, ctx: Pick<CommandContext, 'io'>): AppliedOptions {
  const notes: string[] = [];
  const warnings: string[] = [];
  const text = (name: string): string | undefined => stringOption(values, name);
  const name = text('name');
  if (name !== undefined) {
    draft.name = name;
  }
  const protocol = choiceOption(values, 'protocol', PROTOCOLS);
  const port = integerOption(values, 'port', 1, 65535);
  const user = text('user');
  const remoteRoot = text('remote-root');
  if (protocol !== undefined) {
    draft.protocol = protocol;
  }
  const host = text('host');
  if (host !== undefined) {
    const parsed = parseServerAddress(host);
    if (!parsed.ok) {
      throw new UsageError(`--host ${host}: ${parsed.problem}`);
    }
    const address = parsed.address;
    const clash = (option: string, ours: string | number | undefined, theirs: string | number | undefined): void => {
      if (ours !== undefined && theirs !== undefined && ours !== theirs) {
        throw new UsageError(`--host ${host} gives ${String(theirs)}, but --${option} gives ${String(ours)}. Give one of them.`);
      }
    };
    clash('protocol', protocol, address.protocol);
    clash('port', port, address.port);
    clash('user', user, address.username);
    clash('remote-root', remoteRoot, address.remoteRoot);
    draft.host = address.host;
    if (address.protocol !== undefined) {
      draft.protocol = address.protocol;
    }
    if (address.port !== undefined) {
      draft.port = address.port;
    }
    if (address.username !== undefined) {
      draft.username = address.username;
    }
    if (address.remoteRoot !== undefined) {
      draft.remoteRoot = address.remoteRoot;
    }
    if (address.note !== undefined) {
      notes.push(address.note);
    }
    if (address.warning !== undefined) {
      warnings.push(address.warning);
    }
  }
  if (port !== undefined) {
    draft.port = port;
  }
  if (user !== undefined) {
    draft.username = user;
  }
  const method = choiceOption(values, 'auth', ['password', 'key', 'agent'] as const);
  const keyPath = text('key-path');
  const savePassword = booleanOption(values, 'save-password');
  if (method !== undefined || keyPath !== undefined || savePassword !== undefined) {
    draft.auth ??= { method: keyPath === undefined ? 'password' : 'key' };
    if (method !== undefined) {
      draft.auth.method = method;
    }
    if (keyPath !== undefined) {
      draft.auth.keyPath = localPath(keyPath, ctx);
    }
    if (savePassword !== undefined) {
      draft.auth.savePassword = savePassword;
    }
  }
  if (remoteRoot !== undefined) {
    draft.remoteRoot = draft.protocol === 'local' ? localPath(remoteRoot, ctx) : remoteRoot;
  }
  const webUrl = text('web-url');
  if (webUrl !== undefined) {
    draft.webUrl = normalizeWebUrl(webUrl);
  }
  const options = draft.options;
  const timeout = integerOption(values, 'timeout', 1, 600);
  if (timeout !== undefined) {
    options.timeoutSeconds = timeout;
  }
  const family = choiceOption(values, 'ip-family', ['4', '6'] as const);
  if (family !== undefined) {
    options.ipFamily = family === '4' ? 4 : 6;
  }
  const booleans = [
    ['allow-insecure', 'allowInsecure'],
    ['allow-root-deletes', 'allowRootDeletes'],
    ['legacy-algorithms', 'legacyAlgorithms'],
    ['upload-on-save', 'uploadOnSave'],
  ] as const;
  for (const [option, field] of booleans) {
    const value = booleanOption(values, option);
    if (value !== undefined) {
      options[field] = value;
    }
  }
  const caFile = text('ca-file');
  const servername = text('tls-servername');
  const minVersion = choiceOption(values, 'tls-min-version', ['TLSv1.2', 'TLSv1.3'] as const);
  if (caFile !== undefined || servername !== undefined || minVersion !== undefined) {
    options.tls ??= {};
    if (caFile !== undefined) {
      options.tls.caFile = localPath(caFile, ctx);
    }
    if (servername !== undefined) {
      options.tls.servername = servername;
    }
    if (minVersion !== undefined) {
      options.tls.minVersion = minVersion;
    }
  }
  const fileMode = text('file-mode');
  if (fileMode !== undefined) {
    options.remoteFileMode = fileMode;
  }
  const dirMode = text('dir-mode');
  if (dirMode !== undefined) {
    options.remoteDirMode = dirMode;
  }
  if (draft.port !== undefined && draft.protocol !== undefined && draft.protocol !== 'local' && draft.port === defaultPort(draft.protocol)) {
    delete draft.port;
  }
  return { notes, warnings };
}

/** The draft as a stored server with `id`, or a usage error naming every problem. */
export function draftServer(draft: ServerDraft, id: string): Server {
  const cleaned = JSON.parse(JSON.stringify({ ...draft, id })) as unknown;
  const parsed = serverSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new UsageError(['The server is not valid:', ...formatIssues(parsed.error.issues).map((line) => `  ${line}`)].join('\n'));
  }
  return parsed.data;
}

/** The name a new server takes when none is given: its host, or the name of its folder. */
export function defaultServerName(draft: ServerDraft): string {
  return draft.protocol === 'local' ? path.basename(draft.remoteRoot ?? '') || 'Local folder' : (draft.host ?? 'Server');
}

/**
 * Checks a server built from options alone, for unattended runs: the host
 * and the remote root are required, plain FTP needs `--allow-insecure`, and
 * the remote root must be absolute, since nothing can be picked.
 */
export function checkUnattended(draft: ServerDraft): void {
  draft.protocol ??= 'sftp';
  const missing = [
    ...(draft.protocol !== 'local' && draft.host === undefined ? ['--host'] : []),
    ...(draft.remoteRoot === undefined ? ['--remote-root'] : []),
  ];
  if (missing.length > 0) {
    throw new UsageError(`Missing ${missing.join(', ')}. Pass them as options, or run in a terminal to be asked.`);
  }
  if (draft.protocol === 'ftp' && draft.options.allowInsecure !== true) {
    throw new UsageError('Plain FTP sends the password in clear text. Pass --allow-insecure to use it anyway, or use --protocol sftp or ftps.');
  }
  if (draft.protocol !== 'local' && draft.remoteRoot?.startsWith('/') === false) {
    throw new UsageError(`--remote-root ${draft.remoteRoot} must start with "/". Run in a terminal to pick the folder from what the server shows.`);
  }
}

/** What a guided setup is for. */
export interface GuidedSetup {
  readonly mode: 'site-add' | 'server-add' | 'server-edit';
  /** The site the server belongs to, or will: its id and name. */
  readonly site: Pick<Site, 'id' | 'name'>;
  /** The site's servers, for unique names. */
  readonly servers: readonly Pick<Server, 'id' | 'name'>[];
  /** The server being edited. */
  readonly existing?: Server | undefined;
  /** The id of a new server, chosen up front so a password typed now can be saved under it. */
  readonly serverId: string;
  /** The server options given on the command line. */
  readonly values: OptionValues;
}

/** What a guided setup produced. */
export interface GuidedResult {
  readonly server: Server;
  /** `tested` when the settings signed in, `untested` when the person saved without testing, `unchanged` when an edit changed nothing to test. */
  readonly connection: 'tested' | 'untested' | 'unchanged';
  /** A secret the person typed, the server accepted, and the person chose to save. */
  readonly save?: { readonly kind: SecretKind; readonly secret: string } | undefined;
}

const NOTHING_SAVED = 'Nothing was saved.';

/** The fields a connection depends on: when none changed, an edit needs no test. */
function connectionChanged(before: Server, after: ServerDraft): boolean {
  return (
    before.protocol !== after.protocol ||
    (before.host ?? '') !== (after.host ?? '') ||
    before.port !== after.port ||
    (before.username ?? '') !== (after.username ?? '') ||
    (before.auth?.method ?? 'password') !== (after.auth?.method ?? 'password') ||
    before.auth?.keyPath !== after.auth?.keyPath
  );
}

/**
 * A host adapter for setup: the password typed up front answers the
 * password question, a passphrase asked for is kept to offer saving it, and
 * a host key or certificate trusted once is not asked about again when the
 * setup connects again.
 */
function setupAdapter(base: HostAdapter, typed: () => string | undefined, captured: Map<SecretKind, string>): HostAdapter {
  const once = new Set<string>();
  const confirmCertificate = base.confirmCertificate?.bind(base);
  const confirmHostKey = base.confirmHostKey.bind(base);
  const promptSecret = base.promptSecret.bind(base);
  return {
    credentials: base.credentials,
    ...(base.interactive === undefined ? {} : { interactive: base.interactive }),
    ...(base.logger === undefined ? {} : { logger: base.logger }),
    confirmHostKey: async (info): Promise<HostKeyDecision> => {
      if (once.has(info.sha256)) {
        return 'accept-once';
      }
      const decision = await confirmHostKey(info);
      if (decision === 'accept-once') {
        once.add(info.sha256);
      }
      return decision;
    },
    ...(confirmCertificate === undefined
      ? {}
      : {
          confirmCertificate: async (info): Promise<CertificateDecision> => {
            if (once.has(info.sha256)) {
              return { action: 'accept-once' };
            }
            const decision = await confirmCertificate(info);
            if (decision.action === 'accept-once') {
              once.add(info.sha256);
            }
            return decision;
          },
        }),
    promptSecret: async (request) => {
      const password = typed();
      if (request.ref.kind === 'password' && password !== undefined) {
        return password;
      }
      const answer = await promptSecret(request);
      if (answer !== undefined && answer !== '') {
        captured.set(request.ref.kind, answer);
      }
      return answer;
    },
  };
}

/** True when a password saved for the server would be sent to the settings in `draft`. */
async function savedSecretUsable(ctx: CommandContext, siteId: string, serverId: string, draft: ServerDraft, kind: SecretKind): Promise<boolean> {
  if (draft.auth?.savePassword !== true || draft.protocol === undefined) {
    return false;
  }
  const store = await ctx.credentialStore();
  const stored = await store?.get({ siteId, serverId, kind }).catch(() => undefined);
  return stored !== undefined && openSecret(stored, { protocol: draft.protocol, host: draft.host, port: draft.port, username: draft.username }) !== undefined;
}

/**
 * Sets a server up by asking, as a person would fill in a site manager:
 * Protocol, Host, User and the password, then connects with those settings
 * before anything is saved. Host key and certificate decisions are asked on
 * the way; the remote root is picked from what the server shows; when the
 * root is the top of the account, whether deletes are allowed there is
 * asked; and a password the server accepted is offered for saving. A failed
 * connection offers a fix, saving without testing, or cancel. Nothing is
 * saved here: the caller saves the result.
 *
 * @throws {@link CancelledError} when the person cancels; nothing was saved.
 */
export async function guidedServer(ctx: CommandContext, setup: GuidedSetup): Promise<GuidedResult> {
  const ask = ctx.prompter;
  const editing = setup.mode === 'server-edit';
  const existing = setup.existing;
  const draft: ServerDraft = existing === undefined ? { options: {} } : structuredClone(existing);
  const given = hasServerFieldOptions(setup.values);
  const applied = applyServerOptions(draft, setup.values, ctx);
  const rootGiven = stringOption(setup.values, 'remote-root') !== undefined || draft.remoteRoot !== existing?.remoteRoot;
  let userGiven = stringOption(setup.values, 'user') !== undefined || draft.username !== existing?.username;
  for (const note of applied.notes) {
    ctx.err(`${note}\n`);
  }
  for (const warning of applied.warnings) {
    if (!(await ask.confirm(`${warning} Continue?`, false))) {
      throw new CancelledError(NOTHING_SAVED);
    }
  }

  // Protocol
  if (editing) {
    const index = PROTOCOL_CHOICES.findIndex((choice) => choice.value === draft.protocol);
    draft.protocol = await ask.choose('Protocol', PROTOCOL_CHOICES, Math.max(0, index));
  } else if (draft.protocol === undefined) {
    draft.protocol = given ? 'sftp' : await ask.choose('Protocol', PROTOCOL_CHOICES);
  }
  if (draft.protocol === 'ftp' && draft.options.allowInsecure !== true) {
    if (!(await ask.confirm('Plain FTP sends your password in clear text. Use it anyway?', false))) {
      throw new CancelledError(`${NOTHING_SAVED} Choose SFTP or FTPS instead.`);
    }
    draft.options.allowInsecure = true;
  }

  // `site add` names the server once the setup is done, after the host it ends up connecting to.
  const finish = (connection: GuidedResult['connection'], save?: GuidedResult['save']): GuidedResult => {
    draft.name ??= defaultServerName(draft);
    return { server: draftServer(draft, existing?.id ?? setup.serverId), connection, save };
  };
  const askName = async (fallback: string): Promise<void> => {
    if (setup.mode === 'site-add') {
      draft.name = stringOption(setup.values, 'name');
      return;
    }
    if (editing || stringOption(setup.values, 'name') === undefined) {
      draft.name = await ask.askValid(
        'Server name',
        (answer) => serverNameProblem(setup.site.name, setup.servers, answer, existing?.id),
        editing ? draft.name : fallback,
      );
    }
  };

  if (draft.protocol === 'local') {
    delete draft.host;
    delete draft.port;
    delete draft.username;
    delete draft.auth;
    if (editing || draft.remoteRoot === undefined || !path.isAbsolute(draft.remoteRoot)) {
      draft.remoteRoot = localPath(
        await ask.askValid(
          'Folder (local, mounted or network path)',
          (answer) => (answer !== '' && existsSync(localPath(answer, ctx)) ? undefined : 'Enter an existing folder.'),
          draft.remoteRoot,
        ),
        ctx,
      );
    } else if (!existsSync(draft.remoteRoot)) {
      throw new UsageError(`Folder not found: ${draft.remoteRoot}`);
    }
    await askName(defaultServerName(draft));
    return finish('tested');
  }

  // Host
  const found = { rootFromHost: false };
  const askHost = async (): Promise<void> => {
    for (;;) {
      const answer = await ask.ask('Host', draft.host === undefined ? undefined : hostText(draft));
      const parsed = parseServerAddress(answer);
      if (!parsed.ok) {
        ctx.err(`${parsed.problem}\n`);
        continue;
      }
      const address = parsed.address;
      if (address.warning !== undefined && !(await ask.confirm(`${address.warning} Continue?`, false))) {
        continue;
      }
      if (address.note !== undefined) {
        ctx.err(`${address.note}\n`);
      }
      if (address.protocol !== undefined && address.protocol !== draft.protocol) {
        ctx.err(`Connecting with ${protocolLabel(address.protocol)}, as the address says.\n`);
        draft.protocol = address.protocol;
      }
      const protocol = draft.protocol ?? 'sftp';
      draft.host = address.host;
      draft.port = address.port === undefined || protocol === 'local' || address.port === defaultPort(protocol) ? undefined : address.port;
      if (address.username !== undefined) {
        draft.username = address.username;
        userGiven = true;
      }
      if (address.remoteRoot !== undefined) {
        draft.remoteRoot = address.remoteRoot;
        found.rootFromHost = true;
      }
      return;
    }
  };
  if (editing || draft.host === undefined) {
    await askHost();
  }
  await askName(draft.host ?? defaultServerName(draft));

  // User
  const askUser = async (): Promise<void> => {
    const user = await ask.ask('User', draft.username);
    draft.username = user === '' ? undefined : user;
  };
  if (editing || !userGiven) {
    await askUser();
  }

  // Sign-in method
  if (draft.protocol === 'sftp' && (editing || (!given && draft.auth === undefined))) {
    const methods: { label: string; value: AuthMethod }[] = [
      { label: 'Password', value: 'password' },
      { label: 'Private key file', value: 'key' },
      { label: 'SSH agent', value: 'agent' },
    ];
    const method = await ask.choose(
      'Sign in with',
      methods,
      Math.max(0, methods.findIndex((choice) => choice.value === (draft.auth?.method ?? 'password'))),
    );
    draft.auth = { ...draft.auth, method };
    if (method === 'key') {
      draft.auth.keyPath = localPath(
        await ask.askValid('Private key file', (answer) => (answer !== '' && existsSync(localPath(answer, ctx)) ? undefined : 'File not found.'), draft.auth.keyPath),
        ctx,
      );
    } else {
      delete draft.auth.keyPath;
    }
  } else if (draft.protocol !== 'sftp' && draft.auth !== undefined && draft.auth.method !== 'password') {
    draft.auth = { method: 'password', ...(draft.auth.savePassword === undefined ? {} : { savePassword: draft.auth.savePassword }) };
  }

  const serverId = existing?.id ?? setup.serverId;
  const host = (): string => {
    const name = draft.host ?? '';
    const protocol = draft.protocol === undefined || draft.protocol === 'local' ? 'sftp' : draft.protocol;
    return `${name.includes(':') ? `[${name}]` : name}:${String(draft.port ?? defaultPort(protocol))}`;
  };

  // An edit that changes nothing a connection depends on is not tested again, unless the root changes.
  if (existing !== undefined && !connectionChanged(existing, draft)) {
    const root = await ask.askValid(
      'Root directory on the server',
      (answer) => (answer.startsWith('/') ? undefined : 'Enter a path that starts with "/". To pick from what the server shows, change a connection setting.'),
      draft.remoteRoot,
    );
    if (root === existing.remoteRoot) {
      await askRootDeletes(ctx, draft, setup.values);
      return finish('unchanged');
    }
    draft.remoteRoot = root;
  }

  // Password
  const method = draft.auth?.method ?? 'password';
  const kind: SecretKind = method === 'key' ? 'passphrase' : 'password';
  let typed: string | undefined;
  const askPassword = async (): Promise<void> => {
    typed = await ask.secret('Password: ');
    if (typed === '') {
      typed = undefined;
    } else {
      ctx.logger.redactor.addSecret(typed);
    }
  };
  if (method === 'password' && (ctx.io.env[PASSWORD_ENV] ?? '') === '' && !(await savedSecretUsable(ctx, setup.site.id, serverId, draft, 'password'))) {
    await askPassword();
  }

  // Connect
  const captured = new Map<SecretKind, string>();
  const adapter = setupAdapter(await cliHostAdapter(ctx), () => typed, captured);
  let probe: ServerProbe | undefined;
  let refusals = 0;
  while (probe === undefined) {
    ctx.err(`Connecting to ${host()}...\n`);
    // The probe connects at the top of what the account sees; the root is picked afterwards.
    const attempt = draftServer(
      { ...draft, name: draft.name ?? defaultServerName(draft), remoteRoot: draft.remoteRoot?.startsWith('/') === true ? draft.remoteRoot : '/' },
      serverId,
    );
    // A password typed here is the one sent: not a saved one, and not SYNC_SERVERS_PASSWORD.
    if (typed !== undefined && attempt.auth !== undefined) {
      attempt.auth.savePassword = false;
    }
    try {
      probe = await ServerProbe.open({
        site: setup.site,
        server: attempt,
        host: adapter,
        updateServer: (change) => {
          change(draft as unknown as Server);
          return Promise.resolve();
        },
        env: typed === undefined ? ctx.io.env : { ...ctx.io.env, [PASSWORD_ENV]: undefined },
        logger: ctx.logger,
      });
    } catch (error) {
      if (!isSyncError(error)) {
        throw error;
      }
      ctx.err(`${error.message}\n`);
      const refused = isSyncError(error, 'E_AUTH') && (error.details?.reason === 'rejected' || error.details?.reason === 'missing');
      if (refused) {
        refusals += 1;
        if (refusals < 3) {
          await askUser();
          if (method === 'password') {
            await askPassword();
          }
          continue;
        }
      }
      const choice = await ask.choose<'retry' | 'host' | 'save' | 'cancel'>('What now?', [
        refused ? { label: 'Try again', value: 'retry' } : { label: 'Change the host', value: 'host' },
        { label: 'Save without testing', value: 'save' },
        { label: 'Cancel', value: 'cancel' },
      ]);
      if (choice === 'cancel') {
        throw new CancelledError(NOTHING_SAVED);
      }
      if (choice === 'save') {
        break;
      }
      if (choice === 'retry') {
        refusals = 0;
        await askUser();
        if (method === 'password') {
          await askPassword();
        }
      } else {
        await askHost();
      }
    }
  }

  if (probe === undefined) {
    if (draft.remoteRoot === undefined || !draft.remoteRoot.startsWith('/')) {
      draft.remoteRoot = await ask.askValid(
        'Root directory on the server',
        (answer) => (answer.startsWith('/') ? undefined : 'Enter a path that starts with "/".'),
        draft.remoteRoot?.startsWith('/') === true ? draft.remoteRoot : '/',
      );
    }
    await askRootDeletes(ctx, draft, setup.values);
    return finish('untested');
  }

  try {
    const start = probe.startingFolder ?? '/';
    const intro = `Signed in${draft.username === undefined ? '' : ` as ${safeLine(draft.username)}`}.`;
    const wanted = draft.remoteRoot === undefined ? undefined : resolveRemoteFolder(draft.remoteRoot, start);
    if (wanted !== undefined && (rootGiven || found.rootFromHost) && (await probe.exists(wanted))) {
      draft.remoteRoot = wanted;
    } else if (wanted !== undefined && editing && (await probe.exists(wanted))) {
      draft.remoteRoot = await chooseRemoteRoot(ctx, probe, wanted, intro);
    } else {
      if (wanted !== undefined && (rootGiven || found.rootFromHost || editing)) {
        ctx.err(`The remote root ${safeLine(wanted)} was not found on ${safeLine(draft.host ?? '')}.\n`);
      }
      draft.remoteRoot = await chooseRemoteRoot(ctx, probe, start, intro);
    }
  } finally {
    await probe.close();
  }
  await askRootDeletes(ctx, draft, setup.values);

  // Save the password the server accepted.
  const secret = typed ?? captured.get(kind);
  let save: GuidedResult['save'];
  if (secret !== undefined && method !== 'agent') {
    const what = kind === 'password' ? 'password' : 'key passphrase';
    const store = await ctx.credentialStore();
    if (store === undefined) {
      ctx.err(`The ${what} is asked for when connecting (${ctx.credentialStoreProblem()}).\n`);
    } else if (await ask.confirm(`Save the ${what} in the ${store.name}?`, true)) {
      draft.auth = { method, ...(draft.auth?.keyPath === undefined ? {} : { keyPath: draft.auth.keyPath }), savePassword: true };
      save = { kind, secret };
    }
  }
  return finish('tested', save);
}

/** Asks once whether deletes are allowed when the root is the top of what the account sees, unless an option said. */
async function askRootDeletes(ctx: CommandContext, draft: ServerDraft, values: OptionValues): Promise<void> {
  if (draft.protocol === undefined || draft.remoteRoot === undefined || booleanOption(values, 'allow-root-deletes') !== undefined) {
    return;
  }
  if (!remoteRootIsTop({ protocol: draft.protocol, remoteRoot: draft.remoteRoot })) {
    return;
  }
  const allow = await ctx.prompter.confirm(
    `"${safeLine(draft.remoteRoot)}" is the top of what this account can see. Let synchronizing delete files there?\nEvery delete is listed in the preview first.`,
    draft.options.allowRootDeletes === true,
  );
  if (allow) {
    draft.options.allowRootDeletes = true;
  } else {
    delete draft.options.allowRootDeletes;
  }
}

/**
 * Keeps a secret the person chose to save, sealed for the server as saved,
 * after the server itself was saved. A failure is a warning: the password is
 * then asked for when connecting.
 */
export async function storeTypedSecret(ctx: CommandContext, siteId: string, server: Server, save: GuidedResult['save']): Promise<void> {
  if (save === undefined) {
    return;
  }
  const store = await ctx.credentialStore();
  if (store === undefined) {
    return;
  }
  const what = save.kind === 'password' ? 'password' : 'key passphrase';
  try {
    await store.set({ siteId, serverId: server.id, kind: save.kind }, sealSecret(save.secret, server));
    ctx.logger.info('Secret saved', { siteId, serverId: server.id, kind: save.kind, store: store.name });
    if (!ctx.flags.json) {
      ctx.out(`Saved the ${what} in the ${store.name}.\n`);
    }
  } catch (error) {
    ctx.err(`warning: the ${what} was not saved: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
