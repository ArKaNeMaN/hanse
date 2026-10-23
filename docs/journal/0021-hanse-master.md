# 0020 - Hanse master agent

- Date: 2026-10-23
- Stage: `0018-hanse-master`
- Status: implemented, verified, merged to `main` after the skill-bundles stage
- Design: [`docs/design/hanse-master.md`](../design/hanse-master.md)
- Plan: [`docs/plans/0018-hanse-master.md`](../plans/0018-hanse-master.md)

## Why

Hanse is configured through forms, manifests, and chat windows. An operator who wants to stand up a
project, add applications, write their contracts, change a model, and restart an agent has to move
between all three. The product had no assistant that understands Hanse itself.

The master agent turns the coordinator's API and workspace into a conversational surface without
giving a model raw access to the workspace, the database, or credentials.

## What changed

- **Reserved identity.** `ensureMasterAgent` creates project `hanse-master` and application
  `master` (`hanse-master:master`) idempotently after project discovery. The app directory is
  `<workspace>/.hanse-master`; the row uses `path = "."`, `kind = 'master'`, and the default image.
  Bootstrap refuses symlinked/escaping directories, writes `AGENTS.md` through an
  `O_EXCL | O_NOFOLLOW` temp + rename, clears stale deletion markers, removes stale extra apps
  under the reserved project, and asserts canonical path identity before committing.
- **Isolation.** A new optional `appDirReadOnly` runtime-spec field mounts the master app directory
  `:ro` in the B1 runner while its state directory stays read-write. `ManagedApp` gained optional
  `instructions` and `gitCredentials`; the master gets explicit opencode instructions and no
  materialized git credentials. Model provider auth still reaches its own `auth.json`.
- **MCP allowlist.** `/internal/mcp` dispatches a separate master tool set when the token resolves
  to `hanse-master:master`: `list_projects`, `get_app`, `get_settings`, `set_setting`,
  `inherit_setting`, `create_project`, `add_app`, `start_app`, `restart_app`, `list_dir`,
  `read_file`, `write_file`. SSH and handoff tools are `unknown_tool`; there is no fall-through.
  Failures are `{ok:false, code, message}` text content.
- **Contained file tools.** Realpath/symlink containment, `O_NOFOLLOW` open, fd `fstat`, bounded
  reads/writes (256 KiB decoded UTF-8), 500-entry listings, UTF-8/NUL checks, atomic same-directory
  renames, and denials for `.git`, Hanse manifests, and the master `AGENTS.md`. Writes are audited as
  `events` rows with `scope = 'master'`, path/size only.
- **Shared provisioning.** Project/app creation moved into `src/coordinator/provision.ts` and is used
  by both the web forms and the master. It refuses the reserved directory/id and root equality,
  validates single-segment project directories and app keys, rejects symlinked `.hanse` subtrees,
  writes manifests through the safe-write discipline, serializes names with YAML, validates clone
  remotes, uses `--`, clones to a temp directory and renames, and cleans up on failure. Deletion
  reservations are honored when a `DeletionService` is supplied.
- **Settings and lifecycle.** Settings tools accept only the seven registry keys, validate the target
  scope, and report pending restarts. `start_app`/`restart_app` precheck deletion markers and refuse
  the master itself. Errors map to `deletion_pending`, `restart_in_progress`,
  `deployment_in_progress`, and `unavailable`.
- **Web UI.** A **Master** sidebar entry opens its chat. `buildSite` gained an optional `builtin`
  marker and an `operatorProjects` projection; counters, the overview ledger, the project index, the
  sidebar project list, `/api/projects`, and `/chat` selection exclude the master. Direct master
  project/app/settings/skills URLs still resolve with a reduced master page (no git workbench,
  image panel, manifest card, add-app/new-handoff controls, or danger zone). Settings and skills
  scope pickers keep listing the master so it can be configured.
- **Safety.** Deletion is refused in `DeletionService` and in `handleDeletion` (before the
  unconfigured-return), even without a runner. `registerProject` refuses the reserved project id and
  app paths inside the master directory; `discoverProjectDirs` skips it.
- **Transport.** `/internal/mcp` accepts up to 1 MiB so a maximum `write_file` plus JSON escaping
  fits; every other route keeps its limit.

## Decisions

- The master is a reserved application, not a new entity: it reuses the runner spec, token, settings,
  skills, OMO, context, and restart pipeline with no second lifecycle.
- The master's workspace access is coordinator-mediated MCP, not a workspace bind mount. This keeps
  one audited, path-confined choke point.
- The container mounts the master directory read-only, so prompt-injected native tools cannot persist
  new instructions; the tool-level denial is a second layer.
- Master-side skill creation/editing, provider-key/git-credential entry, deletion, git operations,
  and image builds are deferred. Skills use the existing scope pages.
- The master stays visible in settings/skills scope pickers by design; it is hidden only from
  operator project views.

## Verification

- `npm run typecheck` - clean.
- `npm run lint` - clean.
- `npm test` - 103 files, 1,624 tests passed.
- `npm run build` - clean (tsc + Tailwind).
- `npm run check:sensitive` - passed.
- New coverage: bootstrap idempotence/symlink refusal/reserved registration; workspace containment
  matrix; provisioning (reserved paths, remotes, clone cleanup, symlinked `.hanse`, deletion
  guards); tool authorization, settings, lifecycle, audit; HTTP hiding/nav/chat selection/reduced
  pages/deletion refusal; read-only spec hashing, instructions overlay, and no git credentials.

## Accepted debt

- No master-side deletion, file removal/move, git, image build, skill editing, or secret entry.
- Manifest changes are limited to `create_project`/`add_app`; renaming projects, removing apps, and
  changing base branches remain UI/manifest work.
- A changed master `AGENTS.md` needs an explicit master restart; instructions are not in the settings
  hash.
- Text only, 256 KiB per read/write, 500-entry listings; no binary inspection.
- The master can read workspace content that itself contains secrets and can send it to its
  configured provider/web tools. SSH/handoff tools are denied and no git credentials are
  materialized; this is accepted operator-controlled-assistant risk.
- B0 (internal compatibility host) does not enforce the read-only app directory.
- The SSH grant picker may list the master; grants are inert because `ssh_*` is not in its tool set.
- No live deployment or real-agent QA was performed in this stage; the full gate is the verification
  above.
