# Changelog

All notable changes to **cmd-sync-servers** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Until the first stable release, versions use the pre-release form
`1.0.0-alpha.x.y.z`, where `x.y.z` counts alpha iterations toward `1.0.0`.

## [1.0.0-alpha.1.0.0] - 2026-11-02

### Changed

- **Breaking:** `host` in `sites.json` holds the host name or IP address
  alone. A value with a port, a user, a protocol or a folder, such as
  `server1.hosting.example.net:2083`, no longer loads, and the error names
  the field to use instead.
- **Breaking:** `secretQuestion` reads
  `Password for demo-user on sftp.example.com (My Site: Production): `, so a
  user name that holds an `@` reads clearly.
- **Breaking:** in a terminal, `site add`, `server add` and `server edit`
  connect before they save; `server edit` with no options asks the setup
  questions with the current values as defaults instead of opening the JSON
  editor, which `--editor` still opens; and with only one site, commands use
  it without asking or failing.
- `site add` sets up the site and its first server in one command. It takes
  the server options, with `--server-name` for the server's name, which
  otherwise is its host. In a terminal it asks Protocol, Host, User and the
  password, connects, asks about a new host key or certificate, lets you
  pick the site's folder from what the server shows, asks once whether
  deletes are allowed when that folder is the top of the account, and
  offers to save the password the server accepted. A failed connection
  offers another host, the user name and password again, saving without
  testing, or cancel; cancel saves nothing.
- Questions and tables say Protocol, Host and User, in the terminal
  interface too.
- In the terminal interface, `n` on the Sites screen opens one form for a
  new site and its server; `Shift+N` opens Site Setup for a new site.
- The server editor's Test connects with the values the form shows, without
  saving them first. Web URL moved to the Advanced tab, which also shows the
  trusted certificate with a Forget certificate button. `host:port` typed in
  Host fills Port.
- A password is offered for saving only after the server accepts it, and
  the offer defaults to yes.
- A refused FTP or SFTP sign-in says to check the user name, since many
  hosts name FTP accounts in full, as `user@domain`. A host that does not
  exist and a refused connection say what to check instead of showing the
  library's text, which stays in the debug log.
- A remote root that is not found names the folder the account opens in
  and the folders it holds.
- When a saved password is not sent because the server's protocol, host,
  port or user changed, the question for the password says so.
- An FTP welcome banner shows as its first line.
- The terminal interface frames each screen with two solid rules, and marks
  the top or bottom edge of the content with a dashed line while rows are
  hidden past it. The menu reads `key = action` with a pipe between keys,
  holds up to eight keys, and wraps onto more rows on a narrow terminal
  instead of dropping keys. The message bar is the last row.

### Added

- FTPS certificates that fail verification are shown with their names,
  issuer, validity dates and SHA-256 fingerprint, and a run in a terminal
  asks what to do: connect to a host name the certificate covers and that
  leads to the same machine, keep the host and check the certificate as
  that name, trust the certificate (pinned in
  `options.tls.trustedCertificate`), or cancel. Unattended runs print the
  certificate and the fixes. Expired and not-yet-valid certificates are
  never trusted, and every decision is made before the user name is sent.
- `--trust-certificate <sha256>` on `server test` and on every command that
  takes `--host-key` accepts a certificate by fingerprint for one run.
  `server edit --forget-certificate` removes a pinned certificate.
- FTPS data connections must resume the TLS session of the verified control
  connection or present the same certificate; any other is closed before
  data moves.
- `server test` shows the folder the account opens in, as `Start`, and as
  `startingFolder` in its JSON.
- Once a server accepts a password typed in a terminal, the command line
  and the terminal interface offer to save it in the credential store.
- `server test` in a terminal fixes what it finds and saves each fix: a
  refused sign-in asks for the user name and password again, a remote root
  that is not found is picked from what the server shows, and a host that
  is not found can be changed.
- `config edit` opens the whole `sites.json` in your editor, with its
  problems listed, and reopens it until it is valid; it works while the
  file does not load.
- Problems in `sites.json` name the site, the server, the field and the
  value instead of index paths, and say how to fix the file.
- `--host` and the Host question take `host:port`, `[IPv6]:port`,
  `user@host`, and `sftp://`, `ftpes://`, `ftps://` and `ftp://` addresses;
  `ftp://` connects with FTPS. A web address is refused with what to enter
  instead, and a web control panel port gets a warning.
- A leading `~` in a local folder, key file or CA file is the home folder,
  also in `cmd.exe` and PowerShell.
- A web URL given without a scheme gets `https://`.
- The terminal interface's new-site form: Site name, Local folder,
  Protocol, Host, User, Password and Save password, then Connect, which
  signs in, asks about a new host key or certificate, lets you pick the
  site's folder from what the server shows, and saves the site and its
  server together. A refused sign-in shows under User.
- A folder picker in the terminal interface, for the new-site form and the
  server editor's Browse... button: Enter opens a folder, Backspace goes
  up, and `s` or Use this folder accepts the folder shown in the title.
- Library: `parseServerAddress`, `ServerProbe` (experimental) to connect
  with settings not saved yet and list folders by absolute path,
  `findCoveredNames`, `normalizeCertificateFingerprint`, the
  `CertificateInfo` and `CertificateDecision` types, the optional
  `HostAdapter.confirmCertificate` and `HostAdapter.secretAccepted`
  members, `SecretRequest.note`, `SyncError.details`,
  `Capabilities.startingFolder`, `TransportContext.updateServer` and
  `TransportContext.expectedCertificate`.
- `q` in the preview quits without transferring anything, as `Ctrl+C`
  does; `sync`, `put` and `get` then exit with code 4.

### Fixed

