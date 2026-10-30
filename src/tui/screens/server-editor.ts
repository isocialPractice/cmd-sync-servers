import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { parseServerAddress } from '../../config/address.ts';
import { defaultPort, serverSchema, type Protocol, type Server, type Site } from '../../config/schema.ts';
import { isSyncError } from '../../errors.ts';
import { sealSecret, secretBinding } from '../../credentials/binding.ts';
import type { SecretKind } from '../../credentials/types.ts';
import { remoteRootIsTop } from '../../sync/session.ts';
import type { App, Hint, View, ViewBody } from '../app.ts';
import { isKey, type Key } from '../keys.ts';
import { probeUnsaved, typedPath, type TuiServices } from '../services.ts';
import { span, type Line, type Theme } from '../style.ts';
import { confirmDialog, inputDialog } from '../widgets/dialog.ts';
import { field, Form, type FormField } from '../widgets/form.ts';
import { folderPickerDialog } from '../widgets/folder-picker.ts';
import { protocolName } from './common.ts';

type Tab = 'basic' | 'advanced';

/** The protocols a server can use, as the Protocol field offers them. */
export const PROTOCOL_OPTIONS = [
  { label: 'SFTP', value: 'sftp' },
  { label: 'FTPS, explicit TLS', value: 'ftps' },
  { label: 'FTPS, implicit TLS', value: 'ftps-implicit' },
  { label: 'FTP, insecure', value: 'ftp' },
  { label: 'Local or network folder', value: 'local' },
];

/** Where a schema problem shows: the form field of an issue path. */
const ISSUE_FIELDS: Readonly<Record<string, string>> = {
  name: 'name',
  host: 'host',
  port: 'port',
  username: 'username',
  'auth.method': 'auth',
  'auth.keyPath': 'keyPath',
  remoteRoot: 'remoteRoot',
  webUrl: 'webUrl',
  'options.timeoutSeconds': 'timeout',
  'options.allowInsecure': 'allowInsecure',
  'options.tls.caFile': 'caFile',
  'options.tls.servername': 'servername',
  'options.remoteFileMode': 'fileMode',
  'options.remoteDirMode': 'dirMode',
};

function sameName(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
}

/** A host key or certificate trusted while testing or browsing, kept until the server is saved. */
interface Pending {
  hostKey?: Server['options']['hostKey'];
  trustedCertificate?: NonNullable<Server['options']['tls']>['trustedCertificate'];
}

/**
 * Dreamweaver's server dialog: a Basic tab with the connection and an
 * Advanced tab with the rest. Fields that the chosen protocol does not use
 * are hidden. Test and Browse connect with the values the form shows,
 * without saving them. Ctrl+S saves; secrets go to the OS credential store
 * only.
 */
export class ServerEditorView implements View {
  readonly #services: TuiServices;
  readonly #siteId: string;
  #serverId: string | undefined;
  #site: Site | undefined;
  #server: Server | undefined;
  #tab: Tab = 'basic';
  #fields: Map<string, FormField> | undefined;
  #basic = new Form([]);
  #advanced = new Form([]);
  #dirty = false;
  #pending: Pending = {};
  /** A secret the server accepted while testing, with the settings it was accepted for, saved with the server. */
  #accepted: { readonly binding: string; readonly kind: SecretKind; readonly secret: string } | undefined;

  constructor(services: TuiServices, siteId: string, serverId: string | undefined) {
    this.#services = services;
    this.#siteId = siteId;
    this.#serverId = serverId;
  }

  title(): string {
    const name = this.#server?.name ?? 'New server';
    return `${this.#site?.name ?? 'Site'}: ${name}`;
  }

  primary(): string {
    return 'Ctrl+S Save';
  }

