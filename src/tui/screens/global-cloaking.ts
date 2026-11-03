import { splitPatterns } from '../../sync/cloak.ts';
import type { App, Hint, View, ViewBody } from '../app.ts';
import { isKey, type Key } from '../keys.ts';
import type { TuiServices } from '../services.ts';
import type { Theme } from '../style.ts';
import { confirmDialog } from '../widgets/dialog.ts';
import { field, Form } from '../widgets/form.ts';

/** The help of a pattern field, shared with a site's own patterns. */
export const PATTERN_HELP = '.psd cloaks a suffix, archive* a name, node_modules/ a folder, /drafts/ a root folder, !x re-includes.';

/**
 * The cloaking patterns every site uses before its own, one per line, in
 * the multi-line editor. `Ctrl+S` saves them; `Esc` asks before dropping
 * unsaved changes.
 */
export class GlobalCloakingView implements View {
  readonly #services: TuiServices;
  #form: Form | undefined;
  #dirty = false;

  constructor(services: TuiServices) {
    this.#services = services;
  }

  title(): string {
    return 'Global Cloaking';
  }

  primary(): string {
    return 'Ctrl+S Save';
  }

  hints(): readonly Hint[] {
    return [
      { key: 'Up/Down', label: 'Move' },
      { key: 'Ctrl+S', label: 'Save' },
      { key: 'Esc', label: 'Back' },
    ];
  }

  keys(): readonly Hint[] {
    return [
      { key: 'Up/Down', label: 'Move between the patterns' },
      { key: 'Ctrl+S', label: 'Save the global cloaking patterns' },
      { key: 'Esc', label: 'Back; asks before dropping unsaved changes' },
    ];
  }

  capturesText(): boolean {
    return this.#form?.capturesText() ?? false;
  }

  status(): string | undefined {
    return this.#dirty ? 'Unsaved changes. Ctrl+S saves them.' : this.#form?.status();
  }

  async shown(): Promise<void> {
    if (this.#form !== undefined) {
      return;
    }
    const registry = await this.#services.registry();
    await registry.reload();
    this.#form = new Form([
      field.lines('patterns', 'Cloak in every site', registry.globalCloaking.patterns.join('\n'), 8, PATTERN_HELP),
      field.note('order', '', 'Sites use these before their own patterns.'),
      field.note('opt-out', '', 'Site Setup, Cloaking turns them off for one site.'),
    ]);
  }

  body(width: number, height: number, theme: Theme): ViewBody {
    return this.#form?.render(width, height, theme, true) ?? { lines: [] };
  }

  async key(press: Key, app: App): Promise<void> {
    const form = this.#form;
    if (form === undefined) {
      return;
    }
    if (isKey(press, 'ctrl+s')) {
      const patterns = [...new Set(splitPatterns(form.text('patterns')))];
      await (await this.#services.registry()).updateGlobalCloaking((cloaking) => {
        cloaking.patterns = patterns;
      });
      this.#dirty = false;
      app.message('Saved the global cloaking patterns.');
      return;
    }
    if (isKey(press, 'escape')) {
      if (this.#dirty && !(await app.dialog(confirmDialog('Unsaved changes', 'Leave without saving the global cloaking patterns?', { yes: 'Leave' })))) {
        return;
      }
      app.pop();
      return;
    }
    if (form.key(press).changed === true) {
      this.#dirty = true;
    }
  }
}
