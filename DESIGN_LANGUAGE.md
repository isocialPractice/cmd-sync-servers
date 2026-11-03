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
- **Grouping by space, not boxes.** Two solid rules frame the content, one
  under the title and one above the menu, and blank columns separate table
  columns.
- **Few choices at a time.** The menu shows at most nine keys for the
  screen in front of the user. `?` opens the full key list.
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
| Frame | Bold | The two rules, the dashed scroll edges, and each key in the menu |
| Muted | Dim | Counts, the key hints inside a dialog, skipped rows |
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
| Rule above and below the content | `━━━━` | `____` |
| Scroll edge: rows hidden past it | `━ ━ ━` | `- - -` |

Every action symbol is followed by its word (`↑ Put`), so the meaning never
rests on the symbol alone.

## Layout

```text
 <Screen title>: <subject>                                  <primary shortcut>
 <summary line, when the screen has one>
 ______________________________________________________________________________
 - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
  <content: lists, tables, forms>
 - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
 ______________________________________________________________________________
  <key> = <action>  |  <key> = <action>  |  ...  at most nine, wrapped
 <message bar>
```

- The title bar names the screen and what it acts on, with the primary
  shortcut at the right.
- Two solid rules frame the content, drawn in bold so they take the
  terminal's brightest foreground: white on a dark theme, dark on a light
  one.
- The row under the top rule and the row above the bottom rule are the
  scroll edges. Each shows a dashed line while rows are hidden past it, and
  stays blank at the first or the last row, so the content never moves when
  the dashes come and go.
- The menu lists the screen's keys as `key = action`, with a pipe between
  them, and wraps onto more rows when the terminal is narrow, never
  splitting one.
- The message bar, the last row, shows, in order of priority, a message
  from the last action (for five seconds), the busy spinner with `Esc
  Cancel`, or the full status of the focused row or field: its help, or its
  problem when a save was refused.
- Long values are truncated with an ellipsis at the end, except paths, which
  keep their file name and lose the middle.
- A settings screen puts its category list on the left and the form on the
  right.
- Form labels sit in one column, wide enough for the longest label unless
  the values need the room; a label never wraps. A field's problem shows on
  the line under it.
- Dialogs are boxes drawn over the content and its edges, never over a
  rule, the menu or the message bar, at most 72 columns wide, with the safe
  answer focused unless the action was asked for explicitly.
- When the content would get fewer than three rows, the scroll edges go
  first, then the menu keeps only the rows that fit. Rows are cut at the
  right edge; `?` still lists every key.

## Keys

Keys mean the same thing on every screen.

| Key | Action |
| --- | --- |
| Arrow keys, `j`, `k` | Move |
| `Tab`, `Shift+Tab` | Next or previous pane, or the next filter in a table |
| `Space` | Toggle the focused checkbox or option; in the preview, check or uncheck every row |
| `Enter` | Activate the focused item or the primary action |
| `Esc` | Go back, or cancel the current prompt |
| `/` | Filter the list as you type |
| `Ctrl+S` | Save |
| `?` | Show every key for this screen |
| `q` | Quit, from a top-level screen or the preview |
| `Ctrl+C` | Cancel the running operation, or quit |

While a text field has focus, typed characters go to it, so `?`, `q`, `j`
and `k` are text there. `Ctrl+U` clears the field.

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

## Screens

The screens as they look at 80 x 24 with `--ascii`. In these drawings `>`
marks the focused row where the terminal draws it in inverse video, and
blank body rows, and scroll edges with nothing hidden past them, are left
out. Paths show the way the platform writes them,
such as `C:\Users\<user>\Sites\my-site` on Windows or `~/sites/my-site`
elsewhere.

### Sites

The master list, as Dreamweaver's Manage Sites. `Enter` opens a site and, run
through the `ssv` shell function, changes the shell to its folder on exit.

```text
 Sites                                                               Enter Open
 ______________________________________________________________________________
  Name       Local root                                       Remote server
> Acme Corp  ~/sites/acme                                     Production
  My Site    ~/sites/my-site                                  Production
 ______________________________________________________________________________
  n = New  |  e = Edit  |  Enter = Open  |  d = Remove  |  c = Cloaking
  / = Filter  |  q = Quit
 ~/sites/acme
```

