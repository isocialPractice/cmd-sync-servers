# Vendored: kilo

The terminal handling and editing core of the `sync-servers` terminal UI are
ported to TypeScript from kilo, a small text editor by Salvatore Sanfilippo.
This folder keeps the original source the port follows. It is never packed;
the licence travels in `THIRD_PARTY_NOTICES.md` and in the header of each
ported file.

| Field | Value |
| --- | --- |
| Upstream | <https://github.com/antirez/kilo> |
| Commit | `323d93b29bd89a2cb446de90c4ed4fea1764176e` |
| Commit date | 2025-01-04 |
| Licence | BSD-2-Clause, Copyright (c) 2016, Salvatore Sanfilippo |
| Fetched with | `npm run vendor:kilo` |

## Checksums

`test/unit/tui/vendored.test.ts` recomputes these, so the vendored copy
cannot change unnoticed.

| File | SHA-256 |
| --- | --- |
| `kilo.c` | `4a44dd0e41670a9e49ecccb338ee199334f0dd472fc7f86467569cf99c391abe` |
| `LICENSE` | `b4a76f8575c0d9f3f927988133e6d9a24a55bca1d8e1ce094b30e7c44bcc9eb6` |

## What was ported, and where

| kilo | Ported to | Customized for |
| --- | --- | --- |
| `enableRawMode`, `disableRawMode`, `editorAtExit` | `src/tui/terminal.ts` | Alternate screen, cursor visibility, and restoring the terminal on every exit path: normal exit, Ctrl+C, signals and uncaught errors |
| `getWindowSize`, `updateWindowSize`, `handleSigWinCh` | `src/tui/terminal.ts` | The terminal size and resize events from Node's TTY streams |
| `struct abuf`, `abAppend`, `editorRefreshScreen` | `src/tui/screen.ts` | One write per frame, rewriting only the rows that changed, with styles from the theme |
| The status and message rows of `editorRefreshScreen`, `editorSetStatusMessage` | `src/tui/widgets/chrome.ts`, `src/tui/app.ts` | Title bar, key-hint footer, and a message bar for transient messages and the full status of the focused row |
| `erow`, `editorRowInsertChar`, `editorRowDelChar`, `editorInsertChar`, `editorDelChar` | `src/tui/textfield.ts` | Single-line form fields, with a masked mode for secrets |
| `editorInsertRow`, `editorDelRow`, `editorRowAppendString`, `editorInsertNewline`, `editorRowsToString` | `src/tui/textarea.ts` | The multi-line cloaking and guard pattern editors |
| `editorMoveCursor`, with its `rowoff` and `coloff` scrolling | `src/tui/textfield.ts`, `src/tui/textarea.ts`, `src/tui/widgets/list.ts` | Horizontal scrolling of long values; vertical scrolling of long lists and tables |
| `editorFind` | `src/tui/widgets/list.ts` | Filter-as-you-type in the site list and the preview |
| `editorProcessKeypress` | `src/tui/app.ts` | Key dispatch to the screen in front, with dialogs on top |
| `editorReadKey` | not ported | Node's `readline.emitKeypressEvents` decodes keys on every platform |

Syntax highlighting (`editorUpdateSyntax`, `HLDB` and their helpers), file
reading and saving (`editorOpen`, `editorSave`), and `main` are not ported.
