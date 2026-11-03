/**
 * Styled text for the terminal UI. Meaning never rests on colour alone: every
 * tone that is a colour also stands beside a symbol or a word.
 */
export type Tone = 'normal' | 'focus' | 'accent' | 'dim' | 'warning' | 'error' | 'bold';

export interface Span {
  readonly text: string;
  readonly tone?: Tone | undefined;
}

export type Line = readonly Span[];

/** What a screen draws: one line per terminal row, and where the cursor goes, if anywhere. */
export interface Frame {
  readonly lines: readonly Line[];
  readonly cursor?: { readonly row: number; readonly col: number } | undefined;
}

export interface Theme {
  /** Colour on: the terminal's own cyan, yellow and red. */
  readonly color: boolean;
  /** ASCII symbols only. */
  readonly ascii: boolean;
}

export function span(text: string, tone?: Tone): Span {
  return tone === undefined ? { text } : { text, tone };
}

/** The text of a line without styles. */
export function plain(line: Line): string {
  return line.map((part) => part.text).join('');
}

export interface Symbols {
  readonly checked: string;
  readonly unchecked: string;
  readonly problem: string;
  readonly selected: string;
  readonly unselected: string;
  readonly put: string;
  readonly get: string;
  readonly resolve: string;
  readonly remove: string;
  readonly skip: string;
  readonly synced: string;
  readonly cloaked: string;
  /** The solid line above and below the content. */
  readonly rule: string;
  /** The unit of the dashed line drawn at an edge of the content while rows are hidden past it. */
  readonly edge: string;
  readonly ellipsis: string;
  readonly pointer: string;
  readonly bar: string;
  readonly barEmpty: string;
  readonly spinner: readonly string[];
}

const UNICODE: Symbols = {
  checked: '[x]',
  unchecked: '[ ]',
  problem: '[!]',
  selected: '(*)',
  unselected: '( )',
  put: '↑',
  get: '↓',
  resolve: '?',
  remove: '✕',
  skip: '-',
  synced: '=',
  cloaked: '⊘',
  rule: '━',
  edge: '━ ',
  ellipsis: '…',
  pointer: '>',
  bar: '█',
  barEmpty: '░',
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
};

const ASCII: Symbols = {
  ...UNICODE,
  put: '^',
  get: 'v',
  remove: 'x',
  cloaked: '#',
  rule: '_',
  edge: '- ',
  ellipsis: '...',
  bar: '#',
  barEmpty: '.',
  spinner: ['|', '/', '-', '\\'],
};

export function symbols(theme: Theme): Symbols {
  return theme.ascii ? ASCII : UNICODE;
}
