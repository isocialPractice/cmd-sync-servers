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
- [x] `site add` takes the server options and `--server-name`; the first
      server is named after its host and becomes the Remote server
  - **Goal**: Resolve to [Phase S2, step 1](.claude/prompts/simplify-setup.prompt.md#phase-s2-guided-setup-in-the-command-line)
  - From: Simplify Site Setup
- [x] The guided flow for `site add`, `server add` and interactive
      `server edit`: Host parsing, connecting through `ServerProbe`, the
      failure menus, sign-in retries, the remote root picker, the
      root-at-top question, saving the password after success, and nothing
      saved on Cancel
  - **Goal**: Resolve to [Phase S2, step 2](.claude/prompts/simplify-setup.prompt.md#phase-s2-guided-setup-in-the-command-line)
  - From: Simplify Site Setup
- [x] `server test` in a terminal repairs what it finds: the sign-in, the
      remote root and the host
  - **Goal**: Resolve to [Phase S2, step 3](.claude/prompts/simplify-setup.prompt.md#phase-s2-guided-setup-in-the-command-line)
  - From: Simplify Site Setup
- [x] `config edit` and `sites.json` errors that name the site, the server
      and the value
  - **Goal**: Resolve to [Phase S2, step 4](.claude/prompts/simplify-setup.prompt.md#phase-s2-guided-setup-in-the-command-line)
  - From: Simplify Site Setup
- [x] The only site used without asking, `~` in paths, the Protocol, Host
      and User labels, and web URLs without a scheme
  - **Goal**: Resolve to [Phase S2, step 5](.claude/prompts/simplify-setup.prompt.md#phase-s2-guided-setup-in-the-command-line)
  - From: Simplify Site Setup
- [x] Tests of the guided setup with scripted answers against the sandbox
  - **Goal**: Resolve to [Phase S2, step 6](.claude/prompts/simplify-setup.prompt.md#phase-s2-guided-setup-in-the-command-line)
  - From: Simplify Site Setup
- [x] Documentation for S2, changelog, checks and commit
  - **Goal**: Resolve to [Phase S2, step 7](.claude/prompts/simplify-setup.prompt.md#phase-s2-guided-setup-in-the-command-line)
  - From: Simplify Site Setup
- [x] The quick setup form on the Sites screen
  - **Goal**: Resolve to [Phase S3, step 1](.claude/prompts/simplify-setup.prompt.md#phase-s3-quick-setup-in-the-terminal-ui)
  - From: Simplify Site Setup
- [x] The server editor: Basic tab order and labels, Test with unsaved
      values, Browse, and Web URL and the trusted certificate on the
      Advanced tab
  - **Goal**: Resolve to [Phase S3, step 2](.claude/prompts/simplify-setup.prompt.md#phase-s3-quick-setup-in-the-terminal-ui)
  - From: Simplify Site Setup
- [x] The folder picker dialog, and the certificate and save-password
      dialogs reviewed against `DESIGN_LANGUAGE.md`
  - **Goal**: Resolve to [Phase S3, step 3](.claude/prompts/simplify-setup.prompt.md#phase-s3-quick-setup-in-the-terminal-ui)
  - From: Simplify Site Setup
- [x] Terminal UI tests of quick setup, the certificate choice, the picker
      and Esc with unsaved changes
  - **Goal**: Resolve to [Phase S3, step 4](.claude/prompts/simplify-setup.prompt.md#phase-s3-quick-setup-in-the-terminal-ui)
  - From: Simplify Site Setup
- [x] Documentation for S3, changelog, checks and commit
  - **Goal**: Resolve to [Phase S3, step 5](.claude/prompts/simplify-setup.prompt.md#phase-s3-quick-setup-in-the-terminal-ui)
  - From: Simplify Site Setup
- [x] One order for a server's folders, names that start with a dot last,
      in the probe and in the FTP and SFTP transports
  - **Goal**: Resolve to [Phase P1, step 1](.claude/prompts/patches-1.0.0-alpha.1.0.0.prompt.md#phase-p1-every-folder-in-the-setup-list)
  - From: Patches 1.0.0-alpha.1.0.0
- [x] The setup folder list without a cap, in columns on a terminal
  - **Goal**: Resolve to [Phase P1, step 2](.claude/prompts/patches-1.0.0-alpha.1.0.0.prompt.md#phase-p1-every-folder-in-the-setup-list)
  - From: Patches 1.0.0-alpha.1.0.0
- [x] Tests of the order, the layout and a crowded account in setup
  - **Goal**: Resolve to [Phase P1, step 3](.claude/prompts/patches-1.0.0-alpha.1.0.0.prompt.md#phase-p1-every-folder-in-the-setup-list)
  - From: Patches 1.0.0-alpha.1.0.0
- [x] Documentation for P1, changelog, checks and commit
  - **Goal**: Resolve to [Phase P1, step 4](.claude/prompts/patches-1.0.0-alpha.1.0.0.prompt.md#phase-p1-every-folder-in-the-setup-list)
  - From: Patches 1.0.0-alpha.1.0.0
- [x] The rule and edge symbols, the scroll edge rows, and each scrolling
      view reporting what it hides
  - **Goal**: Resolve to [Phase P2, step 1](.claude/prompts/patches-1.0.0-alpha.1.0.0.prompt.md#phase-p2-the-terminal-frame-and-the-bottom-menu)
  - From: Patches 1.0.0-alpha.1.0.0
- [x] The wrapping `key = label` menu, eight hints, the message bar as the
      last row, the height rules and the dialog bound
  - **Goal**: Resolve to [Phase P2, step 2](.claude/prompts/patches-1.0.0-alpha.1.0.0.prompt.md#phase-p2-the-terminal-frame-and-the-bottom-menu)
  - From: Patches 1.0.0-alpha.1.0.0
- [x] `q` in the preview, and the preview's hints
  - **Goal**: Resolve to [Phase P2, step 3](.claude/prompts/patches-1.0.0-alpha.1.0.0.prompt.md#phase-p2-the-terminal-frame-and-the-bottom-menu)
  - From: Patches 1.0.0-alpha.1.0.0
- [x] Snapshots and tests of the frame, the menu and `q`
  - **Goal**: Resolve to [Phase P2, step 4](.claude/prompts/patches-1.0.0-alpha.1.0.0.prompt.md#phase-p2-the-terminal-frame-and-the-bottom-menu)
  - From: Patches 1.0.0-alpha.1.0.0
- [x] `DESIGN_LANGUAGE.md`, `docs/cli.html`, changelog, checks and commit
  - **Goal**: Resolve to [Phase P2, step 5](.claude/prompts/patches-1.0.0-alpha.1.0.0.prompt.md#phase-p2-the-terminal-frame-and-the-bottom-menu)
  - From: Patches 1.0.0-alpha.1.0.0
- [x] Global cloaking in the schema, written only when set, and the
      registry's `globalCloaking` and `updateGlobalCloaking`
  - **Goal**: Resolve to [Phase P3, step 1](.claude/prompts/patches-1.0.0-alpha.1.0.0.prompt.md#phase-p3-global-cloaking-patterns)
  - From: Patches 1.0.0-alpha.1.0.0
- [x] Global patterns in `siteCloak` and the session
  - **Goal**: Resolve to [Phase P3, step 2](.claude/prompts/patches-1.0.0-alpha.1.0.0.prompt.md#phase-p3-global-cloaking-patterns)
  - From: Patches 1.0.0-alpha.1.0.0
- [x] `cloak` and `uncloak` with `--global`, `--use-global` and
      `--ignore-global`, the summaries and the JSON
  - **Goal**: Resolve to [Phase P3, step 3](.claude/prompts/patches-1.0.0-alpha.1.0.0.prompt.md#phase-p3-global-cloaking-patterns)
  - From: Patches 1.0.0-alpha.1.0.0
- [x] The Global Cloaking screen, `c` on the Sites screen, and Site Setup's
      Cloaking category
  - **Goal**: Resolve to [Phase P3, step 4](.claude/prompts/patches-1.0.0-alpha.1.0.0.prompt.md#phase-p3-global-cloaking-patterns)
  - From: Patches 1.0.0-alpha.1.0.0
- [x] Tests of global cloaking in the engine, the command line and the
      terminal interface
  - **Goal**: Resolve to [Phase P3, step 5](.claude/prompts/patches-1.0.0-alpha.1.0.0.prompt.md#phase-p3-global-cloaking-patterns)
  - From: Patches 1.0.0-alpha.1.0.0
- [x] Documentation for P3, `npm run docs:cli`, changelog, checks and commit
  - **Goal**: Resolve to [Phase P3, step 6](.claude/prompts/patches-1.0.0-alpha.1.0.0.prompt.md#phase-p3-global-cloaking-patterns)
  - From: Patches 1.0.0-alpha.1.0.0
- [x] The generated option index, `docs:cli` for both pages, and the
      environment variable test
  - **Goal**: Resolve to [Phase P4, step 1](.claude/prompts/patches-1.0.0-alpha.1.0.0.prompt.md#phase-p4-quickstart-examples-cheatsheets-and-options)
  - From: Patches 1.0.0-alpha.1.0.0
- [x] The Quickstart, Examples, Cheatsheets and Options pages
  - **Goal**: Resolve to [Phase P4, step 2](.claude/prompts/patches-1.0.0-alpha.1.0.0.prompt.md#phase-p4-quickstart-examples-cheatsheets-and-options)
  - From: Patches 1.0.0-alpha.1.0.0
- [x] The navigation on every page, the page list in the docs test, and the
      links from the home page and the README
  - **Goal**: Resolve to [Phase P4, step 3](.claude/prompts/patches-1.0.0-alpha.1.0.0.prompt.md#phase-p4-quickstart-examples-cheatsheets-and-options)
  - From: Patches 1.0.0-alpha.1.0.0
- [x] Changelog, checks and commit for P4
  - **Goal**: Resolve to [Phase P4, step 4](.claude/prompts/patches-1.0.0-alpha.1.0.0.prompt.md#phase-p4-quickstart-examples-cheatsheets-and-options)
  - From: Patches 1.0.0-alpha.1.0.0
- [x] Run the engine's and the extension's checks once more from clean
      builds
  - **Goal**: Resolve to [Phase P6, step 1](.claude/prompts/patches-1.0.0-alpha.1.0.0.prompt.md#phase-p6-close-the-plan)
  - From: Patches 1.0.0-alpha.1.0.0
- [x] Bring the plan files up to date; a headless run cannot write under
      `.claude/`
  - **Goal**: Resolve to [Phase P6, step 2](.claude/prompts/patches-1.0.0-alpha.1.0.0.prompt.md#phase-p6-close-the-plan)
  - From: Patches 1.0.0-alpha.1.0.0
- [x] Write `.support/complete-patches.md`, the paste-ready prompt that
      makes the same updates
  - **Goal**: Resolve to [Phase P6, step 3](.claude/prompts/patches-1.0.0-alpha.1.0.0.prompt.md#phase-p6-close-the-plan)
  - From: Patches 1.0.0-alpha.1.0.0
- [x] Check these items and commit
  - **Goal**: Resolve to [Phase P6, step 4](.claude/prompts/patches-1.0.0-alpha.1.0.0.prompt.md#phase-p6-close-the-plan)
  - From: Patches 1.0.0-alpha.1.0.0
- [x] Report what was checked and any owner step that remains
  - **Goal**: Resolve to [Phase P6, step 5](.claude/prompts/patches-1.0.0-alpha.1.0.0.prompt.md#phase-p6-close-the-plan)
  - From: Patches 1.0.0-alpha.1.0.0
- [x] Version `1.0.0-alpha.1.1.0`, its changelog section, and the Symbolic
      Links section of this file
  - **Goal**: Resolve to [Phase L1, step 1](.claude/prompts/symlinks-work.prompt.md#phase-l1-the-setting-the-resolver-and-the-local-scan)
  - From: Symbolic Links
- [x] `follow` for `sync.symlinks`, the `LinkPolicy` type and the generated
      schema
  - **Goal**: Resolve to [Phase L1, step 2](.claude/prompts/symlinks-work.prompt.md#phase-l1-the-setting-the-resolver-and-the-local-scan)
  - From: Symbolic Links
- [x] `resolveLocalTarget` and its exports, with every branch tested
  - **Goal**: Resolve to [Phase L1, step 3](.claude/prompts/symlinks-work.prompt.md#phase-l1-the-setting-the-resolver-and-the-local-scan)
  - From: Symbolic Links
- [x] The local scan under each link policy: files reached through links,
      cycles, cloaking through links and single paths, with their statuses
  - **Goal**: Resolve to [Phase L1, step 4](.claude/prompts/symlinks-work.prompt.md#phase-l1-the-setting-the-resolver-and-the-local-scan)
  - From: Symbolic Links
- [x] Changelog, checks and commit for L1
  - **Goal**: Resolve to [Phase L1, step 5](.claude/prompts/symlinks-work.prompt.md#phase-l1-the-setting-the-resolver-and-the-local-scan)
  - From: Symbolic Links

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

- [x] Run the engine's and the extension's checks once more from clean
      builds
  - **Goal**: Resolve to [Phase S5, step 1](.claude/prompts/simplify-setup.prompt.md#phase-s5-close-the-plan)
- [ ] Bring `init-sync-servers.prompt.md` and this plan's status and
      departures up to date. The closing run could not write under
      `.claude/`; pasting `.support/complete-init.md` does it (User Use Only)
  - **Goal**: Resolve to [Phase S5, step 2](.claude/prompts/simplify-setup.prompt.md#phase-s5-close-the-plan)
- [x] Write `.support/complete-init.md`, the paste-ready prompt that makes
      the same updates
  - **Goal**: Resolve to [Phase S5, step 3](.claude/prompts/simplify-setup.prompt.md#phase-s5-close-the-plan)
- [x] Check these items and commit
  - **Goal**: Resolve to [Phase S5, step 4](.claude/prompts/simplify-setup.prompt.md#phase-s5-close-the-plan)
- [x] Report what was checked and the owner step that remains
  - **Goal**: Resolve to [Phase S5, step 5](.claude/prompts/simplify-setup.prompt.md#phase-s5-close-the-plan)

## Patches 1.0.0-alpha.1.0.0

Next version: none. Every item adds to `1.0.0-alpha.1.0.0`. Phase P5 is
tracked in the extension's `TODO.md`.

All items moved to Current and done.

## Symbolic Links

Next version: minor. Phases L1 to L3 together make `1.0.0-alpha.1.1.0`: L1
sets the version, and L2 and L3 add to it. Phase L4 is tracked in the
extension's `TODO.md`. Phase L5 moves no version.

The items of Phase L1 are in Current.

- [ ] The plan through links: the guard on the real path, the status of
      rows reached through a link out of the site, and the fingerprint
  - **Goal**: Resolve to [Phase L2, step 1](.claude/prompts/symlinks-work.prompt.md#phase-l2-put-get-and-delete-through-links)
- [ ] The executor through links: Put, Get and delete, emptied folders, one
      row at a time per local file, and `Recovery.keepLink`
  - **Goal**: Resolve to [Phase L2, step 2](.claude/prompts/symlinks-work.prompt.md#phase-l2-put-get-and-delete-through-links)
- [ ] `SyncSession.execute` and `compare` through links
  - **Goal**: Resolve to [Phase L2, step 3](.claude/prompts/symlinks-work.prompt.md#phase-l2-put-get-and-delete-through-links)
- [ ] The link scenarios over `local`, `sftp` and `ftps`
  - **Goal**: Resolve to [Phase L2, step 4](.claude/prompts/symlinks-work.prompt.md#phase-l2-put-get-and-delete-through-links)
- [ ] Changelog, checks and commit for L2
  - **Goal**: Resolve to [Phase L2, step 5](.claude/prompts/symlinks-work.prompt.md#phase-l2-put-get-and-delete-through-links)
- [ ] Site Setup's Symbolic links choice, `site edit --symlinks` and the
      Links row of `site show`, with their tests
  - **Goal**: Resolve to [Phase L3, step 1](.claude/prompts/symlinks-work.prompt.md#phase-l3-the-terminal-interface-the-command-line-and-the-documentation)
- [ ] `npm run docs:cli` and the documentation of symbolic links
  - **Goal**: Resolve to [Phase L3, step 2](.claude/prompts/symlinks-work.prompt.md#phase-l3-the-terminal-interface-the-command-line-and-the-documentation)
- [ ] Changelog, checks and commit for L3
  - **Goal**: Resolve to [Phase L3, step 3](.claude/prompts/symlinks-work.prompt.md#phase-l3-the-terminal-interface-the-command-line-and-the-documentation)
- [ ] Run the engine's and the extension's checks once more from clean
      builds
  - **Goal**: Resolve to [Phase L5, step 1](.claude/prompts/symlinks-work.prompt.md#phase-l5-close-the-plan)
- [ ] Bring the plan files up to date; a headless run cannot write under
      `.claude/`
  - **Goal**: Resolve to [Phase L5, step 2](.claude/prompts/symlinks-work.prompt.md#phase-l5-close-the-plan)
- [ ] Write `.support/complete-symlinks.md`, the paste-ready prompt that
      makes the same updates
  - **Goal**: Resolve to [Phase L5, step 3](.claude/prompts/symlinks-work.prompt.md#phase-l5-close-the-plan)
- [ ] Check these items and commit
  - **Goal**: Resolve to [Phase L5, step 4](.claude/prompts/symlinks-work.prompt.md#phase-l5-close-the-plan)
- [ ] Report what was checked and any owner step that remains
  - **Goal**: Resolve to [Phase L5, step 5](.claude/prompts/symlinks-work.prompt.md#phase-l5-close-the-plan)

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

- [x] Open a Claude Code session in this folder and paste the whole of
      `.support/complete-init.md` as the prompt. It brings
      `init-sync-servers.prompt.md` and `simplify-setup.prompt.md` up to date
      with the simplify-setup plan, which automated runs cannot write
- [x] Add `.npmrc` with `ignore-scripts=true`, `engine-strict=true`,
      `save-exact=true` and `fund=false`, one per line, then commit it. The
      loop's permission rules treat `.npmrc` as a sensitive file, so a run
      cannot write it
- [ ] Create the public repository `isocialPractice/cmd-sync-servers` and push
      `main` once Phase E0 is committed
- [ ] After the first push, check that the CI job "Interop with OpenSSH and
      vsftpd (Docker)" passes; it cannot run on the development machine
- [x] Try the full-screen interface by hand at 80 x 24 in Windows Terminal,
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
- [x] Delete `test/unit/zz-probe.test.ts`, an empty file a loop run could not
      remove
- [ ] Approve and create the first public pre-release: tag
      `v1.0.0-alpha.1.0.0` and publish a GitHub pre-release for it;
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
