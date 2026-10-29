# cmd-sync-servers

Keep a local site folder and its servers in step from the command line, the
way Dreamweaver's **Synchronize** does: sites with named servers, cloaked
files, a preview of every change before anything moves, and a memory of the
last sync so a file changed on both sides is flagged instead of overwritten.

The same engine is a library: the `vscode-sync-servers` extension for VS Code
uses it in-process, and both read one shared list of sites.

> **Status: early alpha.** This release provides `sync-servers --version` and
> `--help`. Sites, servers, transfers and the terminal UI are not available
> yet. Do not point it at a server you care about until a release says it is
> ready.

## Goals

- **Sites and servers.** A site is a local folder and a list of servers. One
  server holds the Remote role for synchronizing, another may hold the
  Testing role.
- **Protocols.** SFTP by default; FTPS explicit and implicit; plain FTP only
  when switched on per server; local and network folders.
- **Synchronize.** Put newer files, get newer files, or both, with an option
  to delete files missing on the other side. A preview lists only the files
  that differ, each with a checkbox, and asks for a decision when a file
  changed on both sides.
- **Cloaking.** Suffixes, names, folders and single paths that every
  operation skips.
- **Safe by default.** Pinned SSH host keys, verified TLS certificates,
  passwords kept in the operating system's credential store and never in a
  file, a guard that holds back `.env` files and private keys, and
  recoverable local deletes.
- **Every platform.** Windows, macOS and Linux, in any terminal, with a
  full-screen interface, an editor mode for your own editor, and plain
  unattended output with `--json` for scripts.

## Install

Requires [Node.js](https://nodejs.org/) 22.14 or later.

The alpha is not on npm yet. To try it from a clone:

```sh
git clone https://github.com/isocialPractice/cmd-sync-servers.git
cd cmd-sync-servers
npm ci
npm run build
node out/cli/main.js --version
```

## Usage

```sh
sync-servers --version   # print the version
sync-servers --help      # list commands and options
```

## Documentation

- [Contributing](CONTRIBUTING.md): setup, tests and conventions
- [Security policy](SECURITY.md): supported versions and how to report a
  vulnerability
- [Design language](DESIGN_LANGUAGE.md): how the terminal interface looks
  and behaves
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
