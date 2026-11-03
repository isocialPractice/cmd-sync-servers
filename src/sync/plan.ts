import { createHash } from 'node:crypto';
import path from 'node:path';
import * as z from 'zod';
import { formatIssues } from '../config/schema.ts';
import { SyncError } from '../errors.ts';
import type { Guard } from './guard.ts';
import { classify, type CompareOptions, type SyncState } from './classify.ts';
import { guardedStatus, STATUS } from './messages.ts';
import { checkPath, type RemotePath } from './paths.ts';
import type { LinkedFile, ScanResult } from './scan-local.ts';
import type { SyncRecord } from './state.ts';
import type { Action, Direction, Observation, ProblemKind, Scope } from './types.ts';

/** One row of a preview: only paths with a difference, and names that could not be used. */
export interface PlanItem {
  /** Numbers rows from 1 in path order; editor mode refers to rows by number. */
  readonly id: number;
  /** The site-relative path, with `/` between folders. */
  readonly path: string;
  /** How the file changed since the last sync, or `problem` for a name that cannot be used. */
  readonly state: SyncState | 'problem';
  /** Why a problem row cannot be synchronized. */
  readonly problem: ProblemKind | undefined;
  /** What the row does when it runs. */
  readonly action: Action;
  /** `undefined` for a Resolve row until an action is chosen. Problem rows are never checked. */
  readonly checked: boolean | undefined;
  /** A sentence for the person, empty when the action speaks for itself. */
  readonly status: string;
  /** The sensitive pattern the path matches, when it does. */
  readonly guarded: string | undefined;
  /** The local side as scanned, for the stale check before the item runs. */
  readonly local: Observation | undefined;
  /** The remote side as scanned. */
  readonly remote: Observation | undefined;
  /** True when the path has no sync record, so a delete is never checked by default. */
  readonly neverSynced: boolean;
}

type MutableItem = { -readonly [K in keyof PlanItem]: PlanItem[K] };

/** The counts of a preview's summary line. */
export interface PlanSummary {
  /** Checked Put and Get rows. */
  readonly update: number;
  /** Checked delete rows. */
  readonly delete: number;
  /** Compared files that will not change: in sync, not listed, unchecked or skipped. */
  readonly skip: number;
  /** Rows that need a decision. */
  readonly resolve: number;
  /** Rows held back by the sensitive-file guard. */
  readonly guarded: number;
  /** Names that cannot be synchronized. */
  readonly errors: number;
}

/** A record change that needs no transfer: both copies match, or both are gone. */
export interface SilentUpdate {
  readonly path: RemotePath;
  readonly record: SyncRecord | undefined;
}

export interface PlanInput {
  readonly siteId: string;
  readonly serverId: string;
  readonly direction: Direction;
  readonly deleteOrphans: boolean;
  readonly scope: Scope;
  readonly local: ScanResult;
  readonly remote: ScanResult;
  /** The records within scope and outside cloaking. */
  readonly records: ReadonlyMap<string, SyncRecord>;
  readonly compare: CompareOptions;
  readonly guard: Guard;
  /** True when the local file system does not tell names apart by case. */
  readonly caseInsensitive: boolean;
  /** Single-file Put or Get: paths changed on the other side are offered as decisions instead of left out. */
  readonly explicit?: boolean;
  readonly now?: number;
}

/**
 * The action, default check and status {@link decide} gives a state.
 *
 * @experimental
 */
export interface Decision {
  readonly action: Action;
  readonly checked: boolean | undefined;
  readonly status: string;
  readonly neverSynced?: boolean;
}

const transfer = (action: Action, status = ''): Decision => ({ action, checked: true, status });
const resolve = (status: string): Decision => ({ action: 'resolve', checked: undefined, status });
const orphan = (action: Action, status: string): Decision => ({ action, checked: false, status, neverSynced: true });

/**
 * The action and default check of a state, for a direction and the delete
 * option. `undefined` means the path is left out of the preview.
 *
 * @experimental
 */
