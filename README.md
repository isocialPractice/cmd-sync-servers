# cmd-sync-servers

Keep a local site folder and its servers in step from the command line, the
way Dreamweaver's **Synchronize** does: sites with named servers, cloaked
files, a preview of every change before anything moves, and a memory of the
last sync so a file changed on both sides is flagged instead of overwritten.

The same engine is a library: the `vscode-sync-servers` extension for VS Code
uses it in-process, and both read one shared list of sites.

> **Status: early alpha.** This release manages sites, servers, saved
> passwords and cloaking. Connecting, transfers and the terminal UI are not
> available yet.

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

Requires [Node.js](https://nodejs.org/) 22.14 or later to run, and 22.18 or
later to build from source.

The alpha is not on npm yet. To try it from a clone:

```sh
git clone https://github.com/isocialPractice/cmd-sync-servers.git
cd cmd-sync-servers
npm ci --ignore-scripts
npm run build
node out/cli/main.js --version
```

## Usage

```sh
# A site is a local folder and its servers. The first server is the Remote server.
sync-servers site add --name "My Site" --local-root ~/sites/my-site
sync-servers server add --site "My Site" --name Production \
  --host sftp.example.com --user demo-user --remote-root /var/www/my-site

# Keep the password in the operating system's credential store
sync-servers password set Production --site "My Site"

# Cloak what no operation should touch: suffixes, names, folders or paths
sync-servers cloak --site "My Site" .psd "archive*" node_modules/

sync-servers sites      # list the sites
sync-servers doctor     # check the setup
sync-servers --help     # every command and option
```

Run a command inside a site's folder and that site is chosen; elsewhere,
pass `--site`. In a terminal, a command asks for anything it is missing, and
`site edit --editor` or `server edit --editor` opens the settings as JSON in
your own editor. Every listing command takes `--json`.

### Change to a site's folder

`shell-init` prints a small `ssv` function that runs `sync-servers` and then
changes to the folder of the site you chose:

```sh
eval "$(sync-servers shell-init bash)"      # in ~/.bashrc; zsh is the same
ssv site path "My Site"
```

PowerShell: `Invoke-Expression (& sync-servers shell-init pwsh | Out-String)`
in your profile. fish and cmd are supported too: `sync-servers shell-init --help`.

### Where things are kept

`sync-servers config path` shows the folders. The list of sites is
`sites.json` in your settings folder (`%APPDATA%\sync-servers` on Windows,
`~/Library/Application Support/sync-servers` on macOS,
`~/.config/sync-servers` elsewhere), described by
[`schema/site.schema.json`](schema/site.schema.json). Passwords are never
written to a file: they live in the credential store, or come from
`SYNC_SERVERS_PASSWORD`, or are asked for.

## Documentation

- [Contributing](CONTRIBUTING.md): setup, tests and conventions
- [Security policy](SECURITY.md): supported versions and how to report a
  vulnerability
- [Design language](DESIGN_LANGUAGE.md): how the terminal interface looks
  and behaves
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
