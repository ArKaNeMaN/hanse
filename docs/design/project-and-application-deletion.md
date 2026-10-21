# Project and application deletion

Status: implemented and verified (journal 0015); deployment pending. The design was reviewed through
six rounds; all raised findings were addressed. Owner decisions are recorded in section 13.
Stage: `0013-project-and-application-deletion`.

## 1. Context

The coordinator can create projects and add applications, but it cannot remove either. The HTTP
router has no deletion route, `registerProject` only upserts, and nothing stops a container, removes
per-app state, or clears scoped settings. An abandoned application therefore keeps a container, a
network, sessions, credentials, images, grants, and handoff records indefinitely.

The runtime half already exists:

- `DELETE /v1/apps/:appId` (`src/runner/server.ts:1253-1256`).
- `RunnerService.delete` finds the container by the `hanse.managed=true` + `hanse.app.id` labels,
  stops and force-removes it, disconnects the coordinator, and removes the app network
  (`src/runner/server.ts:754-771`). It returns early when no managed container exists, so an orphan
  network is **not** removed by this path.
- `HttpAgentRuntimeClient.delete` (`src/agent/client.ts:118-123`).
- `InstanceManager.stopApp` serializes per app, calls the runtime delete, updates `instances`, clears
  endpoint auth, and revokes the MCP token (`src/opencode/manager.ts:618-640`).

What is missing is coordinator-side orchestration: registry rows, manifest entries, per-app state,
scoped settings/secrets, handoffs, images, and a safe UI/API.

## 2. Requirements

- R1. Deleting an application stops and removes its managed container and network; unmanaged
  containers, networks, and images are never touched.
- R2. Deleting an application removes its `apps` row and every coordinator row scoped to it.
- R3. Deleting an application removes its per-app agents directory: opencode DB/sessions, auth,
  password, MCP token, OMO profile, materialized git credentials, cache, tmp, mise.
- R4. Deleting an application purges its managed images after a successful runtime stop. A warning
  is allowed only for the image purge itself (for example an in-use image); the runner is required
  for the deletion (owner decision Q4).
- R5. Deleting an application removes its entry from `.hanse/project.yaml`, so a restart cannot
  re-register it.
- R6. Deleting a project performs R1-R5 for every application and removes the project row,
  project-scoped settings/secrets, project handoffs, and `.hanse/project.yaml`.
- R7. Both operations are human-only, require an explicit server-side confirmation, are resumable
  after a partial failure, and never leave a startable half-deleted app in the UI.
- R8. SSH audit rows, global settings/provider keys, SSH host definitions, and other projects are
  preserved.

## 3. Current state that constrains the design

### 3.1 Schema and cascade behavior

`PRAGMA foreign_keys` is enabled on every connection (`src/store/database.ts:18`).

- `apps.project_id -> projects(id) ON DELETE CASCADE` (`src/store/migrations.ts:23`).
- `instances.app_id`, `tasks.app_id`, `agent_tokens.app_id`, `app_image_versions.app_id`,
  `app_ssh_hosts.app_id`, `ssh_approvals.app_id`, `ssh_grants.app_id` cascade from `apps`.
- `handoffs.project_id -> projects(id) ON DELETE CASCADE`, but
  `handoffs.from_app_id`/`to_app_id -> apps(id)` have **no** `ON DELETE` action
  (`src/store/migrations.ts:55-73`). An app referenced by a handoff cannot be deleted until the
  handoff is deleted.
- `handoffs.target_task_id -> tasks(id)` has no action; deleting an app's tasks is blocked while a
  handoff points at one. No production code sets `target_task_id` today, but the constraint is real.
- `settings`, `provider_keys`, and `setting_secrets` use `(scope, project_id, app_key)` keys with
  **no** foreign keys (`src/store/migrations.ts:128-164`, `229-250`); no cascade removes them.
- `ssh_audit` has no foreign keys by design (`src/store/migrations.ts:342-364`), so it survives app
  and project deletion.
- `events` (`src/store/migrations.ts:96-109`) has no foreign keys and currently no writer. It is the
  only durable general audit surface available without a new table.

`events`, `tasks`, and `handoff_messages` are schema-only today. They still matter for FK ordering.

### 3.2 Re-registration

`serve` scans the workspace on every start and calls `registerProject` for every directory with
`.hanse/project.yaml` (`src/cli/commands.ts:305-321`, `567-570`). `registerProject` only upserts
(`src/registry/index.ts:103-188`). Therefore:

- A DB delete without a manifest delete resurrects the app/project on restart.
- A manifest delete without a DB delete leaves a DB row that is still rendered from `apps`.
- Both must be removed, and a partially deleted app must be durably marked so it cannot be started.

### 3.3 Per-application state

`agentsHome()` defaults to `~/.local/state/hanse-agents` or `HANSE_AGENTS_HOME`
(`src/runtime/paths.ts:20-26`; Compose uses `/data/agents`). An app root is
`<agentsHome>/<sanitize(projectId)>/<sanitize(appKey)>` (`src/opencode/instance.ts:81-98`) and
contains `home/` (including `.config/hanse/git/` and `.omo/omo.jsonc`), `data/` (opencode auth),
`state/` (opencode DB, password), `config/`, `cache/`, `tmp/`, `mise/`, and `mcp-token` at the app
root.

`sanitizeAppKey` replaces characters outside `[a-zA-Z0-9._-]` with `-`
(`src/opencode/instance.ts:71-73`). Distinct app keys can resolve to the **same** state directory
(`web:api` and `web-api` both become `web-api`); they are never ancestor/descendant by accident
because the layout is fixed at two segments. The guard must compare the computed target for equality
against every other app in the project, not only for ancestry. Worse, `.` and `..` are preserved;
`path.join` normalizes `.` to the project directory and `..` to its parent. The state-path guard
must reject empty, `.`, and `..` segments and must not rely on `sanitizeAppKey` alone. Both were
design-review blockers.

