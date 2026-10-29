import type { CommandSpec } from '../command.ts';
import { UsageError } from '../errors.ts';
import { isShell, shellInitScript, SHELLS } from '../shell-init.ts';

export const shellInitCommand: CommandSpec = {
  path: ['shell-init'],
  args: '<shell>',
  minArgs: 1,
  maxArgs: 1,
  summary: `Print the "ssv" shell function that changes to a chosen site's folder (${SHELLS.join(', ')})`,
  examples: [
    'eval "$(sync-servers shell-init bash)"',
    'sync-servers shell-init fish > ~/.config/fish/functions/ssv.fish',
    'Invoke-Expression (& sync-servers shell-init pwsh | Out-String)',
  ],
  run(ctx, { args }) {
    const shell = args[0] ?? '';
    if (!isShell(shell)) {
      throw new UsageError(`Unknown shell ${JSON.stringify(shell)}. Choose one of: ${SHELLS.join(', ')}.`);
    }
    ctx.out(shellInitScript(shell));
    return Promise.resolve(undefined);
  },
};
