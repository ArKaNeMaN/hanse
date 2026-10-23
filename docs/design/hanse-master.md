# Design - Hanse master agent

Status: **approved** - design review rounds 1-3 (`oracle`); round 1 and 2 returned CHANGES REQUESTED,
round 3 cleared all deltas and requested two provisioning fixes (symlink-safe manifest writes and
YAML-safe project names), which are incorporated. Implementation permitted.
Scope: a built-in coordinator-managed agent that operates Hanse itself: projects, applications,
settings, agent restarts, and workspace files, reachable through the normal chat workspace.
Out of scope: provider API-key entry, git/SSH credential entry, image builds, project/app deletion,
and git operations. Skill creation was deferred by this stage and later added in
[`master-skill-creation.md`](./master-skill-creation.md) (stage 0019, journal 0022); skill updates,
enabling/disabling, deletion, and override remain operator-only.

## 1. Problem

Hanse is configured through a web UI (project/app creation, hierarchical settings, skills, restarts)
and through files on disk (`.hanse/project.yaml`, `.hanse/app.yaml`, application `AGENTS.md`). An
operator who wants to "set up a project and two agents" must switch between forms, manifests, and
chat windows. The product has no assistant that understands Hanse itself.

A master agent turns the coordinator's own API and workspace into a conversational interface:
"create a project called Atlas, add a reviewer app from this repo, set its model, write its
AGENTS.md, then restart it."

## 2. Requirements

| ID | Requirement |
| --- | --- |
| M1 | One built-in master agent exists on every coordinator start, is reachable from the normal chat workspace, and starts lazily like an application agent. |
| M2 | The master agent runs in the same isolated runtime and with the same model/web/OMO/skills/context machinery as an application agent. It never receives the operator token, the runtime token, the coordinator database, the state volume, the provider-key store, or materialized git credentials. It does receive the model-provider auth it needs to run (as every managed agent does). |
| M3 | The master can create projects and applications, write application source and `AGENTS.md` files, read workspace files, read and change the seven non-secret registry settings, and start/restart application agents. It cannot raw-write `.hanse/project.yaml`, `.hanse/app.yaml`, or `.git/**`; those change only through the provisioning tools. |
| M4 | Every mutation is performed by the coordinator on the master's behalf, not by giving the master raw access to the workspace or the database. Paths are confined to the workspace; secret-bearing settings (provider keys, git credentials) are not writable through the master. |
| M5 | The master is a first-class agent for settings and skills scopes (global -> master project -> master app) and is configurable from the existing scope pages, but it is not listed as an operator project. A dedicated navigation entry opens its chat. |
| M6 | The master project, application, reserved directory, and reserved ids cannot be deleted, shadowed by a discovered project, or taken over by project/app creation. |
| M7 | An installation that never opens the master starts no agent and exposes no operator-visible project or counter. The dedicated **Master** navigation entry is the only visible affordance. Starting the coordinator still creates the hidden reserved rows and the master directory (see section 10 for the read-only-workspace consequence). |
| M8 | The feature needs no database migration and no new npm dependency. |
| M9 | Master-originated mutations are recorded in `events` for operator audit; coordinator-held secrets never appear in an event or tool result. Workspace file content read by `read_file` may itself contain secrets (see section 9). |

## 3. Decision - the master is a reserved application, not a new entity

The coordinator's entire agent lifecycle is keyed by an `apps` row: `instances`, `agent_tokens`,
settings scopes, skills scopes, context monitors, restart claims, the runner spec, and chat routing
all join on `apps.id`. Introducing a second entity type would duplicate that pipeline or force a
wide refactor of security-sensitive code.

The master is therefore a **reserved project row plus one reserved app row**, created idempotently
at coordinator start.

### 3.1 Exact identity and row shape

| Field | Value |
| --- | --- |
| project id | `hanse-master` (constant `MASTER_PROJECT_ID`) |
| project name | `Hanse master` |
| project `base_branch` | `main` |
| project `root_path` | the canonical master directory `<workspace>/.hanse-master` |
| app id | `hanse-master:master` (constant `MASTER_APP_ID`) |
| app key | `master` |
| app `project_id` | `hanse-master` |
| app `path` | `.` (resolved against `root_path`) |
| app `kind` | `master` - display metadata only, never an authorization key |
| app `contract` | `AGENTS.md` |
| image fields | `image_status = 'missing'`, `image_ref = NULL`, other image fields `NULL` |
| app directory | `<workspace>/.hanse-master` (read-only inside the agent container; see section 4) |
| state directory | `<agents>/hanse-master/master` |

