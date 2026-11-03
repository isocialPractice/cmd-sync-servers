# Contributing

Thank you for helping. This guide covers setup, the test commands and the
conventions every change follows. Security problems go through
[SECURITY.md](SECURITY.md), never through an issue or a pull request.

## Requirements

- Node.js 22.18 or later for development. Tests run the TypeScript sources
  directly through Node's type stripping. The published package itself runs
  on Node.js 22.14 or later.
- Git.

## Setup

```sh
git clone https://github.com/isocialPractice/cmd-sync-servers.git
cd cmd-sync-servers
npm ci --ignore-scripts
npm run build
npm test
npm link
```

`npm link` puts the `sync-servers` command from your clone on your `PATH`, so
it runs what you last built; `npm unlink --global @isocialpractice/cmd-sync-servers`
takes it off again.

Dependencies never run install scripts. Builds and tests are started
explicitly with the commands below, never from npm lifecycle hooks.

## Commands

| Command | Does |
| --- | --- |
| `npm run build` | Compiles `src/` into `out/` and regenerates `schema/site.schema.json` |
| `npm run schema` | Regenerates `schema/site.schema.json` from the zod schema; commit the result |
| `npm run typecheck` | Type checks `src/`, `test/` and `scripts/` |
| `npm run lint` | ESLint with type-aware rules |
| `npm test` | Builds, then runs every test layer |
| `npm run test:unit` | Unit tests in `test/unit/` |
| `npm run test:integration` | Integration tests in `test/integration/` |
| `npm run test:e2e` | Builds, then runs the CLI as a child process from `test/e2e/` |
| `npm run test:docs` | The documentation checks and the leak scan in `test/docs/` (below) |
| `npm run test:docker` | The interop tests against real OpenSSH and vsftpd containers (see below) |
| `npm run coverage` | Unit and integration tests with coverage, then the coverage bar (below) |
| `npm run sandbox` | Starts local SFTP, FTPS and FTP test servers with throwaway credentials, until Ctrl+C |
| `npm run pack:check` | Builds, then fails if `npm pack` would ship anything outside the `files` allowlist |
| `npm run vendor:kilo` | Fetches the pinned kilo sources into `vendor/kilo/` and prints their checksums |
| `npm run docs:api` | Generates the API reference into `_site/api/`; any undocumented export fails it |
| `npm run docs:cli` | Rewrites the command reference in `docs/cli.html` from the command definitions |
| `npm run docs:site` | Assembles the Pages site in `_site/`: `docs/`, the JSON Schema and the API reference |

Run `npm run lint`, `npm run typecheck` and `npm test` before every pull
request. CI runs the same commands on Linux, macOS and Windows with Node.js
22 and 24.

## Tests

- Tests use `node:test` and `node:assert`. Name test files `*.test.ts` and
  put them in the layer they belong to: `unit`, `integration`, `e2e` or
  `docs`.
- Every test sets `SYNC_SERVERS_HOME` to its own temp folder. The test
  runner also points it at a fresh temp folder and sets
  `SYNC_SERVERS_KEYRING=off`, so no test ever reads or writes your real list
  of sites or your operating system's credential store. Tests that need a
  credential store pass a `MemoryCredentialStore`.
- A unit test fails when `schema/site.schema.json` differs from the zod
  schema. Run `npm run schema` and commit the file after changing the schema.
- The coverage bar: every branch of `src/sync/paths.ts` (path safety) and
  `src/sync/classify.ts` (change detection), and 85 % of the lines of
  `src/`. CI enforces it with `npm run coverage`.
- `test/integration/scenarios.test.ts` runs the synchronization scenarios
  (first syncs, edits, conflicts, deletes, guards, cloaking, stale files,
  hostile names) against the local, SFTP and FTPS sandboxes, and searches
  every file and log record a run wrote for the server password.
- Tests never connect to a real server. Protocol tests run against sandbox
  servers bound to `127.0.0.1` with credentials generated for each run: an
  SFTP server on `ssh2` and an FTP and FTPS server in `test/sandbox/`, which
  can also drop or stall a connection, refuse a rename, answer 421, or list
  hostile names. Their certificates and host keys are generated in memory.
- `test/docker/` runs the same transport contract against real OpenSSH and
  vsftpd containers (`sandbox/compose.yaml`). CI runs it on Linux. To run it
  locally, write a certificate with
  `node test/sandbox/docker-setup.ts sandbox/run/tls`, set `SANDBOX_USER`
  and a generated `SANDBOX_PASSWORD`, run
  `docker compose -f sandbox/compose.yaml up -d --build`, then
  `SANDBOX_DOCKER=1 npm run test:docker`.
- Never commit a private key, certificate or password, even a test one.
  Generate them during the test.
- Terminal UI screens are tested without a terminal: `test/helpers/tui.ts`
  drives an `App` with keys and reads its frames as plain text. Screens whose
  text does not depend on the machine are compared with snapshots in
  `test/unit/tui/snapshots/`. A missing or empty snapshot is written by the
  next local run and fails in CI, so review and commit it with the change.
  After an intended change, rerun with `UPDATE_SNAPSHOTS=1`, or empty the
  file, and review the diff.
