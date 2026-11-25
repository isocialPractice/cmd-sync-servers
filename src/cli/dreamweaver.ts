import type { SiteRegistry } from '../config/registry.ts';
import type { Server, Site } from '../config/schema.ts';
import type { SecretKind } from '../credentials/types.ts';
import { siteCloak, type Cloak } from '../sync/cloak.ts';
import { findDreamweaverServers, type DreamweaverServerCount } from '../sync/dreamweaver.ts';
import { dreamweaverServerName, sameServerName } from '../sync/dwsync.ts';
import { DREAMWEAVER_TEXT, dreamweaverTakeOver } from '../sync/messages.ts';
import { SyncSession } from '../sync/session.ts';
import { safeLine } from '../terminal-text.ts';
import { booleanOption, type OptionSpecs, type OptionValues } from './command.ts';
import type { CommandContext } from './context.ts';
import { cliHostAdapter } from './host.ts';

/** `--dreamweaver` and `--no-dreamweaver`, as `site add` and `site edit` take them. */
export const DREAMWEAVER_OPTION: OptionSpecs = {
  dreamweaver: {
    type: 'boolean',
    description: 'Read and update the synchronization records Dreamweaver keeps as _notes/dwsync.xml (--no-dreamweaver to leave them alone)',
  },
};

/** The cloak a new site starts with: the global patterns and none of its own. */
export function newSiteCloak(registry: SiteRegistry, platform: NodeJS.Platform = process.platform): Cloak {
  return siteCloak({ cloaking: { enabled: true, patterns: [], paths: [] } }, platform, registry.globalCloaking.patterns);
}

/** What setup decided about Dreamweaver's records for a new site. */
export interface DreamweaverChoice {
  /** Whether the site reads and updates the records. */
  readonly enabled: boolean;
  /** The servers Dreamweaver synchronized the folder with; empty when it holds no records. */
  readonly names: readonly DreamweaverServerCount[];
}

/**
 * Decides whether a new site uses Dreamweaver's records: as the option
 * says, and otherwise on when the folder holds some, after asking when a
 * person can answer.
 */
export async function chooseDreamweaver(ctx: CommandContext, localRoot: string, values: OptionValues, ask: boolean): Promise<DreamweaverChoice> {
  const names = await findDreamweaverServers(localRoot, { cloak: newSiteCloak(await ctx.registry()), signal: ctx.io.signal });
  const option = booleanOption(values, 'dreamweaver');
  if (option !== undefined) {
    return { enabled: option, names };
  }
  if (names.length === 0) {
    return { enabled: false, names };
  }
  return { enabled: !ask || (await ctx.prompter.confirm(DREAMWEAVER_TEXT.question, true)), names };
}

/** True when none of the names Dreamweaver used is the one the server goes by. */
export function nameUnmatched(server: Pick<Server, 'protocol' | 'host' | 'remoteRoot' | 'options'>, names: readonly DreamweaverServerCount[]): boolean {
  const own = dreamweaverServerName(server);
  return names.length > 0 && !names.some((found) => sameServerName(found.server, own));
}

function files(count: number): string {
  return `${String(count)} ${count === 1 ? 'file' : 'files'}`;
}

/**
 * Asks which of the servers Dreamweaver synchronized the folder with this
 * server is, when its host and root do not say. Returns the name chosen, or
 * `undefined` for none of them.
 */
export async function askDreamweaverName(ctx: CommandContext, server: Pick<Server, 'name'>, names: readonly DreamweaverServerCount[]): Promise<string | undefined> {
  return ctx.prompter.choose<string | undefined>(
    `Dreamweaver synchronized this folder with these servers. Which one is ${safeLine(server.name)}?`,
    [...names.map((found) => ({ label: `${safeLine(found.server)} (${files(found.files)})`, value: found.server })), { label: 'None of these', value: undefined }],
    names.length,
  );
}

/** For a setup that asks nothing: the names found, and how to say which one the server is. */
export function unmatchedNote(server: Pick<Server, 'name' | 'protocol' | 'host' | 'remoteRoot' | 'options'>, names: readonly DreamweaverServerCount[]): string {
  const listed = names.map((found) => safeLine(found.server)).join(', ');
  return `Dreamweaver synchronized this folder with: ${listed}. None is ${safeLine(dreamweaverServerName(server))}, the name built for "${safeLine(server.name)}". Say which one it is with "sync-servers server edit --dreamweaver-server <name>".`;
}

/**
 * Takes Dreamweaver's records over for a site that was just set up: plans
 * the whole site and saves what the plan found in sync, so the first
 * preview lists only real differences. A secret the server accepted during
 * setup answers the password question, so nothing is asked twice. Returns
 * the sentence to show; a failure is a warning, since the first sync takes
 * the records over as well.
 */
export async function takeOverRecords(
  ctx: CommandContext,
  site: Pick<Site, 'id'>,
  server: Pick<Server, 'id'>,
  accepted: { readonly kind: SecretKind; readonly secret: string } | undefined,
): Promise<string> {
  const base = await cliHostAdapter(ctx);
  const promptSecret = base.promptSecret.bind(base);
  const session = await SyncSession.open({
    registry: await ctx.registry(),
    siteId: site.id,
    serverId: server.id,
    host:
      accepted === undefined
        ? base
        : {
            ...base,
            // The person already said whether to save it, so the offer is not made again.
            secretAccepted: undefined,
            promptSecret: (request) => (request.ref.kind === accepted.kind ? Promise.resolve(accepted.secret) : promptSecret(request)),
          },
    logger: ctx.logger,
    env: ctx.io.env,
  });
  try {
    ctx.err("Reading Dreamweaver's records...\n");
    const plan = await session.plan({ direction: 'both', signal: ctx.io.signal });
    await session.settle(plan);
    return dreamweaverTakeOver(plan.adopted, session.dreamweaverClock ?? 'unknown');
  } catch (error) {
    return `warning: Dreamweaver's records were not read: ${error instanceof Error ? error.message : String(error)} The first sync reads them.`;
  } finally {
    await session.close();
  }
}
