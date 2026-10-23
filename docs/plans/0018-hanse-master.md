# Plan 0020: Hanse master agent

- Status: implemented and verified; plan review PASS (`momus`); design review PASS after three rounds (`oracle`)
- Design: [`docs/design/hanse-master.md`](../design/hanse-master.md)
- Design reviewer: `oracle`
- Plan reviewer: `momus`
- Owner decisions: autonomous mode; decisions recorded in the design and this plan
- Date: 2026-10-23

## Delivery bindings

| Binding | Value |
| --- | --- |
| Stage | `0018-hanse-master` |
| Design artifact | `docs/design/hanse-master.md` |
| Plan artifact | `docs/plans/0018-hanse-master.md` |
| Design index | `docs/design/README.md` |
| Plan index | `docs/plans/README.md` |
| Journal | `docs/journal/0021-hanse-master.md`; index `docs/journal/README.md` |
| Decision record | none; the design records the reserved-identity decision |
| Open questions | none; deferred items listed in the design section 12 |
| Verification | `npm run lint && npm run check:sensitive && npm run typecheck && npm test && npm run build` |
| Commit policy | one coherent stage commit on `main` after the skill-bundles stage (separate branch/worktree during development) |
| Deploy | not deployed by this stage; deployment follows the normal untracked runbook after merge |

## Global invariants

- **No migration and no new dependency.** Existing tables and columns only. A v12 database starts
  unchanged. The other agent's v13 (`skill-bundles`) is not touched.
- **No skill-code changes.** `src/skills/*`, `src/http/skills.ts`, `assets/skill*`, and the skills
  migration are untouched. Master skills use the existing scope pages.
- **No coordinator-held secret reaches the master.** No operator/runtime token, state volume, Docker
  socket, provider-key store, or git credential. Model-provider auth is present as for every agent.
- **Reuse, do not fork.** Provisioning, settings, restart, and path validation run through the
  existing services; the only extraction is project/app provisioning, which the web forms will use
  too.
- **The master is an agent, not a project.** It stays resolvable by direct URL but is excluded from
  operator project lists, counters, and `/api/projects`.
- **One mutation choke point.** Workspace writes happen only through coordinator-side MCP tools with
  realpath containment, capped sizes, `.git`/manifest denials, and an `events` audit row.
- **Idempotent bootstrap.** Every start converges to exactly one project row, one app row, one
  directory, one `AGENTS.md`, and `deleting = 0` on both reserved rows.

## Phases

### Phase 1 - Reserved identity, bootstrap, instructions

Files:
- `src/master/constants.ts` (new): `MASTER_PROJECT_ID`, `MASTER_APP_KEY`, `MASTER_APP_ID`,
  `MASTER_PROJECT_NAME`, `MASTER_DIR_NAME`, `masterAppDir(workspaceRoot)`, `isMasterProject(id)`,
  `isMasterApp(projectId, appKey)`, `masterChatHref()`, `isReservedProjectPath(workspaceRoot,
  resolvedPath)`.
- `src/master/instructions.ts` (new): the coordinator-owned `AGENTS.md` body.
- `src/master/bootstrap.ts` (new): `ensureMasterAgent(db, workspaceRoot)` with the exact row shape,
  transaction order, stale-marker clearing, stale extra app-row removal, canonical-path assertions
  **before** the commit, symlink refusal, and an atomic `O_EXCL | O_NOFOLLOW` `AGENTS.md` write.
  A symlinked or escaping `.hanse-master` fails startup; it is never followed or deleted.
- `src/cli/commands.ts`: call `ensureMasterAgent` after the discovery loop; make
  `discoverProjectDirs` skip the reserved directory (export a small predicate for tests); report the
  operator project count separately in the startup line.
- `src/registry/index.ts`: refuse an app whose resolved path is inside the master directory, and
  keep the reserved project-id guard as defense in depth.

Checks:
- Bootstrap twice yields one row each, unchanged ids, and `deleting = 0`.
- `appDir()` resolves to the canonical master directory; a fresh DB and a restart both pass.
- `AGENTS.md` is written atomically; a read-only workspace or a symlinked master directory produces
  a startup error naming the path; a symlink target is never written through.
- A discovered manifest inside `.hanse-master` is skipped; a manifest app path there is refused.
- A stale extra app row under the reserved project is removed in the transaction.

### Phase 2 - ManagedApp instructions, git-credential exclusion, read-only app directory