`root_path = <master dir>` and `path = "."` make `appDir()` resolve to exactly the master
directory. `resolveAppPath` allows equality with the project root (strict containment is only
required against the workspace root), and the manager's spec validation requires the result to be
strictly inside the workspace, which it is.

`ensureMasterAgent(db, workspaceRoot)`:

1. canonicalize the workspace (`realpath`) and compute the master directory from it; if the
   directory exists, `lstat` it and require a real directory (not a symlink) whose `realpath` is
   exactly `<workspace real>/.hanse-master`; a symlinked or escaping path aborts startup with an
   explicit error and is never followed or deleted;
2. create the directory when absent, then re-resolve and assert containment again;
3. write `AGENTS.md` atomically: refuse a symlink target, create an `O_EXCL | O_NOFOLLOW` temp file
   in the resolved directory with mode `0644`, write, re-resolve the directory, `rename` over the
   target, and remove the temp file on failure;
4. in one `better-sqlite3` transaction: upsert the project row, upsert the app row, set
   `deleting = 0` on both, and delete any other app row under the reserved project (there is no
   supported way to create one; stale rows from a manual edit must not survive);
5. assert, before the transaction commits, that the app id passes `isValidAppId` and that
   `resolveAppPath({appPath: ".", projectRoot: masterDir, workspaceRoot})` equals the canonical
   master directory; a mismatch rolls back;
6. never touch `created_at` on an existing row.

The reserved ids are authoritative for dispatch, hiding, deletion refusal, and provisioning
guards. `kind = 'master'` is never used as an authorization or identity check because `kind` is
operator-controlled through `.hanse/app.yaml` and rewritten by `registerProject`.

### 3.2 Why a reserved row

- It inherits the runner spec, isolation, token minting, settings resolution, skills
  materialization, OMO profile, context monitor, and restart semantics with **zero** changes to
  those subsystems.
- Chat, settings pages, and skills pages already resolve an application by `(projectId, appKey)`;
  the master works through them instead of growing a parallel surface.
- The reserved ids are stable across restarts, so sessions, settings, and skills survive coordinator
  upgrades.

Rejected alternatives: a synthetic in-memory app (FK and join failures), a second runtime pipeline
(duplicates security-sensitive code), and mounting the whole workspace into the master container
(the runner exposes one `appDir`, `resolveWithinRoot` rejects root equality, and the LLM would get
unmediated write access to every project).

## 4. Isolation and access model

- The master container mounts its own `<agents>/hanse-master/master` state read-write and
  `<workspace>/.hanse-master` **read-only**; it has no state volume, Docker socket, runner token, or
  operator token.
- The read-only app directory is a new optional runtime-spec field (`appDirReadOnly`), set only for
  the master and honored by the B1 runner's bind mount (`:ro`). This is kernel-enforced: native
  `write`/`edit`/`bash` cannot rewrite the coordinator-owned `AGENTS.md`, create `.git`/`.hanse`
  files there, or persist new instructions. The coordinator still writes the directory because it
  owns the workspace. The legacy B0 host path is internal compatibility and does not enforce the
  flag; it is documented as such.
- It reaches the coordinator exactly like any app: the `hanse` MCP server over
  `HANSE_MCP_API_BASE`, authenticated by its own `agent_tokens` row.
- Git credentials are **not** materialized into the master HOME. `ManagedApp` gains an optional
  `gitCredentials?: boolean`; `toManagedApp` sets it to `false` for the master, and the manager
  skips `materializeGitCredentials` and injects no `GIT_*` credential paths for that app. Model
  provider auth is still reconciled into the master's own `auth.json`, as for any agent. The
  application page does not render the git workbench for the master (section 8).
- The master's own file tools (`read`/`write`/`edit`/`bash`) see only its read-only directory.
  Workspace operations go through coordinator-side MCP tools.
- Its instructions are passed explicitly through the opencode overlay
  (`instructions: [<container-visible appDir>/AGENTS.md]`) instead of relying on AGENTS.md discovery,
  which depends on the detected project root (the workspace may itself be a git repository).
  `ManagedApp` gains an optional `instructions?: string[]`; `toManagedApp` supplies it for the
  master using the container-visible `appDir`, never the runner host path.

