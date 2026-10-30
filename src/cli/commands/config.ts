import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hasErrorCode } from '../../config/files.ts';
import { ensurePrivateDir } from '../../config/paths.ts';
import { checkSitesFile, replaceSitesFile, serializeSitesFile } from '../../config/registry.ts';
import { SCHEMA_VERSION, type Site, type SitesFile } from '../../config/schema.ts';
import type { CommandSpec } from '../command.ts';
import { KEYRING_ENV, keyringDisabled, type CommandContext } from '../context.ts';
import { editTextUntilValid } from '../editor.ts';
import { UsageError } from '../errors.ts';
import { ExitCode } from '../exit-codes.ts';
import { formatPairs, paint } from '../output.ts';
import { folderProblem } from './shared.ts';

export const configPathCommand: CommandSpec = {
  path: ['config', 'path'],
  summary: 'Show the folders sync-servers reads and writes',
  examples: ['sync-servers config path', 'sync-servers config path --json'],
  run(ctx) {
    const { configDir, sitesFile, stateDir, logDir } = ctx.paths;
    if (ctx.flags.json) {
      ctx.json('config-paths', { configDir, sitesFile, stateDir, logDir });
    } else {
      ctx.out(
        formatPairs([
          ['Settings', configDir],
          ['Sites', sitesFile],
          ['State', stateDir],
          ['Logs', logDir],
        ]),
      );
    }
    return Promise.resolve(undefined);
  },
};

export const configEditCommand: CommandSpec = {
  path: ['config', 'edit'],
  summary: 'Edit the whole sites.json in your editor, also when it is not valid',
  examples: ['sync-servers config edit'],
  async run(ctx) {
    if (!ctx.interactive) {
      throw new UsageError('config edit opens your editor. Run it in a terminal.');
    }
    const file = ctx.paths.sitesFile;
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error;
      }
      text = serializeSitesFile({ schemaVersion: SCHEMA_VERSION, sites: [] });
    }
    const before = checkSitesFile(text, file);
    const edited = await editTextUntilValid<SitesFile>(
      text,
      [
        `sync-servers: edit ${file}, then save and close the editor.`,
        'Delete everything, or close without saving, to cancel. Passwords are never stored here.',
      ],
      (saved) => {
        const checked = checkSitesFile(saved, file);
        return checked.ok ? { ok: true, value: checked.file } : { ok: false, errors: checked.problems };
      },
      ctx.io,
      'sites.json',
      before.ok ? [] : before.problems,
    );
    if (edited === undefined) {
      ctx.err(before.ok ? 'No changes.\n' : `No changes. ${file} is still not valid.\n`);
      return before.ok ? undefined : ExitCode.error;
    }
    await replaceSitesFile(ctx.paths, edited);
    ctx.logger.info('Sites file replaced', { file });
    ctx.out(`Saved ${file}. The file it replaced is kept as sites.json.bak.\n`);
    return undefined;
  },
};

type Status = 'ok' | 'warn' | 'fail';

interface Check {
  status: Status;
  subject: string;
  message: string;
}

const MINIMUM_NODE = [22, 14, 0] as const;

function nodeIsSupported(version: string): boolean {
  const parts = version.split('.').map(Number);
  for (let index = 0; index < MINIMUM_NODE.length; index += 1) {
    const actual = parts[index] ?? 0;
    const minimum = MINIMUM_NODE[index] ?? 0;
    if (actual !== minimum) {
      return actual > minimum;
    }
  }
  return true;
}

async function checkStore(ctx: CommandContext): Promise<Check> {
  const subject = 'Credential store';
  if (keyringDisabled(ctx.io.env)) {
    return { status: 'warn', subject, message: `turned off by ${KEYRING_ENV}. Passwords come from SYNC_SERVERS_PASSWORD or a prompt.` };
  }
  const store = await ctx.credentialStore();
  if (store === undefined) {
    return { status: 'warn', subject, message: 'not available. Passwords come from SYNC_SERVERS_PASSWORD or a prompt.' };
  }
  try {
    await store.get({ siteId: 'doctor', serverId: 'probe', kind: 'password' });
    return { status: 'ok', subject, message: `${store.name} is available.` };
  } catch (error) {
    return { status: 'warn', subject, message: error instanceof Error ? error.message : String(error) };
  }
}

