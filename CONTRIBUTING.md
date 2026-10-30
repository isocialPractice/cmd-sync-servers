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
```

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
| `npm run test:docs` | Documentation checks in `test/docs/` |
| `npm run test:docker` | The interop tests against real OpenSSH and vsftpd containers (see below) |
| `npm run coverage` | Unit and integration tests with coverage, then the coverage bar (below) |
| `npm run sandbox` | Starts local SFTP, FTPS and FTP test servers with throwaway credentials, until Ctrl+C |
| `npm run pack:check` | Builds, then fails if `npm pack` would ship anything outside the `files` allowlist |
| `npm run docs:api` | Generates the API reference into `_site/api/` |

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

## Placeholder Data

Documentation, examples, help text, code comments and test fixtures use
generic placeholders only, never a real person, host, site, folder or file
name:

| Kind | Use |
| --- | --- |
| Site names | `My Site`, `Sample App` |
| Organizations | `Acme Corp`, `Contoso` |
| Hosts | `sftp.example.com`, `ftp.example.org` |
| Users and email | `demo-user`, `jane.doe@example.com` |
| Windows paths | `C:\Users\<user>\Sites\my-site\` |
| POSIX paths | `~/sites/my-site/` |

Match the placeholder to its context: Windows paths in Windows examples,
POSIX paths in shell examples.

## Writing Style

- State what the code or the tool does. Changelog lines state the change.
- Use a hyphen, a colon or a new sentence, never an em or en dash.

## Commits and the Changelog

- One logical change per commit, with a message that says what changed.
- Stage files by explicit path. Local working folders (`.claude/`,
  `.support/`, `.archive/`, `.tmp/`) and workspace files are git-ignored and
  never committed.
- Add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for
  every user-visible change, under Added, Changed, Deprecated, Removed, Fixed
  or Security. Prefix breaking changes with **BREAKING**.

## Versions

Until `1.0.0`, versions use the pre-release form `1.0.0-alpha.x.y.z`:

| Change | Example |
| --- | --- |
| A completed update | `1.0.0-alpha.0.1.0` to `1.0.0-alpha.0.2.0` |
| A fix between updates | `1.0.0-alpha.0.2.0` to `1.0.0-alpha.0.2.1` |
| A breaking change to the library API or the sites file, once an alpha is published | `1.0.0-alpha.0.6.2` to `1.0.0-alpha.1.0.0` |

A version bump changes `package.json`, `package-lock.json`, `src/version.ts`
and `CHANGELOG.md` in one commit. A unit test fails when they disagree.

## Dependencies

Runtime dependencies are kept to a short list. A pull request that adds one
names the package, its licence and why it is needed. Copyleft licences are
not accepted for runtime dependencies. `package-lock.json` is committed, and
CI installs with `npm ci`.