export function decide(state: SyncState, direction: Direction, deleteOrphans: boolean, explicit = false): Decision | undefined {
  switch (state) {
    case 'local-changed':
      if (direction !== 'get') {
        return transfer('put');
      }
      return explicit ? resolve(STATUS.localNewer) : undefined;
    case 'local-only':
      if (direction !== 'get') {
        return transfer('put');
      }
      return deleteOrphans ? orphan('delete-local', STATUS.deleteLocalNeverSynced) : undefined;
    case 'remote-changed':
      if (direction !== 'put') {
        return transfer('get');
      }
      return explicit ? resolve(STATUS.remoteNewer) : undefined;
    case 'remote-only':
      if (deleteOrphans && direction !== 'get') {
        return orphan('delete-remote', STATUS.deleteRemoteNeverSynced);
      }
      return direction === 'put' ? undefined : transfer('get');
    case 'first-sync-local-newer':
      if (direction !== 'get') {
        return transfer('put');
      }
      return explicit ? resolve(STATUS.firstSyncDiffers) : undefined;
    case 'first-sync-remote-newer':
      if (direction !== 'put') {
        return transfer('get');
      }
      return explicit ? resolve(STATUS.firstSyncDiffers) : undefined;
    case 'both-changed':
      return resolve(STATUS.bothChanged);
    case 'first-sync-conflict':
      return resolve(STATUS.firstSyncDiffers);
    case 'changed-locally-deleted-remotely':
      return resolve(STATUS.changedLocallyDeletedRemotely);
    case 'deleted-locally-changed-remotely':
      return resolve(STATUS.deletedLocallyChangedRemotely);
    case 'remote-deleted':
      if (direction !== 'get') {
        return transfer('put', STATUS.putRestore);
      }
      return deleteOrphans ? transfer('delete-local', STATUS.deleteLocalSynced) : undefined;
    case 'local-deleted':
      if (direction === 'get') {
        return transfer('get', STATUS.getRestore);
      }
      if (deleteOrphans) {
        return transfer('delete-remote', STATUS.deleteRemoteSynced);
      }
      return direction === 'both' ? transfer('get', STATUS.getRestoreBoth) : undefined;
    default:
      return undefined;
  }
}

/**
 * The sensitive pattern the file a link reaches matches: by its site path
 * when it is inside the site, otherwise by its real path from the top of its
 * drive or share, so `keys/site.txt` linked to a file in a `.ssh` folder is
 * held back like the file itself.
 */
function guardThroughLink(guard: Guard, linked: LinkedFile | undefined): string | undefined {
  if (linked === undefined) {
    return undefined;
  }
  const name = linked.sitePath ?? path.relative(path.parse(linked.real).root, linked.real).split(path.sep).join('/');
  return name === '' ? undefined : guard.match(name);
}

