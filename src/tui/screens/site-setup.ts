import { statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Site } from '../../config/schema.ts';
import { isSyncError } from '../../errors.ts';
import { splitPatterns } from '../../sync/cloak.ts';
import { DEFAULT_GUARD_PATTERNS } from '../../sync/guard.ts';
import type { App, Hint, View, ViewBody } from '../app.ts';
import { isKey, type Key } from '../keys.ts';
import { openSession, type TuiServices } from '../services.ts';
import { span, symbols, type Line, type Theme } from '../style.ts';
import { padEnd } from '../text.ts';
import { choiceDialog, confirmDialog } from '../widgets/dialog.ts';
import { field, Form } from '../widgets/form.ts';
import { ListState } from '../widgets/list.ts';
import { headerRow, protocolName, serverAddress, tableRow } from './common.ts';
import { GlobalCloakingView, PATTERN_HELP } from './global-cloaking.ts';
import { ServerEditorView } from './server-editor.ts';

type Category = 'site' | 'servers' | 'local' | 'cloaking' | 'sync' | 'security';

const SIDEBAR: readonly { id: Category | 'advanced'; label: string; indent: boolean }[] = [
  { id: 'site', label: 'Site', indent: false },
  { id: 'servers', label: 'Servers', indent: false },
  { id: 'advanced', label: 'Advanced Settings', indent: false },
  { id: 'local', label: 'Local Info', indent: true },
  { id: 'cloaking', label: 'Cloaking', indent: true },
  { id: 'sync', label: 'Synchronization', indent: true },
  { id: 'security', label: 'Security', indent: true },
];

const SIDEBAR_WIDTH = 22;

function whole(text: string, label: string, min: number, max: number): number | string {
  const value = Number(text);
  return Number.isInteger(value) && value >= min && value <= max ? value : `${label} must be a whole number from ${String(min)} to ${String(max)}.`;
}

/**
 * Dreamweaver's Site Setup: the category list on the left and the form of
 * the chosen category on the right. Ctrl+S saves site settings;
 * servers are saved from their own editor.
 */
export class SiteSetupView implements View {
  readonly #services: TuiServices;
  #siteId: string | undefined;
  #site: Site | undefined;
  #category = 0;
  #pane: 'sidebar' | 'content' = 'sidebar';
  #forms = new Map<Category, Form>();
  #paths: string[] = [];
  #globalPatterns: readonly string[] = [];
  readonly #servers = new ListState<Site['servers'][number]>([], (server) => server.name);
  #dirty = false;
  #loaded = false;

  constructor(services: TuiServices, siteId: string | undefined) {
    this.#services = services;
    this.#siteId = siteId;
  }

  #categoryId(): Category {
    const id = SIDEBAR[this.#category]?.id ?? 'site';
    return id === 'advanced' ? 'local' : id;
  }

  title(): string {
    return `Site Setup: ${this.#site?.name ?? 'New site'}`;
  }

  primary(): string {
    return 'Ctrl+S Save';
  }

