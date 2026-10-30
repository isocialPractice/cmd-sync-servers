import { App, type View } from './app.ts';
import { Renderer } from './screen.ts';
import type { Theme } from './style.ts';
import { Terminal, type TerminalInput, type TerminalOutput } from './terminal.ts';

export interface RunTuiOptions {
  readonly input: TerminalInput;
  readonly output: TerminalOutput;
  readonly theme: Theme;
  /** The screens to open, bottom first; Esc on the first one closes the UI. */
  readonly views: readonly View[];
  /** Restore the terminal on process exit, signals and crashes. Default: on. */
  readonly hookProcess?: boolean;
  /** How often the busy spinner turns. */
  readonly spinnerMs?: number;
}

/**
 * Runs the terminal UI until its last screen closes, and returns the app so
 * the caller can read where the shell should go and what a run did. The
 * terminal is restored on every way out, including an error mid-frame.
 */
export async function runTui(options: RunTuiOptions): Promise<App> {
  const app = new App(options.theme);
  const terminal = new Terminal(options.input, options.output, { hookProcess: options.hookProcess ?? true });
  const renderer = new Renderer();
  let scheduled = false;
  let failure: Error | undefined;
  const draw = (): void => {
    scheduled = false;
    if (!terminal.started) {
      return;
    }
    try {
      const { columns, rows } = terminal.size();
      terminal.write(renderer.render(app.render(columns, rows), columns, rows, options.theme));
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
      app.quit();
    }
  };
  // Many changes in one turn of the event loop make one frame.
  app.onRedraw(() => {
    if (!scheduled) {
      scheduled = true;
      setImmediate(draw);
    }
  });
  terminal.start(
    (press) => {
      app.key(press);
    },
    () => {
      renderer.invalidate();
      app.redraw();
    },
  );
  const spinner = setInterval(() => {
    app.tick();
  }, options.spinnerMs ?? 100);
  try {
    for (const view of options.views) {
      app.push(view);
    }
    await app.finished;
    await app.idle();
  } finally {
    clearInterval(spinner);
    terminal.stop();
  }
  if (failure !== undefined) {
    throw failure;
  }
  return app;
}