`n` opens the new-site form; `Shift+N` opens Site Setup for a new site, with
every setting. `c` opens the global cloaking patterns.

### New site

A site and its first server in one form, as a site manager entry. Nothing
is saved until Connect has signed in and the site's folder has been picked
from what the server shows; then the site and its server are saved
together. A refused sign-in shows under User, and fields that the chosen
protocol does not use are hidden.

```text
 New site                                                        Ctrl+S Connect
 ______________________________________________________________________________
  FTPS

  Site name      My Site
  Local folder   ~/sites/my-site
  Protocol       < FTPS, explicit TLS >
  Host           203.0.113.10
> User           demo-user@example.com
  Password       ********
  Save password  [x]
  [ Connect ]
 ______________________________________________________________________________
  Up/Down = Move  |  Space = Change  |  Ctrl+S = Connect  |  Esc = Back
 Many hosts name FTP accounts in full, such as demo-user@example.com.
```

### Folder picker

A dialog over the screen that called it, listing the folders of the server.
The title carries the folder shown, the first row accepts it, and `..` goes
up. It starts where the account opens, or at the current root when that
exists. Listing happens in the background; the dialog says so while it
waits. Names come from the server and are shown escaped.

```text
    +- Choose the site's folder: / ----------------------------------------+
    | > Use this folder                                                    |
    |   css/                                                               |
    |   images/                                                            |
    |   js/                                                                |
    |   and 3 files                                                        |
    |                                                                      |
    | Enter Open   Backspace Up   s Use this folder   Esc Cancel           |
    +----------------------------------------------------------------------+
```

When the picked folder is the top of what the account sees, a confirm
dialog asks once whether synchronizing may delete files there, with Not now
focused.

### Site home

One site at a glance, as the Files panel. The changes are counted in the
background when the screen opens and after every run.

```text
 Site: My Site                                                    s Synchronize
 ______________________________________________________________________________
  Local root  ~/sites/my-site
  Server      Production (SFTP sftp.example.com)
  Last sync   2026-10-29 12:00 UTC
  Changes     3 local, 1 on the server, 0 on both sides
  Cloaking    on, 2 pattern(s), 0 path(s)

> Synchronize...
  Put newer files to remote
  Get newer files from remote
  Check for changes
  Site settings
 ______________________________________________________________________________
  Enter = Choose  |  s = Synchronize  |  r = Check  |  e = Settings
  Esc = Back  |  q = Quit
```

### Site setup

The categories on the left, the form of the chosen one on the right. `Tab`
moves between the two panes; `Ctrl+S` saves the site. Servers are saved from
their own editor, so the Servers table acts at once.

```text
 Site Setup: My Site                                                Ctrl+S Save
 ______________________________________________________________________________
  Site                  Name          Host       Protocol       Remote  Testing
> Servers               Production    sftp.e...  SFTP           (*)     ( )
  Advanced Settings     Staging       stagin...  FTPS           ( )     (*)
    Local Info
    Cloaking
    Synchronization
    Security
 ______________________________________________________________________________
  a = Add  |  Enter = Edit  |  c = Duplicate  |  Del = Remove  |  t = Test
  r = Remote  |  Tab = Pane
 Production: SFTP sftp.example.com /var/www/my-site
```

The Cloaking category edits the site's patterns one per line, in the
multi-line editor ported from kilo. Above them it lists the global
patterns, which the site uses first unless Use global patterns is off, and
opens them for editing:

```text
 Site Setup: My Site                                                Ctrl+S Save
 ______________________________________________________________________________
  Site                  Enable cloaking       [x]
  Servers               Use global patterns   [x]
  Advanced Settings     Global patterns       .git/  node_modules/
    Local Info          [ Edit global patterns... ]
>   Cloaking            Cloak files matching
    Synchronization                           .psd
    Security                                  /drafts/

                        Cloaked paths         (none)
                        [ Uncloak a path... ]
 ______________________________________________________________________________
  Tab = Pane  |  Up/Down = Move  |  Space = Change  |  Ctrl+S = Save
  Esc = Back
 .psd cloaks a suffix, archive* a name, node_modules/ a folder, /drafts/ a root
```