There is no code that removes a per-app state directory today. `stopApp` removes only the MCP token
file and revokes the token row (`src/opencode/manager.ts:828-842`).

### 3.4 Images

- `apps.image_ref` is the current image, `app_image_versions` tracks versions, and
  `instances.image_ref` records the running image.
- `ImageService.#protectedImageRefs` uses all three as the GC keep set
  (`src/images/service.ts:320-344`).
- GC is explicit and never deletes on a disk threshold (`docs/current-state.md:83`); the runner also
  protects every image used by any container, including stopped ones
  (`src/runner/image-gc.ts:181-200`).
- Images are tagged `hanse-app-<slug(appId)>:<buildId>` and labelled `hanse.app.id=<appId>`
  (`src/runner/images.ts:119`, `236-246`). The slug lowercases and collapses punctuation
  (`src/runner/names.ts:6-30`), so tag prefixes are not safe for per-app filtering.
- `ImageService.#active` is set at build start and only cleared by a status refresh
  (`src/images/service.ts:158-183`, `346-447`), so it cannot be used as the authoritative
  "is building" check.
- `/v1/images/:appId` is `GET` only (`src/runner/server.ts:1128-1145`); there is no per-app purge.

### 3.5 HTTP/UI conventions

- Mutations are form posts; browser callers get a `303` to a validated `return_to` with a
  `notice`/`tone` toast; JSON callers get JSON (`src/http/handler.ts:353-368`, `305-351`).
- Human-only routes check `principal.kind` (`src/http/handler.ts:318-323`). `routeMutation` does not.
- The top-level guard at `src/http/handler.ts:440-446` rejects MCP agent tokens only; a principal
  with `kind: "agent"` still reaches route logic.
- `handleRequest` is synchronous (`src/http/handler.ts:431`, `728`); asynchronous work must live in a
  separate handler dispatched from `src/http/server.ts`, as `handleImages` does.
- `server.ts` sends every unclassified `/api/apps/*` path to `handleChat`
  (`src/http/server.ts:140-170`). New app deletion routes must live under `/api/projects/...`.
- Native dialogs use `data-dialog-open`/`data-dialog-close` (`assets/app.js:63-93`, loaded globally
  by `src/http/ui.ts:284`). `data-ssh-confirm` is a `window.confirm` loaded only on `/ssh`;
  `data-confirm-clear` is settings-specific. There is no generic `data-confirm`.
- Destructive actions use `btn btn-danger` (`src/http/settings.ts:1626-1645`) and `trash`
  (`src/http/ui.ts:69-70`).

### 3.6 Concurrency

`InstanceManager.ensure` and `stopApp` are serialized per app by an in-memory promise chain
(`src/opencode/manager.ts:786-797`). The runner has no per-app lock. A deletion must:

- hold a single process-wide deletion mutex (deletions are rare and destructive; this removes
  cross-lock and manifest ordering problems; the writer lock is also single-node),
- mark the app/project durably before the destructive filesystem/manifest steps, and
- make `ensure` and add-app refuse while a deletion is pending.

`stopApp` clears the in-memory entry and endpoint authorization **before** `runtime.delete`
(`src/opencode/manager.ts:631-637`). On a runtime failure the app may be partially stopped and the
manager has forgotten its endpoint. The deletion design must not claim "nothing changed"; the plan
will move the in-memory cleanup after a successful delete and re-read status on failure.

## 4. Decision

Add a coordinator-side `DeletionService`, a durable deletion marker, an async HTTP handler, a
targeted image purge, and the missing runtime/network cleanup. Add one small migration for the
markers. Do not add a foreign-key migration; explicit deletes handle the missing cascades.

### 4.1 Durable deletion markers

Migration v11 adds:

```sql
ALTER TABLE apps ADD COLUMN deleting INTEGER NOT NULL DEFAULT 0 CHECK (deleting IN (0, 1));
ALTER TABLE projects ADD COLUMN deleting INTEGER NOT NULL DEFAULT 0 CHECK (deleting IN (0, 1));
```

`registerProject` upserts do not touch `deleting`, so a startup scan cannot clear a pending deletion.
`CoordinatorService.listApps` and the project query expose the flag; `SiteModel` renders it.

`InstanceManager.ensure` checks `apps.deleting` and `projects.deleting` **inside** the per-app
`#withAppLock` body, before any mkdir, status, or runtime call, and throws a typed
`DeletionPendingError`. The app deletion does not rely on that check alone: it uses a new
`InstanceManager.stopForDeletion(appId)` that performs the runtime delete **and** the
`apps.deleting = 1` update inside one `#withAppLock` body, so a queued `ensure` runs either before the
stop (and is then stopped) or after the marker is committed (and refuses). The typed error is caught
first at every `ensure` caller (chat normal and SSE paths, prompts) and returned as
`409 {code:"deletion_pending"}`. The add-app route refuses a project with `projects.deleting = 1` and
an existing app row with `apps.deleting = 1` (`409 deletion_incomplete`). The UI shows a
`Deletion incomplete` badge and a retry action instead of a start/chat action; a failed deletion is
completed, not cancelled. A runtime stop failure writes no marker and leaves the app normal.

### 4.2 Coordinator orchestration

New module `src/coordinator/deletion.ts`:

```ts
class DeletionService {
  constructor(options: {
    db; workspaceRoot; agentsHome; coordinatorStateDir; manager;
    images: ImageService; // required: the runner is required (Q4)
    logger?;
  });
  deleteApp(projectId, appKey, options: { confirm; deleteFiles? }): Promise<DeleteResult>;
  deleteProject(projectId, options: { confirm; deleteFiles? }): Promise<DeleteResult>;
}
```

