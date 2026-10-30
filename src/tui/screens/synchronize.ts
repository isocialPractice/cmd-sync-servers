import type { Site } from '../../config/schema.ts';
import type { Direction } from '../../sync/types.ts';
import type { App, Hint, View, ViewBody } from '../app.ts';
import { isKey, type Key } from '../keys.ts';
import type { TuiServices } from '../services.ts';
import type { Theme } from '../style.ts';
import { field, Form } from '../widgets/form.ts';
import { DIRECTION_TITLES, deleteLabel } from './common.ts';
import { PreviewView } from './preview.ts';

/** The last answers per site, preselected next time. */
const lastAnswers = new Map<string, { direction: Direction; deleteOrphans: boolean }>();

/** Dreamweaver's Synchronize dialog: scope, direction, and the delete option worded for the direction. */
export class SynchronizeView implements View {
  readonly #services: TuiServices;
  readonly #site: Site;
  readonly #form: Form;

  constructor(services: TuiServices, site: Site) {
    this.#services = services;
    this.#site = site;
    const last = lastAnswers.get(site.id) ?? { direction: 'put', deleteOrphans: false };
    this.#form = new Form([
      field.note('scope', 'Synchronize', `Entire '${site.name}' site`),
      field.choice(
        'direction',
        'Direction',
        (['put', 'get', 'both'] as const).map((value) => ({ label: DIRECTION_TITLES[value], value })),
        last.direction,
        'Space or Left and Right change the direction.',
      ),
      field.toggle('delete', deleteLabel(last.direction), last.deleteOrphans, 'Files never synchronized before stay unchecked in the preview.'),
      field.action('preview', 'Preview', 'Shows every file that would change. Nothing moves until you confirm.'),
    ]);
  }

  title(): string {
    return `Synchronize: ${this.#site.name}`;
  }

  primary(): string {
    return 'Enter Preview';
  }

  hints(): readonly Hint[] {
    return [
      { key: 'Up/Down', label: 'Move' },
      { key: 'Space', label: 'Change' },
      { key: 'Enter', label: 'Preview' },
      { key: 'Esc', label: 'Back' },
    ];
  }

  status(): string | undefined {
    return this.#form.status();
  }

  #direction(): Direction {
    return this.#form.choice('direction') as Direction;
  }

  body(width: number, height: number, theme: Theme): ViewBody {
    const index = this.#form.fields.findIndex((item) => item.id === 'delete');
    const current = this.#form.fields[index];
    if (current?.kind === 'toggle' && current.label !== deleteLabel(this.#direction())) {
      this.#form.fields[index] = field.toggle('delete', deleteLabel(this.#direction()), current.value, current.help);
    }
    const body = this.#form.render(width, height - 1, theme, true);
    return { lines: [[], ...body.lines], cursor: undefined };
  }

  async key(press: Key, app: App): Promise<void> {
    if (isKey(press, 'escape')) {
      app.pop();
      return;
    }
    if (isKey(press, 'enter')) {
      const options = { direction: this.#direction(), deleteOrphans: this.#form.toggle('delete') };
      lastAnswers.set(this.#site.id, options);
      await PreviewView.plan(app, this.#services, this.#site, options, true);
      return;
    }
    this.#form.key(press);
  }
}