Files:
- `src/opencode/manager.ts`: `ManagedApp` gains optional `instructions?: string[]`,
  `gitCredentials?: boolean`, and `appDirReadOnly?: boolean`; `#ensureLocked` passes `instructions`
  into `buildConfigOverlay` (container-visible `appDir` path, never the runner host path), skips
  `materializeGitCredentials` when `gitCredentials === false` (empty `gitEnv`), and adds
  `appDirReadOnly` to the spec hash input only when true.
- `src/agent/spec.ts`: optional `appDirReadOnly?: boolean` in `AppRuntimeSpec`/`SpecHashInput`,
  validation, and conditional hashing so ordinary app hashes do not change.
- `src/runner/server.ts`: mount the app directory `:ro` when `appDirReadOnly` is true.
- `src/http/apps.ts`: `toManagedApp` sets instructions, `gitCredentials: false`, and
  `appDirReadOnly: true` for the master app only.

Checks:
- The master launch env contains `OPENCODE_CONFIG_CONTENT.instructions` pointing at the master
  `AGENTS.md` and no `GIT_CONFIG_GLOBAL`/`GIT_SSH_COMMAND`/`GIT_ASKPASS`/`HANSE_CREDENTIALS_DIR`.
- The master spec carries `appDirReadOnly` and the runner mounts its app directory read-only;
  ordinary apps keep `:rw`, their env, and their spec/settings hashes.
- Instructions are not part of the settings hash (documented); they change only the master's spec
  env.

### Phase 3 - Provisioning helpers shared by forms and master

Files:
- `src/coordinator/provision.ts` (new): `createProject` and `addApplication` with typed
  `ProvisioningError { code }`.
  - slug/name normalization identical to the current forms;
  - `directory`/`path` confined with `resolveAppPath`; reserved master directory refused;
  - derived app key validated with `isValidAppId`;
  - `remote` validated (scheme or scp-like), no leading `-`, no control characters, passed after
    `--`;
  - clone into a unique temp directory beside the target, rename into place, cleanup on failure,
    no DB row on failure;
  - manifest append idempotent by path; DB upsert identical to the current route;
  - manifest writes are symlink-safe (lstat/realpath, `O_NOFOLLOW` temp + same-directory rename) and
    project names are serialized with `stringifyYaml` plus a line-break/control-character refusal.
- `src/http/handler.ts`: replace the inline project/app creation bodies with the helpers, preserving
  every deletion/conflict check, status code, message, and redirect.

Checks:
- Existing HTTP creation tests pass unchanged.
- New provisioning tests: slug, duplicate, reserved directory, root equality, `.git`/`.hanse`
  segments, absolute/`..` paths, app-key `.`/`.hanse-master`, `--upload-pack=`/`file://`/local
  remotes, clone failure cleanup, manifest idempotence, a cloned `.hanse` symlink refused, a
  multi-line/control-character project name refused, existing `app.yaml` kept, deletion
  reservations honored when a service is supplied.

### Phase 4 - Workspace file tools

Files:
- `src/master/workspace-files.ts` (new): `resolveWorkspacePath`, `listWorkspaceDir`,
  `readWorkspaceFile`, `writeWorkspaceFile` implementing the containment contract:
  reject empty/`.`/absolute/`..`/NUL/control/backslash; realpath ancestor containment; strict
  containment except `list_dir("")`; `O_NOFOLLOW`/`O_NONBLOCK` + `fstat` regular-file checks;
  bounded read; `TextDecoder(fatal)`; segment-wise mkdir with symlink refusal; `O_EXCL` temp +
  parent re-resolution + same-directory rename + cleanup; 256 KiB caps; 500-entry listing via
  iterator; `.git` segment, `.hanse/project.yaml`, `.hanse/app.yaml`, and master `AGENTS.md`
  denials.

Checks:
- Every escape and denial in the design section 4.2/4.3 is a test.
- Max-size write succeeds through the MCP path; an over-limit request yields `413
  payload_too_large`.

### Phase 5 - Master MCP tool surface

Files:
- `src/master/tools.ts` (new): `MasterToolContext`, tool schemas, validation, dispatch, audit
  writes, `{ok:false, code, message}` failures. Includes settings target existence checks (and
  `get_settings` using `resolve()`, never `snapshot()`), deletion-marker prechecks, master
  self-start/restart refusal, provisioning calls, decoded-byte caps, and the write content
  well-formedness/control-character rule.
- `src/mcp/master.ts` (new): JSON-RPC wrapper. `tools/list` = master tools only; `tools/call`
  allowlist with no fall-through; `initialize` and other methods use standard handling.