- `confirm` must exactly equal the app key or project name; otherwise `400`.
- `deleteFiles` defaults to `false`; the UI exposes an explicit `Delete files too` checkbox (Q1).
- The service uses a single process-wide mutex; a second concurrent deletion returns
  `409 deletion_in_progress`. A deletion of an app in a project with `projects.deleting = 1` is also
  refused, because that project deletion owns the operation.
- Before the runtime stop, it calls `await ImageService.assertRunnerIdle(appId)` and then
  `ImageService.reserveDelete(appId, observed)` (synchronous local reservation; `build` checks it
  before
  setting `#active`). A runner build that starts after the async check is caught by the runner-side
  purge gate and becomes a warning (the image remains for GC).
- It parses and validates `.hanse/project.yaml` **before** stopping the app for fail-fast only. The
  manifest path is verified with `lstat`/`realpath` (`.hanse` and `project.yaml` must be real paths
  strictly inside the project root, with no symlink components). At step 6 the manifest is
  re-read/re-parsed/re-verified synchronously immediately before a temp-file + rename in the verified
  `.hanse` directory; the entry is removed by resolved app path, not by basename.
- `DeletionService` exposes synchronous `isActive()`, `isDeletingProject(projectId)`,
  `isDeletingApp(appId)`, and `isDeletingPath(resolvedPath)` reservations. `deleteProject` reserves
  the canonical project root and project state dir; `deleteApp` reserves the app id and, when
  `deleteFiles` is true, the canonical source path. The add-app and create-project routes check them
  and return `409 deletion_in_progress` instead of writing a manifest while a deletion is running.
- It returns `{ deleted: true, kind, projectId, appKey?, warnings }`. Warnings are only for the
  post-commit image purge and optional source deletion; core failures throw
  `DeletionError(status, code, message)`.

Wire it in `serveCommand` (`src/cli/commands.ts:572-622`) with `path.resolve(agentsHome())` (the
same root as `InstanceManager`), `coordinatorStateDir(ctx.stateHome)`, the existing `manager` and
`images`, and add `deletion?: DeletionService` to `HttpDeps`. Construct `deletion` only when
`images` exists (runner and host workspace configured); otherwise the HTTP handler returns `503` for
the deletion routes.

### 4.3 Deletion order (application)

1. **Validate and lock.** Resolve the project/app from the DB; verify `confirm`; acquire the global
   deletion mutex. Parse and validate `.hanse/project.yaml` before stopping anything. Refuse `409` if
   an image build is active (runner status, see 4.5). Refuse if the project is marked deleting.
2. **Filesystem guards.**
   - State root: `<resolved agentsHome>/<sanitize(projectId)>/<sanitize(appKey)>`. Resolve
     `agentsHome`, `workspaceRoot`, and `coordinatorStateDir` with `realpath` before any comparison.
     Require exactly two non-empty segments, reject `.`/`..`, `lstat` both literal segments and
     refuse a symlink or non-directory. Resolve with `resolveWithinRoot`; assert the target is not
     `agentsHome`, the project state dir, the workspace root, or the coordinator state root, and is
     neither equal to nor an ancestor/descendant of another app's state dir in the project, and is
     neither contained by nor contains the coordinator state root (both directions). A sanitize
     collision (`web:api`/`web-api`) returns `409 state_path_collision`.
   - App dir: `resolveAppPath`; refuse if it equals the workspace root, the project root, the agents
     root, or the coordinator state root; refuse a symlink at the literal path; refuse if another DB
     app or manifest entry resolves to the same directory. Guard `deleteFiles` against an ancestor
     of another app's source dir, a parent of `agentsHome`, or any containment relationship with
     `coordinatorStateDir`.
3. **Reserve images.** `await ImageService.assertRunnerIdle(appId)`, then
   `ImageService.reserveDelete(appId, observed)` (synchronous; fails on a coordinator `#active`/pending
   build,
   clearing stale `#active` when the runner reports not-building); clear it if the deletion aborts.
4. **Stop and mark.** Call `manager.stopForDeletion(appId)`. This single `#withAppLock` body checks
   the deletion state, calls the runtime delete, and writes `apps.deleting = 1` before releasing the
   lock, so a queued `ensure` either runs before the stop or refuses after the marker.
   `stopForDeletion` is the deletion path: it ignores `apps.deleting`/`projects.deleting` for its
   target app (idempotent retry) and does not throw `DeletionPendingError`; only `ensure` does. On
   failure, no marker is written; clear the image reservation and abort (the app may be partially
   stopped; a retry repeats the idempotent stop).
5. (Removed: the marker is written by `stopForDeletion`.)
6. **Manifest.** Re-read, re-parse, and re-verify `.hanse`/`project.yaml` synchronously, then remove
   the app entry by resolved app path in one synchronous temp-file + rename. Missing file or entry is
   success.
7. **State.** Remove the app state directory recursively. `ENOENT` is success. Re-check `lstat` and
   containment immediately before `rmSync`.
8. **DB transaction.**
   - `UPDATE handoffs SET target_task_id = NULL WHERE target_task_id IN (SELECT id FROM tasks WHERE app_id = ?)`
     (FK safety net, not history preservation; Q2 deletes the handoffs).
   - `DELETE FROM handoffs WHERE from_app_id = ? OR to_app_id = ?` (approvals and messages cascade).
   - `DELETE FROM settings|provider_keys|setting_secrets WHERE scope = 'app' AND project_id = ? AND app_key = ?`.
   - `INSERT INTO events (scope, type, payload, created_at) VALUES ('app', 'app.deleted', ?, ?)`
     with `JSON.stringify({projectId, appId, appKey})` (durable audit after handoff rows are gone).
   - `DELETE FROM apps WHERE id = ?` (all cascade children).
