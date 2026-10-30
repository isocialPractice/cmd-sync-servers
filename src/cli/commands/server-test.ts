import path from 'node:path';
import { ROOT } from '../../sync/paths.ts';
import { safeLine } from '../../terminal-text.ts';
import { createTransport } from '../../transport/index.ts';
import type { Capabilities } from '../../transport/types.ts';
import { stringOption, type CommandSpec } from '../command.ts';
import { cliHostAdapter } from '../host.ts';
import { formatPairs, paint } from '../output.ts';
import { describeServer } from './shared.ts';
import { trustedCertificateOption } from './sync.ts';

function precision(capabilities: Capabilities): string {
  if (capabilities.mtimePrecisionMs === undefined) {
    return 'not in listings; read file by file';
  }
  return capabilities.mtimePrecisionMs >= 1000 ? 'to the second' : 'to the millisecond';
}

export const serverTestCommand: CommandSpec = {
  path: ['server', 'test'],
  args: '[<server>]',
  maxArgs: 1,
  summary: 'Connect, sign in, check the remote root and show what the server offers',
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
    const server = await ctx.chooseServer(site, args[0]);
    const registry = await ctx.registry();
    const transport = createTransport({
      site,
      server,
      host: await cliHostAdapter(ctx),
      env: ctx.io.env,
      logger: ctx.logger,
      expectedHostKey: stringOption(values, 'host-key'),
      expectedCertificate: trustedCertificateOption(values),
      updateServer: async (change) => {
        await registry.updateServer(site.id, server.id, change);
      },
    });
    const started = Date.now();
    let capabilities: Capabilities;
    let entries: number;
    try {
      capabilities = await transport.connect();
      entries = (await transport.list(ROOT)).length;
    } finally {
      await transport.close();
    }
    const elapsedMs = Date.now() - started;
    const hostKey = capabilities.hostKey;
    const pinned = registry.get(site.id)?.servers.find((candidate) => candidate.id === server.id)?.options.hostKey;
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
