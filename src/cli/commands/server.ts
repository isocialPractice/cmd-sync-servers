import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { NewServer } from '../../config/registry.ts';
import { formatIssues, serverSchema, type Server, type Site } from '../../config/schema.ts';
import { booleanOption, flag, stringOption, type CommandSpec, type OptionSpecs, type OptionValues } from '../command.ts';
import type { CommandContext } from '../context.ts';
import { editJsonUntilValid } from '../editor.ts';
import { CancelledError, UsageError } from '../errors.ts';
import { formatTable } from '../output.ts';
import {
  applyServerOptions,
  checkUnattended,
  defaultServerName,
  guidedServer,
  hasServerFieldOptions,
  SERVER_FIELD_OPTIONS,
  serverNameProblem,
  storeTypedSecret,
  type GuidedResult,
  type ServerDraft,
} from '../setup.ts';
import { describeServer, forgetSecrets, protocolLabel, serverAddress, serverSummary } from './shared.ts';

const ROLE_OPTIONS: OptionSpecs = {
  remote: { type: 'boolean', description: "Make it the site's Remote server, used to synchronize" },
  testing: { type: 'boolean', description: "Make it the site's Testing server" },
};

/** True when commands may ask questions and connect: a terminal, and no `--json`. */
export function guided(ctx: CommandContext): boolean {
  return ctx.interactive && !ctx.flags.json;
}

/** A sentence for a server that was saved without connecting, or nothing. */
export function connectionNote(connection: GuidedResult['connection']): string {
  return connection === 'untested' ? ' The connection was not tested.' : '';
}

/** A server from options alone, for unattended runs, named after its host when no name is given. */
export function unattendedServer(ctx: CommandContext, site: Pick<Site, 'name' | 'servers'>, values: OptionValues): ServerDraft {
  const draft: ServerDraft = { options: {} };
  const applied = applyServerOptions(draft, values, ctx);
  for (const line of [...applied.notes, ...applied.warnings]) {
    ctx.err(`warning: ${line}\n`);
  }
  checkUnattended(draft);
  draft.name ??= defaultServerName(draft);
  const problem = serverNameProblem(site.name, site.servers, draft.name);
  if (problem !== undefined) {
    throw new UsageError(problem);
  }
  return draft;
}

/** Adds a server from options, asking for the rest and connecting first when a person can answer. */
export async function addServerFromOptions(ctx: CommandContext, site: Site, values: OptionValues): Promise<Server> {
  const name = stringOption(values, 'name');
  if (name !== undefined) {
    const problem = serverNameProblem(site.name, site.servers, name);
    if (problem !== undefined) {
      throw new UsageError(problem);
    }
  }
  const registry = await ctx.registry();
  let result: GuidedResult | undefined;
  let input: NewServer;
  if (guided(ctx)) {
    result = await guidedServer(ctx, { mode: 'server-add', site, servers: site.servers, serverId: randomUUID(), values });
    input = result.server;
  } else {
    input = unattendedServer(ctx, site, values) as NewServer;
  }
  const server = await registry.addServer(site.id, input);
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
  await storeTypedSecret(ctx, site.id, server, result?.save);
  const updated = registry.get(site.id) ?? site;
  const roles = [
    ...(updated.remoteServerId === server.id ? ['Remote'] : []),
    ...(updated.testingServerId === server.id ? ['Testing'] : []),
  ];
  if (ctx.flags.json) {
    ctx.json('server', { siteId: site.id, server: serverSummary(updated, server) });
  } else {
    const role = roles.length === 0 ? '' : ` It is the ${roles.join(' and ')} server.`;
    ctx.out(`Added server ${describeServer(server)} to "${site.name}".${role}${connectionNote(result?.connection ?? 'tested')}\n`);
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
        ['Name', 'Host', 'Protocol', 'Remote', 'Testing'],
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
  summary: 'Add a server to a site; in a terminal, connect first and pick the root from the server',
  options: { ...SERVER_FIELD_OPTIONS, ...ROLE_OPTIONS },
  examples: [
    'sync-servers server add',
    'sync-servers server add --name Production --host sftp.example.com --user demo-user --remote-root /var/www/my-site',
    'sync-servers server add --name Staging --host ftpes://ftp.example.org --user demo-user --remote-root /public --testing',
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
  summary: 'Change a server: asks again in a terminal, or takes options, or JSON in your editor',
  options: {
    ...SERVER_FIELD_OPTIONS,
    'forget-host-key': { type: 'boolean', description: 'Remove the pinned SSH host key, after checking the new one with the host' },
    'forget-certificate': { type: 'boolean', description: 'Remove the trusted TLS certificate; the next connection verifies it again' },
    editor: { type: 'boolean', description: 'Edit the whole server as JSON in your editor' },
  },
  examples: [
    'sync-servers server edit Production',
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
    if (flag(values, 'editor')) {
      return editServerInEditor(ctx, site, server);
    }
    if (!changing) {
      if (!guided(ctx)) {
        throw new UsageError('Nothing to change. Pass an option such as --host, run in a terminal to be asked, or pass --editor.');
      }
      return editServerByQuestions(ctx, site, server);
    }
    const name = stringOption(values, 'name');
    if (name !== undefined) {
      const problem = serverNameProblem(site.name, site.servers, name, server.id);
      if (problem !== undefined) {
        throw new UsageError(problem);
      }
    }
    const told: string[] = [];
    const updated = await (await ctx.registry()).updateServer(site.id, server.id, (draft) => {
      const applied = applyServerOptions(draft, values, ctx);
      told.splice(0, told.length, ...applied.notes, ...applied.warnings);
      if (flag(values, 'forget-host-key')) {
        delete draft.options.hostKey;
      }
      if (forgetCertificate && draft.options.tls !== undefined) {
        delete draft.options.tls.trustedCertificate;
      }
    });
    for (const line of told) {
      ctx.err(`warning: ${line}\n`);
    }
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

/** `server edit` in a terminal with no options: the setup questions again, with the current values as defaults. */
async function editServerByQuestions(ctx: CommandContext, site: Site, server: Server): Promise<undefined> {
  const result = await guidedServer(ctx, { mode: 'server-edit', site, servers: site.servers, existing: server, serverId: server.id, values: {} });
  const updated = await (await ctx.registry()).replaceServer(site.id, server.id, result.server);
  await storeTypedSecret(ctx, site.id, updated, result.save);
  ctx.out(`Updated server ${describeServer(updated)}.${connectionNote(result.connection)}\n`);
  return undefined;
}

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
      const problem = serverNameProblem(site.name, site.servers, result.data.name, id);
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