  hints(): readonly Hint[] {
    return [
      { key: 'Tab', label: this.#tab === 'basic' ? 'Advanced' : 'Basic' },
      { key: 'Up/Down', label: 'Move' },
      { key: 'Space', label: 'Change' },
      { key: 'Ctrl+S', label: 'Save' },
      { key: 'Esc', label: 'Back' },
    ];
  }

  keys(): readonly Hint[] {
    return [
      { key: 'Tab, Shift+Tab', label: 'Switch between Basic and Advanced' },
      { key: 'Up/Down', label: 'Move between fields' },
      { key: 'Space, Left/Right', label: 'Change a toggle or a choice' },
      { key: 'Enter', label: 'Next field, or run the focused button' },
      { key: 'Ctrl+S', label: 'Save the server' },
      { key: 'Esc', label: 'Back; asks before dropping unsaved changes' },
    ];
  }

  capturesText(): boolean {
    return this.#form().capturesText();
  }

  status(): string | undefined {
    return this.#form().status() ?? (this.#dirty ? 'Unsaved changes. Ctrl+S saves them.' : undefined);
  }

  #form(): Form {
    return this.#tab === 'basic' ? this.#basic : this.#advanced;
  }

  async shown(): Promise<void> {
    const registry = await this.#services.registry();
    await registry.reload();
    this.#site = registry.get(this.#siteId);
    this.#server = this.#site?.servers.find((server) => server.id === this.#serverId);
    if (this.#fields === undefined) {
      this.#fields = this.#build(this.#server, (await this.#services.credentialStore())?.name);
      this.#layout();
    }
    this.#trustNotes();
  }

