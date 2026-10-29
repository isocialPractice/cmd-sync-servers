# Third-Party Notices

This file carries the licence notices of third-party code included in the
`@isocialpractice/cmd-sync-servers` package, and notes about dependencies
whose installed files carry licences of their own.

Dependencies installed from npm are not copied into the package. Each one
carries its own licence in its own folder under `node_modules`.

The package includes no third-party code.

## Optional dependency: @napi-rs/keyring

`@napi-rs/keyring` (MIT) lets the command-line tool keep passwords in the
operating system's credential store. It is optional: when it is not
installed, passwords come from environment variables or a prompt instead.

npm installs one prebuilt binary package for the platform, such as
`@napi-rs/keyring-linux-x64-gnu`. The binaries for Linux, and for other
systems that reach the Secret Service over D-Bus, statically link `libdbus`,
which is licensed under the Academic Free License 2.1 or, at your option,
the GNU General Public License version 2 or later
(`AFL-2.1 OR GPL-2.0-or-later`). The Windows and macOS binaries do not
include `libdbus`.
