// Text that came from outside the program, such as a server's reply, a file
// name or a file's contents, is shown with its control characters escaped,
// so it can never move the cursor, clear the screen, set the clipboard or
// answer a terminal query. Bidirectional formatting characters are escaped
// too, so a name cannot read differently from what it is.

/** C0 controls, DEL and C1 controls, which terminals act on. */
const CONTROLS = '\\u0000-\\u001f\\u007f-\\u009f';
/** Bidirectional embedding, override and isolate characters. */
const BIDI = '\\u202a-\\u202e\\u2066-\\u2069';

const ALL = new RegExp(`[${CONTROLS}${BIDI}]`, 'g');
const ALL_BUT_LINES = new RegExp(`[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f${BIDI}]`, 'g');

function escape(char: string): string {
  return `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`;
}

/** `text` with every control and bidi character replaced by `replacement`, for a screen that draws one row at a time. */
export function replaceUnsafe(text: string, replacement: string): string {
  return text.replace(ALL, replacement);
}

/** One line safe for a terminal, such as a file name: every control and bidi character escaped, newlines and tabs too. */
export function safeLine(text: string): string {
  return text.replace(ALL, escape);
}

/** Text safe for a terminal that keeps its lines and tabs, such as a message or a diff. CRLF line ends become LF. */
export function safeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(ALL_BUT_LINES, escape);
}
