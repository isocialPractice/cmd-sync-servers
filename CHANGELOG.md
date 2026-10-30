# Changelog

All notable changes to **cmd-sync-servers** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Until the first stable release, versions use the pre-release form
`1.0.0-alpha.x.y.z`, where `x.y.z` counts alpha iterations toward `1.0.0`.

## [Unreleased]

## [1.0.0-alpha.0.4.0] - 2026-10-29

### Added

- A full-screen terminal interface, opened by `sync-servers` with no command
  in a terminal: the site list, a home screen for each site with its changes,
  Site Setup with the Servers, Local Info, Cloaking, Synchronization and
  Security categories, a server editor with Basic and Advanced tabs, Set
  password and Test, and the Synchronize, preview, progress and results
  screens. It works from the keyboard at 80 x 24, with `?` listing every key
  of a screen.
- The preview of `sync`, `put` and `get` opens in the full-screen interface
  in a terminal. `--preview editor` opens it as a text file in your editor,
  where boxes and action words can be changed and rows deleted;
  `--preview plain` shows numbered prompts; `--preview none` prints it.
  `SYNC_SERVERS_UI` sets the usual choice.
- Plain mode: `--plain`, `TERM=dumb`, or a terminal without raw mode runs the
  same flows as numbered line prompts, for screen readers and logging
  terminals.
- `ssv` with no command opens the site list and changes to the folder of the
  site you open.

### Security

- The terminal is restored on every way out: a normal exit, `Ctrl+C`,
  `SIGTERM`, `SIGHUP` and an error while drawing.
- Passwords typed in the interface are masked, kept only in the credential
  store, and removed from it when Save password is turned off.
- Control characters in file names and messages are shown as `?`, never sent
  to the terminal.

## [1.0.0-alpha.0.3.0] - 2026-10-29

### Added

- `sync --put`, `--get` or `--both`, with `--delete` to remove files missing
  on the other side: compares both sides, shows a preview of every file with
  a difference, and transfers the checked rows once confirmed. `--yes` runs
  it from a script; without it, a script only sees the preview. Also
  `--dry-run`, `--plan-out` and `--plan-in` for a saved plan, and `--json`.
- Sync records for each site and server, kept in the state folder and saved
  during a run. A file changed on both sides, or changed on one side and
  deleted on the other, waits for a decision instead of being overwritten.
- `put` and `get` for single files and folders, which run at once unless a
  decision is needed.
- `status`, `diff`, `mark-synced` and `state reset`.
- Library API: `SyncSession`, `SyncPlan` and the change classification.

### Security

- Sensitive files such as `.env`, private keys, and version-control or
  credential folders are listed unchecked and move only when checked.
- Deletes need the delete option, and files never synchronized before are
  listed unchecked. Deleting more than 50 files or 25 % of a side needs the
  count typed back or `--allow-mass-delete`. Mirroring from an empty root,
  and deleting at the top of a server, are refused.
- Each file is checked again just before it moves; one that changed since
  the preview is skipped. Files are written to a partial copy, checked for
  size, then renamed into place, and a local file that is overwritten or
  deleted is kept in a recovery folder for 14 days.
- Names that differ only by case on a case-insensitive file system, names
  not valid on this system, and symbolic links are reported and never
  transferred.

## [1.0.0-alpha.0.2.0] - 2026-10-29

### Added

- `server test`: connects, signs in, checks the remote root, and reports the
  SSH host key, the TLS version, the server software, how precise its file
  times are, and the features it offers.
- Transports for SFTP, FTPS with explicit or implicit TLS, plain FTP, and
  local or network folders, in the library API with a connection pool and
  retries.
- `npm run sandbox` starts local SFTP, FTPS and FTP test servers with
  throwaway credentials, for trying the tool without a real host.

### Security

- SSH host keys are confirmed on first use and pinned in the server's
  settings. A changed key stops the connection, shows both fingerprints, and
  is never accepted silently. Unattended runs refuse an unknown key unless
  `--host-key` names it.