### Global cloaking

The cloaking patterns every site uses before its own, one per line, opened
with `c` from Sites or from Site Setup's Cloaking category. `Ctrl+S` saves
them; `Esc` asks before dropping unsaved changes.

```text
 Global Cloaking                                                    Ctrl+S Save
 ______________________________________________________________________________
  Cloak in every site
                       .git/
                       node_modules/
                       Thumbs.db
                       *.lnk

                       Sites use these before their own patterns.
                       Site Setup, Cloaking turns them off for one site.
 ______________________________________________________________________________
  Up/Down = Move  |  Ctrl+S = Save  |  Esc = Back
 .psd cloaks a suffix, archive* a name, node_modules/ a folder, /drafts/ a root
```

### Server editor

Dreamweaver's server dialog: a Basic tab with the connection and an Advanced
tab with the rest, switched with `Tab`. Fields the chosen protocol does not
use are hidden. `host:port` typed in Host fills Port. Test and Browse
connect with the values the form shows, without saving them; a trusted key
or certificate, or another host the certificate covers, goes into the form
and is saved with the server on `Ctrl+S`. Set password works on the saved
server. The Advanced tab starts with the Web URL and ends with the host key
or the trusted certificate and their Forget buttons.

```text
 My Site: Production                                                Ctrl+S Save
 ______________________________________________________________________________
   Basic    Advanced    SFTP

  Server name     Production
  Protocol        < SFTP >
  Host            sftp.example.com
  Port
  User            demo-user
  Sign in with    < Password >
  Save password   [x]
  [ Set password... ]
  Root directory  /var/www/my-site
  [ Browse... ]
  [ Test ]
 ______________________________________________________________________________
  Tab = Advanced  |  Up/Down = Move  |  Space = Change  |  Ctrl+S = Save
  Esc = Back
 The host name or IP address, such as sftp.example.com. host:port fills Port.
```

### Trust and password dialogs

Choices about trust are choice dialogs that show what is being trusted
before the choices: the host key's algorithm and fingerprint, or the
certificate's names, issuer, validity dates and SHA-256 fingerprint, and both
fingerprints when a trusted certificate changed. The focus starts on the
safe answer:

| Dialog | Focused at first | Why |
| --- | --- | --- |
| New host key | Do not trust it | Trust is a decision to check first |
| Certificate, with a host name it covers | Connect to that name | Full verification stays on |
| Certificate, with no covered name, or changed | Cancel | Trust is a decision to check first |
| Save password, once the server accepted it | Save | It goes only to the credential store, and the person just typed it to sign in |

Expired and not-yet-valid certificates never open a dialog: they are
refused with the reason in the message bar.

### Synchronize

The scope, the direction, and the delete option worded for the direction,
as Dreamweaver words it. `Enter` scans both sides and opens the preview.

```text
 Synchronize: My Site                                             Enter Preview
 ______________________________________________________________________________

  Synchronize                             Entire 'My Site' site
  Direction                               < Put newer files to remote >
  Delete remote files not on local drive  [ ]
  [ Preview ]
 ______________________________________________________________________________
  Up/Down = Move  |  Space = Change  |  Enter = Preview  |  Esc = Back
 Space or Left and Right change the direction.
```

### Preview

The summary line, then one row per file with a difference. Unchanged files
are counted, never listed. `Tab` shows only one kind of row: All, Put, Get,
Resolve, Delete, Guarded or Errors.

```text
 Synchronize: My Site -> Production (SFTP)            Put newer files to remote
 Files: 37 will be updated, 169 will be skipped, 12 need a decision
 ______________________________________________________________________________
> [x] ^ Put      img/hero.svg
  [x] ^ Put      scripts/lib/cli.js
  [ ] ? Resolve  css/site.css        Changed locally and on the server since...
  [ ] ^ Put      .env                Matches the sensitive pattern ".env". C...
  [ ] x Delete   old/legacy.html     On the server only and never synchroni...
 - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
 ______________________________________________________________________________
  Space = CHECK/UNCHECK ALL  |  c = Check/Uncheck  |  p = Put  |  g = Get
  s = Skip  |  d = Diff  |  a = All  |  q = Quit  |  Enter = Synchronize
 img/hero.svg
```