  #build(server: Server | undefined, storeName: string | undefined): Map<string, FormField> {
    const options = server?.options;
    const fields: FormField[] = [
      field.text('name', 'Server name', server?.name ?? '', { help: 'Unique within the site.' }),
      field.choice('protocol', 'Protocol', PROTOCOL_OPTIONS, server?.protocol ?? 'sftp', 'SFTP is the safest choice. Plain FTP sends the password in clear text.'),
      field.text('host', 'Host', server?.host ?? '', { help: 'The host name or IP address, such as sftp.example.com. host:port fills Port.' }),
      field.text('port', 'Port', server?.port === undefined ? '' : String(server.port), { help: 'Empty uses the default: 22 for SFTP, 21 for FTP and FTPS, 990 for implicit FTPS.' }),
      field.text('username', 'User', server?.username ?? '', { help: 'Many hosts name FTP accounts in full, such as demo-user@example.com.' }),
      field.choice('auth', 'Sign in with', [
        { label: 'Password', value: 'password' },
        { label: 'Private key file', value: 'key' },
        { label: 'SSH agent', value: 'agent' },
      ], server?.auth?.method ?? 'password'),
      field.text('keyPath', 'Private key file', server?.auth?.keyPath ?? '', { help: 'The key is read from this file when connecting; it is never copied.' }),
      field.toggle(
        'savePassword',
        'Save password',
        server?.auth?.savePassword ?? false,
        storeName === undefined ? 'No credential store is available here; the password is asked for when connecting.' : `Keeps it in the ${storeName}, never in a file.`,
      ),
      field.action('setPassword', 'Set password...', 'Saves the password, or the key passphrase, in the credential store now.'),
      field.text('remoteRoot', 'Root directory', server?.remoteRoot ?? (server === undefined ? '/' : ''), { help: 'The site folder on the server, starting with "/". Browse picks it from what the server shows.' }),
      field.action('browse', 'Browse...', 'Connects with the values shown and lets you pick the folder from what the server shows.'),
      field.text('folder', 'Folder', server?.protocol === 'local' ? server.remoteRoot : '', { help: 'A local, mounted or network folder: an absolute path.' }),
      field.action('test', 'Test', 'Connects with the values shown, without saving them, and checks the root directory.'),
      field.text('webUrl', 'Web URL', server?.webUrl ?? '', { help: 'The address of the site on this server, such as https://www.example.com/. Optional.' }),
      field.text('timeout', 'Timeout (seconds)', String(options?.timeoutSeconds ?? 30)),
      field.choice('ipFamily', 'IP version', [
        { label: 'Either', value: 'any' },
        { label: 'IPv4 only', value: '4' },
        { label: 'IPv6 only', value: '6' },
      ], options?.ipFamily === undefined ? 'any' : String(options.ipFamily)),
      field.note('passive', 'Passive mode', 'Always on; active mode is not supported.'),
      field.toggle('allowInsecure', 'Allow plain FTP', options?.allowInsecure ?? false, 'Plain FTP sends the password and every file in clear text.'),
      field.toggle('legacyAlgorithms', 'Allow older algorithms', options?.legacyAlgorithms ?? false, 'Only for an old server that offers nothing newer.'),
      field.text('caFile', 'Extra CA file', options?.tls?.caFile ?? '', { help: 'A PEM file of certificate authorities, for a server with a private CA.' }),
      field.text('servername', 'Certificate name', options?.tls?.servername ?? '', { help: 'The name to check the certificate against, when it differs from the host.' }),
      field.choice('minVersion', 'Lowest TLS version', [
        { label: 'TLS 1.2', value: 'TLSv1.2' },
        { label: 'TLS 1.3', value: 'TLSv1.3' },
      ], options?.tls?.minVersion ?? 'TLSv1.2'),
      field.text('fileMode', 'File permissions', options?.remoteFileMode ?? '', { help: 'An octal mode such as 644 for uploaded files. Empty leaves the server default.' }),
      field.text('dirMode', 'Folder permissions', options?.remoteDirMode ?? '', { help: 'An octal mode such as 755 for new folders. Empty leaves the server default.' }),
      field.toggle('allowRootDeletes', 'Allow deletes at "/"', options?.allowRootDeletes ?? false, 'Deletes are refused when the root directory is "/" or a drive, unless this is on.'),
      field.toggle('uploadOnSave', 'Upload on save', options?.uploadOnSave ?? false, 'Used by the VS Code extension: puts a file when it is saved.'),
      field.note('hostKey', 'Host key', ''),
      field.action('forgetHostKey', 'Forget host key', 'The next connection asks to trust the host key again.'),
      field.note('certificate', 'Certificate', ''),
      field.action('forgetCertificate', 'Forget certificate', 'The next connection verifies the certificate again, and asks when it does not verify.'),
    ];
    return new Map(fields.map((item) => [item.id, item]));
  }

  /** Shows the fields the chosen protocol uses, keeping every value. */
  #layout(): void {
    const all = this.#fields;
    if (all === undefined) {
      return;
    }
    const protocol = this.#protocol();
    const remote = protocol !== 'local';
    const sftp = protocol === 'sftp';
    const tls = protocol === 'ftps' || protocol === 'ftps-implicit';
    const method = sftp ? this.#choice('auth') : 'password';
    const pick = (ids: readonly (string | false)[]): FormField[] =>
      ids.flatMap((id) => {
        const found = id === false ? undefined : all.get(id);
        return found === undefined ? [] : [found];
      });
    const focusBasic = this.#basic.focused?.id;
    const focusAdvanced = this.#advanced.focused?.id;
    this.#basic = new Form(
      pick([
        'name',
        'protocol',
        remote && 'host',
        remote && 'port',
        remote && 'username',
        sftp && 'auth',
        method === 'key' && 'keyPath',
        remote && method !== 'agent' && 'savePassword',
        remote && method !== 'agent' && 'setPassword',
        remote ? 'remoteRoot' : 'folder',
        remote && 'browse',
        'test',
      ]),
    );
    this.#advanced = new Form(
      pick([
        'webUrl',
        remote && 'timeout',
        remote && 'ipFamily',
        (protocol === 'ftp' || tls) && 'passive',
        protocol === 'ftp' && 'allowInsecure',
        sftp && 'legacyAlgorithms',
        tls && 'caFile',
        tls && 'servername',
        tls && 'minVersion',
        remote && 'fileMode',
        remote && 'dirMode',
        'allowRootDeletes',
        'uploadOnSave',
        sftp && 'hostKey',
        sftp && 'forgetHostKey',
        tls && 'certificate',
        tls && 'forgetCertificate',
      ]),
    );
    if (focusBasic !== undefined) {
      this.#basic.focusOn(focusBasic);
    }
    if (focusAdvanced !== undefined) {
      this.#advanced.focusOn(focusAdvanced);
    }
  }

  /** The host key and certificate notes: what is pinned, or trusted while testing and not saved yet. */
  #trustNotes(): void {
    const hostKey = this.#fields?.get('hostKey');
    if (hostKey?.kind === 'note') {
      const pinned = this.#pending.hostKey ?? this.#server?.options.hostKey;
      hostKey.text =
        pinned === undefined
          ? 'Not trusted yet; the first connection asks.'
          : `${pinned.algorithm} SHA256:${pinned.sha256}${this.#pending.hostKey === undefined ? '' : ' (saved with the server)'}`;
    }
    const certificate = this.#fields?.get('certificate');
    if (certificate?.kind === 'note') {
      const trusted = this.#pending.trustedCertificate ?? this.#server?.options.tls?.trustedCertificate;
      certificate.text =
        trusted === undefined
          ? 'Verified normally; none is trusted by fingerprint.'
          : `Trusted: SHA-256 ${trusted.sha256}${this.#pending.trustedCertificate === undefined ? '' : ' (saved with the server)'}`;
    }
  }

  #text(id: string): string {
    const item = this.#fields?.get(id);
    return item?.kind === 'text' ? item.field.value.trim() : '';
  }

  #setText(id: string, value: string): void {
    const item = this.#fields?.get(id);
    if (item?.kind === 'text') {
      item.field.value = value;
    }
  }

  #choice(id: string): string {
    const item = this.#fields?.get(id);
    return item?.kind === 'choice' ? (item.options[item.index]?.value ?? '') : '';
  }

  #setChoice(id: string, value: string): void {
    const item = this.#fields?.get(id);
    if (item?.kind === 'choice') {
      item.index = Math.max(0, item.options.findIndex((option) => option.value === value));
    }
  }

  #toggle(id: string): boolean {
    const item = this.#fields?.get(id);
    return item?.kind === 'toggle' && item.value;
  }

  #setToggle(id: string, value: boolean): void {
    const item = this.#fields?.get(id);
    if (item?.kind === 'toggle') {
      item.value = value;
    }
  }

  #protocol(): Protocol {
    return this.#choice('protocol') as Protocol;
  }

  body(width: number, height: number, theme: Theme): ViewBody {
    const tabs: Line = [
      span('  '),
      span(' Basic ', this.#tab === 'basic' ? 'focus' : 'dim'),
      span('  '),
      span(' Advanced ', this.#tab === 'advanced' ? 'focus' : 'dim'),
      span(`   ${protocolName(this.#protocol())}`, 'dim'),
    ];
    const form = this.#form().render(width, Math.max(1, height - 2), theme, true);
    return {
      lines: [tabs, [], ...form.lines],
      cursor: form.cursor === undefined ? undefined : { row: form.cursor.row + 2, col: form.cursor.col },
    };
  }

  async key(press: Key, app: App): Promise<void> {
    if (isKey(press, 'ctrl+s')) {
      await this.#save(app);
      return;
    }
    if (isKey(press, 'tab') || isKey(press, 'shift+tab')) {
      this.#readHost();
      this.#tab = this.#tab === 'basic' ? 'advanced' : 'basic';
      return;
    }
    if (isKey(press, 'escape')) {
      if (this.#dirty && !(await app.dialog(confirmDialog('Unsaved changes', 'Leave without saving the changes to this server?', { yes: 'Leave' })))) {
        return;
      }
      app.pop();
      return;
    }
    const before = this.#form().focused?.id;
    const result = this.#form().key(press);
    if (result.changed === true) {
      this.#dirty = true;
      if (before === 'protocol' || before === 'auth') {
        this.#layout();
      }
    }
    if (before === 'host' && this.#form().focused?.id !== 'host') {
      this.#readHost();
    }
    switch (result.action) {
      case 'setPassword':
        await this.#setPassword(app);
        break;
      case 'test':
        await this.#test(app);
        break;
      case 'browse':
        await this.#browse(app);
        break;
      case 'forgetHostKey':
        await this.#forgetHostKey(app);
        break;
      case 'forgetCertificate':
        await this.#forgetCertificate(app);
        break;
      default:
        break;
    }
  }

  /**
   * Splits what was typed in Host as the Host field reads it elsewhere: a
   * port goes to Port, a user to User when it is empty, and a protocol to
   * Protocol. A problem shows under Host.
   */
  #readHost(): void {
    const text = this.#text('host');
    if (text === '' || this.#protocol() === 'local') {
      return;
    }
    const parsed = parseServerAddress(text);
    if (!parsed.ok) {
      this.#basic.setError('host', parsed.problem);
      return;
    }
    this.#basic.setError('host', undefined);
    const { address } = parsed;
    if (address.protocol !== undefined && address.protocol !== this.#protocol()) {
      this.#setChoice('protocol', address.protocol);
      this.#layout();
    }
    if (address.port !== undefined) {
      this.#setText('port', String(address.port));
    }
    if (address.username !== undefined && this.#text('username') === '') {
      this.#setText('username', address.username);
    }
    if (address.remoteRoot !== undefined && (this.#text('remoteRoot') === '' || this.#text('remoteRoot') === '/')) {
      this.#setText('remoteRoot', address.remoteRoot);
    }
    this.#setText('host', address.host);
  }

  #requireSaved(app: App, what: string): Server | undefined {
    if (this.#server === undefined || this.#dirty) {
      app.message(`Save the server first (Ctrl+S), then ${what}.`, 'warning');
      return undefined;
    }
    return this.#server;
  }

  async #setPassword(app: App): Promise<void> {
    const server = this.#requireSaved(app, 'set its password');
    if (server === undefined) {
      return;
    }
    const store = await this.#services.credentialStore();
    if (store === undefined) {
      app.message('No credential store is available. Passwords are never written to a file; set SYNC_SERVERS_PASSWORD or enter it when asked.', 'warning');
      return;
    }
    const kind: SecretKind = server.auth?.method === 'key' ? 'passphrase' : 'password';
    const label = kind === 'password' ? 'password' : 'key passphrase';
    const secret = await app.dialog(inputDialog(`Set ${label}`, `The ${label} for ${server.username ?? 'this server'} at ${server.host ?? ''}. It is kept in the ${store.name}.`, { masked: true }));
    if (secret === undefined || secret === '') {
      return;
    }
    this.#services.logger.redactor.addSecret(secret);
    await store.set({ siteId: this.#siteId, serverId: server.id, kind }, sealSecret(secret, server));
    const registry = await this.#services.registry();
    this.#server = await registry.updateServer(this.#siteId, server.id, (draft) => {
      draft.auth ??= { method: 'password', savePassword: true };
      draft.auth.savePassword = true;
    });
    this.#setToggle('savePassword', true);
    app.message(`Saved the ${label} in the ${store.name}.`);
  }

  /**
   * The server as the form shows it, for connecting before it is saved: with
   * a root of "/" when the root field is not a path yet, since Browse picks it.
   */
  #unsaved(app: App, forBrowsing: boolean): Server | undefined {
    const draft = this.#draft({ rootOptional: forBrowsing });
    if (draft === undefined) {
      app.message(this.#form().status() ?? 'Fix the marked fields first.', 'warning');
      return undefined;
    }
    return serverSchema.parse({ ...draft, id: this.#serverId ?? randomUUID() });
  }

  /** Writes what a connection decided into the form; the server is saved with it on Ctrl+S. */
  #applyDecisions(before: Server, after: Server): boolean {
    let changed = false;
    if (after.host !== before.host && after.host !== undefined) {
      this.#setText('host', after.host);
      changed = true;
    }
    const servername = after.options.tls?.servername;
    if (servername !== undefined && servername !== before.options.tls?.servername) {
      this.#setText('servername', servername);
      changed = true;
    }
    if (after.options.hostKey !== undefined && after.options.hostKey.sha256 !== before.options.hostKey?.sha256) {
      this.#pending.hostKey = after.options.hostKey;
      changed = true;
    }
    const trusted = after.options.tls?.trustedCertificate;
    if (trusted !== undefined && trusted.sha256 !== before.options.tls?.trustedCertificate?.sha256) {
      this.#pending.trustedCertificate = trusted;
      changed = true;
    }
    if (changed) {
      this.#dirty = true;
      this.#trustNotes();
    }
    return changed;
  }

  async #test(app: App): Promise<void> {
    const server = this.#unsaved(app, false);
    if (server === undefined) {
      return;
    }
    const outcome = await probeUnsaved(app, this.#services, {
      site: { id: this.#siteId, name: this.#site?.name ?? '' },
      server,
      label: `Connecting to ${server.protocol === 'local' ? server.remoteRoot : (server.host ?? '')}`,
      use: async (probe) => ({
        capabilities: probe.capabilities,
        rootFound: server.protocol === 'local' || (await probe.exists(server.remoteRoot)),
        entries: server.protocol === 'local' ? undefined : (await probe.folders(server.remoteRoot).catch(() => undefined))?.folders.length,
      }),
    });
    const decided = this.#applyDecisions(server, outcome.server);
    if (!outcome.ok) {
      const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      if (isSyncError(outcome.error, 'E_AUTH')) {
        this.#basic.setError('username', message.split('\n')[0] ?? message);
      }
      app.message(formatFirstLines(message), 'error');
      return;
    }
    this.#remember(outcome);
    const { capabilities, rootFound } = outcome.value;
    if (!rootFound) {
      const start = capabilities.startingFolder === undefined ? '' : ` The account opens in "${capabilities.startingFolder}".`;
      app.message(`Connected, but the root directory ${server.remoteRoot} was not found: Browse picks it.${start}`, 'warning');
      return;
    }
    const details = [capabilities.tls, capabilities.software].filter((item) => item !== undefined && item !== '').join(', ');
    const unsaved = this.#dirty || decided ? ' Not saved yet: Ctrl+S saves these settings.' : '';
    app.message(`Connected; the root directory was found.${unsaved}${details === '' ? '' : ` ${details}.`}`);
  }

  async #browse(app: App): Promise<void> {
    const server = this.#unsaved(app, true);
    if (server === undefined) {
      return;
    }
    const current = this.#text('remoteRoot');
    const outcome = await probeUnsaved(app, this.#services, {
      site: { id: this.#siteId, name: this.#site?.name ?? '' },
      server,
      label: `Connecting to ${server.host ?? ''}`,
      use: async (probe) => {
        const start = current.startsWith('/') && (await probe.exists(current)) ? current : (probe.startingFolder ?? '/');
        return app.dialog(folderPickerDialog(probe, start, (work) => app.background(work)));
      },
    });
    this.#applyDecisions(server, outcome.server);
    if (!outcome.ok) {
      const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      app.message(formatFirstLines(message), 'error');
      return;
    }
    this.#remember(outcome);
    const picked = outcome.value;
    if (picked === undefined) {
      return;
    }
    this.#setText('remoteRoot', picked);
    this.#basic.setError('remoteRoot', undefined);
    this.#dirty = true;
    if (remoteRootIsTop({ protocol: server.protocol, remoteRoot: picked }) && !this.#toggle('allowRootDeletes')) {
      const allow = await app.dialog(
        confirmDialog('Deletes at the top', `"${picked}" is the top of what this account can see. Let synchronizing delete files there? Every delete is listed in the preview first.`, {
          yes: 'Allow deletes',
          no: 'Not now',
        }),
      );
      this.#setToggle('allowRootDeletes', allow);
    }
    app.message(`Root directory: ${picked}. Not saved yet: Ctrl+S saves it.`);
  }

  /** Keeps a secret the server accepted, to save with the server if its settings stay the same. */
  #remember(outcome: { readonly server: Server; readonly typed: { readonly kind: SecretKind; readonly secret: string } | undefined }): void {
    if (outcome.typed !== undefined) {
      this.#services.logger.redactor.addSecret(outcome.typed.secret);
      this.#accepted = { binding: secretBinding(outcome.server), ...outcome.typed };
    }
  }

  async #forgetHostKey(app: App): Promise<void> {
    const server = this.#server;
    if (server?.options.hostKey === undefined && this.#pending.hostKey === undefined) {
      app.message('No host key is trusted for this server yet.');
      return;
    }
    if (!(await app.dialog(confirmDialog('Forget host key', 'The next connection will ask you to check and trust the host key again.', { yes: 'Forget' })))) {
      return;
    }
    delete this.#pending.hostKey;
    if (server?.options.hostKey !== undefined) {
      const registry = await this.#services.registry();
      this.#server = await registry.updateServer(this.#siteId, server.id, (draft) => {
        delete draft.options.hostKey;
      });
    }
    this.#trustNotes();
    app.message('Forgot the host key.');
  }

  async #forgetCertificate(app: App): Promise<void> {
    const server = this.#server;
    if (server?.options.tls?.trustedCertificate === undefined && this.#pending.trustedCertificate === undefined) {
      app.message('No certificate is trusted by fingerprint for this server.');
      return;
    }
    if (!(await app.dialog(confirmDialog('Forget certificate', 'The next connection verifies the certificate again, and asks you when it does not verify.', { yes: 'Forget' })))) {
      return;
    }
    delete this.#pending.trustedCertificate;
    if (server?.options.tls?.trustedCertificate !== undefined) {
      const registry = await this.#services.registry();
      this.#server = await registry.updateServer(this.#siteId, server.id, (draft) => {
        if (draft.options.tls !== undefined) {
          delete draft.options.tls.trustedCertificate;
        }
      });
    }
    this.#trustNotes();
    app.message('Forgot the trusted certificate.');
  }

  /** Builds the server from the fields, or sets field problems and returns `undefined`. */
  #draft(mode: { readonly rootOptional?: boolean } = {}): Record<string, unknown> | undefined {
    this.#readHost();
    const problems = new Map<string, string>();
    const protocol = this.#protocol();
    const site = this.#site;
    const name = this.#text('name');
    if (name === '') {
      problems.set('name', 'Enter a name.');
    } else {
      const clash = site?.servers.find((server) => server.id !== this.#serverId && sameName(server.name, name));
      if (clash !== undefined) {
        problems.set('name', `Another server of this site is named "${clash.name}".`);
      }
    }
    const draft: Record<string, unknown> = { name, protocol };
    const options: Record<string, unknown> = {
      allowRootDeletes: this.#toggle('allowRootDeletes') || undefined,
      uploadOnSave: this.#toggle('uploadOnSave'),
    };
    if (protocol === 'local') {
      draft.remoteRoot = this.#text('folder') === '' ? '' : typedPath(this.#services, this.#text('folder'));
    } else {
      const hostText = this.#text('host');
      if (hostText !== '') {
        const parsed = parseServerAddress(hostText);
        if (parsed.ok) {
          draft.host = parsed.address.host;
        } else {
          problems.set('host', parsed.problem);
          draft.host = hostText;
        }
      }
      const port = this.#text('port');
      if (port !== '') {
        const value = Number(port);
        if (!Number.isInteger(value) || value < 1 || value > 65535) {
          problems.set('port', 'Enter a port from 1 to 65535, or leave it empty.');
        } else if (value !== defaultPort(protocol)) {
          draft.port = value;
        }
      }
      draft.username = this.#text('username') || undefined;
      const method = protocol === 'sftp' ? this.#choice('auth') : 'password';
      const keyPath = this.#text('keyPath');
      const resolvedKey = keyPath === '' ? undefined : typedPath(this.#services, keyPath);
      if (method === 'key' && resolvedKey !== undefined && !existsSync(resolvedKey)) {
        problems.set('keyPath', `File not found: ${resolvedKey}`);
      }
      draft.auth = {
        method,
        ...(method === 'key' ? { keyPath: resolvedKey } : {}),
        savePassword: method !== 'agent' && this.#toggle('savePassword'),
      };
      const root = this.#text('remoteRoot');
      draft.remoteRoot = mode.rootOptional === true && !root.startsWith('/') ? '/' : root;
      const timeout = Number(this.#text('timeout'));
      if (!Number.isInteger(timeout) || timeout < 1 || timeout > 600) {
        problems.set('timeout', 'Enter a whole number of seconds from 1 to 600.');
      }
      options.timeoutSeconds = timeout;
      const family = this.#choice('ipFamily');
      options.ipFamily = family === 'any' ? undefined : Number(family);
      options.allowInsecure = protocol === 'ftp' ? this.#toggle('allowInsecure') : undefined;
      options.legacyAlgorithms = protocol === 'sftp' && this.#toggle('legacyAlgorithms') ? true : undefined;
      const sameEndpoint = this.#server?.protocol === protocol && this.#server.host === draft.host && this.#server.port === draft.port;
      if (protocol === 'ftps' || protocol === 'ftps-implicit') {
        const caFile = this.#text('caFile');
        const resolvedCa = caFile === '' ? undefined : typedPath(this.#services, caFile);
        if (resolvedCa !== undefined && !existsSync(resolvedCa)) {
          problems.set('caFile', `File not found: ${resolvedCa}`);
        }
        options.tls = {
          caFile: resolvedCa,
          servername: this.#text('servername') || undefined,
          minVersion: this.#choice('minVersion'),
          // A trusted certificate stays with the server it was trusted for.
          trustedCertificate: this.#pending.trustedCertificate ?? (sameEndpoint ? this.#server?.options.tls?.trustedCertificate : undefined),
        };
      }
      options.remoteFileMode = this.#text('fileMode') || undefined;
      options.remoteDirMode = this.#text('dirMode') || undefined;
      options.hostKey = protocol === 'sftp' ? (this.#pending.hostKey ?? (sameEndpoint ? this.#server?.options.hostKey : undefined)) : undefined;
    }
    const webUrl = this.#text('webUrl');
    draft.webUrl = webUrl === '' ? undefined : /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(webUrl) ? webUrl : `https://${webUrl}`;
    draft.options = JSON.parse(JSON.stringify(options)) as unknown;
    const cleaned = JSON.parse(JSON.stringify(draft)) as Record<string, unknown>;
    const parsed = serverSchema.safeParse({ ...cleaned, id: this.#serverId ?? '00000000-0000-4000-8000-000000000000' });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        let target = ISSUE_FIELDS[issue.path.map(String).join('.')] ?? 'name';
        if (protocol === 'local' && target === 'remoteRoot') {
          target = 'folder';
        }
        if (!problems.has(target)) {
          problems.set(target, issue.message);
        }
      }
    }
    if (problems.size > 0) {
      for (const form of [this.#basic, this.#advanced]) {
        form.clearErrors();
        for (const [id, message] of problems) {
          if (form.fields.some((item) => item.id === id)) {
            form.setError(id, message);
          }
        }
      }
      const first = [...problems.keys()][0] ?? 'name';
      this.#tab = this.#basic.fields.some((item) => item.id === first) ? 'basic' : 'advanced';
      this.#form().focusOn(first);
      return undefined;
    }
    this.#basic.clearErrors();
    this.#advanced.clearErrors();
    return cleaned;
  }

  async #save(app: App): Promise<void> {
    const draft = this.#draft();
    if (draft === undefined) {
      app.message(this.#form().status() ?? 'Fix the marked fields before saving.', 'warning');
      return;
    }
    if (draft.protocol === 'ftp' && (draft.options as { allowInsecure?: boolean }).allowInsecure !== true) {
      if (!(await app.dialog(confirmDialog('Plain FTP', 'Plain FTP sends the password and every file in clear text. Use it anyway?', { yes: 'Use plain FTP' })))) {
        return;
      }
      (draft.options as { allowInsecure?: boolean }).allowInsecure = true;
      this.#setToggle('allowInsecure', true);
    }
    const registry = await this.#services.registry();
    const wasSaving = this.#server?.auth?.savePassword === true;
    let saved: Server;
    try {
      if (this.#serverId === undefined) {
        saved = await registry.addServer(this.#siteId, draft as Parameters<typeof registry.addServer>[1]);
        this.#serverId = saved.id;
      } else {
        saved = await registry.replaceServer(this.#siteId, this.#serverId, draft);
      }
    } catch (error) {
      app.message(isSyncError(error) ? formatFirstLines(error.message) : String(error), 'error');
      return;
    }
    const store = await this.#services.credentialStore();
    const savePassword = saved.auth?.savePassword === true;
    if (wasSaving && !savePassword) {
      for (const kind of ['password', 'passphrase'] as const) {
        await store?.delete({ siteId: this.#siteId, serverId: saved.id, kind }).catch(() => false);
      }
    }
    // A password the server accepted while testing is saved only for the settings it was accepted with.
    let storedSecret = false;
    const accepted = this.#accepted;
    if (accepted !== undefined && savePassword && store !== undefined && secretBinding(saved) === accepted.binding) {
      await store.set({ siteId: this.#siteId, serverId: saved.id, kind: accepted.kind }, sealSecret(accepted.secret, saved));
      storedSecret = true;
    }
    this.#accepted = undefined;
    this.#pending = {};
    this.#dirty = false;
    await this.shown();
    app.message(`Saved "${saved.name}".${storedSecret ? ` The password is saved in the ${store?.name ?? ''}.` : ''}`);
  }
}

function formatFirstLines(message: string): string {
  return message.split('\n').slice(0, 2).map((line) => line.trim()).join(' ');
}
