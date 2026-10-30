import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { parseServerAddress } from '../../config/address.ts';
import { defaultPort, serverSchema, type Protocol, type Server } from '../../config/schema.ts';
import { sealSecret } from '../../credentials/binding.ts';
import { isSyncError } from '../../errors.ts';
import { remoteRootIsTop } from '../../sync/session.ts';
import type { App, Hint, View, ViewBody } from '../app.ts';
import { isKey, type Key } from '../keys.ts';
import { probeUnsaved, typedPath, type TuiServices } from '../services.ts';
import { span, type Theme } from '../style.ts';
import { confirmDialog } from '../widgets/dialog.ts';
import { field, Form, type FormField } from '../widgets/form.ts';
import { folderPickerDialog } from '../widgets/folder-picker.ts';
import { protocolName } from './common.ts';
import { PROTOCOL_OPTIONS } from './server-editor.ts';

function sameName(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
}

function isFolder(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * A new site and its server in one form, as a site manager entry: the
 * site's name and folder, then Protocol, Host, User and Password. Connect
 * signs in with what the form shows, asks about a new host key or
 * certificate, lets the person pick the site's folder from what the server
 * shows, and saves the site and its server together. Nothing is saved
 * before that.
 */
/** Which server a trust decision was made for: the protocol, the host and the port. */
function endpoint(server: Server): string {
  return `${server.protocol}|${(server.host ?? '').toLowerCase()}|${String(server.port ?? '')}`;
}

export class QuickSetupView implements View {
  readonly #services: TuiServices;
  readonly #fields: Map<string, FormField>;
  #form = new Form([]);
  #dirty = false;
  /** What an earlier attempt trusted, so connecting again to the same server does not ask again. */
  #trusted: { readonly endpoint: string; readonly options: Server['options'] } | undefined;

  constructor(services: TuiServices) {
    this.#services = services;
    const items: FormField[] = [
      field.text('name', 'Site name', '', { help: 'The name you know the site by; unique, ignoring case.' }),
      field.text('localRoot', 'Local folder', services.cwd, { help: 'The folder on this computer that holds the files you publish.' }),
      field.choice('protocol', 'Protocol', PROTOCOL_OPTIONS, 'sftp', 'SFTP is the safest choice. Plain FTP sends the password in clear text.'),
      field.text('host', 'Host', '', { help: 'The FTP or SFTP host your hosting panel shows, such as sftp.example.com; host:port works too.' }),
      field.text('username', 'User', '', { help: 'Many hosts name FTP accounts in full, such as demo-user@example.com.' }),
      field.text('password', 'Password', '', { masked: true, help: 'Sent only after the server is verified. Saved only once the server accepts it.' }),
      field.toggle('savePassword', 'Save password', true, 'Keeps the password in the credential store once the server accepts it, never in a file.'),
      field.text('folder', 'Folder', '', { help: 'A local, mounted or network folder: an absolute path.' }),
      field.action('connect', 'Connect', 'Signs in with these values, then lets you pick the folder on the server that holds the site.'),
    ];
    this.#fields = new Map(items.map((item) => [item.id, item]));
    this.#layout();
  }

  title(): string {
    return 'New site';
  }

  primary(): string {
    return 'Ctrl+S Connect';
  }

  hints(): readonly Hint[] {
    return [
      { key: 'Up/Down', label: 'Move' },
      { key: 'Space', label: 'Change' },
      { key: 'Ctrl+S', label: 'Connect' },
      { key: 'Esc', label: 'Back' },
    ];
  }

  keys(): readonly Hint[] {
    return [
      { key: 'Up/Down', label: 'Move between fields' },
      { key: 'Space, Left/Right', label: 'Change a toggle or a choice' },
      { key: 'Enter', label: 'Next field, or Connect on the button' },
      { key: 'Ctrl+S', label: 'Connect, pick the folder on the server, and save the site' },
      { key: 'Esc', label: 'Back; asks before dropping what you typed' },
    ];
  }

  capturesText(): boolean {
    return this.#form.capturesText();
  }

  status(): string | undefined {
    return this.#form.status();
  }

  #text(id: string): string {
    const item = this.#fields.get(id);
    return item?.kind === 'text' ? item.field.value.trim() : '';
  }

  #setText(id: string, value: string): void {
    const item = this.#fields.get(id);
    if (item?.kind === 'text') {
      item.field.value = value;
    }
  }

  #protocol(): Protocol {
    const item = this.#fields.get('protocol');
    return (item?.kind === 'choice' ? item.options[item.index]?.value : 'sftp') as Protocol;
  }

  #layout(): void {
    const local = this.#protocol() === 'local';
    const focus = this.#form.focused?.id;
    const ids = local
      ? ['name', 'localRoot', 'protocol', 'folder', 'connect']
      : ['name', 'localRoot', 'protocol', 'host', 'username', 'password', 'savePassword', 'connect'];
    this.#form = new Form(ids.flatMap((id) => this.#fields.get(id) ?? []));
    if (focus !== undefined) {
      this.#form.focusOn(focus);
    }
  }

  body(width: number, height: number, theme: Theme): ViewBody {
    const form = this.#form.render(width, Math.max(1, height - 2), theme, true);
    return {
      lines: [[span(`  ${protocolName(this.#protocol())}`, 'dim')], [], ...form.lines],
      cursor: form.cursor === undefined ? undefined : { row: form.cursor.row + 2, col: form.cursor.col },
    };
  }

  async key(press: Key, app: App): Promise<void> {
    if (isKey(press, 'ctrl+s')) {
      await this.#connect(app);
      return;
    }
    if (isKey(press, 'escape')) {
      if (this.#dirty && !(await app.dialog(confirmDialog('Leave the new site', 'Leave without adding the site? What you typed is dropped.', { yes: 'Leave' })))) {
        return;
      }
      app.pop();
      return;
    }
    const before = this.#form.focused?.id;
    const result = this.#form.key(press);
    if (result.changed === true) {
      this.#dirty = true;
      if (before === 'protocol') {
        this.#layout();
      }
    }
    if (before === 'host' && this.#form.focused?.id !== 'host') {
      this.#readHost();
    }
    if (result.action === 'connect') {
      await this.#connect(app);
    }
  }

  /** Splits what was typed in Host into the host, the port, the user and the protocol. */
  #readHost(): number | undefined {
    const text = this.#text('host');
    if (text === '') {
      return undefined;
    }
    const parsed = parseServerAddress(text);
    if (!parsed.ok) {
      this.#form.setError('host', parsed.problem);
      return undefined;
    }
    this.#form.setError('host', undefined);
    const { address } = parsed;
    if (address.protocol !== undefined && address.protocol !== this.#protocol()) {
      const item = this.#fields.get('protocol');
      if (item?.kind === 'choice') {
        item.index = Math.max(0, item.options.findIndex((option) => option.value === address.protocol));
        this.#layout();
      }
    }
    if (address.username !== undefined && this.#text('username') === '') {
      this.#setText('username', address.username);
    }
    const port = address.port;
    this.#setText('host', port === undefined ? address.host : `${address.host.includes(':') ? `[${address.host}]` : address.host}:${String(port)}`);
    return port;
  }

  /** The site and server the form describes, or `undefined` with the problems marked. */
  #draft(): { name: string; localRoot: string; server: Server } | undefined {
    this.#form.clearErrors();
    const problems = new Map<string, string>();
    const name = this.#text('name');
    if (name === '') {
      problems.set('name', 'Enter a name.');
    }
    const localRoot = typedPath(this.#services, this.#text('localRoot'));
    if (!isFolder(localRoot)) {
      problems.set('localRoot', `Folder not found: ${localRoot}`);
    }
    const protocol = this.#protocol();
    let input: Record<string, unknown>;
    if (protocol === 'local') {
      const folder = typedPath(this.#services, this.#text('folder'));
      if (this.#text('folder') === '' || !isFolder(folder)) {
        problems.set('folder', `Folder not found: ${folder}`);
      }
      input = { protocol, remoteRoot: folder };
    } else {
      const text = this.#text('host');
      const parsed = text === '' ? undefined : parseServerAddress(text);
      if (parsed === undefined || !parsed.ok) {
        problems.set('host', parsed?.ok === false ? parsed.problem : 'Enter the host, such as sftp.example.com.');
      }
      const address = parsed?.ok === true ? parsed.address : undefined;
      const port = address?.port === undefined || address.port === defaultPort(protocol) ? undefined : address.port;
      const user = this.#text('username');
      input = {
        protocol,
        host: address?.host ?? 'invalid',
        ...(port === undefined ? {} : { port }),
        ...(user === '' ? {} : { username: user }),
        auth: { method: 'password', savePassword: false },
        remoteRoot: '/',
        options: protocol === 'ftp' ? { allowInsecure: true } : {},
      };
    }
    for (const [id, message] of problems) {
      this.#form.setError(id, message);
    }
    if (problems.size > 0) {
      this.#form.focusOn([...problems.keys()][0] ?? 'name');
      return undefined;
    }
    const parsed = serverSchema.safeParse({ ...input, id: randomUUID(), name: 'Server' });
    if (!parsed.success) {
      this.#form.setError('host', parsed.error.issues[0]?.message ?? 'Not valid.');
      return undefined;
    }
    return { name, localRoot, server: parsed.data };
  }

  async #connect(app: App): Promise<void> {
    this.#readHost();
    const draft = this.#draft();
    if (draft === undefined) {
      app.message(this.#form.status() ?? 'Fix the marked fields first.', 'warning');
      return;
    }
    const registry = await this.#services.registry();
    await registry.reload();
    const clash = registry.list().find((site) => sameName(site.name, draft.name));
    if (clash !== undefined) {
      this.#form.setError('name', `A site named "${clash.name}" already exists.`);
      this.#form.focusOn('name');
      app.message(`A site named "${clash.name}" already exists.`, 'warning');
      return;
    }
    if (draft.server.protocol === 'ftp') {
      if (!(await app.dialog(confirmDialog('Plain FTP', 'Plain FTP sends the password and every file in clear text. Use it anyway?', { yes: 'Use plain FTP' })))) {
        return;
      }
    }
    const siteId = randomUUID();
    let server = draft.server;
    let typed: { kind: 'password' | 'passphrase'; secret: string } | undefined;
    if (server.protocol !== 'local') {
      if (this.#trusted?.endpoint === endpoint(server)) {
        server = { ...server, options: this.#trusted.options };
      }
      const password = this.#text('password');
      const outcome = await probeUnsaved(app, this.#services, {
        site: { id: siteId, name: draft.name },
        server,
        password,
        label: `Connecting to ${server.host ?? ''}`,
        use: (probe) => app.dialog(folderPickerDialog(probe, probe.startingFolder ?? '/', (work) => app.background(work))),
      });
      // A host the certificate covers, or a trusted key or certificate, holds for the next attempt too.
      this.#trusted = { endpoint: endpoint(outcome.server), options: outcome.server.options };
      if (outcome.server.host !== server.host && outcome.server.host !== undefined) {
        const port = outcome.server.port;
        this.#setText('host', port === undefined ? outcome.server.host : `${outcome.server.host}:${String(port)}`);
      }
      if (!outcome.ok) {
        const error = outcome.error;
        const message = error instanceof Error ? error.message : String(error);
        if (isSyncError(error, 'E_AUTH')) {
          this.#form.setError('username', message);
          this.#form.focusOn('username');
        } else if (isSyncError(error, 'E_CANCELLED')) {
          app.message('Nothing was saved.');
          return;
        } else {
          this.#form.setError('host', message.split('\n')[0] ?? message);
          this.#form.focusOn('host');
        }
        app.message(message.split('\n')[0] ?? message, 'error');
        return;
      }
      if (outcome.value === undefined) {
        app.message('No folder was chosen, so nothing was saved.');
        return;
      }
      typed = outcome.typed;
      server = { ...outcome.server, remoteRoot: outcome.value };
      if (remoteRootIsTop(server)) {
        const allow = await app.dialog(
          confirmDialog(
            'Deletes at the top',
            `"${server.remoteRoot}" is the top of what this account can see. Let synchronizing delete files there? Every delete is listed in the preview first.`,
            { yes: 'Allow deletes', no: 'Not now' },
          ),
        );
        if (allow) {
          server = { ...server, options: { ...server.options, allowRootDeletes: true } };
        }
      }
    }
    const store = await this.#services.credentialStore();
    const accepted = typed;
    const save = accepted !== undefined && store !== undefined && this.#toggle('savePassword');
    const name = server.protocol === 'local' ? 'Folder' : (server.host ?? 'Server');
    const site = await registry.add({
      id: siteId,
      name: draft.name,
      localRoot: draft.localRoot,
      servers: [{ ...server, name, ...(server.auth === undefined ? {} : { auth: { ...server.auth, savePassword: save } }) }],
    });
    const saved = site.servers[0];
    if (save && saved !== undefined) {
      await store.set({ siteId: site.id, serverId: saved.id, kind: accepted.kind }, sealSecret(accepted.secret, saved));
      this.#services.logger.info('Secret saved', { siteId: site.id, serverId: saved.id, kind: accepted.kind, store: store.name });
    }
    this.#dirty = false;
    app.pop();
    app.message(`Added "${site.name}" with the server ${saved?.name ?? name}.${save ? ` The password is saved in the ${store.name}.` : ''}`);
  }

  #toggle(id: string): boolean {
    const item = this.#fields.get(id);
    return item?.kind === 'toggle' && item.value;
  }
}
