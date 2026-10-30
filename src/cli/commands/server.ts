import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { NewServer } from '../../config/registry.ts';
import { defaultPort, formatIssues, PROTOCOLS, serverSchema, type Protocol, type Server, type Site } from '../../config/schema.ts';
import {
  booleanOption,
  choiceOption,
  flag,
  integerOption,
  stringOption,
  type CommandSpec,
  type OptionSpecs,
  type OptionValues,
} from '../command.ts';
import type { CommandContext } from '../context.ts';
import { editJsonUntilValid } from '../editor.ts';
import { CancelledError, UsageError } from '../errors.ts';
import { formatTable } from '../output.ts';
import { offerToSaveSecret } from './password.ts';
import { describeServer, forgetSecrets, protocolLabel, serverAddress, serverSummary } from './shared.ts';

/** The server fields every `server add` and `server edit` option sets. */
export const SERVER_FIELD_OPTIONS: OptionSpecs = {
  name: { type: 'string', value: '<name>', description: 'The server name, unique within the site' },
  protocol: { type: 'string', value: '<protocol>', description: 'sftp (default), ftps, ftps-implicit, ftp or local' },
  host: { type: 'string', value: '<host>', description: 'The server address' },
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

const ROLE_OPTIONS: OptionSpecs = {
  remote: { type: 'boolean', description: "Make it the site's Remote server, used to synchronize" },
  testing: { type: 'boolean', description: "Make it the site's Testing server" },
};

type AuthMethod = 'password' | 'key' | 'agent';

/** A server being built or edited from options and answers. */
interface ServerDraft {
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

export function hasServerFieldOptions(values: OptionValues): boolean {
  return Object.keys(SERVER_FIELD_OPTIONS).some((name) => values[name] !== undefined);
}

function sameName(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
}

function serverNameProblem(site: Site, name: string, exceptId?: string): string | undefined {
  if (name.trim() === '') {
    return 'Enter a name.';
  }
  const clash = site.servers.find((server) => server.id !== exceptId && sameName(server.name, name.trim()));
  return clash === undefined ? undefined : `Site "${site.name}" already has a server named "${clash.name}".`;
}

/** Copies the server options that were given onto `draft`. */
function applyServerOptions(draft: ServerDraft, values: OptionValues, cwd: string): void {
  const text = (name: string): string | undefined => stringOption(values, name);
  const name = text('name');
  if (name !== undefined) {
    draft.name = name;
  }
  const protocol = choiceOption(values, 'protocol', PROTOCOLS);
  if (protocol !== undefined) {
    draft.protocol = protocol;
  }
  const host = text('host');
  if (host !== undefined) {
    draft.host = host;
  }
  const port = integerOption(values, 'port', 1, 65535);
  if (port !== undefined) {
    draft.port = port;
  }
  const user = text('user');
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
      draft.auth.keyPath = path.resolve(cwd, keyPath);
    }
    if (savePassword !== undefined) {
      draft.auth.savePassword = savePassword;
    }
  }
  const remoteRoot = text('remote-root');
  if (remoteRoot !== undefined) {
    draft.remoteRoot = remoteRoot;
  }
  const webUrl = text('web-url');
  if (webUrl !== undefined) {
    draft.webUrl = webUrl;
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
      options.tls.caFile = path.resolve(cwd, caFile);
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
}

const PROTOCOL_CHOICES: readonly { label: string; value: Protocol }[] = [
  { label: 'SFTP (recommended)', value: 'sftp' },
  { label: 'FTPS, explicit TLS', value: 'ftps' },
  { label: 'FTPS, implicit TLS', value: 'ftps-implicit' },
  { label: 'FTP, insecure: sends the password in clear text', value: 'ftp' },
  { label: 'Local or network folder', value: 'local' },
];

/** Asks for the fields still missing; with `full`, also the optional ones. */
async function promptServer(ctx: CommandContext, site: Site, draft: ServerDraft, full: boolean): Promise<void> {
  const ask = ctx.prompter;
  draft.name ??= await ask.askValid('Server name', (answer) => serverNameProblem(site, answer));
  draft.protocol ??= full ? await ask.choose('Connect using', PROTOCOL_CHOICES) : 'sftp';
  if (draft.protocol === 'ftp' && draft.options.allowInsecure !== true) {
    if (!(await ask.confirm('Plain FTP sends your password in clear text. Use it anyway?', false))) {
      throw new CancelledError('Nothing was added. Choose SFTP or FTPS instead.');
    }
    draft.options.allowInsecure = true;
  }
  if (draft.protocol === 'local') {
    draft.remoteRoot ??= await ask.askValid('Folder (local, mounted or network path)', (answer) =>
      path.isAbsolute(answer) ? undefined : 'Enter an absolute path.',
    );
    return;
  }
  const protocol = draft.protocol;
  draft.host ??= await ask.askValid('Address', (answer) => (answer === '' ? 'Enter the server address.' : undefined));
  if (full && draft.port === undefined) {
    const port = Number(
      await ask.askValid(
        'Port',
        (answer) => (/^\d+$/.test(answer) && Number(answer) >= 1 && Number(answer) <= 65535 ? undefined : 'Enter a port from 1 to 65535.'),
        String(defaultPort(protocol)),
      ),
    );
    if (port !== defaultPort(protocol)) {
      draft.port = port;
    }
  }
  if (full && draft.username === undefined) {
    const user = await ask.ask('Username');
    if (user !== '') {
      draft.username = user;
    }
  }
  if (full && draft.auth === undefined && protocol === 'sftp') {
    const method = await ask.choose<AuthMethod>('Sign in with', [
      { label: 'Password', value: 'password' },
      { label: 'Private key file', value: 'key' },
      { label: 'SSH agent', value: 'agent' },
    ]);
    draft.auth = { method };
    if (method === 'key') {
      const keyPath = await ask.askValid('Private key file', (answer) =>
        existsSync(path.resolve(ctx.io.cwd, answer)) ? undefined : 'File not found.',
      );
      draft.auth.keyPath = path.resolve(ctx.io.cwd, keyPath);
    }
  }
  draft.remoteRoot ??= await ask.askValid(
    'Root directory on the server',
    (answer) => (answer.startsWith('/') ? undefined : 'Enter an absolute path that starts with "/".'),
    '/',
  );
  if (full && draft.webUrl === undefined) {
    const url = await ask.askValid('Web URL (optional)', (answer) =>
      answer === '' || URL.canParse(answer) ? undefined : 'Enter a full address, such as https://www.example.com/.',
    );
    if (url !== '') {
      draft.webUrl = url;
    }
  }
}

/** Adds a server from options, asking for whatever is missing when a person can answer. */
export async function addServerFromOptions(ctx: CommandContext, site: Site, values: OptionValues): Promise<Server> {
  const draft: ServerDraft = { options: {} };
  applyServerOptions(draft, values, ctx.io.cwd);
  if (draft.name !== undefined) {
    const problem = serverNameProblem(site, draft.name);
    if (problem !== undefined) {
      throw new UsageError(problem);
    }
  }
  if (ctx.interactive) {
    await promptServer(ctx, site, draft, !hasServerFieldOptions(values));
  } else {
    draft.protocol ??= 'sftp';
    const missing = [
      ...(draft.name === undefined ? ['--name'] : []),
      ...(draft.protocol !== 'local' && draft.host === undefined ? ['--host'] : []),
      ...(draft.remoteRoot === undefined ? ['--remote-root'] : []),
    ];
    if (missing.length > 0) {
      throw new UsageError(`Missing ${missing.join(', ')}. Pass them as options, or run in a terminal to be asked.`);
    }
    if (draft.protocol === 'ftp' && draft.options.allowInsecure !== true) {
      throw new UsageError('Plain FTP sends the password in clear text. Pass --allow-insecure to use it anyway, or use --protocol sftp or ftps.');
    }
  }

  const registry = await ctx.registry();
  const server = await registry.addServer(site.id, draft as NewServer);
  if (flag(values, 'remote') || flag(values, 'testing')) {
    await registry.update(site.id, (target) => {
      if (flag(values, 'remote')) {
        target.remoteServerId = server.id;
      }
      if (flag(values, 'testing')) {
        target.testingServerId = server.id;
      }
    });
  }
  const updated = registry.get(site.id) ?? site;
  const roles = [
    ...(updated.remoteServerId === server.id ? ['Remote'] : []),
    ...(updated.testingServerId === server.id ? ['Testing'] : []),
  ];
  if (ctx.flags.json) {
    ctx.json('server', { siteId: site.id, server: serverSummary(updated, server) });
  } else {
    const role = roles.length === 0 ? '' : ` It is the ${roles.join(' and ')} server.`;
    ctx.out(`Added server ${describeServer(server)} to "${site.name}".${role}\n`);
  }
  if (ctx.interactive && !ctx.flags.json) {
    await offerToSaveSecret(ctx, updated, server);
  }
  return server;
}

export const serverListCommand: CommandSpec = {
  path: ['server', 'list'],
  summary: "List a site's servers",
  examples: ['sync-servers server list', 'sync-servers server list --site "My Site" --json'],
  async run(ctx) {
    const site = await ctx.chooseSite();
    if (ctx.flags.json) {
      ctx.json('servers', { siteId: site.id, servers: site.servers.map((server) => serverSummary(site, server)) });
      return undefined;
    }
    if (site.servers.length === 0) {
      ctx.out(`Site "${site.name}" has no servers. Add one with "sync-servers server add".\n`);
      return undefined;
    }
    const mark = (on: boolean): string => (on ? '(*)' : '( )');
    ctx.out(
      formatTable(
        ['Name', 'Address', 'Connection', 'Remote', 'Testing'],
        site.servers.map((server) => [
          server.name,
          serverAddress(server),
          protocolLabel(server.protocol),
          mark(site.remoteServerId === server.id),
          mark(site.testingServerId === server.id),
        ]),
      ),
    );
    return undefined;
  },
};

export const serverAddCommand: CommandSpec = {
  path: ['server', 'add'],
  summary: 'Add a server to a site',
  options: { ...SERVER_FIELD_OPTIONS, ...ROLE_OPTIONS },
  examples: [
    'sync-servers server add',
    'sync-servers server add --name Production --host sftp.example.com --user demo-user --remote-root /var/www/my-site',
    'sync-servers server add --name Staging --protocol ftps --host ftp.example.org --user demo-user --remote-root /public --testing',
  ],
  async run(ctx, { values }) {
    await addServerFromOptions(ctx, await ctx.chooseSite(), values);
    return undefined;
  },
};

export const serverEditCommand: CommandSpec = {
  path: ['server', 'edit'],
  args: '[<server>]',
  maxArgs: 1,
  summary: 'Change a server, with options or as JSON in your editor',
  options: {
    ...SERVER_FIELD_OPTIONS,
    'forget-host-key': { type: 'boolean', description: 'Remove the pinned SSH host key, after checking the new one with the host' },
    'forget-certificate': { type: 'boolean', description: 'Remove the trusted TLS certificate; the next connection verifies it again' },
    editor: { type: 'boolean', description: 'Edit the whole server as JSON in your editor' },
  },
  examples: [
    'sync-servers server edit Production --port 2222',
    'sync-servers server edit Production --forget-host-key',
    'sync-servers server edit Production --forget-certificate',
    'sync-servers server edit --editor',
  ],
  async run(ctx, { values, args }) {
    const site = await ctx.chooseSite();
    const server = await ctx.chooseServer(site, args[0]);
    const forgetCertificate = flag(values, 'forget-certificate');
    const changing = hasServerFieldOptions(values) || flag(values, 'forget-host-key') || forgetCertificate;
    if (flag(values, 'editor') || (!changing && ctx.interactive)) {
      return editServerInEditor(ctx, site, server);
    }
    if (!changing) {
      throw new UsageError('Nothing to change. Pass an option such as --host, or --editor.');
    }
    const name = stringOption(values, 'name');
    if (name !== undefined) {
      const problem = serverNameProblem(site, name, server.id);
      if (problem !== undefined) {
        throw new UsageError(problem);
      }
    }
    const updated = await (await ctx.registry()).updateServer(site.id, server.id, (draft) => {
      applyServerOptions(draft, values, ctx.io.cwd);
      if (flag(values, 'forget-host-key')) {
        delete draft.options.hostKey;
      }
      if (forgetCertificate && draft.options.tls !== undefined) {
        delete draft.options.tls.trustedCertificate;
      }
    });
    if (booleanOption(values, 'save-password') === false) {
      await forgetSecrets(ctx, site.id, [updated]);
    }
    if (ctx.flags.json) {
      ctx.json('server', { siteId: site.id, server: serverSummary(site, updated) });
    } else {
      const notes = [
        ...(flag(values, 'forget-host-key') ? [' Its host key will be confirmed on the next connection.'] : []),
        ...(forgetCertificate && server.options.tls?.trustedCertificate !== undefined ? [' Its certificate will be verified again on the next connection.'] : []),
      ];
      ctx.out(`Updated server ${describeServer(updated)}.${notes.join('')}\n`);
    }
    return undefined;
  },
};

async function editServerInEditor(ctx: CommandContext, site: Site, server: Server): Promise<undefined> {
  const { id, ...editable } = server;
  const edited = await editJsonUntilValid(
    editable,
    [
      `sync-servers: edit the server "${server.name}" of "${site.name}", then save and close the editor.`,
      'Delete everything, or close without saving, to cancel. Passwords are never stored here.',
    ],
    (parsed) => {
      const result = serverSchema.safeParse(typeof parsed === 'object' && parsed !== null ? { ...parsed, id } : parsed);
      if (!result.success) {
        return { ok: false, errors: formatIssues(result.error.issues) };
      }
      const problem = serverNameProblem(site, result.data.name, id);
      return problem === undefined ? { ok: true, value: result.data } : { ok: false, errors: [`name: ${problem}`] };
    },
    ctx.io,
    'server.json',
  );
  if (edited === undefined) {
    ctx.err('No changes.\n');
    return undefined;
  }
  const updated = await (await ctx.registry()).replaceServer(site.id, id, edited);
  if (ctx.flags.json) {
    ctx.json('server', { siteId: site.id, server: serverSummary(site, updated) });
  } else {
    ctx.out(`Updated server ${describeServer(updated)}.\n`);
  }
  return undefined;
}

export const serverRemoveCommand: CommandSpec = {
  path: ['server', 'remove'],
  args: '<server>',
  minArgs: 1,
  maxArgs: 1,
  summary: 'Remove a server, its saved passwords and its sync records',
  options: {
    yes: { type: 'boolean', short: 'y', description: 'Do not ask for confirmation' },
  },
  examples: ['sync-servers server remove Staging', 'sync-servers server remove Staging --site "My Site" --yes'],
  async run(ctx, { values, args }) {
    const site = await ctx.chooseSite();
    const server = await ctx.chooseServer(site, args[0]);
    if (!flag(values, 'yes')) {
      if (!ctx.interactive) {
        throw new UsageError('Pass --yes to remove a server without a terminal.');
      }
      if (!(await ctx.prompter.confirm(`Remove the server ${describeServer(server)} from "${site.name}"?`, false))) {
        throw new CancelledError('Nothing was removed.');
      }
    }
    await (await ctx.registry()).removeServer(site.id, server.id);
    await forgetSecrets(ctx, site.id, [server]);
    await rm(path.join(ctx.paths.stateDir, 'sites', site.id, `${server.id}.json`), { force: true });
    if (ctx.flags.json) {
      ctx.json('server-removed', { siteId: site.id, serverId: server.id, name: server.name });
    } else {
      ctx.out(`Removed the server "${server.name}" from "${site.name}". The files on the server were not touched.\n`);
    }
    return undefined;
  },
};

export const serverSetRemoteCommand: CommandSpec = {
  path: ['server', 'set-remote'],
  args: '<server>',
  minArgs: 1,
  maxArgs: 1,
  summary: 'Make a server the one synchronization uses',
  examples: ['sync-servers server set-remote Production'],
  async run(ctx, { args }) {
    const site = await ctx.chooseSite();
    const server = await ctx.chooseServer(site, args[0]);
    await (await ctx.registry()).update(site.id, (target) => {
      target.remoteServerId = server.id;
    });
    ctx.out(`"${server.name}" is now the Remote server of "${site.name}".\n`);
    return undefined;
  },
};

export const serverSetTestingCommand: CommandSpec = {
  path: ['server', 'set-testing'],
  args: '[<server>]',
  maxArgs: 1,
  summary: 'Make a server the Testing server, or clear the role',
  options: {
    clear: { type: 'boolean', description: 'Leave the site without a Testing server' },
  },
  examples: ['sync-servers server set-testing Staging', 'sync-servers server set-testing --clear'],
  async run(ctx, { values, args }) {
    const site = await ctx.chooseSite();
    if (flag(values, 'clear')) {
      if (args.length > 0) {
        throw new UsageError('Pass a server or --clear, not both.');
      }
      await (await ctx.registry()).update(site.id, (target) => {
        delete target.testingServerId;
      });
      ctx.out(`"${site.name}" has no Testing server now.\n`);
      return undefined;
    }
    if (args[0] === undefined) {
      throw new UsageError('Name the server, or pass --clear.');
    }
    const server = await ctx.chooseServer(site, args[0]);
    await (await ctx.registry()).update(site.id, (target) => {
      target.testingServerId = server.id;
    });
    ctx.out(`"${server.name}" is now the Testing server of "${site.name}".\n`);
    return undefined;
  },
};
