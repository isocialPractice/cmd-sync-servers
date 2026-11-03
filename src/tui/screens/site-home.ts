import type { Site } from '../../config/schema.ts';
import { cloakingSummary } from '../../sync/cloak.ts';
import type { StatusReport } from '../../sync/session.ts';
import type { App, Hint, View, ViewBody } from '../app.ts';
import { isKey, type Key } from '../keys.ts';
import { openSession, type TuiServices } from '../services.ts';
import { span, symbols, type Line, type Theme } from '../style.ts';
import { padEnd, truncatePath } from '../text.ts';
import { ListState } from '../widgets/list.ts';
import { protocolName, remoteServer, serverAddress, when } from './common.ts';
import { PreviewView } from './preview.ts';
import { SiteSetupView } from './site-setup.ts';
import { SynchronizeView } from './synchronize.ts';

type HomeAction = 'synchronize' | 'put' | 'get' | 'refresh' | 'settings';

const ACTIONS: readonly { id: HomeAction; label: string }[] = [
  { id: 'synchronize', label: 'Synchronize...' },
  { id: 'put', label: 'Put newer files to remote' },
  { id: 'get', label: 'Get newer files from remote' },
  { id: 'refresh', label: 'Check for changes' },
  { id: 'settings', label: 'Site settings' },
];

/** One site at a glance, as Dreamweaver's Files panel: its server, its changes and what to do next. */
export class SiteHomeView implements View {
  readonly #services: TuiServices;
  readonly #siteId: string;
  readonly #actions = new ListState(ACTIONS, (action) => action.label);
  #site: Site | undefined;
  #globalPatterns: readonly string[] = [];
  #status: StatusReport | undefined;
  #problem: string | undefined;

  constructor(services: TuiServices, siteId: string) {
    this.#services = services;
    this.#siteId = siteId;
  }

  title(): string {
    return `Site: ${this.#site?.name ?? ''}`;
  }

  primary(): string {
    return 's Synchronize';
  }

  hints(): readonly Hint[] {
    return [
      { key: 'Enter', label: 'Choose' },
      { key: 's', label: 'Synchronize' },
      { key: 'r', label: 'Check' },
      { key: 'e', label: 'Settings' },
      { key: 'Esc', label: 'Back' },
      { key: 'q', label: 'Quit' },
    ];
  }

  async shown(app: App): Promise<void> {
    const registry = await this.#services.registry();
    await registry.reload();
    this.#site = registry.get(this.#siteId);
    this.#globalPatterns = registry.globalCloaking.patterns;
    if (this.#site === undefined) {
      app.pop();
      return;
    }
    await this.#refresh(app);
  }

  async #refresh(app: App): Promise<void> {
    const site = this.#site;
    if (site === undefined || remoteServer(site) === undefined) {
      return;
    }
    this.#problem = undefined;
    const report = await app.task('Checking for changes', async (signal) => {
      const session = await openSession(app, this.#services, site.id);
      try {
        return await session.status({ signal });
      } finally {
        await session.close();
      }
    });
    if (report === undefined) {
      this.#problem = app.currentMessage()?.text ?? 'Not checked.';
    }
    this.#status = report;
  }

  body(width: number, _height: number, theme: Theme): ViewBody {
    const site = this.#site;
    if (site === undefined) {
      return { lines: [] };
    }
    const server = remoteServer(site);
    const status = this.#status;
    const counts =
      status === undefined
        ? (this.#problem ?? 'not checked yet')
        : `${String(status.local.length)} local, ${String(status.remote.length)} on the server, ${String(status.conflicts.length)} on both sides`;
    const pairs: [string, string][] = [
      ['Local root', truncatePath(site.localRoot, width - 18, symbols(theme).ellipsis)],
      ['Server', server === undefined ? 'none: press e to add one' : `${server.name} (${protocolName(server.protocol)} ${serverAddress(server)})`],
      ['Last sync', when(status?.lastSyncedAt)],
      ['Changes', counts],
      ['Cloaking', cloakingSummary(site.cloaking, this.#globalPatterns)],
    ];
    const lines: Line[] = pairs.map(([label, value]) => [span(`  ${padEnd(label, 12)}`, 'dim'), span(value)]);
    lines.push([]);
    this.#actions.items.forEach((action, index) => {
      const focused = index === this.#actions.index;
      lines.push([span(focused ? `${symbols(theme).pointer} ` : '  '), span(action.label, focused ? 'focus' : undefined)]);
    });
    return { lines };
  }

  async key(press: Key, app: App): Promise<void> {
    const site = this.#site;
    if (site === undefined) {
      return;
    }
    if (this.#actions.key(press, 5)) {
      return;
    }
    let action: HomeAction | undefined;
    if (isKey(press, 'enter')) {
      action = this.#actions.selected?.id;
    } else if (press.text === 's') {
      action = 'synchronize';
    } else if (press.text === 'r') {
      action = 'refresh';
    } else if (press.text === 'e') {
      action = 'settings';
    } else if (isKey(press, 'escape')) {
      app.pop();
      return;
    } else if (press.text === 'q') {
      app.quit();
      return;
    }
    if (action === 'settings') {
      app.push(new SiteSetupView(this.#services, site.id));
    } else if (action === 'refresh') {
      await this.#refresh(app);
    } else if (action !== undefined) {
      if (remoteServer(site) === undefined) {
        app.message('The site has no Remote server. Add one in Site settings (e).', 'warning');
        return;
      }
      if (action === 'synchronize') {
        app.push(new SynchronizeView(this.#services, site));
      } else {
        await PreviewView.plan(app, this.#services, site, { direction: action, deleteOrphans: false });
      }
    }
  }
}