- `vendor/kilo/` is the upstream code the terminal layer is ported from,
  byte for byte. A unit test checks it against the checksums in
  `vendor/kilo/VENDORED.md`; `npm run vendor:kilo` fetches the pinned commit
  again and prints the checksums to record.

## Placeholder Data

Documentation, examples, help text, code comments and test fixtures use
generic placeholders only, never a real person, host, site, folder or file
name:

| Kind | Use |
| --- | --- |
| Site names | `My Site`, `Sample App` |
| Organizations | `Acme Corp`, `Contoso` |
| Hosts | `sftp.example.com`, `ftp.example.org` |
| Users and email | `demo-user`, `jane.doe@example.com`; `<user>` in profile paths |
| Windows paths | `C:\Users\<user>\Sites\my-site\` |
| POSIX paths | `~/sites/my-site/` |

Match the placeholder to its context: Windows paths in Windows examples,
POSIX paths in shell examples.

`npm run test:docs` enforces this with a leak scan over the documents, the
docs site, every source and test file, the help output and the workflows. It
fails on an email address outside `example.com`, `example.org` and
`example.net`; a home folder path on Windows, macOS or Linux naming anyone
but `<user>`; and an IPv4 address outside
loopback and the documentation ranges. It also fails on every line of
`.claude/leak-denylist.txt`, a git-ignored file you fill with your own
names, hosts and paths; the test never prints an entry.

## Documentation Site

The site at <https://isocialpractice.github.io/cmd-sync-servers/> is the
static HTML in `docs/` with one stylesheet, published by
`.github/workflows/pages.yml`. There is no build step beyond copying: edit
the pages directly. The command reference in `docs/cli.html` is generated
from the command definitions with `npm run docs:cli`, and `test/docs` fails
when it is out of date. Pages carry a Content-Security-Policy that allows
only their own origin, so they use no scripts, inline styles or third-party
fonts. Every public export needs TSDoc: `npm run docs:api` fails on an
undocumented one.

## Writing Style

- State what the code or the tool does. Changelog lines state the change.
- Use a hyphen, a colon or a new sentence, never an em or en dash.

## Commits and the Changelog

- One logical change per commit, with a message that says what changed.
- Stage files by explicit path. Local working folders (`.claude/`,
  `.support/`, `.archive/`, `.tmp/`) and workspace files are git-ignored and
  never committed.
- Add a line to the newest version, the top section of
  [CHANGELOG.md](CHANGELOG.md), for every user-visible change, under Added,
  Changed, Deprecated, Removed, Fixed or Security. There is no
  `## [Unreleased]` section: work in progress is written into the version
  being worked on. Start a breaking change with **Breaking:** and list it
  first under its heading.

## Versions

Versions follow [Semantic Versioning](https://semver.org/):

| Change | Example |
| --- | --- |
| A fix | `1.0.0` to `1.0.1` |
| A feature that keeps the library API and the sites file compatible | `1.0.1` to `1.1.0` |
| A breaking change to the library API or the sites file | `1.1.0` to `2.0.0` |

Names marked experimental in the API reference are outside this promise and
may change in a minor version. A pre-release for testing carries a suffix,
such as `1.1.0-alpha.0`, and is published under that label rather than as
`latest`. Before `1.0.0`, versions used the pre-release form
`1.0.0-alpha.x.y.z`.

A version bump changes `package.json`, `package-lock.json`, `src/version.ts`
and `CHANGELOG.md` in one commit. A unit test fails when they disagree.

## Releases

A maintainer creates the tag `v<version>` and publishes a GitHub release for
it, marked as a pre-release when the version has a suffix;
`.github/workflows/release.yml` does the rest:

1. `build` checks out `refs/tags/v<version>` and runs
   `node scripts/release-check.ts v<version>`, which fails unless the tag,
   `package.json`, `package-lock.json`, `src/version.ts` and a dated
   `CHANGELOG.md` heading agree. It runs `npm test` and `npm run pack:check`,
   packs the tarball and writes a CycloneDX SBOM with `npm sbom`. It can read
   the repository and nothing more.
2. `attest` attests the tarball and the SBOM with
   `actions/attest-build-provenance`. It runs no code from the repository, so
   nothing it installs can use its signing token.
3. `attach` adds the tarball, the SBOM, the Sigstore bundle and `SHA256SUMS`
   to the release, and fails rather than replace files already there.
4. When the repository variable `NPM_PUBLISH` is `true`, `publish-npm` waits
   for approval in the `npm` environment, checks the tarball's attestation
   against this workflow, and publishes it with npm trusted publishing: a
   stable version as `latest`, a pre-release under its label, such as
   `alpha`. No npm token is stored anywhere.

A failed run can be repeated by hand from the Actions tab with the tag as
input. Builds never run from npm lifecycle scripts: installs use
`--ignore-scripts`, and every step is an explicit command.

## Dependencies

Runtime dependencies are kept to a short list. A pull request that adds one
names the package, its licence and why it is needed. Copyleft licences are
not accepted for runtime dependencies. `package-lock.json` is committed, and
CI installs with `npm ci`.