9. **Post-commit.** `images.purgeApp(appId)` is attempted immediately (Q3); failure is a warning.
   If `deleteFiles` is true, synchronously re-query and canonicalize `projects.root_path` and
   `apps.path`. Allow the deleted app's **own** project root to contain the target (the normal
   `<projectRoot>/apps/<key>` layout). Reject: (a) the target equal to or an ancestor of any project
   root; (b) any other project root containing the target; (c) any app path equal to, inside, or
   containing the target; (d) the app id still exists. If any check fails, skip source deletion and
   add a warning. Otherwise remove the source directory last with the extended
   containment/symlink guards. Clear the image reservation.
10. Release the mutex.

### 4.4 Deletion order (project)

1. Validate, confirm, acquire the global mutex; assert the project has no active build; parse nothing
   from the manifest (the file is being removed).
2. Set `projects.deleting = 1` before stopping anything. This blocks add-app and `ensure` for all
   project apps. If the process crashes, the marker survives and the project can be retried.
3. Re-query the app set and reserve each app's images. Call `manager.stopForDeletion(appId)` for every
   app (each call writes that app's marker inside its lock after a successful stop). On the first
   failure, do **not** clear `projects.deleting`; the project stays `deletion_incomplete` and is
   retried, so no app marker can be stranded under a normal-looking project. Clear image reservations
   on abort.
4. (Removed: `stopForDeletion` writes each app marker.)
5. Remove `.hanse/project.yaml` (synchronous temp-file + rename; missing file is success).
6. Remove the project agents directory (guards as in 4.3; `ENOENT` success; refuse an ancestor of
   another project's state).
7. DB transaction:
   - `UPDATE handoffs SET target_task_id = NULL WHERE target_task_id IN (SELECT id FROM tasks WHERE app_id IN (SELECT id FROM apps WHERE project_id = ?))`.
   - `DELETE FROM handoffs WHERE project_id = ? OR from_app_id IN (SELECT id FROM apps WHERE project_id = ?) OR to_app_id IN (SELECT id FROM apps WHERE project_id = ?)`.
   - `DELETE FROM settings|provider_keys|setting_secrets WHERE project_id = ?` (both project- and
     app-scoped rows; global rows have `project_id = ''`).
   - `INSERT INTO events ... ('project', 'project.deleted', JSON.stringify({projectId, apps: [...]}))`.
   - `DELETE FROM apps WHERE project_id = ?`, then `DELETE FROM projects WHERE id = ?`.
8. Purge each app's images immediately (Q3; failures are warnings). If `deleteFiles` is true,
   synchronously re-query **both** `projects.root_path` and `apps.path`, canonicalize them, and check
   the target root for equality, containment, and ancestry in both directions (no project or app may
   resolve to the target, be inside it, or contain it). If any check fails, skip source deletion and
   add a warning. Otherwise remove the project directory last, but never when it equals the workspace
   root, the filesystem root, the agents root, the coordinator state root, or contains
   `agentsHome`/another app's source/another project's root; never through a symlink component. A
   failure is a warning. The create-project route also checks the active-deletion reservations and
   refuses a root that is being deleted.
9. Release the mutex.

A project deletion uses subqueries rather than a precomputed `IN (...)` list, so an app added before
the project marker was set is still covered; the marker prevents new additions during the operation.

### 4.5 Runtime cleanup gaps

- **Orphan networks.** Add `DockerClient.inspectNetwork(name)` (`GET /networks/{name}`, `404 ->
  undefined`). On the no-container path in `RunnerService.delete`, inspect
  `appNetworkName(appId)` and remove it only when its labels are `hanse.managed=true` and
  `hanse.app.id=<appId>`, **after** `disconnectNetwork(network, coordinatorContainer)` (ignore
  "not connected"). On the container path, verify the same labels before removing the network. Never
  remove an unmanaged network. Tests: orphan network, coordinator attached, unmanaged network,
  unmanaged container with the managed name.
- **Images.** Add `DELETE /v1/images/:appId` (the explicit `usage`/`gc`/`build` branches keep their
  methods and are matched first). It:
  - refuses `409 build_in_progress` when the app has an in-flight build, including the window before
    `#byApp` is registered (a synchronous per-app `#starting` reservation in `ImageBuildService`
    covers `start` before and after each `await`; `#deleting` blocks a new start during purge);
  - enumerates container usage with `listContainers()` (not `system/df`) and protects every image
    used by any container; an in-use removal `409` is reported as a warning, not a fatal error;
  - selects candidates **only by the exact `hanse.app.id === appId` label**;
  - removes only tags matching the exact `appContainerName(appId):` prefix; if the image carries any
    other tag, skips it as `shared_tag`; if it has no tags, removes by image id;
  - never prunes the global build cache;
  - clears the in-memory build record for the app (`ImageBuildService.forget`, which also removes
    `#byBuild` records and refuses while `building`).
- **Coordinator image state.** Add `ImageService.assertRunnerIdle(appId)` (async: runner
  `get(appId).status === "building"`), `reserveDelete(appId, observed)`/`endDelete(appId)`
  (synchronous local reservation; `reserveDelete` fails on coordinator `#active`, including the
  `"pending"` value; `"pending"` is never treated as stale because the build request may still be in
  flight; only a concrete build id reported not-building by `assertRunnerIdle` is reconciled as
  stale; `build` checks the reservation before setting `#active`), `purgeApp(appId)` (calls the
  runner by id, does not call `#getApp` after the DB commit), and `forgetApp(appId)` (clears
  coordinator `#active` and `#builds` entries). `status` re-reads the app row synchronously
  immediately before `#applyRecord`/`#recordVersion` writes; if the row is gone, it returns the
  runner-available view without writing. This closes the FK window on `app_image_versions` even when
  an in-flight `status` resumes after the deletion reservation is cleared. `ImageService.build` also
  refuses an app/project with `deleting = 1`, and a runner build that starts after
  `assertRunnerIdle` is caught by the runner purge gate (warning; image left for GC).
- **Stop failure.** Refactor `InstanceManager.stopApp` to keep `#running` and endpoint auth until
  `runtime.delete` succeeds; on failure, re-read `runtime.status` and do not revoke the token. The
  deletion service then reports a truthful `502` and leaves the app retryable.
- **Unmanaged containers and lifecycle races.** `RunnerService.delete` already lists only
  `hanse.managed=true` and removes by container id; keep that and add a regression test. The runner
  has no per-app delete lock, so `reconcile`/`stopAll` may race a deletion; tolerate `404`/`409` and
  test it.

### 4.6 HTTP contract

New async handler `src/http/deletion.ts`, dispatched from `src/http/server.ts` before `isChat` (and
therefore before `handleRequest`). It resolves `deletion` from `HttpDeps`; if absent, `503`.

Routes:

- `POST /api/projects/:projectId/delete` (browser form and form-encoded API).
- `POST /api/projects/:projectId/apps/:appKey/delete`.
- `DELETE /api/projects/:projectId?confirm=...` (JSON alias).
- `DELETE /api/projects/:projectId/apps/:appKey?confirm=...` (JSON alias).

`confirm` is required in the form body (POST) or query (DELETE). `deleteFiles` is an optional
`true`/`false` field. The handler:

- rejects MCP agent tokens (`403`) and non-human principals (`403`); anonymous JSON `401`, browser
  login redirect;
- returns `200 {deleted, kind, projectId, appKey?, warnings}` for JSON;
- returns `303` with a success notice for browser callers: `/projects` after a project delete,
  `/projects/:projectId` after an app delete. The `return_to` field is used only for the login
  round-trip and ignored after success (the target page may be gone);
- maps `404` unknown, `400` bad confirmation, `409 build_in_progress|deletion_in_progress|
  state_path_collision|shared_app_dir`, `502` runner/runtime failure.

Destructive routes also reject a cross-site `Origin` when present (defense in depth; the existing
SameSite=Strict cookie already blocks cross-site form posts). `src/http/server.ts:122-129` currently
forwards only a subset of headers, so the plan must forward `origin` and `host` into `HttpRequest`
for this check (or compare against the raw request) and test it. The handler returns `503` when
`HttpDeps.deletion` is absent (no runner/host workspace configured). The `409 deletion_pending`
mapping applies to the actual `ensure` callers in `src/http/chat.ts` (normal and SSE) and
`src/http/prompts.ts`; `routeRuntimeStatus` does not call `ensure` and is not part of that mapping.

### 4.7 UI

- Home/projects tables: show a `Deletion incomplete` badge for `deleting` rows.
- Project page (`src/http/dashboard.ts:760-912`): add a `Danger zone` card after the workbench grid.
  If `project.deleting`, show the incomplete state and a `Retry deletion` button instead of the normal
  action; otherwise a `Delete project` `btn-danger` opens a native `<dialog>` with a required exact
  project-name input, an optional `Delete files too` checkbox, hidden `return_to`, Cancel, and a
  `btn-danger` submit. The dialog warns that all apps, sessions, handoffs, credentials, images, and
  (when checked) files are removed.
- Application page (`src/http/application.ts:230-376`): the same pattern with the exact app key. If
  `app.deleting` or the project is deleting, show a banner, disable chat/terminal/start, and offer a
  retry: an app retry when only `app.deleting` is set, a project-deletion retry (with the project-name
  confirmation) when `project.deleting` is set. `SiteModel` must carry both flags so the app page does
  not show a dead retry button.
- No new client script: `data-dialog-open`/`data-dialog-close` are global; native `required` plus
  server-side exact-name validation handle confirmation.

## 5. Schema change

Migration v11 adds `apps.deleting` and `projects.deleting` (both `INTEGER NOT NULL DEFAULT 0 CHECK
(deleting IN (0,1))`). No other schema change. The migration is additive, backward compatible, and
does not rebuild a table. `registerProject`, `create project`, and add-app must not reset these
flags. `instances.state` is not used as a tombstone because a never-started app has no instances row
and the state vocabulary is runner-owned.

## 6. Failure model

- Runtime stop failure (app delete): `stopForDeletion` writes no marker; abort. The container may be
  partially stopped; the app still exists and a retry repeats the idempotent stop. The image
  reservation is cleared.
- Runtime stop failure (project delete): `projects.deleting` stays `1`; the project and any
  already-stopped apps stay `deletion_incomplete` and are retried. This prevents stranded app markers
  under a normal-looking project. A failed project deletion is not cancelled.
- Runner unreachable (application delete): deletion aborts with `502` (Q4); `stopForDeletion` writes
  no marker, so a never-started app is not silently unregistered while a container could exist. A
  project deletion has already written `projects.deleting = 1` before stopping (section 4.4) and
  stays `deletion_incomplete` on the same failure.
- Crash between the runtime delete and the marker `UPDATE` (application delete): the app is stopped but
  normal (no data removed); retry deletion. A project deletion has already set
  `projects.deleting = 1` and stays `deletion_incomplete`.
- Failure after the flag (manifest, state, DB): the app/project stays marked `deleting`; the UI
  offers retry and `ensure`/start is refused. Re-running deletion treats a missing manifest entry,
  missing manifest, and `ENOENT` state directory as success.
- DB transaction failure: rows are unchanged (single transaction), the marker remains, and retry
  works. No ghost app can be started because `ensure` checks the marker inside its lock.
- Image purge failure (including an in-use image `409`): warning; the app rows are gone, images are
  unprotected and will be removed by the next explicit GC.
- Optional source-directory removal failure: warning; the registry is already gone and the manifest
  is absent, so the directory cannot be re-registered by the startup scan.

## 7. Security

- Human-only, SameSite=Strict cookie, no new token or URL secret; destructive routes reject a
  cross-site `Origin` when present.
- Server-side exact-name confirmation, not only a dialog.
- State path: exactly two safe segments, no `.`/`..`/empty, `lstat` both segments, refuse symlinks,
  and compare for equality/ancestry against every other app in the project; `resolveWithinRoot` is a
  second check, not the only one.
- Manifest path: `lstat`/`realpath` `.hanse` and `project.yaml`, require both strictly inside the
  project root and no symlink components; write the temp file in the verified real `.hanse`.
- Source deletion (if enabled): `resolveWithinRoot`, refuse any symlink component, never the
  workspace root, filesystem root, agents root, coordinator state root, project root for an app
  delete, a parent of `agentsHome`, or a directory containing another app/project source or the
  coordinator state root.
- Only `hanse.managed=true` containers/networks and `hanse.app.id`-labelled images are touched.
- Preserve SSH audit, global settings/secrets, SSH hosts, and other projects.
- Log ids, counts, and warnings only; never credentials, prompts, session content, or file contents.

## 8. Alternatives considered

- **Soft delete / archive flag only.** Leaves containers, state, and images; contradicts R1-R4.
- **DB-only deletion.** Manifest resurrection, orphan state, and running containers.
- **FK-cascade-only deletion.** Blocked by handoffs; does not cover settings/secrets, filesystem,
  images, or manifests.
- **Global GC after delete.** Simpler, but does not clear the runner's per-app image record, is
  global and slow, and can remove unrelated garbage. Targeted purge plus the existing GC is chosen.
- **`instances.state = 'deleting'` tombstone.** No row exists for a never-started app, and the state
  column is runner-owned; a dedicated column is clearer.
- **Preserve handoffs with nullable FKs.** Requires a table rebuild; the owner chose deletion plus an
  `events` audit row (Q2).
- **Delete source files by default.** Irreversible and outside the "runtime garbage" scope; the owner
  chose keep-by-default with an explicit checkbox (Q1).

## 9. Non-goals

- Bulk deletion, undo/trash, restore, or cancelling a pending deletion.
- Deleting global SSH hosts, principals, provider keys, or settings.
- Cleaning pre-existing orphan state for apps already absent from the DB.
- A CLI delete command.
- Cross-host/distributed deletion coordination.
- Deleting IDE user data or the workspace root.
- Preserving handoff history (owner chose deletion with an `events` audit row).

## 10. Deletion state matrix

| State | Removed | Preserved |
| --- | --- | --- |
| Container/network | managed app container, `hanse-app-*` network | unmanaged containers/networks |
| Coordinator DB | apps/projects row; instances, tasks, agent_tokens, app_image_versions, app_ssh_hosts, ssh_approvals, ssh_grants (cascade); app-scoped settings/provider_keys/setting_secrets; handoffs touching the app/project; approvals/messages (cascade) | ssh_audit; global settings/secrets; SSH hosts; other projects |
| Filesystem | per-app/project agents dir; manifest entry/file (and source dir only if `deleteFiles`) | source by default; IDE data; workspace root |
| Images | app-labelled images not used by a container and without unrelated tags | base/default images, shared/unrelated tags, images used by containers |
| Audit | an `events` row records the deletion | SSH audit rows |

## 11. Verification

- Unit: `DeletionService` with an in-memory DB and fake runtime/image client; app/project ordering,
  handoff cleanup, app-scoped and project-scoped settings/secrets, marker lifecycle,
  `stopForDeletion` + queued `ensure` (no ghost), project-retry with app markers, add-app on a
  deleting app, manifest idempotency/atomic write/symlink refusal, state-path `.`/`..`/symlink/
  equality guards (`web:api`/`web-api`), source-containment guards (`agentsHome`,
  `coordinatorStateDir` in both directions, sibling apps), manifest re-read/re-add races, a delayed
  in-flight `status` after the reservation clears, preserved SSH audit/global rows, `events` row, and
  409 `deletion_pending` mapping in chat/prompts.
- Runner: `DELETE /v1/apps` idempotency, unmanaged container/network safety, orphan network with the
  coordinator attached, `DELETE /v1/images/:appId` strict label filtering, container protection via
  `listContainers`, shared tags, in-use 409 warning, build-in-progress (`#starting` window), forget
  records, build/purge race, reconcile/stopAll tolerance.
- HTTP: browser `303` + notice, JSON `200`, `401`/`403`, `400`/`404`/`409`/`502`, `503` without a
  runner, route dispatch before `handleChat`, human-only checks (principal and MCP token), `confirm`
  from form/query, `Origin`/`host` forwarding and cross-site rejection.
- Filesystem: state/project dir removal, symlink component refusal, shared app dir refusal, root
  refusal, manifest preserved for sibling apps, source deletion guarded against `agentsHome` and
  sibling sources.
- Migration v11: fresh DB, v10 -> v11, existing rows default to 0; update
  `test/migrations.test.ts`/`test/store.test.ts` version arrays.
- Full gates: `npm run lint && npm run typecheck && npm test && npm run build`.
- Optional live smoke on `deployment-host` after the gates: create a throwaway app, start it, delete it, verify
  no container/network/state/image/settings/handoff row remains, the `events` row and SSH audit
  survive, and a re-add with the same key starts clean.

## 12. Design review record (historical)

This section records each review round and its disposition. The normative rules are sections 4-7; where
a historical entry names an intermediate design (`beginDelete`, `isBuilding`) or an earlier marker
policy, the later entry and the normative sections supersede it.

Independent reviewer: `oracle`, 2026-10-21. Verdict: **CHANGES REQUIRED**.

Findings folded into this revision:

1. Blocker: `.`/`..` app keys could normalize the state target to the project directory and wipe
   every app's state. Fixed by the exact-two-segment guard, dot-segment rejection, ancestor check,
   and tests.
2. Blocker: the async service cannot run from the synchronous `handleRequest`. Fixed with an async
   `handleDeletion` dispatched from `server.ts` before `handleChat`.
3. Blocker: DB-last deletion can leave a startable ghost after a DB failure. Fixed with durable
   `apps.deleting`/`projects.deleting` markers, `ensure`/add-app refusal, and a retry UI.
4. Blocker: concurrent deletes and manifest read-modify-write races. Fixed with a single global
   deletion mutex, a synchronous manifest update, project markers, and subquery-based project
   deletes.
5. Blocker: optional source deletion was ordered before the DB and could delete the workspace root.
   Fixed by moving source deletion after the DB commit, making it warning-only, and adding root,
   symlink, and shared-directory guards.
6. Major: orphan-network cleanup did not disconnect the coordinator. Fixed.
7. Major: `isBuilding` via coordinator `#active` could block forever and a build could race the
   purge. Fixed with runner status checks and a runner-side build/delete gate.
8. Major: a tag-driven image purge could hit another app with a colliding slug. Fixed with strict
   `hanse.app.id` filtering and exact tag-prefix removal.
9. Major: symlinked/shared app directories. Fixed with `lstat` guards and shared-resolved-dir
   refusal.
10. Major: project deletion could race add-app and used `IN (...)` lists. Fixed with the project
    marker and subqueries.
11. Major: the "cross-project handoff history" claim was false. The design now states handoffs are
    deleted and records an `events` row.
12. Major: coordinator image state was not forgotten and purge depended on the deleted row. Fixed
    with `forgetApp`/`purgeApp` and direct runner calls.
13. Major: `stopApp` failure semantics were overstated. Fixed by reordering the in-memory cleanup and
    documenting a truthful retry path.
14. Minor: HTTP confirmation/human-only details. Fixed in 4.6.
15. Minor: reserved image route names and `agentsHome` consistency. Fixed in 4.1/4.5.

Second independent review (`oracle`, 2026-10-21): **CHANGES REQUIRED**. Findings and dispositions:

1. Blocker: shared state directories were checked for ancestry, not equality. Fixed: explicit
   equality against every other app in the project and a `web:api`/`web-api` test.
2. Blocker: `ensure` could start after the marker if the check sat outside `#withAppLock`. Fixed: the
   check is inside the lock before any mkdir/status/runtime call, with a queued-ensure test.
3. Major: project retry could strand app markers. Final rule (supersedes the intermediate
   clear-on-no-app-marker idea): once `projects.deleting = 1` is set, it is never cleared on a stop
   failure; the project stays `deletion_incomplete` and is retried. See 4.4 step 3 and 6.
4. Major: source deletion could contain `agentsHome`/sibling sources or traverse a symlinked
   ancestor. Fixed: extended containment and symlink-component guards; `deleteFiles` stays an
   explicit checkbox (owner Q1).
5. Major: runner-unavailable blocked even never-started deletes. Resolved by owner Q4: the runner is
   required; the design no longer promises a no-runner path.
6. Major: image builds could start during deletion. Fixed: coordinator `beginDelete`/`endDelete`,
   `ImageService.build` refusal on `deleting=1`, runner `#starting` reservation checked before/after
   awaits, and `#deleting` purge gate.
7. Major: add-app could recreate a marked app. Fixed: refuse `409 deletion_incomplete` when the app
   row is marked deleting.
8. Major: project-deleting UI/retry. Fixed: `SiteModel` carries both flags; app actions disabled and
   retry routes to the project deletion.
9. Major: the claimed 409 mapping did not exist. Fixed: catch `DeletionPendingError` first in chat
   (normal and SSE) and prompts. `routeRuntimeStatus` does not call `ensure`, so it is not part of
   the mapping.
10. Major: manifest parse after stop, non-atomic write, basename filtering. Fixed: parse/validate
    before stop, temp-file + rename, filter by resolved app path.
11. Minor: `Origin` was not forwarded. Fixed: forward `origin`/`host` and test the cross-site check.
12. Minor: image purge used `system/df` for container protection and ignored in-use races. Fixed:
    use `listContainers`, treat in-use `409` as a warning, tolerate reconcile/stopAll races.

Third independent review (`oracle`, 2026-10-21): **CHANGES REQUIRED**. Findings and dispositions:

1. Blocker: a queued `ensure` ran before the post-stop marker write. Fixed: deletion now uses
   `InstanceManager.stopForDeletion`, which performs the runtime delete and the marker `UPDATE` in
   one `#withAppLock` body; a queued `ensure` either runs before the stop or refuses after the marker.
2. Major: source deletion could remove the coordinator state root, which the service could not see.
   Fixed: `DeletionService` receives `coordinatorStateDir`; all source/state guards reject equality
   with, containing, or being contained by the coordinator state root.
3. Major: manifest read/write followed symlinks. Fixed: `.hanse`/`project.yaml` are `lstat`/`realpath`
   verified inside the project root and written via a temp file in the verified real directory.
4. Major: the image build check/reserve was not atomic. Fixed: `beginDelete` fails if a coordinator
   `#active`/pending build or a runner `#starting`/`building` build exists; `status`/`#applyRecord`
   skip DB writes while a deletion reservation is held; tests cover the check→reserve window.
5. Minor: the 409 "runtime status" mapping had no `ensure` caller. Fixed: the design/tests name only
   chat (normal/SSE) and prompts.
6. Minor: `images?` left a no-runner path and post-commit re-add could race source deletion. Fixed:
   `images` is required and `deletion` is constructed only with a runner/host workspace (otherwise
   the route is `503`); source deletion re-checks that the app/project row was not re-added and skips
   with a warning.

A fourth focused review is required to confirm these dispositions.

Fourth independent review (`oracle`, 2026-10-21): **CHANGES REQUIRED**. Findings and dispositions:

1. Major: the pre-stop manifest parse was written back after an await, so a concurrent add-app could
   be lost. Fixed: the pre-stop parse is fail-fast only; step 6 re-reads/re-parses/re-verifies the
   manifest synchronously before temp+rename; add-app/create-project check the deletion reservations
   and return `409 deletion_in_progress`.
2. Major: the post-commit "not re-added" check was id-only and missed a re-created project at the
   same root. Fixed: source deletion re-checks by resolved root/path for any project and any app;
   create-project refuses a root with an active deletion.
3. Minor: `beginDelete` could not synchronously inspect the runner. Fixed: split into async
   `assertRunnerIdle` + synchronous local `reserveDelete`; the runner purge gate covers a build that
   starts after the check, and stale `#active` is reconciled from the runner status.
4. Minor: an in-flight `status` could write `app_image_versions` after the reservation cleared. Fixed:
   `status` re-reads the app row synchronously immediately before `#applyRecord`/`#recordVersion`.
5. Minor: the state guard did not state both containment directions and did not resolve the state
   root. Fixed: canonicalize `agentsHome`/`workspaceRoot`/`coordinatorStateDir` and reject both
   directions.
6. Minor: §6 contradicted §4.4 about the project marker. Fixed: the "no durable flag" statement is
   scoped to application deletion; project deletion keeps its marker.

A fifth focused review is required to confirm these dispositions.

Fifth independent review (`oracle`, 2026-10-21): **CHANGES REQUIRED**. Findings and dispositions:

1. Major: app `deleteFiles` did not re-check project roots or reverse containment. Fixed: both app
   and project source deletion re-query canonical `projects.root_path` and `apps.path` and reject
   equality, containment, and ancestry in both directions; `deleteApp` reserves the canonical source
   path when `deleteFiles` is true.
2. Minor: `stopForDeletion` marker semantics were ambiguous for retries/project deletion. Fixed: it
   ignores `apps.deleting`/`projects.deleting` for its target app; only `ensure` throws
   `DeletionPendingError`.
3. Minor: §12 contained stale/contradictory dispositions. Fixed: the section is marked historical and
   the project-marker entry now points to the final never-clear rule.
4. Minor: `reserveDelete` could be read as clearing a legitimate `"pending"` build. Fixed:
   `"pending"` is never stale; `assertRunnerIdle` passes only concrete build ids for reconciliation.
5. Minor: §6's crash bullet was unscoped. Fixed: it is labelled as application-delete behavior and
   notes that a project deletion keeps `projects.deleting`.

A sixth focused review is required to confirm these dispositions.

Sixth independent review (`oracle`, 2026-10-21): **CHANGES REQUIRED**. Finding and disposition:

1. Major: the app `deleteFiles` check rejected any project root containing the target, so the normal
   `<projectRoot>/apps/<key>` layout always skipped source deletion. Fixed: the app's own project
   root may contain the target; the check rejects target equality/ancestry over any project root,
   any other project root containing the target, any app path equal to/inside/containing the target,
   and a still-existing app id. Tests cover the normal layout, `path: .`, and sibling/other-project
   containment.

All raised findings are addressed; the design review gate is closed. Implementation follows in the
plan.

## 13. Owner decisions (closed)

The owner answered the five open questions on 2026-10-21:

- **Q1 - Workspace files:** keep source by default; offer an explicit `Delete files too` checkbox.
  The guarded source-deletion path in 4.3/4.4 applies when checked.
- **Q2 - Handoff history:** delete handoffs that reference the app/project and write an `events` audit
  row. No nullable-FK migration.
- **Q3 - Images:** purge the app's managed images immediately (targeted, after a successful stop).
  Failure or in-use images are warnings; the global GC remains available.
- **Q4 - Runtime failure:** strictly require the runner. A runner failure aborts with `502` before
  any durable marker; deletion is retried later. No force-delete path.
- **Q5 - Confirmation:** require the exact project name or app key, validated server-side.

## 14. Impact

- New: `src/coordinator/deletion.ts`, `src/http/deletion.ts`, migration v11, tests.
- Changed: `src/opencode/manager.ts` (ensure guard, `stopForDeletion`), `src/runner/server.ts`
  (orphan network, image DELETE), `src/runner/docker.ts` (inspectNetwork), `src/runner/images.ts`
  (forget/build gate), `src/runner/image-gc.ts` (per-app purge), `src/images/service.ts`/`client.ts`
  (`assertRunnerIdle`/reserve/endDelete, purge/forget, status row re-check),
  `src/http/server.ts` (dispatch, `origin`/`host`), `src/http/handler.ts` (add-app/create-project
  deletion guards, types), `src/http/chat.ts`/`prompts.ts` (409 mapping),
  `src/http/dashboard.ts`/`application.ts`/`ui.ts` (danger zone, badges), `src/registry`,
  `src/coordinator/service.ts`, `src/store/migrations.ts`, `src/cli/commands.ts` (deletion wiring
  with `coordinatorStateDir`).
- Docs: `docs/current-state.md`, `docs/design/README.md`, `docs/plans/0013-...`,
  `docs/journal/0015-...`, `docs/open-questions.md`.
