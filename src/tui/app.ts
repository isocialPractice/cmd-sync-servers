// Key dispatch follows kilo's editorProcessKeypress, and the message bar its
// editorSetStatusMessage (https://github.com/antirez/kilo, commit 323d93b2).
// Copyright (c) 2016, Salvatore Sanfilippo. BSD-2-Clause; see THIRD_PARTY_NOTICES.md.
import { isKey, key, type Key } from './keys.ts';
import type { Frame, Line, Theme, Tone } from './style.ts';
import { renderFrame } from './widgets/chrome.ts';
import { helpDialog } from './widgets/dialog.ts';

export interface Hint {
  readonly key: string;
  readonly label: string;
}

export interface ViewBody {
  readonly lines: readonly Line[];
  readonly cursor?: { readonly row: number; readonly col: number } | undefined;
  /** Whether rows are hidden above or below what the body shows, for a body that scrolls. */
  readonly more?: { readonly above: boolean; readonly below: boolean } | undefined;
}

/** One screen of the terminal UI. */
export interface View {
  title(): string;
  /** The primary action, at the right of the title bar, such as `Ctrl+S Save`. */
  primary?(): string | undefined;
  /** A line under the title, such as the preview's summary. */
  summary?(): Line | undefined;
  /** At most eight key hints for the footer menu. */
  hints(): readonly Hint[];
  /** Every key of the screen, for the `?` help. */
  keys?(): readonly Hint[];
  /** What the message bar shows when no message is waiting, such as the full status of the focused row. */
  status?(): string | undefined;
  body(width: number, height: number, theme: Theme): ViewBody;
  key(press: Key, app: App): void | Promise<void>;
  /** Called when the view comes to the front. */
  shown?(app: App): void | Promise<void>;
  /** True while a text field has focus, so typed characters such as `?` and `q` go to it. */
  capturesText?(): boolean;
}

/** A modal box on top of the screen that resolves with a value. */
export interface Dialog<T> {
  readonly title: string;
  render(width: number, theme: Theme): ViewBody;
  key(press: Key, close: (value: T) => void): void;
}

interface OpenDialog {
  readonly dialog: Dialog<unknown>;
  readonly close: (value: unknown) => void;
}

const MESSAGE_MS = 5000;

/**
 * The terminal UI: a stack of views, dialogs on top, a message bar and
 * background tasks. It has no terminal of its own; {@link render} returns
 * frames and {@link key} takes keys, so tests can drive it directly.
 */
export class App {
  readonly theme: Theme;
  readonly #now: () => number;
  readonly #views: View[] = [];
  readonly #dialogs: OpenDialog[] = [];
  readonly #pending = new Set<Promise<unknown>>();
  readonly #background = new Set<Promise<unknown>>();
  readonly #dialogWaiters: (() => void)[] = [];
  #message: { text: string; tone: Tone; at: number } | undefined;
  #busy: { label: string; controller: AbortController } | undefined;
  #tick = 0;
  #done = false;
  #redraw: () => void = () => undefined;
  #finish!: () => void;
  readonly finished: Promise<void>;
  /** The folder the shell should change to when the UI closes (`--cd-file`). */
  cdTarget: string | undefined;
  /** What the last synchronization did, for the exit code. */
  outcome: unknown;

  constructor(theme: Theme, now: () => number = Date.now) {
    this.theme = theme;
    this.#now = now;
    this.finished = new Promise((resolve) => {
      this.#finish = resolve;
    });
  }

  onRedraw(redraw: () => void): void {
    this.#redraw = redraw;
  }

  redraw(): void {
    this.#redraw();
  }

  get view(): View | undefined {
    return this.#views[this.#views.length - 1];
  }

  get depth(): number {
    return this.#views.length;
  }

  get busy(): boolean {
    return this.#busy !== undefined;
  }

