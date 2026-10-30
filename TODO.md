# TODO - cmd-sync-servers

## Current

The work queued for the next run, moved from the phase sections below. Each
item keeps a nested `From:` line recording the section it came from, so its
origin survives archiving into `## Complete`. Every item's **Goal** links to
the step of the plan that specifies it.

- [x] Initialize the git repository and its ignore rules: a `.gitignore` that
      re-includes `.github/` and `package-lock.json` past the global excludes
      file and ignores the local working folders, plus `.gitattributes` and
      `.editorconfig`
  - **Goal**: Resolve to [Phase E0, step 1](.claude/prompts/init-sync-servers.prompt.md#phase-e0-foundation)
  - From: version.control = null
- [x] Package manifest at `1.0.0-alpha.0.0.0`, TypeScript, ESLint and the
      `node:test` harness, with `sync-servers --version` and `--help` and their
      first tests
  - **Goal**: Resolve to [Phase E0, steps 2 and 3](.claude/prompts/init-sync-servers.prompt.md#phase-e0-foundation)
  - From: version.control = null
- [x] Project documents: `LICENSE` (MIT), the `README.md` front door,
      `CHANGELOG.md` opening at `[1.0.0-alpha.0.0.0]`, `SECURITY.md`,
      `CONTRIBUTING.md`, `THIRD_PARTY_NOTICES.md` and `DESIGN_LANGUAGE.md`
  - **Goal**: Resolve to [Phase E0, step 4](.claude/prompts/init-sync-servers.prompt.md#phase-e0-foundation)
  - From: version.control = null
- [x] CI, CodeQL, dependency review, Scorecard and Dependabot, with every
      action pinned by commit SHA and `permissions: {}` as the default
  - **Goal**: Resolve to [Phase E0, step 5](.claude/prompts/init-sync-servers.prompt.md#phase-e0-foundation)
  - From: version.control = null
- [x] First local commit, staged by explicit path after checking the ignore
      rules with `git status --short --ignored`
  - **Goal**: Resolve to [Phase E0, step 6](.claude/prompts/init-sync-servers.prompt.md#phase-e0-foundation)
  - From: version.control = null
- [x] Per-OS settings and state folders with `SYNC_SERVERS_HOME`, tested with
      injected platform and environment values
  - **Goal**: Resolve to [Phase E1, step 1](.claude/prompts/init-sync-servers.prompt.md#phase-e1-configuration-and-site-registry)
  - From: Phase E1 - Configuration and Site Registry
- [x] The `sites.json` schema in zod, with `schema/site.schema.json`
      generated at build and checked in CI
  - **Goal**: Resolve to [Phase E1, step 2](.claude/prompts/init-sync-servers.prompt.md#phase-e1-configuration-and-site-registry)
  - From: Phase E1 - Configuration and Site Registry
- [x] The site registry: atomic writes with a backup, the lock file,
      unknown-key errors, site resolution order, and the migrations scaffold
  - **Goal**: Resolve to [Phase E1, step 3](.claude/prompts/init-sync-servers.prompt.md#phase-e1-configuration-and-site-registry)
  - From: Phase E1 - Configuration and Site Registry
- [x] Credential stores: environment, prompt and memory, and the OS keyring
      behind its own export, loaded lazily with a clean fallback
  - **Goal**: Resolve to [Phase E1, step 4](.claude/prompts/init-sync-servers.prompt.md#phase-e1-configuration-and-site-registry)
  - From: Phase E1 - Configuration and Site Registry
- [x] The redacting logger, used by every module from here on
  - **Goal**: Resolve to [Phase E1, step 5](.claude/prompts/init-sync-servers.prompt.md#phase-e1-configuration-and-site-registry)
  - From: Phase E1 - Configuration and Site Registry
- [x] Path safety in `sync/paths.ts`, with the exhaustive hostile-name tests
  - **Goal**: Resolve to [Phase E2, step 1](.claude/prompts/init-sync-servers.prompt.md#phase-e2-transports-and-sandbox)
  - From: Phase E2 - Transports and Sandbox
- [x] The transport interface, the `local` transport and the sandbox harness
  - **Goal**: Resolve to [Phase E2, step 2](.claude/prompts/init-sync-servers.prompt.md#phase-e2-transports-and-sandbox)
  - From: Phase E2 - Transports and Sandbox
- [x] The SFTP transport with host key pinning and modern algorithms, and the
      in-process SFTP sandbox with fault injection
  - **Goal**: Resolve to [Phase E2, step 3](.claude/prompts/init-sync-servers.prompt.md#phase-e2-transports-and-sandbox)
  - From: Phase E2 - Transports and Sandbox
- [x] The FTP and FTPS transport with certificate verification and the
      insecure opt-in, and the in-process FTP and FTPS sandbox
  - **Goal**: Resolve to [Phase E2, step 4](.claude/prompts/init-sync-servers.prompt.md#phase-e2-transports-and-sandbox)
  - From: Phase E2 - Transports and Sandbox
- [x] Connection pool, retries and timeouts, and `server test`
  - **Goal**: Resolve to [Phase E2, step 5](.claude/prompts/init-sync-servers.prompt.md#phase-e2-transports-and-sandbox)
  - From: Phase E2 - Transports and Sandbox
- [x] Local and remote scanners with cloaking, the sensitive-file guard, the
      symbolic link policy and the scan cache
  - **Goal**: Resolve to [Phase E3, step 1](.claude/prompts/init-sync-servers.prompt.md#phase-e3-sync-engine)
  - From: Phase E3 - Sync Engine
- [x] Sync records and the classification matrix, as table-driven tests of
      every state, direction and delete option
  - **Goal**: Resolve to [Phase E3, step 2](.claude/prompts/init-sync-servers.prompt.md#phase-e3-sync-engine)
  - From: Phase E3 - Sync Engine
- [x] The sync plan model with its fingerprint, and the empty-root and
      mass-delete guards
  - **Goal**: Resolve to [Phase E3, step 3](.claude/prompts/init-sync-servers.prompt.md#phase-e3-sync-engine)
  - From: Phase E3 - Sync Engine
- [x] The executor and the recovery folder: stale re-checks, atomic
      transfers, times, ordering, retries and cancellation
  - **Goal**: Resolve to [Phase E3, step 4](.claude/prompts/init-sync-servers.prompt.md#phase-e3-sync-engine)
  - From: Phase E3 - Sync Engine
- [x] `SyncSession` and the public library API
  - **Goal**: Resolve to [Phase E3, step 5](.claude/prompts/init-sync-servers.prompt.md#phase-e3-sync-engine)
  - From: Phase E3 - Sync Engine
- [x] Vendor kilo at a pinned commit with `VENDORED.md`, the checksum test and
      the BSD-2-Clause notice
  - **Goal**: Resolve to [Phase E4, step 1](.claude/prompts/init-sync-servers.prompt.md#phase-e4-terminal-ui-and-editor-mode)
  - From: Phase E4 - Terminal UI and Editor Mode
- [x] Port kilo's terminal layer and editing core into `src/tui/`, restoring
      the terminal on every exit path
  - **Goal**: Resolve to [Phase E4, step 2](.claude/prompts/init-sync-servers.prompt.md#phase-e4-terminal-ui-and-editor-mode)
  - From: Phase E4 - Terminal UI and Editor Mode
- [x] TUI widgets with ASCII and `NO_COLOR` modes and frame snapshot tests
  - **Goal**: Resolve to [Phase E4, step 3](.claude/prompts/init-sync-servers.prompt.md#phase-e4-terminal-ui-and-editor-mode)
  - From: Phase E4 - Terminal UI and Editor Mode
- [x] Sites, site home, site setup, server editor and cloaking screens
  - **Goal**: Resolve to [Phase E4, step 4](.claude/prompts/init-sync-servers.prompt.md#phase-e4-terminal-ui-and-editor-mode)
  - From: Phase E4 - Terminal UI and Editor Mode
- [x] Synchronize, preview, progress and results screens
  - **Goal**: Resolve to [Phase E4, step 5](.claude/prompts/init-sync-servers.prompt.md#phase-e4-terminal-ui-and-editor-mode)
  - From: Phase E4 - Terminal UI and Editor Mode
- [x] Review the public API surface and mark anything unsettled
      `@experimental`
  - **Goal**: Resolve to [Phase E5, step 1](.claude/prompts/init-sync-servers.prompt.md#phase-e5-library-api-and-documentation)
  - From: Phase E5 - Library API and Documentation
- [x] TypeDoc reference generated by `npm run docs:api`, never committed
  - **Goal**: Resolve to [Phase E5, step 2](.claude/prompts/init-sync-servers.prompt.md#phase-e5-library-api-and-documentation)
  - From: Phase E5 - Library API and Documentation
- [x] The docs site with placeholder data throughout, and `test/docs` with
      the leak scan
  - **Goal**: Resolve to [Phase E5, step 3](.claude/prompts/init-sync-servers.prompt.md#phase-e5-library-api-and-documentation)
  - From: Phase E5 - Library API and Documentation
- [x] `release.yml` with the tag, version and changelog checks, SBOM,
      checksums and attestations on the GitHub pre-release
  - **Goal**: Resolve to [Phase E6, step 1](.claude/prompts/init-sync-servers.prompt.md#phase-e6-release-pipeline-and-first-public-alpha)
  - From: Phase E6 - Release Pipeline and First Public Alpha
- [x] The gated `publish-npm` job with trusted publishing and `--tag alpha`
  - **Goal**: Resolve to [Phase E6, step 2](.claude/prompts/init-sync-servers.prompt.md#phase-e6-release-pipeline-and-first-public-alpha)
  - From: Phase E6 - Release Pipeline and First Public Alpha
- [x] A full security pass against the threat model, with every finding fixed
      and the checks recorded in `docs/security.html`
  - **Goal**: Resolve to [Phase E6, step 3](.claude/prompts/init-sync-servers.prompt.md#phase-e6-release-pipeline-and-first-public-alpha)
  - From: Phase E6 - Release Pipeline and First Public Alpha
- [x] Resolve the Scorecard findings that are in the repository's control
  - **Goal**: Resolve to [Phase E6, step 4](.claude/prompts/init-sync-servers.prompt.md#phase-e6-release-pipeline-and-first-public-alpha)
  - From: Phase E6 - Release Pipeline and First Public Alpha
- [x] `parseServerAddress` for the Host field, and a `host` in `sites.json`
      that holds the host alone
  - **Goal**: Resolve to [Phase S1, step 1](.claude/prompts/simplify-setup.prompt.md#phase-s1-connections-that-explain-themselves)
  - From: Simplify Site Setup
- [x] Certificate inspection and decisions in the FTPS transport: covered
      names, `use-host`, `check-as`, pins checked before credentials,
      `changed`, never-trusted expired certificates, and the data-connection
      rule, with the sandbox's test authority and data certificate
  - **Goal**: Resolve to [Phase S1, step 2](.claude/prompts/simplify-setup.prompt.md#phase-s1-connections-that-explain-themselves)
  - From: Simplify Site Setup
- [x] The starting folder for FTP and SFTP, and `E_REMOTE_ROOT` naming it and
      what it holds
  - **Goal**: Resolve to [Phase S1, step 3](.claude/prompts/simplify-setup.prompt.md#phase-s1-connections-that-explain-themselves)
  - From: Simplify Site Setup
- [x] `ServerProbe`, with integration tests on every sandbox protocol
  - **Goal**: Resolve to [Phase S1, step 4](.claude/prompts/simplify-setup.prompt.md#phase-s1-connections-that-explain-themselves)
  - From: Simplify Site Setup
- [x] Sign-in and network messages: the 530 and SFTP text, `E_AUTH`
      reasons, `SecretRequest.note`, `secretAccepted` and the new
      `secretQuestion`
  - **Goal**: Resolve to [Phase S1, step 5](.claude/prompts/simplify-setup.prompt.md#phase-s1-connections-that-explain-themselves)
  - From: Simplify Site Setup
- [x] The CLI and TUI adapters, `--trust-certificate`, `--forget-certificate`,
      and the starting folder and banner in `server test`
  - **Goal**: Resolve to [Phase S1, step 6](.claude/prompts/simplify-setup.prompt.md#phase-s1-connections-that-explain-themselves)
  - From: Simplify Site Setup
- [x] Documentation for S1, the extension's `TODO.md` item, the version
      `1.0.0-alpha.1.0.0` and the changelog without `## [Unreleased]`
  - **Goal**: Resolve to [Phase S1, step 7](.claude/prompts/simplify-setup.prompt.md#phase-s1-connections-that-explain-themselves)
  - From: Simplify Site Setup

## Phase E1 - Configuration and Site Registry

Next version: minor.

- [x] Site, server, password and cloak commands, `config path` and a first
      `doctor`, with `--editor` JSON editing
  - **Goal**: Resolve to [Phase E1, step 6](.claude/prompts/init-sync-servers.prompt.md#phase-e1-configuration-and-site-registry)
- [x] Shell integration: `shell-init` for bash, zsh, fish, pwsh and cmd, and
      `--cd-file`
  - **Goal**: Resolve to [Phase E1, step 7](.claude/prompts/init-sync-servers.prompt.md#phase-e1-configuration-and-site-registry)

## Phase E2 - Transports and Sandbox

Next version: minor.

- [x] The Docker interop sandbox, its Linux CI job, and `npm run sandbox`
  - **Goal**: Resolve to [Phase E2, step 6](.claude/prompts/init-sync-servers.prompt.md#phase-e2-transports-and-sandbox)

## Phase E3 - Sync Engine

Next version: minor.

- [x] The `sync`, `status`, `put`, `get`, `mark-synced`, `state reset` and
      `diff` commands, unattended and with `--json`
  - **Goal**: Resolve to [Phase E3, step 6](.claude/prompts/init-sync-servers.prompt.md#phase-e3-sync-engine)
- [x] The scenario suite across the `local`, SFTP and FTPS sandboxes, ending
      with the search for the password in every output
  - **Goal**: Resolve to [Phase E3, step 7](.claude/prompts/init-sync-servers.prompt.md#phase-e3-sync-engine)

## Phase E4 - Terminal UI and Editor Mode

Next version: minor.

- [x] Editor mode and plain mode
  - **Goal**: Resolve to [Phase E4, step 6](.claude/prompts/init-sync-servers.prompt.md#phase-e4-terminal-ui-and-editor-mode)
- [x] Complete `DESIGN_LANGUAGE.md` with the final screens
  - **Goal**: Resolve to [Phase E4, step 7](.claude/prompts/init-sync-servers.prompt.md#phase-e4-terminal-ui-and-editor-mode)

## Phase E5 - Library API and Documentation

Next version: minor.

- [x] The `pages.yml` workflow deploying the site through GitHub Actions
  - **Goal**: Resolve to [Phase E5, step 4](.claude/prompts/init-sync-servers.prompt.md#phase-e5-library-api-and-documentation)
- [x] Reduce `README.md` to the front door, under 300 lines, linking to the
      site
  - **Goal**: Resolve to [Phase E5, step 5](.claude/prompts/init-sync-servers.prompt.md#phase-e5-library-api-and-documentation)

## Phase E6 - Release Pipeline and First Public Alpha

Next version: minor.

All items moved to Current and done. The first public alpha waits on the
owner steps under User Use Only.

## Simplify Site Setup

Next version: major. Phases S1 to S3 together make `1.0.0-alpha.1.0.0`:
S1 sets the version, and S2 and S3 add to it without moving it again. The
items of Phase S5 move no version.

- [ ] `site add` takes the server options and `--server-name`; the first
      server is named after its host and becomes the Remote server
  - **Goal**: Resolve to [Phase S2, step 1](.claude/prompts/simplify-setup.prompt.md#phase-s2-guided-setup-in-the-command-line)
- [ ] The guided flow for `site add`, `server add` and interactive
      `server edit`: Host parsing, connecting through `ServerProbe`, the
      failure menus, sign-in retries, the remote root picker, the
      root-at-top question, saving the password after success, and nothing
      saved on Cancel
  - **Goal**: Resolve to [Phase S2, step 2](.claude/prompts/simplify-setup.prompt.md#phase-s2-guided-setup-in-the-command-line)
- [ ] `server test` in a terminal repairs what it finds: the sign-in, the
      remote root and the host
  - **Goal**: Resolve to [Phase S2, step 3](.claude/prompts/simplify-setup.prompt.md#phase-s2-guided-setup-in-the-command-line)
- [ ] `config edit` and `sites.json` errors that name the site, the server
      and the value
  - **Goal**: Resolve to [Phase S2, step 4](.claude/prompts/simplify-setup.prompt.md#phase-s2-guided-setup-in-the-command-line)
- [ ] The only site used without asking, `~` in paths, the Protocol, Host
      and User labels, and web URLs without a scheme
  - **Goal**: Resolve to [Phase S2, step 5](.claude/prompts/simplify-setup.prompt.md#phase-s2-guided-setup-in-the-command-line)
- [ ] Tests of the guided setup with scripted answers against the sandbox
  - **Goal**: Resolve to [Phase S2, step 6](.claude/prompts/simplify-setup.prompt.md#phase-s2-guided-setup-in-the-command-line)
- [ ] Documentation for S2, changelog, checks and commit
  - **Goal**: Resolve to [Phase S2, step 7](.claude/prompts/simplify-setup.prompt.md#phase-s2-guided-setup-in-the-command-line)
- [ ] The quick setup form on the Sites screen
  - **Goal**: Resolve to [Phase S3, step 1](.claude/prompts/simplify-setup.prompt.md#phase-s3-quick-setup-in-the-terminal-ui)
- [ ] The server editor: Basic tab order and labels, Test with unsaved
      values, Browse, and Web URL and the trusted certificate on the
      Advanced tab
  - **Goal**: Resolve to [Phase S3, step 2](.claude/prompts/simplify-setup.prompt.md#phase-s3-quick-setup-in-the-terminal-ui)
- [ ] The folder picker dialog, and the certificate and save-password
      dialogs reviewed against `DESIGN_LANGUAGE.md`
  - **Goal**: Resolve to [Phase S3, step 3](.claude/prompts/simplify-setup.prompt.md#phase-s3-quick-setup-in-the-terminal-ui)
- [ ] Terminal UI tests of quick setup, the certificate choice, the picker
      and Esc with unsaved changes
  - **Goal**: Resolve to [Phase S3, step 4](.claude/prompts/simplify-setup.prompt.md#phase-s3-quick-setup-in-the-terminal-ui)
- [ ] Documentation for S3, changelog, checks and commit
  - **Goal**: Resolve to [Phase S3, step 5](.claude/prompts/simplify-setup.prompt.md#phase-s3-quick-setup-in-the-terminal-ui)
- [ ] Run the engine's and the extension's checks once more from clean
      builds
  - **Goal**: Resolve to [Phase S5, step 1](.claude/prompts/simplify-setup.prompt.md#phase-s5-close-the-plan)
- [ ] Bring `init-sync-servers.prompt.md` and this plan's status and
      departures up to date
  - **Goal**: Resolve to [Phase S5, step 2](.claude/prompts/simplify-setup.prompt.md#phase-s5-close-the-plan)
- [ ] Write `.support/complete-init.md`, the paste-ready prompt that makes
      the same updates
  - **Goal**: Resolve to [Phase S5, step 3](.claude/prompts/simplify-setup.prompt.md#phase-s5-close-the-plan)
- [ ] Check these items and commit
  - **Goal**: Resolve to [Phase S5, step 4](.claude/prompts/simplify-setup.prompt.md#phase-s5-close-the-plan)
- [ ] Report what was checked and the owner step that remains
  - **Goal**: Resolve to [Phase S5, step 5](.claude/prompts/simplify-setup.prompt.md#phase-s5-close-the-plan)

## Later Roadmap - paused

Waits until both alphas are public; each item then becomes its own section.
Remove `- paused` from this heading to resume.

- [ ] Import Dreamweaver site definitions (`.ste`), never their passwords
  - **Goal**: Resolve to [Later roadmap, item 1](.claude/prompts/init-sync-servers.prompt.md#17-later-roadmap)
- [ ] Checksum comparison
  - **Goal**: Resolve to [Later roadmap, item 2](.claude/prompts/init-sync-servers.prompt.md#17-later-roadmap)
- [ ] File check-out and check-in compatible with Dreamweaver's `.LCK` files
  - **Goal**: Resolve to [Later roadmap, item 3](.claude/prompts/init-sync-servers.prompt.md#17-later-roadmap)
- [ ] `recovery list` and `recovery restore`
  - **Goal**: Resolve to [Later roadmap, item 4](.claude/prompts/init-sync-servers.prompt.md#17-later-roadmap)
- [ ] Resumable transfers
  - **Goal**: Resolve to [Later roadmap, item 5](.claude/prompts/init-sync-servers.prompt.md#17-later-roadmap)
- [ ] WebDAV transport
  - **Goal**: Resolve to [Later roadmap, item 6](.claude/prompts/init-sync-servers.prompt.md#17-later-roadmap)
- [ ] `sync-servers watch`
  - **Goal**: Resolve to [Later roadmap, item 7](.claude/prompts/init-sync-servers.prompt.md#17-later-roadmap)
- [ ] Bandwidth limit per server
  - **Goal**: Resolve to [Later roadmap, item 8](.claude/prompts/init-sync-servers.prompt.md#17-later-roadmap)
- [ ] `1.0.0`: API and schema frozen, npm `latest`, the alpha suffix dropped
  - **Goal**: Resolve to [Later roadmap, item 10](.claude/prompts/init-sync-servers.prompt.md#17-later-roadmap)

## User Use Only

Steps only the owner takes, because each changes state outside this machine
or needs a person at a real terminal.

- [ ] Add `.npmrc` with `ignore-scripts=true`, `engine-strict=true`,
      `save-exact=true` and `fund=false`, one per line, then commit it. The
      loop's permission rules treat `.npmrc` as a sensitive file, so a run
      cannot write it
- [ ] Create the public repository `isocialPractice/cmd-sync-servers` and push
      `main` once Phase E0 is committed
- [ ] After the first push, check that the CI job "Interop with OpenSSH and
      vsftpd (Docker)" passes; it cannot run on the development machine
- [ ] Try the full-screen interface by hand at 80 x 24 in Windows Terminal,
      the classic Windows console, macOS Terminal and a Linux terminal; the
      tests drive it through a simulated terminal only
- [ ] Apply the repository and account settings of plan section 11.7
- [ ] Select "GitHub Actions" as the Pages source if the first `pages.yml`
      run cannot enable Pages itself
- [ ] Create the `isocialpractice` npm organization, the trusted publisher
      (workflow `release.yml`, and require the environment `npm` there so no
      other job can publish) and the GitHub `npm` environment with yourself as
      required reviewer, then set the repository variable `NPM_PUBLISH` to
      `true` when ready. If npm needs the package to exist first, publish the
      first alpha from your machine with 2FA
- [ ] Delete `test/unit/zz-probe.test.ts`, an empty file a loop run could not
      remove
- [ ] Approve and create the first public pre-release: tag
      `v1.0.0-alpha.0.6.0` and publish a GitHub pre-release for it;
      `release.yml` builds, attests and attaches the files. Then check
      `gh attestation verify` on the attached tarball
- [ ] For Scorecard, outside the repository's files: enable branch and tag
      rulesets (section 11.7) and register for the OpenSSF Best Practices
      badge; fuzzing is not set up
- [ ] Fill the git-ignored `.claude/leak-denylist.txt` with personal names,
      hosts and paths for the docs leak scan, including the host names,
      account name, domains and IP address of the server first set up by
      hand, and copy it to `vscode-sync-servers/.claude/leak-denylist.txt`,
      where the extension's leak scan looks
