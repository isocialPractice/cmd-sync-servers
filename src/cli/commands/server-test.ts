import path from 'node:path';
import { parseServerAddress } from '../../config/address.ts';
import { defaultPort, type Server, type Site } from '../../config/schema.ts';
import { PASSWORD_ENV } from '../../credentials/env.ts';
import { isSyncError, type SyncError } from '../../errors.ts';
import { remoteRootIsTop } from '../../sync/session.ts';
import { ROOT } from '../../sync/paths.ts';
import { safeLine } from '../../terminal-text.ts';
import { createTransport } from '../../transport/index.ts';
import { ServerProbe } from '../../transport/probe.ts';
import type { Capabilities } from '../../transport/types.ts';
import { stringOption, type CommandSpec, type OptionValues } from '../command.ts';
import type { CommandContext } from '../context.ts';
import { cliHostAdapter, rememberTypedSecrets, type RememberingAdapter } from '../host.ts';
import { formatPairs, paint } from '../output.ts';
import { chooseRemoteRoot } from '../remote-root.ts';
import { hostText } from '../setup.ts';
import { guided } from './server.ts';
import { describeServer } from './shared.ts';
import { trustedCertificateOption } from './sync.ts';

function precision(capabilities: Capabilities): string {
  if (capabilities.mtimePrecisionMs === undefined) {
    return 'not in listings; read file by file';
  }
  return capabilities.mtimePrecisionMs >= 1000 ? 'to the second' : 'to the millisecond';
}

/** The Node.js code under a connection error, such as `ENOTFOUND`. */
function causeCode(error: SyncError): string | undefined {
  const cause: unknown = error.cause;
  return typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined;
}

interface TestRun {
  readonly capabilities: Capabilities;
  readonly entries: number;
  readonly elapsedMs: number;
}

interface Attempt {
  /** After a refused sign-in, only a password typed now is sent: not the saved one, nor SYNC_SERVERS_PASSWORD. */
  typedOnly: boolean;
}

async function testOnce(ctx: CommandContext, site: Site, server: Server, host: RememberingAdapter, values: OptionValues, attempt: Attempt): Promise<TestRun> {
  const registry = await ctx.registry();
  const tried: Server = attempt.typedOnly && server.auth !== undefined ? { ...server, auth: { ...server.auth, savePassword: false } } : server;
  const transport = createTransport({
    site,
    server: tried,
    host,
    env: attempt.typedOnly ? { ...ctx.io.env, [PASSWORD_ENV]: undefined } : ctx.io.env,
    logger: ctx.logger,
    expectedHostKey: stringOption(values, 'host-key'),
    expectedCertificate: trustedCertificateOption(values),
    updateServer: async (change) => {
      await registry.updateServer(site.id, server.id, change);
    },
  });
  const started = Date.now();
  try {
    const capabilities = await transport.connect();
    const entries = (await transport.list(ROOT)).length;
    return { capabilities, entries, elapsedMs: Date.now() - started };
  } finally {
    await transport.close();
  }
}

/**
 * Offers a fix for what a test found, in a terminal: the user name and
 * password again after a refused sign-in, the root picked from what the
 * server shows when it was not found, or another host when the host was
 * not found or refused the connection. Saves the fix and resolves the
 * server as saved, or `undefined` when there is nothing to offer.
 */
async function repair(ctx: CommandContext, site: Site, server: Server, host: RememberingAdapter, error: SyncError, attempt: Attempt): Promise<Server | undefined> {
  const registry = await ctx.registry();
  const ask = ctx.prompter;
  if (error.code === 'E_AUTH' && error.details?.reason === 'rejected') {
    ctx.err(`${error.message}\n`);
    host.forget();
    attempt.typedOnly = true;
    const user = await ask.ask('User', server.username);
    if (user === (server.username ?? '')) {
      return server;
    }
    return registry.updateServer(site.id, server.id, (draft) => {
      if (user === '') {
        delete draft.username;
      } else {
        draft.username = user;
      }
    });
  }
  if (error.code === 'E_REMOTE_ROOT' && server.protocol !== 'local') {
    ctx.err(`${error.message}\n`);
    const probe = await ServerProbe.open({
      site,
      server,
      host,
      env: attempt.typedOnly ? { ...ctx.io.env, [PASSWORD_ENV]: undefined } : ctx.io.env,
      logger: ctx.logger,
      updateServer: async (change) => {
        await registry.updateServer(site.id, server.id, change);
      },
    });
    let root: string;
    try {
      root = await chooseRemoteRoot(ctx, probe, error.details?.startingFolder ?? probe.startingFolder ?? '/');
    } finally {
      await probe.close();
    }
    let allowRootDeletes = server.options.allowRootDeletes;
    if (remoteRootIsTop({ protocol: server.protocol, remoteRoot: root })) {
      allowRootDeletes = await ask.confirm(
        `"${safeLine(root)}" is the top of what this account can see. Let synchronizing delete files there?\nEvery delete is listed in the preview first.`,
        allowRootDeletes === true,
      );
    }
    return registry.updateServer(site.id, server.id, (draft) => {
      draft.remoteRoot = root;
      if (allowRootDeletes === true) {
        draft.options.allowRootDeletes = true;
      } else {
        delete draft.options.allowRootDeletes;
      }
    });
  }
  const code = causeCode(error);
  if (error.code === 'E_CONNECTION' && server.protocol !== 'local' && (code === 'ENOTFOUND' || code === 'EAI_NONAME' || code === 'EAI_NODATA' || code === 'ECONNREFUSED')) {
    ctx.err(`${error.message}\n`);
    const current = hostText(server);
    for (;;) {
      const answer = await ask.ask('Host', current);
      if (answer === current) {
        return undefined;
      }
      const parsed = parseServerAddress(answer);
      if (!parsed.ok) {
        ctx.err(`${parsed.problem}\n`);
        continue;
      }
      const address = parsed.address;
      if (address.warning !== undefined && !(await ask.confirm(`${address.warning} Continue?`, false))) {
        continue;
      }
      return registry.updateServer(site.id, server.id, (draft) => {
        if (address.protocol !== undefined) {
          draft.protocol = address.protocol;
        }
        draft.host = address.host;
        const protocol = draft.protocol === 'local' ? 'sftp' : draft.protocol;
        if (address.port === undefined || address.port === defaultPort(protocol)) {
          delete draft.port;
        } else {
          draft.port = address.port;
        }
        if (address.username !== undefined) {
          draft.username = address.username;
        }
      });
    }
  }
  return undefined;
}