### 4.1 MCP authorization and dispatch

`POST /internal/mcp` already resolves the presented bearer token to
`AgentTokenIdentity {appId, projectId, appKey}` through `agent_tokens`. When
`agent.appId === MASTER_APP_ID`:

- `tools/list` returns exactly the master tools from section 5;
- `tools/call` dispatches **only** names in the master allowlist. Any other name, including
  `ssh_exec`, `ssh_upload`, `ssh_download`, `request_sibling_change`, `deliver_handoff`,
  `list_apps`, and `handoff_status`, returns `{ok:false, code:"unknown_tool"}`. There is no
  fall-through to `handleRpcAsync`;
- `initialize` and other protocol methods use the standard JSON-RPC handling, with the master tool
  list as the only advertised surface.

An ordinary app token can never reach master tools because the dispatch is keyed on the verified
`appId` (not on a tool name, project id, or `kind`), and its tool list does not contain them. A
master token cannot reach SSH or handoff tools because the master dispatch has no fall-through.
Both directions are covered by tests.

### 4.2 Workspace file tools - containment contract

All workspace paths are workspace-relative and must satisfy every rule:

- reject empty, `.`, `./`, absolute paths (POSIX or Windows drive/UNC forms), any `..` segment, NUL,
  control characters, and backslashes; paths are POSIX-style inside the workspace;
- resolve the nearest existing ancestor with `realpath` and require the final target to stay
  strictly inside the canonical workspace root; `list_dir("")` is the only allowed root reference;
- read: `open(O_RDONLY | O_NOFOLLOW | O_NONBLOCK)`, then `fstat` the descriptor and require a regular
  file; enforce the 256 KiB cap with `fstat` and a bounded read; refuse NUL bytes and invalid UTF-8
  (`TextDecoder(..., {fatal:true})`); a path with a `.git` segment is refused for reads as well as
  writes;
- write: resolve and create parent directories segment by segment, re-resolving each existing
  segment and refusing a symlinked segment; create a unique temp file in the resolved parent with
  `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW` and mode `0600`; refuse an existing final target that is
  not a regular file; re-resolve the parent immediately before `rename(tmp, target)` and abort if it
  changed; remove the temp file on every failure;
- caps are decoded UTF-8 bytes: 256 KiB for a read result and 256 KiB for write content. Write
  content must be well-formed UTF-16 (no lone surrogates) and must not contain C0 controls other
  than tab, line feed, and carriage return; this bounds JSON escaping to about 2x. The
  `/internal/mcp` transport limit is 1 MiB, which covers a maximum write plus the JSON-RPC envelope;
- `list_dir`: `opendir` and iterate, stop after 501 entries, `lstat` each entry without following
  it, return name/type/size only;
- refuse FIFOs, sockets, devices, and directories for `read_file`/`write_file`;
- hardlinks are accepted as same-filesystem inode aliases; they are not detected. A host process can
  still race a parent directory between the final check and `rename`; the re-resolution reduces, but
  cannot eliminate, that residual TOCTOU. Both limits are documented; the threat model here is an
  LLM, not a hostile host user.
- bind mounts inside the workspace are outside this guarantee.

### 4.3 Write surface integrity

`write_file` refuses:

- any path containing a `.git` segment (config, hooks, refs, and worktree files);
- any `.hanse/project.yaml` or `.hanse/app.yaml` anywhere in the workspace - manifests change only
  through `create_project`/`add_app`, which update files and rows together;
- the master's own `<master dir>/AGENTS.md`, which the coordinator owns and rewrites at start;
  additionally, the container mounts the directory read-only (section 4), so native `write`/`edit`/
  `bash` cannot rewrite it or persist new instructions either. The tool-level denial keeps the
  behavior explicit even if the mount flag is ever misconfigured.

Other existing regular files may be replaced. The tool reports `{path, bytes, created}`; the audit
event records path and size, never content. There is no backup and no delete tool.

## 5. Master tools

The master's MCP surface (opencode exposes these as `hanse_<name>`):

