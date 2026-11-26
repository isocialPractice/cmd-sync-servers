import type { Site } from '../../config/schema.ts';
import { DEFAULT_RANGE, formatRange, parseRange, rangeStart } from '../../sync/range.ts';
import { RANGE_TITLE, type Direction } from '../../sync/types.ts';
import type { App, Hint, View, ViewBody } from '../app.ts';
import { isKey, type Key } from '../keys.ts';
import type { TuiServices } from '../services.ts';
import type { Theme } from '../style.ts';
import { field, Form, type TextInput } from '../widgets/form.ts';
import { DIRECTION_TITLES, deleteLabel } from './common.ts';
import { PreviewView } from './preview.ts';

/** What the Direction choice offers: the files of a time range, or one of the three directions. */
type Way = 'recent' | Direction;

interface Answers {
  readonly way: Way;
  readonly deleteOrphans: boolean;
  /** The range as it was last typed and accepted. */
  readonly range: string;
}

/** The last answers per site, preselected next time. */
const lastAnswers = new Map<string, Answers>();

const WAYS: readonly { readonly label: string; readonly value: Way }[] = [
  { label: RANGE_TITLE, value: 'recent' },
  ...(['put', 'get', 'both'] as const).map((value) => ({ label: DIRECTION_TITLES[value], value })),
];

const DELETE_HELP = 'Files never synchronized before stay unchecked in the preview.';
/** How a range is written, short enough to show whole on one row of an 80-column screen. */
const RANGE_FORM = 'number and m, h, d or w: 90m, 24h, 2d, 1w.';
const RANGE_HELP = `A ${RANGE_FORM}`;
/** What the field says of a text that is not a range. */
const RANGE_REFUSED = `Enter a ${RANGE_FORM}`;

/**
 * Dreamweaver's Synchronize dialog: scope, direction, and the delete option
 * worded for the direction. With the files of a time range chosen, the
 * delete option gives way to the range, since a range never lists a delete.
 */
export class SynchronizeView implements View {
  readonly #services: TuiServices;
  readonly #site: Site;
  readonly #form: Form;
  /** The range field, kept while the delete option is in its place, so what was typed is not lost. */
  readonly #range: TextInput;
  /** The delete option as it was last set, kept while the range is in its place. */
  #deleteOrphans: boolean;

  constructor(services: TuiServices, site: Site) {
    this.#services = services;
    this.#site = site;
    const last = lastAnswers.get(site.id) ?? { way: 'put', deleteOrphans: false, range: DEFAULT_RANGE };
    this.#deleteOrphans = last.deleteOrphans;
    this.#range = field.text('range', 'Time range', last.range, { help: RANGE_HELP });
    this.#form = new Form([
      field.note('scope', 'Synchronize', `Entire '${site.name}' site`),
      field.choice('direction', 'Direction', WAYS, last.way, 'Space or Left and Right change the direction.'),
      last.way === 'recent' ? this.#range : field.toggle('delete', deleteLabel(last.way), last.deleteOrphans, DELETE_HELP),
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

  capturesText(): boolean {
    return this.#form.capturesText();
  }

  #way(): Way {
    return this.#form.choice('direction') as Way;
  }

  /** Puts the field that goes with the chosen direction under it: the range, or the delete option worded for the direction. */
  #fit(): void {
    const index = this.#form.fields.findIndex((item) => item.id === 'delete' || item.id === 'range');
    const current = this.#form.fields[index];
    const way = this.#way();
    if (current?.kind === 'toggle') {
      this.#deleteOrphans = current.value;
    }
    if (way === 'recent') {
      this.#form.fields[index] = this.#range;
    } else if (current?.kind !== 'toggle' || current.label !== deleteLabel(way)) {
      this.#form.setError('range', undefined);
      this.#form.fields[index] = field.toggle('delete', deleteLabel(way), this.#deleteOrphans, DELETE_HELP);
    }
  }

  body(width: number, height: number, theme: Theme): ViewBody {
    this.#fit();
    const body = this.#form.render(width, height - 1, theme, true);
    return { lines: [[], ...body.lines], cursor: body.cursor === undefined ? undefined : { row: body.cursor.row + 1, col: body.cursor.col } };
  }

  async key(press: Key, app: App): Promise<void> {
    if (isKey(press, 'escape')) {
      app.pop();
      return;
    }
    if (isKey(press, 'enter')) {
      this.#fit();
      const way = this.#way();
      if (way === 'recent') {
        const range = parseRange(this.#range.field.value);
        if (range === undefined) {
          this.#form.setError('range', RANGE_REFUSED);
          this.#form.focusOn('range');
          return;
        }
        this.#form.setError('range', undefined);
        lastAnswers.set(this.#site.id, { way, deleteOrphans: this.#deleteOrphans, range: formatRange(range) });
        await PreviewView.plan(app, this.#services, this.#site, { direction: 'put', deleteOrphans: false, changedSince: rangeStart(range), range }, true);
        return;
      }
      const options = { direction: way, deleteOrphans: this.#form.toggle('delete') };
      lastAnswers.set(this.#site.id, { way, deleteOrphans: options.deleteOrphans, range: lastAnswers.get(this.#site.id)?.range ?? DEFAULT_RANGE });
      await PreviewView.plan(app, this.#services, this.#site, options, true);
      return;
    }
    this.#form.key(press);
    this.#fit();
  }
}