export const serverTestCommand: CommandSpec = {
  path: ['server', 'test'],
  args: '[<server>]',
  maxArgs: 1,
  summary: 'Connect, sign in, check the remote root and show what the server offers; in a terminal, fix what it finds',
  options: {
    'host-key': { type: 'string', value: '<fingerprint>', description: 'Accept this SSH host key (SHA256:...) when it is not pinned yet, for scripts' },
    'trust-certificate': { type: 'string', value: '<sha256>', description: 'Accept this TLS certificate (SHA-256 fingerprint) when it does not verify, for scripts' },
  },
  examples: [
    'sync-servers server test',
    'sync-servers server test Production --site "My Site"',
    'sync-servers server test --host-key SHA256:<fingerprint>',
    'sync-servers server test --trust-certificate 3A:91:5C:<...>:C4',
  ],
  async run(ctx, { values, args }) {
    const site = await ctx.chooseSite();
    let server = await ctx.chooseServer(site, args[0]);
    const registry = await ctx.registry();
    const host = rememberTypedSecrets(await cliHostAdapter(ctx));
    const attempt: Attempt = { typedOnly: false };
    let run: TestRun | undefined;
    for (let fixes = 0; run === undefined; fixes += 1) {
      try {
        run = await testOnce(ctx, site, server, host, values, attempt);
      } catch (error) {
        if (!guided(ctx) || fixes >= 3 || !isSyncError(error)) {
          throw error;
        }
        const fixed = await repair(ctx, site, server, host, error, attempt);
        if (fixed === undefined) {
          throw error;
        }
        server = fixed;
      }
    }
    // Decisions made while connecting are saved; show the server as it is now.
    server = registry.get(site.id)?.servers.find((candidate) => candidate.id === server.id) ?? server;
    const { capabilities, entries, elapsedMs } = run;
    const hostKey = capabilities.hostKey;
    const pinned = server.options.hostKey;
    const hostKeyState = hostKey === undefined ? undefined : pinned?.sha256 === hostKey.sha256 ? 'pinned' : 'accepted for this connection only';
    const rootIsTop =
      server.protocol === 'local' ? path.parse(path.resolve(server.remoteRoot)).root === path.resolve(server.remoteRoot) : server.remoteRoot.replace(/\/+$/, '') === '';
    const warnings = [
      ...(rootIsTop && server.options.allowRootDeletes !== true
        ? ['The remote root is the top of the server; synchronizing will refuse to delete there unless allowRootDeletes is set.']
        : []),
      ...(server.protocol === 'ftp' ? ['Plain FTP sends the password and every file unencrypted.'] : []),
    ];
    ctx.logger.info('Server test passed', { siteId: site.id, serverId: server.id, protocol: server.protocol, elapsedMs });

    if (ctx.flags.json) {
      ctx.json('server-test', {
        siteId: site.id,
        serverId: server.id,
        protocol: capabilities.protocol,
        elapsedMs,
        remoteRoot: server.remoteRoot,
        startingFolder: capabilities.startingFolder ?? null,
        entries,
        hostKey: hostKey === undefined ? null : { algorithm: hostKey.algorithm, fingerprint: hostKey.fingerprint, state: hostKeyState },
        tls: capabilities.tls ?? null,
        software: capabilities.software ?? null,
        mtimePrecisionMs: capabilities.mtimePrecisionMs ?? null,
        canSetMtime: capabilities.canSetMtime,
        atomicReplace: capabilities.atomicReplace,
        features: capabilities.features,
        warnings,
      });
      return undefined;
    }
    ctx.out(`Connected to ${describeServer(server)} in ${String(elapsedMs)} ms.\n`);
    ctx.out(
      formatPairs([
        ...(hostKey === undefined ? [] : [['Host key', `${hostKey.algorithm} ${hostKey.fingerprint} (${hostKeyState ?? ''})`] as const]),
        ...(capabilities.tls === undefined ? [] : [['TLS', capabilities.tls] as const]),
        ...(capabilities.software === undefined || capabilities.software === '' ? [] : [['Server', safeLine(capabilities.software)] as const]),
        ...(capabilities.startingFolder === undefined ? [] : [['Start', `${safeLine(capabilities.startingFolder)}, where the account opens`] as const]),
        ['Root', `${server.remoteRoot}, a folder with ${String(entries)} entr${entries === 1 ? 'y' : 'ies'}`],
        ['Times', `${precision(capabilities)}${capabilities.canSetMtime ? '; can be set' : '; cannot be set'}`],
        ['Replace', capabilities.atomicReplace ? 'in one step' : 'remove, then rename'],
        ...(capabilities.features.length === 0 ? [] : [['Features', safeLine(capabilities.features.join(', '))] as const]),
      ]),
    );
    for (const warning of warnings) {
      ctx.err(`${paint('warn', 'yellow', ctx.color)}  ${warning}\n`);
    }
    return undefined;
  },
};