  hints(): readonly Hint[] {
    if (this.#pane === 'content' && this.#categoryId() === 'servers') {
      return [
        { key: 'a', label: 'Add' },
        { key: 'Enter', label: 'Edit' },
        { key: 'c', label: 'Duplicate' },
        { key: 'Del', label: 'Remove' },
        { key: 't', label: 'Test' },
        { key: 'r', label: 'Remote' },
        { key: 'Tab', label: 'Pane' },
      ];
    }
    return [
      { key: 'Tab', label: 'Pane' },
      { key: 'Up/Down', label: 'Move' },
      { key: this.#pane === 'sidebar' ? 'Enter' : 'Space', label: this.#pane === 'sidebar' ? 'Open' : 'Change' },
      { key: 'Ctrl+S', label: 'Save' },
      { key: 'Esc', label: 'Back' },
    ];
  }

  keys(): readonly Hint[] {
    return [
      { key: 'Tab, Shift+Tab', label: 'Switch between the categories and the form' },
      { key: 'Up/Down', label: 'Move' },
      { key: 'Space, Left/Right', label: 'Change a toggle or a choice' },
      { key: 'Ctrl+S', label: 'Save the site settings' },
      { key: 'Esc', label: 'Back; asks before dropping unsaved changes' },
      { key: 'a, Enter, c, Del', label: 'Servers: add, edit, duplicate, remove' },
      { key: 't, r, T', label: 'Servers: test, make Remote, make Testing' },
    ];
  }

  capturesText(): boolean {
    return this.#pane === 'content' && (this.#forms.get(this.#categoryId())?.capturesText() ?? false);
  }

  status(): string | undefined {
    if (this.#pane === 'content') {
      if (this.#categoryId() === 'servers') {
        const server = this.#servers.selected;
        return server === undefined ? undefined : `${server.name}: ${protocolName(server.protocol)} ${serverAddress(server)} ${server.remoteRoot}`;
      }
      return this.#forms.get(this.#categoryId())?.status();
    }
    return this.#dirty ? 'Unsaved changes. Ctrl+S saves them.' : undefined;
  }

  async shown(): Promise<void> {
    const registry = await this.#services.registry();
    await registry.reload();
    this.#site = this.#siteId === undefined ? undefined : registry.get(this.#siteId);
    this.#servers.items = this.#site?.servers ?? [];
    this.#globalPatterns = registry.globalCloaking.patterns;
    if (!this.#loaded) {
      this.#loaded = true;
      this.#build(this.#site);
    }
  }

  #build(site: Site | undefined): void {
    const sync = site?.sync;
    this.#paths = [...(site?.cloaking.paths ?? [])];
    this.#forms = new Map<Category, Form>([
      [
        'site',
        new Form([
          field.text('name', 'Site name', site?.name ?? '', { help: 'The name you know the site by; unique, ignoring case.' }),
          field.text('localRoot', 'Local site folder', site?.localRoot ?? this.#services.cwd, { help: 'The folder on this computer that holds the site.' }),
        ]),
      ],
      [
        'local',
        new Form([
          field.text('webUrl', 'Web URL', site?.local.webUrl ?? '', { help: 'The local web address, such as http://localhost:8080/. Optional.' }),
          field.choice(
            'caseSensitive',
            'Case-sensitive names',
            [
              { label: 'Ask the file system', value: 'auto' },
              { label: 'Yes', value: 'yes' },
              { label: 'No', value: 'no' },
            ],
            site?.local.caseSensitive === undefined ? 'auto' : site.local.caseSensitive ? 'yes' : 'no',
          ),
          field.toggle('cache', 'Enable cache', site?.local.cache ?? true, 'Remembers file hashes between runs in checksum mode.'),
        ]),
      ],
      [
        'cloaking',
        new Form([
          field.toggle('enabled', 'Enable cloaking', site?.cloaking.enabled ?? true),
          field.toggle('useGlobal', 'Use global patterns', site?.cloaking.useGlobalPatterns !== false, 'The global patterns come before the patterns below; !x below re-includes.'),
          field.note('global', 'Global patterns', ''),
          field.action('editGlobal', 'Edit global patterns...'),
          field.lines('patterns', 'Cloak files matching', (site?.cloaking.patterns ?? []).join('\n'), 6, PATTERN_HELP),
          field.note('paths', 'Cloaked paths', ''),
          field.action('uncloak', 'Uncloak a path...'),
        ]),
      ],
      [
        'sync',
        new Form([
          field.toggle('maintainInfo', 'Maintain sync information', sync?.maintainInfo ?? true, 'Keeps sync records, so changes on both sides are detected.'),
          field.choice('compare', 'Compare files by', [
            { label: 'Size and time', value: 'metadata' },
            { label: 'Checksum', value: 'checksum' },
          ], sync?.compare ?? 'metadata'),
          field.text('tolerance', 'Time tolerance (seconds)', String(sync?.mtimeToleranceSeconds ?? 2), { help: 'Times closer than this count as equal, for servers that round them.' }),
          field.choice('symlinks', 'Symbolic links', [
            { label: 'Skip them', value: 'skip' },
            { label: 'Follow inside site', value: 'follow-inside-root' },
          ], sync?.symlinks ?? 'skip'),
          field.text('concurrency', 'Transfers at once', String(sync?.concurrency ?? 4), { help: 'From 1 to 16.' }),
          field.text('maxCount', 'Delete limit (files)', String(sync?.massDelete.maxCount ?? 50), { help: 'Deleting more files than this asks you to confirm by typing the count.' }),
          field.text('maxPercent', 'Delete limit (percent)', String(sync?.massDelete.maxPercent ?? 25), { help: 'Deleting more than this share of the files asks you to confirm too.' }),
          field.toggle('recovery', 'Keep a recovery copy', sync?.recovery.enabled ?? true, 'Local files that are deleted or overwritten are kept in the recovery folder first.'),
          field.text('keepDays', 'Keep copies for (days)', String(sync?.recovery.keepDays ?? 14)),
          field.text('maxMegabytes', 'Recovery size (MB)', String(sync?.recovery.maxMegabytes ?? 1024)),
        ]),
      ],
      [
        'security',
        new Form([
          field.toggle('guard', 'Hold back sensitive files', sync?.guard.enabled ?? true, 'Matching files are listed unchecked; you decide.'),
          field.lines('guardPatterns', 'Also hold back', (sync?.guard.patterns ?? []).join('\n'), 4),
          field.note('builtIn', 'Always held back', DEFAULT_GUARD_PATTERNS.join('  ')),
        ]),
      ],
    ]);
  }

  body(width: number, height: number, theme: Theme): ViewBody {
    const sym = symbols(theme);
    const sidebar: Line[] = SIDEBAR.map((item, index) => {
      const selected = index === this.#category;
      const text = padEnd(`${item.indent ? '  ' : ''}${item.label}`, SIDEBAR_WIDTH - 2);
      const tone = selected ? (this.#pane === 'sidebar' ? 'focus' : 'bold') : item.id === 'advanced' ? 'dim' : undefined;
      return [span(selected ? `${sym.pointer} ` : '  '), span(text, tone)];
    });
    const contentWidth = Math.max(20, width - SIDEBAR_WIDTH - 1);
    const content = this.#content(contentWidth, height, theme);
    const lines: Line[] = [];
    for (let row = 0; row < height; row += 1) {
      lines.push([...padLine(sidebar[row] ?? [], SIDEBAR_WIDTH), ...(content.lines[row] ?? [])]);
    }
    return {
      lines,
      cursor: content.cursor === undefined ? undefined : { row: content.cursor.row, col: content.cursor.col + SIDEBAR_WIDTH },
    };
  }

  #content(width: number, height: number, theme: Theme): ViewBody {
    const category = this.#categoryId();
    const active = this.#pane === 'content';
    if (category === 'servers') {
      if (this.#site === undefined) {
        return { lines: [[span('  Save the site first (Ctrl+S), then add its servers here.')]] };
      }
      const site = this.#site;
      // Name, host, protocol, Remote; Testing takes the rest. The message bar shows the full address.
      const widths = [12, Math.max(8, width - 48), 13, 6];
      const rows = this.#servers.items.map((server, index) =>
        tableRow(
          [
            server.name,
            serverAddress(server),
            protocolName(server.protocol),
            site.remoteServerId === server.id ? '(*)' : '( )',
            site.testingServerId === server.id ? '(*)' : '( )',
          ],
          widths,
          width,
          active && index === this.#servers.index,
          theme,
        ),
      );
      return {
        lines: [
          headerRow(['Name', 'Host', 'Protocol', 'Remote', 'Testing'], widths),
          ...(rows.length === 0 ? [[span('  No servers yet. Press a to add one.')]] : rows),
        ],
      };
    }
    const form = this.#forms.get(category);
    if (category === 'cloaking' && form !== undefined) {
      const note = form.get('paths');
      if (note?.kind === 'note') {
        note.text = this.#paths.length === 0 ? '(none)' : this.#paths.join('  ');
      }
      const global = form.get('global');
      if (global?.kind === 'note') {
        global.text = this.#globalPatterns.length === 0 ? '(none)' : this.#globalPatterns.join('  ');
      }
    }
    return form?.render(width, height, theme, active) ?? { lines: [] };
  }

  #moveCategory(delta: number): void {
    let next = this.#category + delta;
    if (SIDEBAR[next]?.id === 'advanced') {
      next += delta;
    }
    if (next >= 0 && next < SIDEBAR.length) {
      this.#category = next;
    }
  }

  async key(press: Key, app: App): Promise<void> {
    if (isKey(press, 'ctrl+s')) {
      await this.#save(app);
      return;
    }
    if (isKey(press, 'tab') || isKey(press, 'shift+tab')) {
      this.#pane = this.#pane === 'sidebar' ? 'content' : 'sidebar';
      return;
    }
    if (isKey(press, 'escape') && !(this.#pane === 'content' && this.#categoryId() === 'servers' && this.#servers.filtering)) {
      if (this.#pane === 'content') {
        this.#pane = 'sidebar';
        return;
      }
      if (this.#dirty && !(await app.dialog(confirmDialog('Unsaved changes', 'Leave without saving the changes to this site?', { yes: 'Leave' })))) {
        return;
      }
      app.pop();
      return;
    }
    if (this.#pane === 'sidebar') {
      if (isKey(press, 'up') || press.text === 'k') {
        this.#moveCategory(-1);
      } else if (isKey(press, 'down') || press.text === 'j') {
        this.#moveCategory(1);
      } else if (isKey(press, 'enter') || isKey(press, 'right')) {
        this.#pane = 'content';
      }
      return;
    }
    if (this.#categoryId() === 'servers') {
      await this.#serverKey(press, app);
      return;
    }
    const form = this.#forms.get(this.#categoryId());
    const result = form?.key(press);
    if (result?.changed === true) {
      this.#dirty = true;
    }
    if (result?.action === 'editGlobal') {
      app.push(new GlobalCloakingView(this.#services));
      return;
    }
    if (result?.action === 'uncloak') {
      if (this.#paths.length === 0) {
        app.message('No path is cloaked one by one.');
        return;
      }
      const chosen = await app.dialog(choiceDialog<string | undefined>('Uncloak', 'Which path should no longer be cloaked?', this.#paths.map((item) => ({ label: item, value: item })), undefined));
      if (chosen !== undefined) {
        this.#paths = this.#paths.filter((item) => item !== chosen);
        this.#dirty = true;
      }
    }
  }

  async #serverKey(press: Key, app: App): Promise<void> {
    const site = this.#site;
    if (site === undefined) {
      return;
    }
    if (this.#servers.key(press, 10)) {
      return;
    }
    const server = this.#servers.selected;
    const registry = await this.#services.registry();
    if (press.text === 'a') {
      app.push(new ServerEditorView(this.#services, site.id, undefined));
    } else if ((isKey(press, 'enter') || press.text === 'e') && server !== undefined) {
      app.push(new ServerEditorView(this.#services, site.id, server.id));
    } else if (press.text === 'c' && server !== undefined) {
      const names = new Set(site.servers.map((item) => item.name.toLowerCase()));
      let name = `${server.name} copy`;
      for (let index = 2; names.has(name.toLowerCase()); index += 1) {
        name = `${server.name} copy ${String(index)}`;
      }
      await registry.addServer(site.id, { ...server, id: randomUUID(), name, options: { ...server.options, hostKey: undefined } });
      app.message(`Added "${name}".`);
      await this.shown();
    } else if ((isKey(press, 'delete') || press.text === 'd') && server !== undefined) {
      if (await app.dialog(confirmDialog('Remove server', `Remove "${server.name}" from "${site.name}"? The files on the server are not touched.`, { yes: 'Remove' }))) {
        await registry.removeServer(site.id, server.id);
        const store = await this.#services.credentialStore();
        for (const kind of ['password', 'passphrase'] as const) {
          await store?.delete({ siteId: site.id, serverId: server.id, kind }).catch(() => false);
        }
        await rm(path.join(registry.paths.stateDir, 'sites', site.id, `${server.id}.json`), { force: true });
        app.message(`Removed "${server.name}".`);
        await this.shown();
      }
    } else if (press.text === 't' && server !== undefined) {
      const report = await app.task(`Testing ${server.name}`, async (signal) => {
        const session = await openSession(app, this.#services, site.id, server.id);
        try {
          return await session.testConnection(signal);
        } finally {
          await session.close();
        }
      });
      if (report !== undefined) {
        app.message(`Connected to ${server.name}: ${String(report.rootEntries)} entries in ${server.remoteRoot}${report.tls === undefined ? '' : `, ${report.tls}`}.`);
      }
    } else if (press.text === 'r' && server !== undefined) {
      await registry.update(site.id, (draft) => {
        draft.remoteServerId = server.id;
      });
      await this.shown();
    } else if (press.text === 'T' && server !== undefined) {
      await registry.update(site.id, (draft) => {
        if (draft.testingServerId === server.id) {
          delete draft.testingServerId;
        } else {
          draft.testingServerId = server.id;
        }
      });
      await this.shown();
    }
  }

  async #save(app: App): Promise<void> {
    const forms = this.#forms;
    const get = (category: Category): Form => forms.get(category) ?? new Form([]);
    for (const form of forms.values()) {
      form.clearErrors();
    }
    const siteForm = get('site');
    const syncForm = get('sync');
    const problems: [Category, string, string][] = [];
    const name = siteForm.text('name');
    if (name === '') {
      problems.push(['site', 'name', 'Enter a name.']);
    }
    const localRoot = path.resolve(this.#services.cwd, siteForm.text('localRoot'));
    let isFolder: boolean;
    try {
      isFolder = statSync(localRoot).isDirectory();
    } catch {
      isFolder = false;
    }
    if (!isFolder) {
      problems.push(['site', 'localRoot', `Folder not found: ${localRoot}`]);
    }
    const numbers = {
      tolerance: whole(syncForm.text('tolerance'), 'The tolerance', 0, 3600),
      concurrency: whole(syncForm.text('concurrency'), 'Transfers at once', 1, 16),
      maxCount: whole(syncForm.text('maxCount'), 'The count', 0, 1_000_000),
      maxPercent: whole(syncForm.text('maxPercent'), 'The percentage', 0, 100),
      keepDays: whole(syncForm.text('keepDays'), 'The days', 0, 3650),
      maxMegabytes: whole(syncForm.text('maxMegabytes'), 'The size', 0, 1_000_000),
    };
    for (const [id, value] of Object.entries(numbers)) {
      if (typeof value === 'string') {
        problems.push(['sync', id, value]);
      }
    }
    if (problems.length > 0) {
      for (const [category, id, message] of problems) {
        get(category).setError(id, message);
      }
      const [category, id, message] = problems[0] ?? ['site', 'name', ''];
      this.#category = SIDEBAR.findIndex((item) => item.id === category);
      this.#pane = 'content';
      get(category).focusOn(id);
      app.message(problems.length === 1 ? message : `${message} (${String(problems.length)} problems to fix)`, 'warning');
      return;
    }
    const localForm = get('local');
    const cloakForm = get('cloaking');
    const securityForm = get('security');
    const caseChoice = localForm.choice('caseSensitive');
    const webUrl = localForm.text('webUrl');
    const settings = {
      name,
      localRoot,
      local: {
        ...(webUrl === '' ? {} : { webUrl }),
        ...(caseChoice === 'auto' ? {} : { caseSensitive: caseChoice === 'yes' }),
        cache: localForm.toggle('cache'),
      },
      cloaking: {
        enabled: cloakForm.toggle('enabled'),
        ...(cloakForm.toggle('useGlobal') ? {} : { useGlobalPatterns: false }),
        patterns: splitPatterns(cloakForm.text('patterns')),
        paths: this.#paths,
      },
      sync: {
        maintainInfo: syncForm.toggle('maintainInfo'),
        compare: syncForm.choice('compare') as 'metadata' | 'checksum',
        mtimeToleranceSeconds: numbers.tolerance as number,
        symlinks: syncForm.choice('symlinks') as 'skip' | 'follow-inside-root',
        concurrency: numbers.concurrency as number,
        guard: { enabled: securityForm.toggle('guard'), patterns: splitPatterns(securityForm.text('guardPatterns')) },
        massDelete: { maxCount: numbers.maxCount as number, maxPercent: numbers.maxPercent as number },
        recovery: { enabled: syncForm.toggle('recovery'), keepDays: numbers.keepDays as number, maxMegabytes: numbers.maxMegabytes as number },
      },
    };
    const registry = await this.#services.registry();
    try {
      if (this.#siteId === undefined) {
        const added = await registry.add(settings);
        this.#siteId = added.id;
      } else {
        await registry.update(this.#siteId, (draft) => {
          Object.assign(draft, settings);
        });
      }
    } catch (error) {
      app.message(isSyncError(error) ? error.message.split('\n').slice(0, 2).join(' ') : String(error), 'error');
      return;
    }
    this.#dirty = false;
    await this.shown();
    app.message(`Saved "${name}".`);
  }
}

function padLine(line: Line, width: number): Line {
  const used = line.reduce((sum, part) => sum + part.text.length, 0);
  return used >= width ? line : [...line, span(' '.repeat(width - used))];
}