| Tool | Arguments | Result |
| --- | --- | --- |
| `list_projects` | - | Projects with `builtin` flag, root path, and apps (key, path, kind, runtime state, pending restart). |
| `get_app` | `project_id`, `app_key` | App path/kind/runtime/pending-restart/image status, effective settings, manifest summary. |
| `get_settings` | optional `project_id`, `app_key` | Effective values with source scope, scoped states, provider status (never key material), warnings. |
| `set_setting` | `key`, `value`, `scope`, optional ids | Validated write through `SettingsService.set`; `null` calls `SettingsService.clear` for a clearable key. Returns the new effective value and pending-restart state. |
| `inherit_setting` | `key`, `scope`, optional ids | Deletes the scoped row; returns the new effective value. |
| `create_skill` | `scope`, `name`, `description`, `content`; optional `confirm_global`, ids, `license`, `compatibility`, `metadata`, `references` | Creates an enabled bundle through `SkillService.create`; global scope requires `confirm_global`; returns the row projection, `shadows`, `shadowedBy`, `appsInScope`, and app-scope `pendingRestart`. |
| `list_skills` | `scope`, optional ids | Effective set and rows defined at a target; no bodies or reference content. |
| `get_skill` | `skill_id` | Full bundle: body, reference contents/sizes, metadata, `metadataRaw`, stored issues. |
| `update_skill` | `skill_id`; optional fields, `confirm_global` | Edit description/body/license/compatibility/metadata/references; name/scope/target immutable. |
| `set_skill_enabled` | `skill_id`, `enabled`, optional `confirm_global` | Enable/disable a row; a disabled row is a tombstone, not a deletion. |
| `override_skill` | `source_skill_id`, project/app `scope`, `project_id`, optional `app_key`, `enabled`, `confirm_replace` | Copy an enabled source into a project/app; exact target replacement needs `confirm_replace`. |
| `start_app` | `project_id`, `app_key` | `ensure()`; reports the resulting runtime state. Running apps reconnect. |
| `restart_app` | `project_id`, `app_key` | `restartIfRunning()`; reports whether a container restarted. A stopped app is not started. |
| `create_project` | `name`, optional `directory` | Creates `<workspace>/<slug>`, writes `.hanse/project.yaml`, inserts the row. |
| `add_app` | `project_id`, `name`, optional `path`, optional `remote` | Creates/clones the app directory, writes `.hanse/app.yaml` when absent, updates the manifest, inserts the row. |
| `list_dir` | optional `path` | Bounded directory listing. |
| `read_file` | `path` | Bounded UTF-8 text read. |
| `write_file` | `path`, `content` | Bounded atomic write; creates parent directories inside the workspace. |

Contract rules:

- The dispatcher receives an explicit `MasterToolContext {db, workspaceRoot, settings?, manager?,
  deletion?, skills?}` built in `handleInternalMcp`. Optional services return
  `{ok:false, code:"unavailable"}` instead of crashing a fixture.
- Failures return `{ok:false, code, message}` as MCP text content, not JSON-RPC errors, so the model
  can correct itself. Codes include `invalid_argument`, `unknown_project`, `unknown_app`,
  `not_found`, `already_exists`, `reserved_path`, `deletion_pending`, `restart_in_progress`,
  `deployment_in_progress`, `self_restart_unsupported`, `master_protected`, `confirmation_required`,
  `replacement_confirmation_required`, `invalid_skill`, `skill_exists`, `unknown_skill`,
  `unknown_tool`, `unavailable`, and `io_error`.
- `set_setting` with `null` clears a clearable key through `SettingsService.clear`; a
  non-clearable key fails with `invalid_argument`.
- `set_setting`/`inherit_setting` resolve the target through `getProjects()` and
  `CoordinatorService.listApps()` before writing; unknown ids are rejected. A global write is
  allowed and explicitly reported as affecting every app. `get_settings` uses
  `SettingsService.resolve()` only; it must never call `snapshot()`, whose `mergedAuth` contains
  provider key material.
- `start_app`/`restart_app` precheck the app and project `deleting` markers before touching the
  runtime. Both refuse the master's own app id with `self_restart_unsupported`: a restart kills the
  in-flight MCP response, and `ensure()` can take a recreate path when a running container has no
  endpoint, which would have the same effect. The operator controls the master from its UI.
  `restart_app` on a stopped app returns `{restarted:false, started:false, state:"stopped"}`.
