# Third-Party Notices

This file carries the licence notices of third-party code included in the
`@isocialpractice/cmd-sync-servers` package, and notes about dependencies
whose installed files carry licences of their own.

Dependencies installed from npm are not copied into the package. Each one
carries its own licence in its own folder under `node_modules`.

## kilo

The terminal handling and editing core of the terminal UI (`out/tui/`) are
ported to TypeScript from kilo, <https://github.com/antirez/kilo>, at commit
`323d93b29bd89a2cb446de90c4ed4fea1764176e`.

```text
Copyright (c) 2016, Salvatore Sanfilippo <antirez at gmail dot com>

All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice,
  this list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

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
