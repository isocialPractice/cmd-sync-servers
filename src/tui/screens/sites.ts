import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { Site } from '../../config/schema.ts';
import type { App, Hint, View, ViewBody } from '../app.ts';
import { isKey, type Key } from '../keys.ts';
import type { TuiServices } from '../services.ts';
import { span, symbols, type Theme } from '../style.ts';
import { truncatePath } from '../text.ts';
import { confirmDialog } from '../widgets/dialog.ts';
import { ListState } from '../widgets/list.ts';
import { headerRow, remoteServer, tableRow } from './common.ts';
import { SiteHomeView } from './site-home.ts';
import { SiteSetupView } from './site-setup.ts';

/** The master list of sites, as Dreamweaver's Manage Sites. */
export class SitesView implements View {
  readonly #services: TuiServices;
  readonly #list = new ListState<Site>([], (site) => `${site.name} ${site.localRoot}`);
  #height = 10;

  constructor(services: TuiServices) {
    this.#services = services;
  }

  title(): string {
    return 'Sites';
  }

  primary(): string {
    return 'Enter Open';
  }

  hints(): readonly Hint[] {
    return [
      { key: 'n', label: 'New' },
      { key: 'e', label: 'Edit' },
      { key: 'Enter', label: 'Open' },
      { key: 'd', label: 'Remove' },
      { key: '/', label: 'Filter' },
      { key: 'q', label: 'Quit' },
    ];
  }

  keys(): readonly Hint[] {
    return [
      { key: 'Up/Down', label: 'Move' },
      ...this.hints(),
      { key: 'Esc', label: 'Clear the filter' },
      { key: '?', label: 'These keys' },
    ];
  }

  status(): string | undefined {
    return this.#list.filterText() ?? this.#list.selected?.localRoot;
  }

  capturesText(): boolean {
    return this.#list.filtering;
  }

  async shown(): Promise<void> {
    const registry = await this.#services.registry();
    await registry.reload();
    this.#list.items = registry.list();
  }

  body(width: number, height: number, theme: Theme): ViewBody {
    this.#height = height - 1;
    const sites = this.#list.visible;
    if (this.#list.items.length === 0) {
      return { lines: [[], [span('  No sites yet. Press n to add one.')]] };
    }
    const nameWidth = Math.min(24, Math.max(4, ...sites.map((site) => site.name.length)));
    const remoteWidth = 16;
    const rootWidth = Math.max(10, width - nameWidth - remoteWidth - 8);
    const { start, items } = this.#list.window(this.#height);
    return {
      lines: [
        headerRow(['Name', 'Local root', 'Remote server'], [nameWidth, rootWidth]),
        ...items.map((site, offset) =>
          tableRow(
            [site.name, truncatePath(site.localRoot, rootWidth, symbols(theme).ellipsis), remoteServer(site)?.name ?? '-'],
            [nameWidth, rootWidth, remoteWidth],
            width,
            start + offset === this.#list.index,
            theme,
          ),
        ),
      ],
    };
  }

  async key(press: Key, app: App): Promise<void> {
    if (this.#list.key(press, this.#height)) {
      return;
    }
    const site = this.#list.selected;
    if (press.text === 'q') {
      app.quit();
    } else if (press.text === 'n') {
      app.push(new SiteSetupView(this.#services, undefined));
    } else if (press.text === 'e' && site !== undefined) {
      app.push(new SiteSetupView(this.#services, site.id));
    } else if (isKey(press, 'enter') && site !== undefined) {
      app.cdTarget = site.localRoot;
      await (await this.#services.registry()).setLastSelected(site.id);
      app.push(new SiteHomeView(this.#services, site.id));
    } else if ((press.text === 'd' || isKey(press, 'delete')) && site !== undefined) {
      const sure = await app.dialog(
        confirmDialog('Remove site', `Remove "${site.name}" and its ${String(site.servers.length)} server(s)? Its local folder and the files on its servers are not touched.`, {
          yes: 'Remove',
        }),
      );
      if (sure) {
        const registry = await this.#services.registry();
        await registry.remove(site.id);
        const store = await this.#services.credentialStore();
        for (const server of site.servers) {
          for (const kind of ['password', 'passphrase'] as const) {
            await store?.delete({ siteId: site.id, serverId: server.id, kind }).catch(() => false);
          }
        }
        await rm(path.join(registry.paths.stateDir, 'sites', site.id), { recursive: true, force: true });
        this.#list.items = registry.list();
        app.message(`Removed "${site.name}".`);
      }
    }
  }
}