function checkSite(site: Site, storeAvailable: boolean): Check[] {
  const checks: Check[] = [];
  const subject = `Site "${site.name}"`;
  const rootProblem = folderProblem(site.localRoot);
  checks.push(
    rootProblem === undefined
      ? { status: 'ok', subject, message: `local root ${site.localRoot}` }
      : { status: 'fail', subject, message: rootProblem },
  );
  if (site.servers.length > 0 && !site.servers.some((server) => server.id === site.remoteServerId)) {
    checks.push({ status: 'warn', subject, message: 'has no Remote server. Set one with "sync-servers server set-remote".' });
  }
  for (const server of site.servers) {
    const where = `${subject}, server "${server.name}"`;
    if (server.protocol === 'ftp') {
      checks.push({ status: 'warn', subject: where, message: 'uses plain FTP, which sends the password in clear text.' });
    }
    if (server.protocol === 'local' && !existsSync(server.remoteRoot)) {
      checks.push({ status: 'warn', subject: where, message: `folder not found: ${server.remoteRoot}` });
    }
    if (server.auth?.method === 'key' && server.auth.keyPath !== undefined && !existsSync(server.auth.keyPath)) {
      checks.push({ status: 'warn', subject: where, message: `private key not found: ${server.auth.keyPath}` });
    }
    if (server.auth?.savePassword === true && !storeAvailable) {
      checks.push({ status: 'warn', subject: where, message: 'saves its password, but no credential store is available.' });
    }
  }
  return checks;
}

export const doctorCommand: CommandSpec = {
  path: ['doctor'],
  summary: 'Check Node.js, the folders, the credential store, the terminal and every site',
  examples: ['sync-servers doctor', 'sync-servers doctor --json'],
  async run(ctx) {
    const checks: Check[] = [];
    const node = process.versions.node;
    checks.push(
      nodeIsSupported(node)
        ? { status: 'ok', subject: 'Node.js', message: node }
        : { status: 'fail', subject: 'Node.js', message: `${node} is too old. Use ${MINIMUM_NODE.join('.')} or later.` },
    );

    let sites: Site[] = [];
    try {
      sites = (await ctx.registry()).list();
      checks.push({ status: 'ok', subject: 'Sites', message: `${String(sites.length)} in ${ctx.paths.sitesFile}` });
    } catch (error) {
      checks.push({ status: 'fail', subject: 'Sites', message: error instanceof Error ? error.message : String(error) });
    }

    try {
      await ensurePrivateDir(ctx.paths.stateDir);
      const probe = path.join(ctx.paths.stateDir, `.doctor-${randomBytes(4).toString('hex')}`);
      await writeFile(probe, '', { mode: 0o600 });
      await rm(probe, { force: true });
      checks.push({ status: 'ok', subject: 'State folder', message: `${ctx.paths.stateDir} is writable` });
    } catch (error) {
      checks.push({ status: 'fail', subject: 'State folder', message: error instanceof Error ? error.message : String(error) });
    }

    const store = await checkStore(ctx);
    checks.push(store);

    const out = ctx.io.stdout;
    checks.push({
      status: 'ok',
      subject: 'Terminal',
      message: [
        out.isTTY === true ? 'a terminal' : 'not a terminal',
        ctx.color ? 'colour' : 'no colour',
        ctx.ascii ? 'ASCII symbols' : 'Unicode symbols',
        ...(out.columns === undefined ? [] : [`${String(out.columns)} columns`]),
      ].join(', '),
    });

    for (const site of sites) {
      checks.push(...checkSite(site, store.status === 'ok'));
    }

    const failed = checks.some((check) => check.status === 'fail');
    if (ctx.flags.json) {
      ctx.json('doctor', { ok: !failed, checks });
    } else {
      for (const check of checks) {
        const word = check.status.padEnd(4);
        const tone = check.status === 'fail' ? 'red' : 'yellow';
        ctx.out(`${check.status === 'ok' ? word : paint(word, tone, ctx.color)}  ${check.subject}: ${check.message}\n`);
      }
    }
    return failed ? ExitCode.error : undefined;
  },
};
