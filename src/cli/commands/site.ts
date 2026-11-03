import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { NewServer } from '../../config/registry.ts';
import { formatIssues, siteSchema, type Site } from '../../config/schema.ts';
import { cloakingSummary } from '../../sync/cloak.ts';
import type { LinkPolicy } from '../../sync/paths.ts';
import { flag, booleanOption, choiceOption, stringOption, type CommandSpec, type OptionValues } from '../command.ts';
import type { CommandContext } from '../context.ts';
import { editJsonUntilValid } from '../editor.ts';
import { CancelledError, UsageError } from '../errors.ts';
import { formatPairs, formatTable } from '../output.ts';
import { guidedServer, hasServerFieldOptions, SERVER_FIELD_OPTIONS, storeTypedSecret } from '../setup.ts';
import { connectionNote, guided, unattendedServer } from './server.ts';
import { describeServer, folderProblem, forgetSecrets, localPath, normalizeWebUrl, protocolLabel, serverAddress, siteSummary } from './shared.ts';

function sameName(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
}

async function nameProblem(ctx: CommandContext, name: string, exceptId?: string): Promise<string | undefined> {
  if (name.trim() === '') {
    return 'Enter a name.';
  }
  const clash = (await ctx.registry()).list().find((site) => site.id !== exceptId && sameName(site.name, name.trim()));
  return clash === undefined ? undefined : `A site named "${clash.name}" already exists.`;
}

export const sitesCommand: CommandSpec = {
  path: ['sites'],
  summary: 'List the sites',
  examples: ['sync-servers sites', 'sync-servers sites --json'],
  async run(ctx) {
    const sites = (await ctx.registry()).list();
    if (ctx.flags.json) {
      ctx.json('sites', { sites: sites.map(siteSummary) });
      return undefined;
    }
    if (sites.length === 0) {
      ctx.out('No sites yet. Add one with "sync-servers site add".\n');
      return undefined;
    }
    ctx.out(
      formatTable(
        ['Name', 'Local root', 'Remote server'],
        sites.map((site) => [
          site.name,
          site.localRoot,
          site.servers.find((server) => server.id === site.remoteServerId)?.name ?? '-',
        ]),
      ),
    );
    return undefined;
  },
};

/** The server options, but `--name`, which names the site here; `--server-name` names the server. */
const SERVER_OPTIONS_FOR_SITE = Object.fromEntries(Object.entries(SERVER_FIELD_OPTIONS).filter(([option]) => option !== 'name'));

export const siteAddCommand: CommandSpec = {
  path: ['site', 'add'],
  summary: 'Add a site and its first server; in a terminal, connect first and pick the root from the server',
  options: {
    name: { type: 'string', value: '<name>', description: 'The site name, unique ignoring case' },
    'local-root': { type: 'string', value: '<folder>', description: 'The local site folder, which must exist' },
    'server-name': { type: 'string', value: '<name>', description: 'The name of the first server (default: its host)' },
    ...SERVER_OPTIONS_FOR_SITE,
  },
  examples: [
    'sync-servers site add',
    'sync-servers site add --name "My Site" --local-root {root} --protocol ftps --host 203.0.113.10 --user demo-user@example.com',
    'sync-servers site add --name "My Site" --local-root {root} --host sftp.example.com --user demo-user --remote-root /var/www/my-site',
  ],
  async run(ctx, { values }) {
    let name = stringOption(values, 'name');
    const rootOption = stringOption(values, 'local-root');
    const serverValues: OptionValues = { ...values, name: values['server-name'] };
    const withServer = hasServerFieldOptions(serverValues);
    if (!guided(ctx)) {
      if (name === undefined || rootOption === undefined) {
        throw new UsageError('Pass --name and --local-root, or run in a terminal to be asked.');
      }
      const root = localPath(rootOption, ctx);
      const problem = (await nameProblem(ctx, name)) ?? folderProblem(root);
      if (problem !== undefined) {
        throw new UsageError(problem);
      }
      const server = withServer ? unattendedServer(ctx, { name, servers: [] }, serverValues) : undefined;
      const site = await (await ctx.registry()).add({ name, localRoot: root, ...(server === undefined ? {} : { servers: [server as NewServer] }) });
      if (ctx.flags.json) {
        ctx.json('site', { site });
        return undefined;
      }
      const first = site.servers[0];
      ctx.out(
        first === undefined
          ? `Added site "${site.name}" at ${site.localRoot}. Add a server with "sync-servers server add".\n`
          : `Added site "${site.name}" with the server ${describeServer(first)}. It is the Remote server. The connection was not tested.\n`,
      );
      return undefined;
    }
    const sites = (await ctx.registry()).list();
    name ??= await ctx.prompter.askValid('Site name', (answer) =>
      answer === '' ? 'Enter a name.' : sites.some((site) => sameName(site.name, answer)) ? `A site named "${answer}" already exists.` : undefined,
    );
    const problem = await nameProblem(ctx, name);
    if (problem !== undefined) {
      throw new UsageError(problem);
    }
    const root =
      rootOption === undefined
        ? localPath(await ctx.prompter.askValid('Local site folder', (answer) => folderProblem(localPath(answer, ctx)), ctx.io.cwd), ctx)
        : localPath(rootOption, ctx);
    const rootProblem = folderProblem(root);
    if (rootProblem !== undefined) {
      throw new UsageError(rootProblem);
    }
    const siteId = randomUUID();
    const result = await guidedServer(ctx, { mode: 'site-add', site: { id: siteId, name }, servers: [], serverId: randomUUID(), values: serverValues });
    const site = await (await ctx.registry()).add({ id: siteId, name, localRoot: root, servers: [result.server] });
    const server = site.servers[0] ?? result.server;
    await storeTypedSecret(ctx, site.id, server, result.save);
    ctx.out(
      [
        `Added site "${site.name}" with the server ${server.name} (${protocolLabel(server.protocol)}). It is the Remote server.${connectionNote(result.connection)}`,
        `Next: cd "${site.localRoot}", then "sync-servers sync --put" to preview what would be put.`,
        '',
      ].join('\n'),
    );
    return undefined;
  },
};

