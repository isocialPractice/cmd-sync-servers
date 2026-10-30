/** Display width of terminal text: wide East Asian characters take two columns, combining marks none. */

const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

const ZERO: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f],
  [0x200b, 0x200f],
  [0x20d0, 0x20ff],
  [0xfe00, 0xfe0f],
];

function within(codePoint: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([low, high]) => codePoint >= low && codePoint <= high);
}

/** Columns one code point takes. */
export function charWidth(codePoint: number): number {
  if (within(codePoint, ZERO)) {
    return 0;
  }
  return within(codePoint, WIDE) ? 2 : 1;
}

/** Columns a string takes. */
export function textWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += charWidth(char.codePointAt(0) ?? 0);
  }
  return width;
}

/** Replaces control characters, which would act on the terminal, with `?`. */
export function printable(text: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are what this replaces
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?');
}

/** The columns `start` to `start + width` of `text`, never splitting a wide character. */
export function sliceColumns(text: string, start: number, width: number): string {
  let column = 0;
  let result = '';
  for (const char of text) {
    const size = charWidth(char.codePointAt(0) ?? 0);
    if (column >= start && column + size <= start + width) {
      result += char;
    }
    column += size;
    if (column >= start + width) {
      break;
    }
  }
  return result;
}

/** Pads `text` with spaces to `width` columns, or cuts it there. */
export function padEnd(text: string, width: number): string {
  const cut = sliceColumns(text, 0, width);
  return cut + ' '.repeat(Math.max(0, width - textWidth(cut)));
}

/** Cuts `text` to at most `width` columns, ending with `ellipsis` when it was cut. */
export function truncate(text: string, width: number, ellipsis: string): string {
  if (textWidth(text) <= width) {
    return text;
  }
  const room = width - textWidth(ellipsis);
  return room <= 0 ? sliceColumns(ellipsis, 0, width) : sliceColumns(text, 0, room) + ellipsis;
}

/** Cuts a path in the middle so its file name stays readable. */
export function truncatePath(path: string, width: number, ellipsis: string): string {
  if (textWidth(path) <= width) {
    return path;
  }
  const slash = path.lastIndexOf('/');
  const name = slash === -1 ? path : path.slice(slash);
  const room = width - textWidth(ellipsis) - textWidth(name);
  if (slash === -1 || room < 1) {
    return truncate(path, width, ellipsis);
  }
  return sliceColumns(path, 0, room) + ellipsis + name;
}