function fold(value: string): string {
  return value.normalize('NFC').toLowerCase();
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A digest of everything a plan was built from, so a saved plan can be checked against a fresh scan. */
function scanFingerprint(input: Pick<PlanInput, 'direction' | 'deleteOrphans' | 'scope' | 'local' | 'remote' | 'records'>): string {
  const side = (scan: ScanResult): unknown[] =>
    [...scan.files.entries()].sort(([a], [b]) => compareText(a, b)).map(([key, value]) => [key, value.size, value.mtimeMs ?? null, value.sha256 ?? null]);
  const problems = [...input.local.problems, ...input.remote.problems].map((problem) => `${problem.side}:${problem.kind}:${problem.path}`).sort(compareText);
  const records = [...input.records.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([key, value]) => [key, value.local.size, value.local.mtimeMs ?? null, value.remote.size, value.remote.mtimeMs ?? null]);
  // Where each link leads, so a saved plan is refused once a link points elsewhere. A site without links digests as before.
  const linked = [...input.local.linked.entries()].sort(([a], [b]) => compareText(a, b)).map(([key, value]) => [key, value.real]);
  const canonical = JSON.stringify({
    direction: input.direction,
    deleteOrphans: input.deleteOrphans,
    scope: input.scope,
    local: side(input.local),
    remote: side(input.remote),
    problems,
    records,
    ...(linked.length === 0 ? {} : { linked }),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

const planFileSchema = z.object({
  schema: z.literal('sync-servers/plan@1'),
  siteId: z.string(),
  serverId: z.string(),
  direction: z.enum(['put', 'get', 'both']),
  deleteOrphans: z.boolean(),
  scope: z.union([z.object({ kind: z.literal('site') }), z.object({ kind: z.literal('paths'), paths: z.array(z.string()) })]),
  createdAt: z.string(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  items: z.array(
    z.object({
      id: z.number().int().min(1),
      path: z.string(),
      action: z.enum(['put', 'get', 'resolve', 'delete-remote', 'delete-local', 'skip', 'synced']),
      checked: z.boolean().nullable(),
    }),
  ),
});

/** The choices of a saved plan: which action each row takes and whether it is checked. */
export interface SavedPlan {
  readonly siteId: string;
  readonly serverId: string;
  readonly direction: Direction;
  readonly deleteOrphans: boolean;
  readonly scope: Scope;
  readonly fingerprint: string;
  readonly items: readonly { readonly id: number; readonly path: string; readonly action: Action; readonly checked: boolean | null }[];
}

/**
 * What a synchronization would do: one row per path with a difference, each
 * with an action and a checkbox, built from both scans and the records.
 * Transfers nothing; {@link SyncSession.execute} runs the checked rows.
 */
export class SyncPlan {
  /** The site the plan was built for. */
  readonly siteId: string;
  /** The server the plan was built for. */
  readonly serverId: string;
  /** Put, get or both. */
  readonly direction: Direction;
  /** Whether files missing on the other side are offered for deletion. */
  readonly deleteOrphans: boolean;
  /** The whole site, or some paths of it. */
  readonly scope: Scope;
  /** When the plan was built, as an ISO 8601 time. */
  readonly createdAt: string;
  /** A digest of the scans the plan came from; a saved plan runs only while it still matches. */
  readonly fingerprint: string;
  /** Record changes that need no transfer. */
  readonly silent: readonly SilentUpdate[];
  /** Files compared but not listed: in sync, or not part of this direction. */
  readonly unlisted: number;
  /** How many local files the scan found. */
  readonly localFiles: number;
  /** How many remote files the scan found. */
  readonly remoteFiles: number;
  /** The local folders the scan found, for creating them on the other side. */
  readonly localDirs: ReadonlySet<string>;
  /** The remote folders the scan found. */
  readonly remoteDirs: ReadonlySet<string>;
  readonly #items: MutableItem[];

  /**
   * Builds a plan from two scans; programs get plans from {@link SyncSession.plan}.
   *
   * @internal
   */
  constructor(input: PlanInput) {
    this.siteId = input.siteId;
    this.serverId = input.serverId;
    this.direction = input.direction;
    this.deleteOrphans = input.deleteOrphans;
    this.scope = input.scope;
    this.createdAt = new Date(input.now ?? Date.now()).toISOString();
    this.fingerprint = scanFingerprint(input);
    this.localFiles = input.local.files.size;
    this.remoteFiles = input.remote.files.size;
    this.localDirs = input.local.dirs;
    this.remoteDirs = input.remote.dirs;

    const problems: Omit<MutableItem, 'id'>[] = [];
    const blocked = new Set<string>();
    const problemRow = (path: string, problem: ProblemKind, status: string, local?: Observation, remote?: Observation): void => {
      problems.push({ path, state: 'problem', problem, action: 'skip', checked: false, status, guarded: undefined, local, remote, neverSynced: false });
    };
    for (const problem of [...input.local.problems, ...input.remote.problems]) {
      problemRow(problem.path, problem.kind, problem.status);
      blocked.add(problem.path);
    }
    if (input.caseInsensitive) {
      const groups = new Map<string, RemotePath[]>();
      for (const target of input.remote.files.keys()) {
        groups.set(fold(target), [...(groups.get(fold(target)) ?? []), target]);
      }
      const localByFold = new Map([...input.local.files.keys()].map((target) => [fold(target), target]));
      for (const [folded, group] of groups) {
        const localTwin = localByFold.get(folded);
        const spellings = new Set<string>([...group, ...(localTwin === undefined ? [] : [localTwin])]);
        // Two spellings of one name on a file system that cannot tell them apart: neither is safe.
        const twins = spellings.size > 1 ? [...spellings] : [];
        for (const target of twins as RemotePath[]) {
          if (!blocked.has(target)) {
            problemRow(target, 'case', STATUS.caseCollision, input.local.files.get(target), input.remote.files.get(target));
            blocked.add(target);
          }
        }
      }
    } else {
      // A name spelled one way here and only another way on the server, as after renaming by
      // case: a server that ignores case would take the Put and the delete for the same file.
      const remoteByFold = new Map<string, RemotePath[]>();
      for (const target of input.remote.files.keys()) {
        remoteByFold.set(fold(target), [...(remoteByFold.get(fold(target)) ?? []), target]);
      }
      for (const target of input.local.files.keys()) {
        const others = input.remote.files.has(target) ? [] : (remoteByFold.get(fold(target)) ?? []).filter((other) => !input.local.files.has(other));
        for (const twin of others.length === 0 ? [] : [target, ...others]) {
          if (!blocked.has(twin)) {
            problemRow(twin, 'case', STATUS.caseRename, input.local.files.get(twin), input.remote.files.get(twin));
            blocked.add(twin);
          }
        }
      }
    }
    // Nothing is transferred inside a linked folder on either side: a server can follow a link out of its root.
    const links = [...input.local.problems, ...input.remote.problems].filter((problem) => problem.kind === 'symlink').map((problem) => `${problem.path}/`);

    const paths = new Set<string>([...input.local.files.keys(), ...input.remote.files.keys(), ...input.records.keys()]);
    const rows: Omit<MutableItem, 'id'>[] = [];
    const silent: SilentUpdate[] = [];
    let unlisted = 0;
    for (const target of [...paths].sort(compareText)) {
      if (blocked.has(target)) {
        continue;
      }
      const checked = checkPath(target);
      if (!checked.ok) {
        continue;
      }
      const local = input.local.files.get(checked.path);
      const remote = input.remote.files.get(checked.path);
      if (links.some((link) => target.startsWith(link))) {
        problemRow(target, 'symlink', STATUS.underLink, local, remote);
        continue;
      }
      const record = input.records.get(target);
      const state = classify(local, remote, record, input.compare);
      if (state === undefined) {
        continue;
      }
      if (state === 'refresh-record' && local !== undefined && remote !== undefined) {
        silent.push({ path: checked.path, record: { local, remote, syncedAt: input.now ?? Date.now() } });
        unlisted += 1;
        continue;
      }
      if (state === 'drop-record') {
        silent.push({ path: checked.path, record: undefined });
        continue;
      }
      const decision = decide(state, input.direction, input.deleteOrphans, input.explicit === true);
      if (decision === undefined) {
        unlisted += 1;
        continue;
      }
      const linked = input.local.linked.get(checked.path);
      const guarded = input.guard.match(target) ?? guardThroughLink(input.guard, linked);
      const status = guarded === undefined ? decision.status : guardedStatus(guarded);
      rows.push({
        path: target,
        state,
        problem: undefined,
        action: decision.action,
        checked: guarded !== undefined && decision.checked === true ? false : decision.checked,
        status: linked?.outside === true ? [status, STATUS.throughLinkOutside].filter((text) => text !== '').join(' ') : status,
        guarded,
        local,
        remote,
        neverSynced: decision.neverSynced === true,
      });
    }
    this.silent = silent;
    this.unlisted = unlisted;
    this.#items = [...rows, ...problems.sort((a, b) => compareText(a.path, b.path))].map((item, index) => ({ ...item, id: index + 1 }));
  }

  /** Every row, in path order, with problem rows last. */
  get items(): readonly PlanItem[] {
    return this.#items;
  }

  /** The row with this number, or with this site-relative path. */
  item(ref: number | string): PlanItem | undefined {
    return this.#find(ref);
  }

  #find(ref: number | string): MutableItem | undefined {
    return typeof ref === 'number' ? this.#items.find((item) => item.id === ref) : this.#items.find((item) => item.path === ref);
  }

  #require(ref: number | string): MutableItem {
    const item = this.#find(ref);
    if (item === undefined) {
      throw new SyncError('E_PLAN_INVALID', `The plan has no row ${JSON.stringify(ref)}.`);
    }
    return item;
  }

  /** The actions a row can take: Put needs a local copy, Get a remote one, Synchronized both. */
  allowedActions(ref: number | string): Action[] {
    const item = this.#require(ref);
    if (item.state === 'problem') {
      return ['skip'];
    }
    const actions: Action[] = [];
    if (item.local !== undefined) {
      actions.push('put');
    }
    if (item.remote !== undefined) {
      actions.push('get');
    }
    actions.push('skip');
    if (item.local !== undefined && item.remote !== undefined) {
      actions.push('synced');
    }
    if (item.remote !== undefined) {
      actions.push('delete-remote');
    }
    if (item.local !== undefined) {
      actions.push('delete-local');
    }
    return actions;
  }

  /** Changes a row's action; any chosen action except Skip checks the row. */
  setAction(ref: number | string, action: Action): void {
    const item = this.#require(ref);
    if (!this.allowedActions(ref).includes(action)) {
      throw new SyncError('E_PLAN_INVALID', `"${item.path}" cannot take the action ${action}.`);
    }
    item.action = action;
    item.checked = action !== 'skip';
  }

  /**
   * Checks or unchecks a row; only checked rows run.
   *
   * @throws {@link SyncError} `E_PLAN_INVALID` for a problem row, or a Resolve row before an action is chosen.
   */
  setChecked(ref: number | string, checked: boolean): void {
    const item = this.#require(ref);
    if (item.state === 'problem') {
      throw new SyncError('E_PLAN_INVALID', `"${item.path}" cannot be synchronized.`);
    }
    if (item.action === 'resolve') {
      throw new SyncError('E_PLAN_INVALID', `"${item.path}" needs a decision first: choose Put, Get, Skip or Synchronized.`);
    }
    item.checked = checked;
  }

  /** The counts behind {@link summaryLine}, as they stand after the person's choices. */
  get summary(): PlanSummary {
    let update = 0;
    let remove = 0;
    let skip = this.unlisted;
    let resolveCount = 0;
    let guarded = 0;
    let errors = 0;
    for (const item of this.#items) {
      if (item.state === 'problem') {
        errors += 1;
      } else if (item.action === 'resolve') {
        resolveCount += 1;
      } else if (item.checked !== true || item.action === 'skip' || item.action === 'synced') {
        skip += 1;
        guarded += item.guarded !== undefined && item.checked !== true ? 1 : 0;
      } else if (item.action === 'put' || item.action === 'get') {
        update += 1;
      } else {
        remove += 1;
      }
    }
    return { update, delete: remove, skip, resolve: resolveCount, guarded, errors };
  }

  /** `Files: 37 will be updated, 169 will be skipped, 12 need a decision`. */
  summaryLine(): string {
    const summary = this.summary;
    const parts = [`${String(summary.update)} will be updated`];
    if (summary.delete > 0) {
      parts.push(`${String(summary.delete)} will be deleted`);
    }
    parts.push(`${String(summary.skip)} will be skipped`);
    if (summary.resolve > 0) {
      parts.push(`${String(summary.resolve)} ${summary.resolve === 1 ? 'needs' : 'need'} a decision`);
    }
    if (summary.errors > 0) {
      parts.push(`${String(summary.errors)} cannot be synchronized`);
    }
    return `Files: ${parts.join(', ')}`;
  }

  /** The plan as JSON for `--plan-out`. Never contains a secret. */
  toJSON(): Record<string, unknown> {
    return {
      schema: 'sync-servers/plan@1',
      siteId: this.siteId,
      serverId: this.serverId,
      direction: this.direction,
      deleteOrphans: this.deleteOrphans,
      scope: this.scope,
      createdAt: this.createdAt,
      fingerprint: this.fingerprint,
      summary: this.summary,
      items: this.#items.map((item) => ({
        id: item.id,
        path: item.path,
        state: item.state,
        action: item.action,
        checked: item.checked ?? null,
        status: item.status,
        ...(item.guarded === undefined ? {} : { guarded: item.guarded }),
        ...(item.local === undefined ? {} : { local: item.local }),
        ...(item.remote === undefined ? {} : { remote: item.remote }),
      })),
    };
  }

  /** Reads the choices of a plan saved with {@link toJSON}. Run them with {@link applySaved} on a fresh plan. */
  static fromJSON(data: unknown): SavedPlan {
    const parsed = planFileSchema.safeParse(data);
    if (!parsed.success) {
      throw new SyncError('E_PLAN_INVALID', ['The saved plan is not valid:', ...formatIssues(parsed.error.issues).map((line) => `  ${line}`)].join('\n'));
    }
    return parsed.data;
  }

  /**
   * Copies the choices of a saved plan onto this fresh one, after checking
   * that both were built from the same scan. A plan whose scan no longer
   * matches is refused, and so is a saved row this plan does not hold or an
   * action its file cannot take; every row is checked before any is applied,
   * so a refused plan leaves this one as it was.
   */
  applySaved(saved: SavedPlan): void {
    if (saved.fingerprint !== this.fingerprint || saved.siteId !== this.siteId || saved.serverId !== this.serverId) {
      throw new SyncError('E_STALE_ITEM', 'The site or the server changed since the plan was saved. Make a new plan.');
    }
    const rows = saved.items.map((row) => {
      const item = this.#require(row.path);
      if (item.id !== row.id) {
        throw new SyncError('E_PLAN_INVALID', `Row ${String(row.id)} of the saved plan does not match "${row.path}".`);
      }
      const keeps = row.action === item.action;
      if (!keeps && (row.action === 'resolve' || !this.allowedActions(item.id).includes(row.action))) {
        throw new SyncError('E_PLAN_INVALID', `"${item.path}" cannot take the action ${row.action}.`);
      }
      return { item, row, keeps };
    });
    for (const { item, row, keeps } of rows) {
      if (!keeps) {
        this.setAction(item.id, row.action);
      }
      if (row.checked !== null && item.state !== 'problem' && item.action !== 'resolve') {
        this.setChecked(item.id, row.checked);
      }
    }
  }
}