const SITE_EDIT_OPTIONS = ['name', 'local-root', 'web-url', 'case-sensitive', 'cache', 'symlinks'] as const;

const LINK_POLICIES: readonly LinkPolicy[] = ['skip', 'follow-inside-root', 'follow'];

/** How `site show` names a link policy. */
const LINK_POLICY_NAMES: Readonly<Record<LinkPolicy, string>> = {
  skip: 'skipped',
  'follow-inside-root': 'followed inside the site',
  follow: 'followed everywhere',
};

export const siteEditCommand: CommandSpec = {
  path: ['site', 'edit'],
  args: '[<site>]',
  maxArgs: 1,
  summary: 'Change a site, with options or as JSON in your editor',
  options: {
    name: { type: 'string', value: '<name>', description: 'Rename the site' },
    'local-root': { type: 'string', value: '<folder>', description: 'Move the local site folder' },
    'web-url': { type: 'string', value: '<url>', description: 'The local web address, such as http://localhost:8080/' },
    'case-sensitive': { type: 'boolean', description: 'Treat file names as case-sensitive (--no-case-sensitive to turn off)' },
    cache: { type: 'boolean', description: 'Cache local scans between runs (--no-cache to turn off)' },
    symlinks: {
      type: 'string',
      value: '<policy>',
      description: 'Symbolic links in the local folder: skip them (skip), follow those inside the site (follow-inside-root), or follow all (follow)',
    },
    editor: { type: 'boolean', description: 'Edit the whole site as JSON in your editor' },
  },
  examples: [
    'sync-servers site edit "My Site" --name "Sample App"',
    'sync-servers site edit --local-root {root}',
    'sync-servers site edit --symlinks follow-inside-root',
    'sync-servers site edit --editor',
  ],
  async run(ctx, { values, args }) {
    const site = await ctx.chooseSite(args[0]);
    const changing = SITE_EDIT_OPTIONS.some((name) => values[name] !== undefined);
    if (flag(values, 'editor') || (!changing && ctx.interactive)) {
      return editSiteInEditor(ctx, site);
    }
    if (!changing) {
      throw new UsageError('Nothing to change. Pass an option such as --name, or --editor.');
    }
    const name = stringOption(values, 'name');
    const localRoot = stringOption(values, 'local-root');
    const root = localRoot === undefined ? undefined : localPath(localRoot, ctx);
    const problem = (name === undefined ? undefined : await nameProblem(ctx, name, site.id)) ?? (root === undefined ? undefined : folderProblem(root));
    if (problem !== undefined) {
      throw new UsageError(problem);
    }
    const webUrlOption = stringOption(values, 'web-url');
    const webUrl = webUrlOption === undefined ? undefined : normalizeWebUrl(webUrlOption).replace(/^https:\/\/(localhost|127\.0\.0\.1)\b/, 'http://$1');
    const caseSensitive = booleanOption(values, 'case-sensitive');
    const cache = booleanOption(values, 'cache');
    const symlinks = choiceOption(values, 'symlinks', LINK_POLICIES);
    const updated = await (await ctx.registry()).update(site.id, (draft) => {
      if (name !== undefined) {
        draft.name = name;
      }
      if (root !== undefined) {
        draft.localRoot = root;
      }
      if (webUrl !== undefined) {
        draft.local.webUrl = webUrl;
      }
      if (caseSensitive !== undefined) {
        draft.local.caseSensitive = caseSensitive;
      }
      if (cache !== undefined) {
        draft.local.cache = cache;
      }
      if (symlinks !== undefined) {
        draft.sync.symlinks = symlinks;
      }
    });
    if (ctx.flags.json) {
      ctx.json('site', { site: updated });
    } else {
      ctx.out(`Updated site "${updated.name}".\n`);
    }
    return undefined;
  },
};