- SFTP connects in runtimes whose crypto lacks ChaCha20, such as the VS Code
  extension host: ChaCha20-Poly1305 is offered only where it is available,
  after AES-GCM as before.
- Picking the site's folder during setup lists and numbers every folder,
  not only the first 30, so any of them opens by number. In a terminal the
  list is laid out in columns; with `--plain` or without a terminal it keeps
  one folder per line.
- Folders whose names start with a dot are listed after the others when
  picking a folder on a server, in the command line, the terminal
  interface's folder picker, and the folders a missing remote root names.

## [1.0.0-alpha.0.6.1] - 2026-10-30

### Fixed

- A local file saved again within the time tolerance of its last sync, at
  the same size, counted as unchanged and was not put. A local file is now
  held to its own record exactly; the tolerance applies to server times
  only.

## [1.0.0-alpha.0.6.0] - 2026-10-29

### Added

- A release workflow: each published GitHub release is built from its tag
  after checking that the tag, the version files and the changelog agree and
  that every test passes. The release carries the package tarball, a
  CycloneDX SBOM, a Sigstore attestation bundle and `SHA256SUMS`. When
  switched on, the same attested tarball is published to npm with trusted
  publishing and provenance, under the `alpha` tag.
- How to verify a release, and the threats checked with the test that
  proves each, on the security page.

- `secretBinding`, `sealSecret` and `openSecret` in the library API, for
  credential stores that keep saved passwords for the engine.

### Changed

- A local or remote folder that is a symbolic link is never written
  through, and the files inside it become problem rows. With
  `follow-inside-root`, linked folders are still read for uploads.

### Security

- A saved password is tied to the protocol, address, port and user it was
  saved for, and is not sent after any of them changes. Passwords saved by
  earlier alphas are asked for once more.
- Server replies, the FTP banner, debug traces, diffs and names are shown
  with control and bidirectional characters escaped, so a server cannot send
  escape sequences to the terminal. Names with C1 control characters are
  refused.
- Backslashes are refused in names on every platform, and names shaped like
  Windows short 8.3 names, such as `GIT~1`, on Windows. A download is never
  written through a folder reached by another name, a link or a junction,
  and an upload refuses a file swapped for a link after it was checked.
- A download stops as soon as a server sends more than the size it listed.
  A remote scan stops beyond 1,000,000 entries or 64 levels of folders.
- A file renamed only by case on one side is held back, so a server that
  ignores case never takes its upload and the delete of the old spelling
  for the same file.
- The recovery folder keeps the files of the current run when it is
  pruned. With recovery off, a Get replaces the local file in one step, and
  a failed replacement on a server without atomic renames keeps the new copy
  under its partial name. Partial copies left by a crash are never
  synchronized as files.
- Deletes are refused at the top of a Windows server's drive (`/C:/`) as at
  `/`.
- Taking over a stale settings lock lets one waiter in at a time, and a
  process only ever removes its own lock.
- A saved plan (`--plan-in`) that adds a path, renumbers a row or chooses an
  action its file cannot take is refused whole, leaving the fresh plan as it
  was.
- FTPS with `--ca-file` trusts the given authority in addition to the
  system's, as documented.
- The release workflow builds and tests without signing or publishing
  rights, attests in a job that runs no repository code, checks out the tag
  by its full ref, and never replaces files already attached to a release.

## [1.0.0-alpha.0.5.0] - 2026-10-29

### Added

- A documentation site with pages for getting started, configuration, the
  command line, synchronization, the library API, security and
  troubleshooting, published to GitHub Pages. It also serves the JSON Schema
  at the address `sites.json` files point to.
- An API reference generated from the source, linked from the site.
- `DIRECTION_TITLES` in the library API: the names of the three directions.
- The error codes, with what to do about each, on the troubleshooting page.

### Changed

- Every public export is documented. The transports, the connection pool,
  the retry helpers, the sync records and the classification helpers are
  marked experimental: they may change before 1.0.0.
- The README is a short front door that links to the site.

### Removed

- `scanFingerprint` is no longer exported. A plan's `fingerprint` carries
  the same digest.

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

[1.0.0-alpha.1.0.0]: https://github.com/isocialPractice/cmd-sync-servers/compare/v1.0.0-alpha.0.6.1...v1.0.0-alpha.1.0.0
[1.0.0-alpha.0.6.1]: https://github.com/isocialPractice/cmd-sync-servers/compare/v1.0.0-alpha.0.6.0...v1.0.0-alpha.0.6.1
[1.0.0-alpha.0.6.0]: https://github.com/isocialPractice/cmd-sync-servers/compare/v1.0.0-alpha.0.5.0...v1.0.0-alpha.0.6.0
[1.0.0-alpha.0.5.0]: https://github.com/isocialPractice/cmd-sync-servers/compare/v1.0.0-alpha.0.4.0...v1.0.0-alpha.0.5.0
[1.0.0-alpha.0.4.0]: https://github.com/isocialPractice/cmd-sync-servers/compare/v1.0.0-alpha.0.3.0...v1.0.0-alpha.0.4.0
[1.0.0-alpha.0.3.0]: https://github.com/isocialPractice/cmd-sync-servers/compare/v1.0.0-alpha.0.2.0...v1.0.0-alpha.0.3.0
[1.0.0-alpha.0.2.0]: https://github.com/isocialPractice/cmd-sync-servers/compare/v1.0.0-alpha.0.1.0...v1.0.0-alpha.0.2.0
[1.0.0-alpha.0.1.0]: https://github.com/isocialPractice/cmd-sync-servers/compare/v1.0.0-alpha.0.0.0...v1.0.0-alpha.0.1.0
[1.0.0-alpha.0.0.0]: https://github.com/isocialPractice/cmd-sync-servers/releases/tag/v1.0.0-alpha.0.0.0
