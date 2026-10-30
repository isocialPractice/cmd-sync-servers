# cmd-sync-servers

Keep a local site folder and its servers in step from the command line, the
way Dreamweaver's **Synchronize** does: sites with named servers, cloaked
files, a preview of every change before anything moves, and a memory of the
last sync so a file changed on both sides is flagged instead of overwritten.

The same engine is a library: the `vscode-sync-servers` extension for VS Code
uses it in-process, and both read one shared list of sites.

**Documentation: <https://isocialpractice.github.io/cmd-sync-servers/>**

> **Status: early alpha.** Sites, servers, saved passwords, cloaking and
> synchronizing work from the command line, in a full-screen terminal UI,
> in your own editor and in plain prompts. Try it on a copy of a site first.

## Highlights

- **Sites and servers.** A site is a local folder and its servers; one holds
  the Remote role for synchronizing, another may hold the Testing role.
- **Protocols.** SFTP by default; FTPS with explicit or implicit TLS; plain
  FTP only when switched on per server; local and network folders.
- **A preview of every change.** Put newer files, get newer files, or both,
  optionally deleting what the other side lost. Only files that differ are
  listed, each with a checkbox, and a file changed on both sides waits for
  your decision.
- **Safe by default.** Pinned SSH host keys, verified TLS certificates,
  passwords in the operating system's credential store and never in a file,
  a guard that holds back `.env` files and private keys, and local files
  kept for 14 days after a sync replaces them.
- **Every platform, three ways to work.** Windows, macOS and Linux; a
  full-screen interface, a preview in your own editor, and plain or
  unattended runs with `--json` for scripts.

## Install

Requires [Node.js](https://nodejs.org/) 22.14 or later.

Once the alpha is published on npm:

```sh
npm install --global @isocialpractice/cmd-sync-servers@alpha
```

Until then, from a clone (building needs Node.js 22.18 or later):

```sh
git clone https://github.com/isocialPractice/cmd-sync-servers.git
cd cmd-sync-servers
npm ci --ignore-scripts
npm run build
node out/cli/main.js --version
```

## A first sync

```sh
sync-servers site add --name "My Site" --local-root ~/sites/my-site
sync-servers server add --site "My Site" --name Production \
  --host sftp.example.com --user demo-user --remote-root /var/www/my-site
sync-servers password set Production --site "My Site"
sync-servers server test Production --site "My Site"
cd ~/sites/my-site && sync-servers sync --put
```

The test shows the server's host key fingerprint once and asks whether to
trust it. The last command opens the preview: check what should move, then
press Enter. Run `sync-servers` with no command to do all of this from menus.

## Documentation

- [Getting started](https://isocialpractice.github.io/cmd-sync-servers/getting-started.html):
  a site, a server, a password and the first preview
- [Configuration](https://isocialpractice.github.io/cmd-sync-servers/configuration.html):
  where settings live, every field, cloaking, the guard and secrets
- [Command line](https://isocialpractice.github.io/cmd-sync-servers/cli.html):
  every command, the terminal interface, editor and plain modes, shell
  integration, exit codes and JSON output
- [Synchronization](https://isocialpractice.github.io/cmd-sync-servers/synchronization.html):
  how changes are found and turned into actions
- [Library API](https://isocialpractice.github.io/cmd-sync-servers/api.html)
  and the [API reference](https://isocialpractice.github.io/cmd-sync-servers/api/)
- [Security](https://isocialpractice.github.io/cmd-sync-servers/security.html)
  and [troubleshooting](https://isocialpractice.github.io/cmd-sync-servers/troubleshooting.html)

The same pages are in [`docs/`](docs/).

## Contributing and security

- [Contributing](CONTRIBUTING.md): setup, tests and conventions
- [Security policy](SECURITY.md): report vulnerabilities privately, never in
  a public issue
- [Design language](DESIGN_LANGUAGE.md): how the terminal interface looks
  and behaves
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
