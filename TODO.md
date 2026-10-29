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
- [ ] Path safety in `sync/paths.ts`, with the exhaustive hostile-name tests
  - **Goal**: Resolve to [Phase E2, step 1](.claude/prompts/init-sync-servers.prompt.md#phase-e2-transports-and-sandbox)
  - From: Phase E2 - Transports and Sandbox
- [ ] The transport interface, the `local` transport and the sandbox harness
  - **Goal**: Resolve to [Phase E2, step 2](.claude/prompts/init-sync-servers.prompt.md#phase-e2-transports-and-sandbox)
  - From: Phase E2 - Transports and Sandbox
- [ ] The SFTP transport with host key pinning and modern algorithms, and the
      in-process SFTP sandbox with fault injection
  - **Goal**: Resolve to [Phase E2, step 3](.claude/prompts/init-sync-servers.prompt.md#phase-e2-transports-and-sandbox)
  - From: Phase E2 - Transports and Sandbox
- [ ] The FTP and FTPS transport with certificate verification and the
      insecure opt-in, and the in-process FTP and FTPS sandbox
  - **Goal**: Resolve to [Phase E2, step 4](.claude/prompts/init-sync-servers.prompt.md#phase-e2-transports-and-sandbox)
  - From: Phase E2 - Transports and Sandbox
- [ ] Connection pool, retries and timeouts, and `server test`
  - **Goal**: Resolve to [Phase E2, step 5](.claude/prompts/init-sync-servers.prompt.md#phase-e2-transports-and-sandbox)
  - From: Phase E2 - Transports and Sandbox

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

- [ ] The Docker interop sandbox, its Linux CI job, and `npm run sandbox`
  - **Goal**: Resolve to [Phase E2, step 6](.claude/prompts/init-sync-servers.prompt.md#phase-e2-transports-and-sandbox)

## Phase E3 - Sync Engine

Next version: minor.

- [ ] Local and remote scanners with cloaking, the sensitive-file guard, the
      symbolic link policy and the scan cache
  - **Goal**: Resolve to [Phase E3, step 1](.claude/prompts/init-sync-servers.prompt.md#phase-e3-sync-engine)
- [ ] Sync records and the classification matrix, as table-driven tests of
      every state, direction and delete option
  - **Goal**: Resolve to [Phase E3, step 2](.claude/prompts/init-sync-servers.prompt.md#phase-e3-sync-engine)
- [ ] The sync plan model with its fingerprint, and the empty-root and
      mass-delete guards
  - **Goal**: Resolve to [Phase E3, step 3](.claude/prompts/init-sync-servers.prompt.md#phase-e3-sync-engine)
- [ ] The executor and the recovery folder: stale re-checks, atomic
      transfers, times, ordering, retries and cancellation
  - **Goal**: Resolve to [Phase E3, step 4](.claude/prompts/init-sync-servers.prompt.md#phase-e3-sync-engine)
- [ ] `SyncSession` and the public library API
  - **Goal**: Resolve to [Phase E3, step 5](.claude/prompts/init-sync-servers.prompt.md#phase-e3-sync-engine)
- [ ] The `sync`, `status`, `put`, `get`, `mark-synced`, `state reset` and
      `diff` commands, unattended and with `--json`
  - **Goal**: Resolve to [Phase E3, step 6](.claude/prompts/init-sync-servers.prompt.md#phase-e3-sync-engine)
- [ ] The scenario suite across the `local`, SFTP and FTPS sandboxes, ending
      with the search for the password in every output
  - **Goal**: Resolve to [Phase E3, step 7](.claude/prompts/init-sync-servers.prompt.md#phase-e3-sync-engine)

## Phase E4 - Terminal UI and Editor Mode

Next version: minor.

- [ ] Vendor kilo at a pinned commit with `VENDORED.md`, the checksum test and
      the BSD-2-Clause notice
  - **Goal**: Resolve to [Phase E4, step 1](.claude/prompts/init-sync-servers.prompt.md#phase-e4-terminal-ui-and-editor-mode)
- [ ] Port kilo's terminal layer and editing core into `src/tui/`, restoring
      the terminal on every exit path
  - **Goal**: Resolve to [Phase E4, step 2](.claude/prompts/init-sync-servers.prompt.md#phase-e4-terminal-ui-and-editor-mode)
- [ ] TUI widgets with ASCII and `NO_COLOR` modes and frame snapshot tests
  - **Goal**: Resolve to [Phase E4, step 3](.claude/prompts/init-sync-servers.prompt.md#phase-e4-terminal-ui-and-editor-mode)
- [ ] Sites, site home, site setup, server editor and cloaking screens
  - **Goal**: Resolve to [Phase E4, step 4](.claude/prompts/init-sync-servers.prompt.md#phase-e4-terminal-ui-and-editor-mode)
- [ ] Synchronize, preview, progress and results screens
  - **Goal**: Resolve to [Phase E4, step 5](.claude/prompts/init-sync-servers.prompt.md#phase-e4-terminal-ui-and-editor-mode)
- [ ] Editor mode and plain mode
  - **Goal**: Resolve to [Phase E4, step 6](.claude/prompts/init-sync-servers.prompt.md#phase-e4-terminal-ui-and-editor-mode)
- [ ] Complete `DESIGN_LANGUAGE.md` with the final screens
  - **Goal**: Resolve to [Phase E4, step 7](.claude/prompts/init-sync-servers.prompt.md#phase-e4-terminal-ui-and-editor-mode)

## Phase E5 - Library API and Documentation

Next version: minor.

- [ ] Review the public API surface and mark anything unsettled
      `@experimental`
  - **Goal**: Resolve to [Phase E5, step 1](.claude/prompts/init-sync-servers.prompt.md#phase-e5-library-api-and-documentation)
- [ ] TypeDoc reference generated by `npm run docs:api`, never committed
  - **Goal**: Resolve to [Phase E5, step 2](.claude/prompts/init-sync-servers.prompt.md#phase-e5-library-api-and-documentation)
- [ ] The docs site with placeholder data throughout, and `test/docs` with
      the leak scan
  - **Goal**: Resolve to [Phase E5, step 3](.claude/prompts/init-sync-servers.prompt.md#phase-e5-library-api-and-documentation)
- [ ] The `pages.yml` workflow deploying the site through GitHub Actions
  - **Goal**: Resolve to [Phase E5, step 4](.claude/prompts/init-sync-servers.prompt.md#phase-e5-library-api-and-documentation)
- [ ] Reduce `README.md` to the front door, under 300 lines, linking to the
      site
  - **Goal**: Resolve to [Phase E5, step 5](.claude/prompts/init-sync-servers.prompt.md#phase-e5-library-api-and-documentation)

## Phase E6 - Release Pipeline and First Public Alpha

Next version: minor.

- [ ] `release.yml` with the tag, version and changelog checks, SBOM,
      checksums and attestations on the GitHub pre-release
  - **Goal**: Resolve to [Phase E6, step 1](.claude/prompts/init-sync-servers.prompt.md#phase-e6-release-pipeline-and-first-public-alpha)
- [ ] The gated `publish-npm` job with trusted publishing and `--tag alpha`
  - **Goal**: Resolve to [Phase E6, step 2](.claude/prompts/init-sync-servers.prompt.md#phase-e6-release-pipeline-and-first-public-alpha)
- [ ] A full security pass against the threat model, with every finding fixed
      and the checks recorded in `docs/security.html`
  - **Goal**: Resolve to [Phase E6, step 3](.claude/prompts/init-sync-servers.prompt.md#phase-e6-release-pipeline-and-first-public-alpha)
- [ ] Resolve the Scorecard findings that are in the repository's control
  - **Goal**: Resolve to [Phase E6, step 4](.claude/prompts/init-sync-servers.prompt.md#phase-e6-release-pipeline-and-first-public-alpha)

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

Steps only the owner takes, because each changes state outside this machine.

- [ ] Add `.npmrc` with `ignore-scripts=true`, `engine-strict=true`,
      `save-exact=true` and `fund=false`, one per line, then commit it. The
      loop's permission rules treat `.npmrc` as a sensitive file, so a run
      cannot write it
- [ ] Create the public repository `isocialPractice/cmd-sync-servers` and push
      `main` once Phase E0 is committed
- [ ] Apply the repository and account settings of plan section 11.7
- [ ] Select "GitHub Actions" as the Pages source if the first `pages.yml`
      run cannot enable Pages itself
- [ ] Create the `isocialpractice` npm organization, the trusted publisher and
      the `npm` environment, then set `NPM_PUBLISH` to `true` when ready
- [ ] Approve and create the first public pre-release
- [ ] Fill the git-ignored `.claude/leak-denylist.txt` with personal names,
      hosts and paths for the docs leak scan