async function editSiteInEditor(ctx: CommandContext, site: Site): Promise<undefined> {
  const others = (await ctx.registry()).list().filter((other) => other.id !== site.id);
  const { id, ...editable } = site;
  const edited = await editJsonUntilValid(
    editable,
    [
      `sync-servers: edit the site "${site.name}", then save and close the editor.`,
      'Delete everything, or close without saving, to cancel. Passwords are never stored here.',
    ],
    (parsed) => {
      const result = siteSchema.safeParse(typeof parsed === 'object' && parsed !== null ? { ...parsed, id } : parsed);
      if (!result.success) {
        return { ok: false, errors: formatIssues(result.error.issues) };
      }
      const clash = others.find((other) => sameName(other.name, result.data.name));
      if (clash !== undefined) {
        return { ok: false, errors: [`name: A site named "${clash.name}" already exists.`] };
      }
      return { ok: true, value: result.data };
    },
    ctx.io,
    'site.json',
  );
  if (edited === undefined) {
    ctx.err('No changes.\n');
    return undefined;
  }
  const updated = await (await ctx.registry()).replace(id, edited);
  if (ctx.flags.json) {
    ctx.json('site', { site: updated });
  } else {
    ctx.out(`Updated site "${updated.name}".\n`);
  }
  return undefined;
}

export const siteShowCommand: CommandSpec = {
  path: ['site', 'show'],
  args: '[<site>]',
  maxArgs: 1,
  summary: 'Show a site and its servers',
  examples: ['sync-servers site show', 'sync-servers site show "My Site" --json'],
  async run(ctx, { args }) {
    const site = await ctx.chooseSite(args[0]);
    if (ctx.flags.json) {
      ctx.json('site', { site });
      return undefined;
    }
    const remote = site.servers.find((server) => server.id === site.remoteServerId);
    const testing = site.servers.find((server) => server.id === site.testingServerId);
    const globalPatterns = (await ctx.registry()).globalCloaking.patterns;
    ctx.out(
      formatPairs([
        ['Name', site.name],
        ['Id', site.id],
        ['Local root', site.localRoot],
        ...(site.local.webUrl === undefined ? [] : [['Web URL', site.local.webUrl] as const]),
        ['Remote', remote === undefined ? 'none' : describeServer(remote)],
        ['Testing', testing === undefined ? 'none' : describeServer(testing)],
        ['Cloaking', cloakingSummary(site.cloaking, globalPatterns)],
        ['Guard', site.sync.guard.enabled ? 'on' : 'off'],
        ['Links', LINK_POLICY_NAMES[site.sync.symlinks]],
      ]),
    );
    if (site.servers.length > 0) {
      ctx.out(
        `\n${formatTable(
          ['Server', 'Host', 'Protocol'],
          site.servers.map((server) => [server.name, serverAddress(server), protocolLabel(server.protocol)]),
        )}`,
      );
    }
    return undefined;
  },
};

export const siteRemoveCommand: CommandSpec = {
  path: ['site', 'remove'],
  args: '<site>',
  minArgs: 1,
  maxArgs: 1,
  summary: 'Remove a site, its saved passwords and its sync records',
  options: {
    yes: { type: 'boolean', short: 'y', description: 'Do not ask for confirmation' },
  },
  examples: ['sync-servers site remove "My Site"', 'sync-servers site remove "My Site" --yes'],
  async run(ctx, { values, args }) {
    const site = await ctx.chooseSite(args[0]);
    if (!flag(values, 'yes')) {
      if (!ctx.interactive) {
        throw new UsageError('Pass --yes to remove a site without a terminal.');
      }
      const typed = await ctx.prompter.ask(
        `Remove "${site.name}" and its ${String(site.servers.length)} server(s)? Type the site name to confirm`,
      );
      if (!sameName(typed, site.name)) {
        throw new CancelledError('The name did not match. Nothing was removed.');
      }
    }
    await (await ctx.registry()).remove(site.id);
    await forgetSecrets(ctx, site.id, site.servers);
    await rm(path.join(ctx.paths.stateDir, 'sites', site.id), { recursive: true, force: true });
    if (ctx.flags.json) {
      ctx.json('site-removed', { siteId: site.id, name: site.name });
    } else {
      ctx.out(`Removed site "${site.name}". Its local folder and the files on its servers were not touched.\n`);
    }
    return undefined;
  },
};

export const sitePathCommand: CommandSpec = {
  path: ['site', 'path'],
  args: '[<site>]',
  maxArgs: 1,
  summary: "Print a site's local root (with shell integration, change to it)",
  examples: ['sync-servers site path "My Site"', 'ssv site path "My Site"'],
  async run(ctx, { args }) {
    const site = await ctx.chooseSite(args[0]);
    ctx.cdTarget = site.localRoot;
    if (ctx.flags.json) {
      ctx.json('site-path', { siteId: site.id, name: site.name, localRoot: site.localRoot });
    } else {
      ctx.out(`${site.localRoot}\n`);
    }
    return undefined;
  },
};