- `create_project`/`add_app` use one provisioning module shared with the web forms:
  - `directory` is an optional **single workspace-relative path segment**, not an absolute path and
    not nested; it defaults to the name slug. It is resolved against the workspace root and every
    path segment `.git`, `.hanse`, and `.hanse-master` is refused; equality with the workspace root
    and with the master directory is refused. Nested project directories are unsupported because
    `discoverProjectDirs` only scans one level;
  - project ids remain random UUIDs; duplicate manifests/directories are refused;
  - `add_app` rejects the reserved project id, validates the derived app key with `isValidAppId`,
    refuses any resolved path equal to or inside the master directory, refuses a path equal to the
    project root or workspace root, refuses path segments `.git`/`.hanse`, and refuses a duplicate
    app key in the project. If `.hanse/app.yaml` already exists it is kept byte-for-byte; the app key
    comes from the directory name, not from the existing file, matching the current form;
  - `remote` is optional; when present it must not start with `-`, must not contain control
    characters, and must be an `http(s)://`, `ssh://`, `git://`, or scp-like `user@host:path` URL.
    Local paths and `file://` are refused. It is passed after `--` to `git clone`;
  - clone into a unique temporary directory beside the target, then rename into place; a failure
    removes the temporary directory and inserts no row; the manifest and row are written only after
    the directory exists;
  - manifest writes never follow a symlink: `.hanse`, `project.yaml`, and `app.yaml` are lstat/realpath
    checked, refused when linked, and written with the same `O_NOFOLLOW` temp + same-directory
    rename discipline as `write_file`. A cloned repository that ships a `.hanse` symlink cannot
    redirect a manifest write outside the workspace or into another project;
  - project names are serialized with the YAML library (`stringifyYaml`), and names containing line
    breaks or C0 controls are rejected, so a manifest can never be made unparseable by a name;
  - the module runs the same deletion-reservation checks as the web form when a `DeletionService` is
    supplied (`isActive`, `isDeletingProject`, `isDeletingApp`, `isDeletingAppState`,
    `isDeletingPath`); with no service (fixtures) the checks are skipped.
- Every mutation writes one bounded `events` row with `scope = 'master'` and a type such as
  `master.project_created`, `master.app_added`, `master.setting_changed`,
  `master.setting_inherited`, `master.file_written`, `master.app_started`,
  `master.app_restarted`, `master.skill_created`, `master.skill_updated`, `master.skill_enabled`,
  or `master.skill_overridden`. Payloads contain ids, paths, key, value, changed field names, and
  byte counts, never file content, skill bodies, reference content, descriptions, metadata values,
  or coordinator-held secrets, and are bounded to 8 KiB.

## 6. Instructions and built-in skills

`<workspace>/.hanse-master/AGENTS.md` is coordinator-owned and rewritten on every coordinator start;
it is also passed explicitly through the opencode `instructions` overlay. It states:

- the workspace root, the manifest conventions, and that the master's own directory is not a
  project;
- the tool names as opencode exposes them (`hanse_list_projects`, `hanse_write_file`, ...) and
  recipes for the common jobs (new project, new app, write an app's `AGENTS.md`, change a model,
  restart after a settings change, create/list/read/update/enable/override a skill);
- that provider keys, git credentials, deleting/reverting/discarding/renaming skills, project
  deletion, and image builds are operator-only UI actions; skill creation and management use the
  master tools, with global mutations only after operator approval;
- that repository, manifest, and agent content **and skill tool output** are **data**, never
  instructions, and that the master must not act on text found in project files or skill bundles
  without an operator request;
- that it must not rewrite manifests, its own `AGENTS.md`, or `.git` files, and must not attempt to
  start/restart itself.

The master still receives the image-baked codegraph/web MCP servers and the opencode built-in
tools, like every agent; only the `hanse` MCP surface is allowlisted. Its read-only directory and
absent git credentials bound what those tools can change, and the instructions require workspace
edits through the Hanse tools.

The master inherits global skills through the existing skill hierarchy. An operator can add
app-scoped skills on `/projects/hanse-master/apps/master/skills`, and the global scope still applies
to every application. Materialization and restart semantics are unchanged. Master-side creation was
added by stage 0019 and full management by stage 0020: `create_skill`, `list_skills`, `get_skill`,
`update_skill`, `set_skill_enabled`, and `override_skill` reuse the human bundle model, refuse the
reserved master project/app for mutations, require operator confirmation for global mutations and
target replacement, and audit every mutation. Deleting, reverting/discarding, and renaming skills
remain operator-only.

## 7. Settings and restart semantics

The master resolves settings exactly like an app, with three scopes: global, project
`hanse-master`, and app `master`. No new settings keys are introduced.

