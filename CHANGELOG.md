# Changelog

All notable changes to **cmd-sync-servers** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Until the first stable release, versions use the pre-release form
`1.0.0-alpha.x.y.z`, where `x.y.z` counts alpha iterations toward `1.0.0`.

## [Unreleased]

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

[Unreleased]: https://github.com/isocialPractice/cmd-sync-servers/compare/v1.0.0-alpha.0.2.0...HEAD
[1.0.0-alpha.0.2.0]: https://github.com/isocialPractice/cmd-sync-servers/compare/v1.0.0-alpha.0.1.0...v1.0.0-alpha.0.2.0
[1.0.0-alpha.0.1.0]: https://github.com/isocialPractice/cmd-sync-servers/compare/v1.0.0-alpha.0.0.0...v1.0.0-alpha.0.1.0
[1.0.0-alpha.0.0.0]: https://github.com/isocialPractice/cmd-sync-servers/releases/tag/v1.0.0-alpha.0.0.0
