import { statSync } from 'node:fs';
import { defaultPort, type Protocol, type Server, type Site } from '../../config/schema.ts';
import type { SecretKind } from '../../credentials/types.ts';
import type { CommandContext } from '../context.ts';

export const SECRET_KINDS: readonly SecretKind[] = ['password', 'passphrase'];

const LABELS: Readonly<Record<Protocol, string>> = {
  sftp: 'SFTP',
  ftps: 'FTPS',
  'ftps-implicit': 'FTPS (implicit)',
  ftp: 'FTP (insecure)',
  local: 'Local/Network',
};

export function protocolLabel(protocol: Protocol): string {
  return LABELS[protocol];
}

/** `sftp.example.com`, `sftp.example.com:2222`, or the folder of a local server. */
export function serverAddress(server: Server): string {
  if (server.protocol === 'local') {
    return server.remoteRoot;
  }
  const host = server.host ?? '';
  return server.port === undefined || server.port === defaultPort(server.protocol) ? host : `${host}:${String(server.port)}`;
}

/** `Production (SFTP sftp.example.com)`. */
export function describeServer(server: Server): string {
  return `${server.name} (${protocolLabel(server.protocol)} ${serverAddress(server)})`;
}

/** A problem with `dir` as a local folder, or undefined when it is an existing folder. */
export function folderProblem(dir: string): string | undefined {
  try {
    return statSync(dir).isDirectory() ? undefined : `Not a folder: ${dir}`;
  } catch {
    return `Folder not found: ${dir}`;
  }
}

/** The example site folder for help text on this platform. */
export function exampleRoot(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'C:\\Users\\<user>\\Sites\\my-site' : '~/sites/my-site';
}

/** The fields of a site shown by `sites --json`. */
export function siteSummary(site: Site): Record<string, unknown> {
  const remote = site.servers.find((server) => server.id === site.remoteServerId);
  const testing = site.servers.find((server) => server.id === site.testingServerId);
  return {
    id: site.id,
    name: site.name,
    localRoot: site.localRoot,
    remoteServer: remote === undefined ? null : { id: remote.id, name: remote.name },
    testingServer: testing === undefined ? null : { id: testing.id, name: testing.name },
    serverCount: site.servers.length,
  };
}

/** The fields of a server shown by `server list --json`. Never contains a secret. */
export function serverSummary(site: Site, server: Server): Record<string, unknown> {
  return {
    id: server.id,
    name: server.name,
    protocol: server.protocol,
    host: server.host ?? null,
    port: server.protocol === 'local' ? null : (server.port ?? defaultPort(server.protocol)),
    username: server.username ?? null,
    remoteRoot: server.remoteRoot,
    remote: site.remoteServerId === server.id,
    testing: site.testingServerId === server.id,
    savePassword: server.auth?.savePassword ?? false,
    hostKeyPinned: server.options.hostKey !== undefined,
  };
}

/** Deletes every saved secret of these servers, reporting problems as warnings. */
export async function forgetSecrets(ctx: CommandContext, siteId: string, servers: readonly Server[]): Promise<void> {
  const store = await ctx.credentialStore();
  if (store === undefined) {
    return;
  }
  for (const server of servers) {
    for (const kind of SECRET_KINDS) {
      try {
        await store.delete({ siteId, serverId: server.id, kind });
      } catch (error) {
        ctx.err(`warning: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }
}