`c` checks or unchecks the focused row, and `Space` every row at once:
when most rows are checked it unchecks them all, and otherwise it checks
them all, so once the rows agree each press turns them all the other way.
`a` checks every row, or unchecks them all when all are checked. `d` opens
the difference of the focused file as a scrolling text screen, and `q`
quits without transferring anything, as `Ctrl+C` does.
`Enter` asks once more before anything moves:

```text
    +- Synchronize --------------------------------------------------------+
    | Synchronize 37 file(s) now?                                          |
    |                                                                      |
    | [ Synchronize ]  [ Cancel ]                                          |
    +----------------------------------------------------------------------+
```

### Progress and results

Overall progress and the file in hand while the plan runs; `Esc` cancels
cleanly between files. The results list failures first.

```text
 Synchronizing: My Site -> Production (SFTP)
 ______________________________________________________________________________

  12 of 37 files   ##############..................................
  480 KB moved

  scripts/lib/cli.js
 ______________________________________________________________________________
  Esc = Cancel
 | Synchronizing  Esc Cancel
```

```text
 Results: My Site -> Production
 Synchronized 36 files. 1 failed. 169 skipped.
 ______________________________________________________________________________
> failed    img/banner.png  Permission denied.
  done      img/hero.svg
  done      scripts/lib/cli.js
  skipped   css/site.css
 ______________________________________________________________________________
  Up/Down = Move  |  Esc = Done
 img/banner.png: Permission denied.
```

### Plain mode

The same flows as numbered line prompts. The preview takes typed commands:
row numbers and ranges check or uncheck rows, `p`, `g`, `s`, `m` and `x` set
an action, `diff` shows a difference, `go` synchronizes and `q` cancels.

```text
Synchronize: My Site -> Production (SFTP)   Put newer files to remote
Files: 2 will be updated, 1 will be skipped, 1 needs a decision
  1 [ ] ^ Put      .env          Matches the sensitive pattern ".env".
  2 [ ] ? Resolve  css/site.css  Changed locally and on the server.
  3 [x] ^ Put      img/hero.svg
  4 [x] ^ Put      index.html
Type "help" for commands, "go" to synchronize, "q" to cancel.
preview: p 2
Files: 3 will be updated, 1 will be skipped
preview: go
Synchronize 3 file(s)? (y/N): y
Synchronized 3 files. 0 failed. 1 skipped.
```

### Editor mode

`--preview editor` writes the plan to a private temporary file and opens it
in the user's editor. Saving and closing synchronizes what is checked;
closing without saving, or deleting every row, cancels. A row that cannot be
read reopens the file with the problems as comments at the top.

```text
# sync-servers preview: My Site -> Production (SFTP)
# Put newer files to remote
# Files: 37 will be updated, 169 will be skipped, 12 need a decision
#
# Check or uncheck a box, or change the action word, then save and close to
# synchronize. Close without saving, or delete every row, to cancel.
#   put  get  skip  synced  delete-remote  delete-local
#
[x] put       1  img/hero.svg
[ ] resolve   3  css/site.css      # Changed locally and on the server.
[ ] put       4  .env              # Matches the sensitive pattern ".env".
```

## Accessibility

- `--plain` runs every flow as numbered line prompts with no alternate
  screen and no cursor movement, which screen readers and logging terminals
  follow. It is chosen automatically when `TERM=dumb`, and when the terminal
  cannot be put in raw mode.
- `SYNC_SERVERS_UI` (`tui`, `editor`, `plain` or `none`) sets how previews
  are shown, for people who always want one form.
- Nothing depends on colour alone, and nothing depends on a mouse.
- The terminal is restored on every exit path: normal exit, `Ctrl+C`,
  `SIGINT` and uncaught errors.
