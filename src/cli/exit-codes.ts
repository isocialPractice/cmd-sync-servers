/** Exit codes of the `sync-servers` command. */
export const ExitCode = {
  /** Done, or nothing to do. */
  ok: 0,
  /** Could not run. */
  error: 1,
  /** Usage error, or no site could be chosen. */
  usage: 2,
  /** Finished with item failures or unresolved rows. */
  incomplete: 3,
  /** Cancelled by the user. */
  cancelled: 4,
  /** Stopped by a safety guard. */
  guarded: 5,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];