- SSH uses modern key exchange, host key, cipher and MAC algorithms only,
  unless a server sets `legacyAlgorithms`, which warns on every connection.
- FTPS verifies the certificate chain and host name and requires TLS 1.2 or
  later; a private certificate authority is trusted through `--ca-file`.
  Plain FTP is refused unless the server sets `allowInsecure`, and warns on
  every connection.
- Passwords are asked for and sent only after the SSH host key or the TLS
  certificate has been verified.
- Names a server returns that would leave the site, are not valid on this
  system, contain control characters, or are too long are never used as
  paths. Writes never follow a symbolic link or junction out of the site.
- Dropped and stalled connections fail with a transient error and are
  retried on a fresh connection; an FTP server that answers 421 gets fewer
  connections. Very large folder listings are refused.

## [1.0.0-alpha.0.1.0] - 2026-10-29

### Added

- The master list of sites, `sites.json`, in the per-user settings folder of
  each platform (or `SYNC_SERVERS_HOME`), validated against a JSON Schema
  shipped as `schema/site.schema.json`. Every write is atomic, keeps a
  backup, and takes a lock file, so the CLI and the VS Code extension can
  share the list.
- Site and server commands: `sites`, `site add`, `site edit`, `site show`,
  `site remove`, `site path`, `server list`, `server add`, `server edit`,
  `server remove`, `server set-remote` and `server set-testing`. In a
  terminal they ask for what is missing; scripts pass options. `--editor`
  edits a site or a server as JSON in your own editor and reopens it with
  the problems listed until it is valid.
- `password set` and `password forget`: passwords and private key
  passphrases are kept in the operating system's credential store and never
  in a file. `SYNC_SERVERS_KEYRING=off` turns the store off.
- `cloak` and `uncloak`: cloaking by suffix, name, folder and single path.
- `config path`, `doctor` and `help`.
- `shell-init` for bash, zsh, fish, PowerShell and cmd, with the global
  `--cd-file` option: the `ssv` function changes to the folder of the chosen
  site.
- `--json` output for every command that lists or shows something, and
  stable exit codes.
- Run logs in JSON Lines in the state folder, the newest 30 kept, with
  passwords and other secrets removed.
- Library API: `SiteRegistry`, `defaultPaths`, the `sites.json` schema, the
  credential stores, and a redacting logger. The OS credential store is a
  separate export, `@isocialpractice/cmd-sync-servers/credentials/keyring`.

## [1.0.0-alpha.0.0.0] - 2026-10-29

### Added

- Project scaffold: package manifest, TypeScript build, test harness, and
  the `sync-servers --version` and `--help` commands.
- A package-content check that fails when anything outside the published
  file list would be packed.
- Continuous integration on Linux, macOS and Windows with Node.js 22 and 24,
  CodeQL analysis, dependency review, OpenSSF Scorecard and Dependabot
  updates, with every action pinned to a commit.
- Security policy, contribution guide and design language.

[Unreleased]: https://github.com/isocialPractice/cmd-sync-servers/compare/v1.0.0-alpha.0.4.0...HEAD
[1.0.0-alpha.0.4.0]: https://github.com/isocialPractice/cmd-sync-servers/compare/v1.0.0-alpha.0.3.0...v1.0.0-alpha.0.4.0
[1.0.0-alpha.0.3.0]: https://github.com/isocialPractice/cmd-sync-servers/compare/v1.0.0-alpha.0.2.0...v1.0.0-alpha.0.3.0
[1.0.0-alpha.0.2.0]: https://github.com/isocialPractice/cmd-sync-servers/compare/v1.0.0-alpha.0.1.0...v1.0.0-alpha.0.2.0
[1.0.0-alpha.0.1.0]: https://github.com/isocialPractice/cmd-sync-servers/compare/v1.0.0-alpha.0.0.0...v1.0.0-alpha.0.1.0
[1.0.0-alpha.0.0.0]: https://github.com/isocialPractice/cmd-sync-servers/releases/tag/v1.0.0-alpha.0.0.0
