// `@jhauga/timecal` ships no type declarations. These cover the two
// functions `src/sync/range.ts` calls, as far as it uses them.
declare module '@jhauga/timecal' {
  /** What `parseArguments` makes of its arguments; `calculate` takes it as it is. */
  interface ParsedArguments {
    readonly mode: string;
  }

  interface Timecal {
    /**
     * Reads command-line style arguments. For an empty list, and for `-h`,
     * `--help` or `/?` anywhere in it, it prints its help and ends the
     * process. It throws an `Error` for anything else it cannot read.
     */
    readonly parseArguments: (args: readonly string[]) => ParsedArguments;
    /**
     * For one time expression such as `2d`, `date` is that long before the
     * device's clock, which it reads itself. Other kinds of arguments give
     * no `date`.
     */
    readonly calculate: (parsed: ParsedArguments) => { readonly date?: Date };
  }

  const timecal: Timecal;
  export = timecal;
}
