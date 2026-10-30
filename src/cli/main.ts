#!/usr/bin/env node
import { processIo } from './io.ts';
import { runCli } from './router.ts';

// The first Ctrl+C cancels cleanly: no new transfers start, partial files are
// removed and finished work is recorded. A second one stops at once.
const controller = new AbortController();
process.on('SIGINT', () => {
  if (controller.signal.aborted) {
    process.exit(130);
  }
  process.stderr.write('\nCancelling. Press Ctrl+C again to stop at once.\n');
  controller.abort();
});

process.exitCode = await runCli(process.argv.slice(2), { ...processIo(), signal: controller.signal });