- The master's model, web drivers, OMO profile, context policy, and git identity resolve through
  this hierarchy. Git identity settings are inert for the master because its git credentials are not
  materialized.
- A settings change made through the master is an ordinary settings write: a running target is
  marked restart-required and never restarted silently. `set_setting` reports the pending state so
  the master can offer `restart_app`.
- Changing the master's own settings marks the master restart-required; its chat shows the same
  restart affordance as any app.

## 8. Web UI and routing

The master stays in `SiteModel` (so direct pages resolve) and gains a `builtin` marker. Operator
presentation is derived from it:

- `SiteModel.projects[].builtin?: boolean` (optional so hand-built fixtures keep compiling) and an
  `operatorProjects(site)` projection;
- `buildSite` counters (`appCount`, runtime counts, handoff count) skip builtin projects;
- `renderOverview` and `renderProjects` use the operator projection for rows, empty states, and
  counts;
- `GET /api/projects` returns the operator projection;
- `appShell` filters the reserved project id out of the sidebar project list centrally (all pages
  share this function; `NavProject` is unchanged) and renders a **Master** entry above it, linking
  to `/chat?app=master&project=hanse-master`;
- `/chat` without `app` prefers the first operator application and falls back to the master only
  when no operator application exists;
- the chat app selector hides builtin projects unless the current app is the master, in which case
  it injects a single selected option so the control never shows a blank value;
- project and application pages keep resolving the master by direct URL, but render a reduced
  master variant: no danger zone, no "Add app"/"New handoff" controls, no `.hanse/project.yaml`
  manifest card, no git workbench and no `/assets/git.js` (the master directory is not a repository
  and its git credentials are not materialized), and no image panel. Chat, terminal, settings, and
  skills links remain;
- settings and skills scope pickers keep listing the master: those pages are how the operator
  configures the master itself. This is deliberate, not an oversight;
- the SSH grant picker may list the master as an app; grants are inert because master dispatch never
  exposes `ssh_*`. This is accepted debt;
- the coordinator startup log reports operator project count separately from the master.

No new page, stylesheet, or client module is added. `navProjects` copies do not change; the shared
`appShell` filter covers every sidebar.

## 9. Safety

- **Deletion is refused at the service and the HTTP layer.** `DeletionService.deleteProject` and
  `deleteApp` throw `DeletionError` with `409 master_protected` for the reserved ids; `handleDeletion`
  also rejects the reserved project before its `deps.deletion === undefined` early return, so JSON
  callers get `409` even when deletion is unconfigured. Browser callers get a redirect notice.
- **Shadowing and takeover are refused.** `create_project` refuses the reserved directory, root
  equality, and `.git`/`.hanse` segments; `add_app` refuses the reserved project, root equality, and
  paths equal to or inside the master directory; `discoverProjectDirs` skips the master directory;
  `registerProject` refuses app paths inside the master directory. The project-id check is kept as
  defense in depth but the directory check is the real boundary (manifest ids are UUIDs).
- **Bootstrap never follows a symlink.** The master directory and `AGENTS.md` are resolved and
  asserted to be real paths strictly inside the workspace before any write; the file is written
  with `O_EXCL | O_NOFOLLOW` plus a same-directory rename and the directory is re-resolved before
  the commit. A pre-existing symlinked `.hanse-master` aborts startup instead of redirecting the
  write into coordinator state.
- **Native tools cannot rewrite the master's own instructions.** The B1 runner mounts the master
  app directory read-only (new `appDirReadOnly` spec field); the state directory stays read-write.
  The tool-level `write_file` denial is a second layer. B0 (internal compatibility, not deployed)
  does not enforce the flag; this is documented.
- **Tool surface is small.** No delete, move, chmod, exec, git, handoff, or SSH tool. File writes
  are confined, capped, and deny `.git`, manifests, and the master's instructions.
- **No coordinator-held secret in results.** `get_settings` returns provider and git-credential
  status only, matching the human settings API. `write_file` audit rows contain no content.
  `read_file` returns workspace file content by design; that content may include secrets committed
  to a repository (`.env`, keys). This is accepted: the master is the operator's assistant and the
  content is also sent to the configured model provider.
- **Network reality.** App containers are ordinary Docker bridge networks with egress to model
  providers and web APIs. The master can therefore send what it reads to its configured provider or
  web tools. It cannot reach the coordinator state volume, other app state, the Docker socket, or an
  SSH host (no SSH tools, and credentials are not materialized). This is an acknowledged
  operator-controlled-assistant risk, not a containment boundary against the operator.
