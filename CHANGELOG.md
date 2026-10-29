# Changelog

All notable changes to **cmd-sync-servers** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Until the first stable release, versions use the pre-release form
`1.0.0-alpha.x.y.z`, where `x.y.z` counts alpha iterations toward `1.0.0`.

## [Unreleased]

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

[Unreleased]: https://github.com/isocialPractice/cmd-sync-servers/compare/v1.0.0-alpha.0.1.0...HEAD
[1.0.0-alpha.0.1.0]: https://github.com/isocialPractice/cmd-sync-servers/compare/v1.0.0-alpha.0.0.0...v1.0.0-alpha.0.1.0
[1.0.0-alpha.0.0.0]: https://github.com/isocialPractice/cmd-sync-servers/releases/tag/v1.0.0-alpha.0.0.0