- `src/http/internal-mcp.ts`: build the context from `deps` and route master tokens to the wrapper.
- `src/http/server.ts`: `bodyLimitFor("/internal/mcp") = 1 MiB`; skills and default limits unchanged.

Checks:
- Ordinary app token: master tools absent and not callable.
- Master token: SSH/handoff tools return `unknown_tool`.
- `set_setting` rejects unknown projects/apps/keys and never writes provider/git secrets.
- `start_app`/`restart_app`: deletion markers, deployment-lock mapping, restart-claim mapping,
  stopped-app result, self-refusal, one manager call.
- Audit rows are bounded and content-free.

### Phase 6 - Web UI and routing

Files:
- `src/http/dashboard.ts`: optional `ProjectView.builtin`; `operatorProjects` helper; counters skip
  builtin; `renderOverview`/`renderProjects` use the projection; a reduced master project page (no
  danger zone, no manifest card, no Add app/New handoff).
- `src/http/application.ts`: a reduced master application page (no git workbench/`git.js`, no image
  panel, no danger zone) and the danger zone suppression.
- `src/http/ui.ts`: `appShell` filters the reserved project id from the sidebar and adds the
  **Master** nav entry (`NavProject` unchanged).
- `src/http/chat.ts`: `/chat` selection algorithm; app selector hides builtin projects except the
  current app (inject a single option when it is the master).
- `src/http/handler.ts`: `/api/projects` returns the operator projection.

Checks:
- Master-only, operator+master, and operator-with-zero-apps `/chat` behavior.
- Direct master chat/project/app/settings/skills URLs resolve.
- Sidebar, overview, projects index, counters, and `/api/projects` exclude the master; the nav entry
  is present on every page.
- Existing page tests unchanged.

### Phase 7 - Safety guards

Files:
- `src/coordinator/deletion.ts`: `deleteProject`/`deleteApp` throw `DeletionError(409,
  master_protected)` for the reserved ids.
- `src/http/deletion.ts`: reserved-project guard before the `deps.deletion === undefined` return and
  before any filesystem work; browser notice and JSON `409`.

Checks:
- `POST`/`DELETE`, browser/JSON, with and without a configured deletion service.
- Service-level `deleteProject`/`deleteApp` refusal; rows and files untouched.

### Phase 8 - Tests

New files: `test/master-bootstrap.test.ts`, `test/master-workspace.test.ts`,
`test/master-tools.test.ts`, `test/master-provision.test.ts`, `test/master-http.test.ts`,
`test/master-runtime.test.ts`. Coverage as listed per phase and design section 11, including the
spec/runner read-only mount, symlinked bootstrap, reserved-segment provisioning, master page
variants, self start/restart refusal, and the maximum-size write through `/internal/mcp`.

### Phase 9 - Documentation and record

Files:
- `docs/current-state.md`: master identity, directory, tools, UI, limits, accepted risks.
- `README.md`: one feature bullet.
- `docs/design/README.md`, `docs/plans/README.md`, `docs/journal/README.md`: index entries.
- `docs/journal/0021-hanse-master.md` (new): what changed, evidence, accepted debt.
- `docs/open-questions.md` only if an owner decision remains.

### Phase 10 - Gates

```bash
npm run lint
npm run check:sensitive
npm run typecheck
npm test
npm run build
```

Then one commit: `feat(master): add a built-in Hanse master agent`.

## Risks

| Risk | Mitigation |
| --- | --- |
| File tools become an escape hatch | Realpath containment, `O_NOFOLLOW`, fd `fstat`, parent re-resolution, caps, denials; one test per rule. |
| Hostile project file prompt-injects the master | Instructions declare repository content as data; mutations visible in chat/`events`; no SSH/handoff/secret tools; provider-egress risk documented. |
| Divergence between form and master provisioning | Single provisioning module; existing HTTP tests pinned. |
| Hidden master breaks direct pages or tests | `builtin` flag, `appShell` central filter, direct-URL preservation, full suite. |
| Parallel skills rework conflicts | Isolated worktree/branch; no skill files, no migration, no skills assets. |
| `/internal/mcp` body-limit change affects app calls | Only that route changes; ordinary payloads are far smaller; 256 KiB write cap tested. |
| Self start/restart kills the response | Both refused explicitly; UI restart remains. |
| Native tools rewrite the master instructions | Read-only app-dir mount in the runner plus tool-level denial; B0 limitation documented. |
| Bootstrap follows a symlink | Canonical real-path checks before write and before commit; symlink aborts startup. |
| Master page shows dead git/danger controls | Reduced master project/app variants. |