  #track(result: void | Promise<void>): void {
    if (result instanceof Promise) {
      const tracked = result.catch((error: unknown) => {
        this.message(error instanceof Error ? error.message : String(error), 'error');
      });
      this.#pending.add(tracked);
      void tracked.finally(() => {
        this.#pending.delete(tracked);
        this.redraw();
      });
    }
  }

  push(view: View): void {
    this.#views.push(view);
    this.#track(view.shown?.(this));
    this.redraw();
  }

  replace(view: View): void {
    this.#views.pop();
    this.push(view);
  }

  pop(): void {
    this.#views.pop();
    const top = this.view;
    if (top === undefined) {
      this.quit();
      return;
    }
    this.#track(top.shown?.(this));
    this.redraw();
  }

  /** Ends the UI: aborts the running task and answers every open dialog with Esc. */
  quit(): void {
    this.#done = true;
    this.#busy?.controller.abort();
    for (const open of [...this.#dialogs].reverse()) {
      open.dialog.key(key('escape'), open.close);
    }
    this.#finish();
  }

  message(text: string, tone: Tone = 'normal'): void {
    this.#message = { text, tone, at: this.#now() };
    this.redraw();
  }

  /** The transient message, while it is fresh. */
  currentMessage(): { text: string; tone: Tone } | undefined {
    if (this.#message !== undefined && this.#now() - this.#message.at < MESSAGE_MS) {
      return this.#message;
    }
    return undefined;
  }

  busyLabel(): string | undefined {
    return this.#busy?.label;
  }

  spinnerFrame(): number {
    return this.#tick;
  }

  /** Advances the busy spinner. */
  tick(): void {
    this.#tick += 1;
    if (this.#busy !== undefined) {
      this.redraw();
    }
  }

  dialog<T>(dialog: Dialog<T>): Promise<T> {
    return new Promise<T>((resolve) => {
      const open: OpenDialog = {
        dialog,
        close: (value) => {
          const index = this.#dialogs.indexOf(open);
          if (index !== -1) {
            this.#dialogs.splice(index, 1);
          }
          resolve(value as T);
          this.redraw();
        },
      };
      this.#dialogs.push(open);
      if (this.#done) {
        // Nobody is left to answer: a dialog opened after quit gets Esc.
        dialog.key(key('escape'), open.close);
        return;
      }
      for (const waiter of this.#dialogWaiters.splice(0)) {
        waiter();
      }
      this.redraw();
    });
  }

  get topDialog(): Dialog<unknown> | undefined {
    return this.#dialogs[this.#dialogs.length - 1]?.dialog;
  }

  /**
   * Runs work in the background with a spinner and a label. Esc or Ctrl+C
   * aborts its signal. A failure becomes an error message and resolves `undefined`.
   */
  async task<T>(label: string, work: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    const controller = new AbortController();
    this.#busy = { label, controller };
    this.redraw();
    try {
      return await work(controller.signal);
    } catch (error) {
      this.message(error instanceof Error ? error.message : String(error), controller.signal.aborted ? 'normal' : 'error');
      return undefined;
    } finally {
      this.#busy = undefined;
      this.redraw();
    }
  }

  key(press: Key): void {
    const open = this.#dialogs[this.#dialogs.length - 1];
    if (open !== undefined) {
      open.dialog.key(press, open.close);
      this.redraw();
      return;
    }
    if (this.#busy !== undefined) {
      if (isKey(press, 'escape') || isKey(press, 'ctrl+c')) {
        this.#busy.controller.abort();
        this.message('Cancelling...');
      }
      return;
    }
    if (isKey(press, 'ctrl+c')) {
      this.quit();
      return;
    }
    const view = this.view;
    if (view === undefined) {
      return;
    }
    if (press.text === '?' && view.capturesText?.() !== true) {
      void this.dialog(helpDialog(view.title(), view.keys?.() ?? view.hints()));
      return;
    }
    this.#track(view.key(press, this));
    this.redraw();
  }

  /**
   * Runs work a dialog started, such as loading a folder listing, and redraws
   * when it settles. {@link idle} waits for it even while the dialog is open.
   */
  background<T>(work: Promise<T>): Promise<T> {
    this.#background.add(work);
    const settled = (): void => {
      this.#background.delete(work);
      this.redraw();
    };
    work.then(settled, settled);
    return work;
  }

  /**
   * Resolves when every key handler and task started so far has finished, or
   * when a dialog is waiting for a key and has no work of its own running.
   */
  async idle(): Promise<void> {
    for (;;) {
      if (this.#background.size > 0) {
        await Promise.allSettled([...this.#background]);
        continue;
      }
      if (this.#pending.size === 0 || this.#dialogs.length > 0) {
        return;
      }
      await Promise.race([
        Promise.all([...this.#pending]),
        new Promise<void>((resolve) => {
          this.#dialogWaiters.push(resolve);
        }),
      ]);
    }
  }

  render(columns: number, rows: number): Frame {
    return renderFrame(this, columns, rows);
  }
}