- **Prompt injection.** Project files are untrusted data. The instructions state this; every
  mutation is visible in chat and in `events`; the master can write into another project's source
  and `AGENTS.md`, which is the feature. A hostile repository can influence the model and cause
  cross-project edits; it cannot reach coordinator secrets, other app state, or an SSH host. This is
  accepted and documented.

## 10. Failure handling

- Master bootstrap failure (workspace not writable, or `.hanse-master` is a symlink) fails `serve`
  startup with an explicit message. A coordinator without its master is a configuration error.
  Installing the master therefore requires a writable workspace; the default deployment mounts it
  read-write. The master app directory is mounted read-only **inside the agent container only**.
- If the master agent cannot start (runner unavailable), chat shows the ordinary runtime error; the
  rest of Hanse is unaffected.
- Optional services (settings, manager, deletion) missing from a fixture produce typed `unavailable`
  tool failures, never a crash.
- Tool mutations run through the same services as the UI, so deployment locks, restart claims, and
  validation errors surface as tool failures rather than partial state. Project/app creation and
  settings writes are not deployment-locked, matching the existing UI routes; the design does not
  claim otherwise.
- `start_app`/`restart_app` on the master itself are refused. If the operator restarts the master
  from the UI, the in-flight tool call fails with a transport/runtime error and the chat client
  shows the normal disconnect/error state.
- A coordinator upgrade that changes the master `AGENTS.md` does not mark a running master
  restart-required: opencode reads instructions at process start, and instructions are not part of
  the settings hash. The operator restarts the master (or it starts fresh on next use). This is
  accepted debt.

## 11. Testing

New test files:

- `test/master-bootstrap.test.ts` - idempotent rows, exact row shape, `appDir` resolution,
  `AGENTS.md`, stale marker clearing, reserved-row assertions, reserved-directory refusal.
- `test/master-workspace.test.ts` - containment matrix (empty/`.`/absolute/`..`/NUL/backslash),
  symlinked ancestor and final target, FIFO/device/directory refusal, binary/invalid UTF-8, size
  caps, atomic replace, temp cleanup, `.git`/manifest/own-AGENTS.md denials, listing cap.
- `test/master-tools.test.ts` - tool list and authorization (ordinary token cannot call master
  tools; master cannot call SSH/handoff tools), argument validation, settings set/inherit with
  target validation, provisioning, start/restart semantics with a fake manager, self-restart
  refusal, deletion markers, audit rows.
- `test/master-provision.test.ts` - slug/reserved directory, `remote` scheme/option validation,
  app-key validation, manifest/row consistency, clone failure cleanup.
- `test/master-http.test.ts` - nav entry, hidden lists/counters/`/api/projects`, `/chat` selection
  algorithm, direct master chat/project/app/settings pages, suppressed danger zones, deletion `409`
  for `POST` and `DELETE` without a deletion service.
- `test/master-runtime.test.ts` - `toManagedApp` supplies instructions and disables git credentials
  for the master; a minimal manager launch carries `instructions` and no `GIT_*` credential paths;
  `appDirReadOnly` validates and hashes only for the master, and the runner mounts its app directory
  read-only while ordinary apps stay read-write.

Existing suites remain unchanged and green. The full gate is section 13.

## 12. Accepted debt

- No project/app deletion, file removal, move, rename, chmod, git operation, or image build from the
  master.
- The master can create, list, read, update, enable/disable, and override skills, but cannot delete,
  revert/discard, or rename them; those remain operator-only. It cannot mutate its own reserved
  project/app. Global mutations and target replacement require explicit operator confirmation and
  are accepted self-modification paths after that confirmation.
- No provider-key or git-credential entry from the master.
- Manifest edits are limited to what `create_project`/`add_app` produce; renaming projects, removing
  apps, and changing base branches are UI/manifest-operator jobs.
- Text files only, 256 KiB per read/write, 500-entry listing; no binary inspection.
- One global master; no per-operator or per-project masters.
- SSH grants may be attached to the master app but are inert.
- Master `AGENTS.md` changes require an explicit master restart; they are not auto-marked.
- B0 (internal compatibility host mode) does not enforce the read-only app directory.

## 13. Verification

```bash
npm run lint
npm run check:sensitive
npm run typecheck
npm test
npm run build
```
