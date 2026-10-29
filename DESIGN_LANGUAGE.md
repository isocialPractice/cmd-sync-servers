# Design Language

How the `sync-servers` terminal interface looks, reads and responds. The
medium is a grid of characters in whatever terminal and theme the user
already has, so every rule here works with the terminal's own palette and
degrades to plain ASCII without losing meaning.

## Principles

- **One place for the eye.** The focused row or field is drawn in inverse
  video. The primary action of a screen (Synchronize, Save) is the only
  element in the accent colour.
- **One accent colour.** Cyan from the terminal's own palette, so the user's
  theme decides the exact hue. Yellow means warning and red means error,
  always beside a symbol and a word, never on their own.
- **Grouping by space, not boxes.** One rule under the title, one rule above
  the footer, and blank columns between table columns.
- **Few choices at a time.** The footer shows at most seven key hints for
  the screen in front of the user. `?` opens the full key list.
- **Works at 80 x 24.** Every screen fits a standard terminal and gives any
  extra width to the column that needs it most, usually the path.
- **Colour is never the only signal.** `NO_COLOR` and `--no-color` remove
  colour without losing any meaning. `--ascii` swaps every symbol for its
  ASCII form.

## Colour Roles

| Role | Terminal attribute | Used for |
| --- | --- | --- |
| Text | Default foreground | Everything not listed below |
| Focus | Inverse video | The focused row, field or button |
| Accent | Cyan | The primary action and the title of the focused pane |
| Muted | Dim | Counts, key hints, skipped rows |
| Warning | Yellow, with `!` and a word | Guarded files, insecure protocols, rows that need a decision |
| Error | Red, with `x` and a word | Failed items, refused operations |

The terminal's own background and foreground carry most of the screen, plain
text carries the content, and the accent is kept for the one action that
matters. A screen with more than one accent-coloured element is a bug.

## Symbols

Every symbol has an ASCII form, chosen by `--ascii`, by `TERM=dumb`, or on a
Windows console whose code page is not UTF-8.

| Meaning | Symbol | ASCII |
| --- | --- | --- |
| Put: upload the local file | `↑` | `^` |
| Get: download the remote file | `↓` | `v` |
| Resolve: changed on both sides | `?` | `?` |
| Delete remote or delete local | `✕` | `x` |
| Skip | `-` | `-` |
| Synchronized without transfer | `=` | `=` |
| Cloaked | `⊘` | `#` |
| Checked and unchecked | `[x]` `[ ]` | `[x]` `[ ]` |
| Selected and unselected option | `(*)` `( )` | `(*)` `( )` |
| Truncated text | `…` | `...` |

Every action symbol is followed by its word (`↑ Put`), so the meaning never
rests on the symbol alone.

## Layout

```text
 <Screen title>: <subject>                                  <primary shortcut>
 <summary line, when the screen has one>
 ------------------------------------------------------------------------------
  <content: lists, tables, forms>
 ------------------------------------------------------------------------------
  <at most seven key hints>
```

- The title bar names the screen and what it acts on, with the primary
  shortcut at the right.
- The message bar below the content shows transient messages and the full
  status of the focused row when the table truncates it.
- Long values are truncated with an ellipsis at the end, except paths, which
  keep their file name and lose the middle.
- A settings screen puts its category list on the left and the form on the
  right.

## Keys

Keys mean the same thing on every screen.

| Key | Action |
| --- | --- |
| Arrow keys, `j`, `k` | Move |
| `Tab`, `Shift+Tab` | Next or previous pane, or the next filter in a table |
| `Space` | Toggle the focused checkbox or option |
| `Enter` | Activate the focused item or the primary action |
| `Esc` | Go back, or cancel the current prompt |
| `/` | Filter the list as you type |
| `Ctrl+S` | Save |
| `?` | Show every key for this screen |
| `q` | Quit, from a top-level screen |
| `Ctrl+C` | Cancel the running operation, or quit |

## States

Every control has a rest, focused and disabled state, and a busy state when
it starts work:

| State | Drawn as |
| --- | --- |
| Rest | Default text |
| Focused | Inverse video |
| Disabled | Dim, and skipped by focus movement |
| Busy | A spinner and a word in the message bar, with `Ctrl+C` to cancel |

## Copy

- Titles name the thing: `Site Setup: My Site`, `Synchronize: My Site`.
- Actions are verbs: Put, Get, Synchronize, Save, Test.
- Status texts are full sentences ending with a period. They say what
  happened and, when the user has to act, what to do: "Changed locally and
  on the server since the last sync. Choose Put or Get."
- Counts are digits: `Files: 37 will be updated, 169 will be skipped`.
- Warnings say what is at risk, without exclamation marks or blame.
- Examples and help text use placeholder data only: `My Site`,
  `sftp.example.com`, `demo-user`.

## Accessibility

- `--plain` runs every flow as numbered line prompts with no alternate
  screen and no cursor movement, which screen readers and logging terminals
  follow. It is chosen automatically when `TERM=dumb`.
- Nothing depends on colour alone, and nothing depends on a mouse.
- The terminal is restored on every exit path: normal exit, `Ctrl+C`,
  `SIGINT` and uncaught errors.
