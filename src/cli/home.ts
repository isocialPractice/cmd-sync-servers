import type { Site } from '../config/schema.ts';
import { siteAddCommand, siteEditCommand } from './commands/site.ts';
import { serverTestCommand } from './commands/server-test.ts';
import { protocolLabel, serverAddress } from './commands/shared.ts';
import { statusCommand, syncCommand } from './commands/sync.ts';
import type { CommandContext } from './context.ts';
import { CancelledError } from './errors.ts';
import { ExitCode } from './exit-codes.ts';
import { startTui, wantsPlain } from './ui.ts';

/** Runs one menu action; a failure is reported and the menu comes back. */
async function run(ctx: CommandContext, action: () => Promise<ExitCode | undefined>): Promise<ExitCode | undefined> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof CancelledError) {
      ctx.err(`${error.message}\n`);
      return ExitCode.cancelled;
    }
    ctx.err(`sync-servers: ${ctx.logger.redactor.redact(error instanceof Error ? error.message : String(error))}\n`);
    return ExitCode.error;
  }
}

/**
 * Plain mode with no command: the sites as a numbered list, then a numbered
 * menu for the chosen site. Each choice runs the same flow as its command.
 */
export async function plainHome(ctx: CommandContext, start: Site | undefined): Promise<ExitCode | undefined> {
  const ask = ctx.prompter;
  const registry = await ctx.registry();
  let site = start;
  let code: ExitCode | undefined;
  for (;;) {
    if (site === undefined) {
      await registry.reload();
      const sites = registry.list();
      ctx.out('\nSites\n');
      sites.forEach((candidate, index) => {
        const remote = candidate.servers.find((server) => server.id === candidate.remoteServerId);
        ctx.out(`  ${String(index + 1)}. ${candidate.name}  ${candidate.localRoot}${remote === undefined ? '' : `  -> ${remote.name}`}\n`);
      });
      if (sites.length === 0) {
        ctx.out('  (none yet)\n');
      }
      const answer = (await ask.ask('Site number, n for a new site, q to quit')).toLowerCase();
      if (answer === 'q' || answer === 'quit') {
        return code;
      }
      if (answer === 'n') {
        await run(ctx, () => siteAddCommand.run(ctx, { values: {}, args: [] }));
        continue;
      }
      site = sites[Number(answer) - 1];
      if (site === undefined) {
        ctx.out(sites.length === 0 ? 'Enter n or q.\n' : `Enter a number from 1 to ${String(sites.length)}, n or q.\n`);
      } else {
        ctx.cdTarget = site.localRoot;
      }
      continue;
    }
    await registry.reload();
    const current: Site = registry.get(site.id) ?? site;
    const remote = current.servers.find((server) => server.id === current.remoteServerId);
    ctx.out(`\n${current.name}  ${current.localRoot}\n`);
    ctx.out(
      remote === undefined
        ? '  No Remote server yet: add one with "sync-servers server add".\n'
        : `  ${remote.name}: ${protocolLabel(remote.protocol)} ${serverAddress(remote)}${remote.protocol === 'local' ? '' : ` ${remote.remoteRoot}`}\n`,
    );
    const choice = await ask.choose('What now?', [
      { label: 'Synchronize...', value: 'sync' },
      { label: 'Put newer files', value: 'put' },
      { label: 'Get newer files', value: 'get' },
      { label: 'Check for changes', value: 'status' },
      { label: 'Test the connection', value: 'test' },
      { label: 'Edit the site settings', value: 'edit' },
      { label: 'Back to the sites', value: 'back' },
      { label: 'Quit', value: 'quit' },
    ] as const);
    ctx.siteOverride = current.id;
    try {
      switch (choice) {
        case 'sync':
          code = await run(ctx, () => syncCommand.run(ctx, { values: {}, args: [] }));
          break;
        case 'put':
        case 'get':
          code = await run(ctx, () => syncCommand.run(ctx, { values: { [choice]: true }, args: [] }));
          break;
        case 'status':
          await run(ctx, () => statusCommand.run(ctx, { values: {}, args: [] }));
          break;
        case 'test':
          await run(ctx, () => serverTestCommand.run(ctx, { values: {}, args: [] }));
          break;
        case 'edit':
          await run(ctx, () => siteEditCommand.run(ctx, { values: {}, args: [current.id] }));
          break;
        case 'back':
          site = undefined;
          break;
        case 'quit':
          return code;
      }
    } finally {
      ctx.siteOverride = undefined;
    }
  }
}

/**
 * `sync-servers` with no command in a terminal: the full-screen UI, or plain
 * mode, opening at the site of the current folder (or `--site`), else at the
 * site list.
 */
export async function home(ctx: CommandContext): Promise<ExitCode | undefined> {
  const registry = await ctx.registry();
  const named = ctx.flags.site ?? ctx.io.env.SYNC_SERVERS_SITE;
  const site = named !== undefined && named.trim() !== '' ? await ctx.chooseSite() : registry.resolve({ path: ctx.io.cwd });
  if (wantsPlain(ctx)) {
    return plainHome(ctx, site);
  }
  const [{ SitesView }, { SiteHomeView }] = await Promise.all([import('../tui/screens/sites.ts'), import('../tui/screens/site-home.ts')]);
  const app = await startTui(ctx, (services) => [new SitesView(services), ...(site === undefined ? [] : [new SiteHomeView(services, site.id)])]);
  ctx.cdTarget = app.cdTarget;
  return undefined;
}
