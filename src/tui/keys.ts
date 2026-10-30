/** One key press, as Node's `readline.emitKeypressEvents` decodes it on every platform. */
export interface Key {
  /** `up`, `down`, `enter`, `escape`, `tab`, `backspace`, `delete`, `space`, `home`, `end`, `pageup`, `pagedown`, or a letter or digit. */
  readonly name: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  /** The printable text the key types, when it types any. */
  readonly text: string | undefined;
}

interface Keypress {
  readonly name?: string | undefined;
  readonly ctrl?: boolean | undefined;
  readonly meta?: boolean | undefined;
  readonly shift?: boolean | undefined;
  readonly sequence?: string | undefined;
}

// eslint-disable-next-line no-control-regex -- control characters never count as typed text
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Normalizes a `keypress` event. */
export function fromKeypress(text: string | undefined, press: Keypress | undefined): Key {
  const ctrl = press?.ctrl === true;
  const meta = press?.meta === true;
  let name = press?.name ?? text ?? '';
  if (name === 'return' || name === 'enter') {
    name = 'enter';
  }
  const typed = text !== undefined && text !== '' && !ctrl && !meta && !CONTROL.test(text) ? text : undefined;
  if (name === '' && typed !== undefined) {
    name = typed;
  }
  return { name, ctrl, meta, shift: press?.shift === true, text: typed };
}

/**
 * Builds a key from a short description, for tests and key maps:
 * `down`, `enter`, `ctrl+s`, `shift+tab`, `a`, `A`, `space`, or `text:any text`.
 */
export function key(spec: string): Key {
  if (spec.startsWith('text:')) {
    const text = spec.slice(5);
    return { name: text, ctrl: false, meta: false, shift: false, text };
  }
  const parts = spec.split('+');
  const base = parts[parts.length - 1] ?? '';
  const ctrl = parts.includes('ctrl');
  const shift = parts.includes('shift') || (base.length === 1 && base !== base.toLowerCase());
  const meta = parts.includes('meta');
  const name = base.length === 1 ? base.toLowerCase() : base;
  const text = !ctrl && !meta ? (base === 'space' ? ' ' : base.length === 1 ? base : undefined) : undefined;
  return { name, ctrl, meta, shift, text };
}

/** True for the key that matches `spec`, compared by name and modifiers. */
export function isKey(press: Key, spec: string): boolean {
  const wanted = key(spec);
  return press.name === wanted.name && press.ctrl === wanted.ctrl && press.meta === wanted.meta && press.shift === wanted.shift;
}
