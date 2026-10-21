# 0013 - Project and application deletion

Status: implemented and verified (journal 0015); deployment pending. Design: [`docs/design/project-and-application-deletion.md`](../design/project-and-application-deletion.md).

## Bindings

- Design reviewer: `oracle` (design review closed after six rounds; all findings addressed).
- Plan reviewer: `momus`.
- Design artifact: `docs/design/project-and-application-deletion.md`; index `docs/design/README.md`.
- Plan artifact: this file; index `docs/plans/README.md`.
- Journal: `docs/journal/0015-project-and-application-deletion.md`; index `docs/journal/README.md`.
- Owner decisions: Q1 keep source by default with a `Delete files too` checkbox; Q2 delete handoffs
  and write an `events` audit row; Q3 immediate targeted image purge; Q4 strictly require the runner;
  Q5 exact-name confirmation.
- Verification per phase: `npm run lint`, `npm run typecheck`, `npx vitest run <files>`, and the full
  `npm run lint && npm run typecheck && npm test && npm run build` before the record.
- Commit: only on explicit owner instruction; one coherent commit for the stage.

## Invariants

1. A deleting app/project is never startable: `apps.deleting` / `projects.deleting` are durable and
   checked inside `InstanceManager.ensure`'s per-app lock.
2. Only managed runtime resources are touched: containers/networks with `hanse.managed=true` and the
   matching `hanse.app.id`; images with the exact `hanse.app.id` label.
3. No path outside the intended root is removed; `.`/`..`, symlinks, shared state dirs, shared source
   dirs, workspace/agents/coordinator-state roots, and siblings are refused.
4. A partial failure leaves a retryable `deletion_incomplete` state, never a normal-looking half-app.
5. SSH audit, global settings/secrets, SSH hosts, and other projects survive.
6. No FK violation is possible during deletion or a concurrent image-status refresh.

## Phase 1 - Schema markers and registry exposure

Boundaries: migration v11, `RegisteredApp`/`ProjectContext`/`SiteModel` flags. No deletion behavior yet.

- Add migration v11:
  `ALTER TABLE apps ADD COLUMN deleting INTEGER NOT NULL DEFAULT 0 CHECK (deleting IN (0,1));`
  `ALTER TABLE projects ADD COLUMN deleting INTEGER NOT NULL DEFAULT 0 CHECK (deleting IN (0,1));`
- Do not add the column to `registerProject`'s upsert column lists; inserts default to 0, updates
  preserve the marker.
- Add `deleting: boolean` to `RegisteredApp`, select `a.deleting` in
  `CoordinatorService.listApps`, and expose `deleting` on `ProjectContext`/`getProjects`.
- Add the flags to the dashboard `SiteModel` project/app types (used in Phase 7).
- Update `test/migrations.test.ts`/`test/store.test.ts` version arrays to `[1..11]`; add a v10→v11
  test proving existing rows default to 0. Add a registry test that re-registration preserves a
  manually set `deleting=1`.

Acceptance: migration applies to a fresh and a v10 DB; all typecheck; no behavior change.

## Phase 2 - Manager guard and deletion stop

Boundaries: `src/opencode/manager.ts`, `src/http/chat.ts`, `src/http/prompts.ts`; no HTTP delete route.

- Add `DeletionPendingError` (status 409, code `deletion_pending`).
- `InstanceManager.ensure`: inside `#withAppLock`, before mkdir/status/runtime, query
  `SELECT a.deleting, p.deleting FROM apps a JOIN projects p ... WHERE a.id = ?`; throw
  `DeletionPendingError` if either is 1. Do not rely on the caller's `ManagedApp` snapshot.
- Extract a lock-free private `#stopLocked(appId)` used by both `stopApp` and `stopForDeletion`:
  perform `runtime.status`/`runtime.delete` first; only after a successful delete remove `#running`,
  clear endpoint auth, record the stopped status, and revoke the token. On failure, re-read
  `runtime.status`, keep the entry/auth, and rethrow.
- `stopForDeletion(appId)` uses `#withAppLock`, calls `#stopLocked`, then writes
  `UPDATE apps SET deleting = 1 WHERE id = ?` in the same locked body. It ignores existing
  `apps.deleting`/`projects.deleting` for its target (idempotent retry); only `ensure` throws.
- Map `DeletionPendingError` first in `src/http/chat.ts` normal and SSE ensure paths and
  `src/http/prompts.ts:564,676` to `409 {error, code:"deletion_pending"}`.
- Tests: ensure queued behind `stopForDeletion` cannot start; retry on an already-marked app;
  runtime delete failure leaves no marker and keeps the in-memory entry; 409 mapping.

Acceptance: no start during deletion; stop failure retryable; existing restart/stop tests unchanged.

## Phase 3 - Runner cleanup and image purge

Boundaries: `src/runner/*` and `src/runner` tests; no coordinator UI.

- Add `DockerRuntime.inspectNetwork?` and `DockerClient.inspectNetwork(name)` (`GET /networks/{name}`,
  `404 -> undefined`); return labels and container endpoints.
- `RunnerService.delete`: on the no-container path, inspect `appNetworkName(appId)`; if
  `hanse.managed=true` and `hanse.app.id=appId`, disconnect the coordinator (ignore not-connected),
  then remove. On the container path, verify the same network labels before removal; never remove an
  unmanaged network. Tolerate 404/409. Tests: orphan network with coordinator attached, unmanaged
  network/container untouched.
- `ImageBuildService`: add a synchronous `#starting` map (appId -> buildId) reserved after validating
  the raw appId and before any await, and a `#deleting` set. `start` refuses if `#deleting` or a
  build for the app is in flight, rechecks after each await, and exposes `building` from `get` while
  `#starting`. Add `forget(appId)` (refuse if building; delete `#byApp`, matching `#byBuild`, and
  `#starting`/`#active`).
- `ImageGcService.purgeApp(appId)`: reuse the GC lock, `systemDf` image list, `listContainers`
  protection, strict `hanse.app.id === appId`, exact `appContainerName(appId):` tag prefix,
  `shared_tag` skip, no build-cache prune, in-use `409` warning. Return `ImageGcReport`.
- Add `DELETE /v1/images/:appId`, after the explicit usage/gc/build/builds routes; validate app id;
  call `purgeApp`, then `forget`; `409 build_in_progress` if building.
- Tests: label/tag filtering (including `web:api`/`web-api`), container protection, shared tag,
  in-use 409, build/purge race, forget, reserved route names, reconcile/stopAll tolerance.

Acceptance: runner deletes only its resources and purges one app's images; existing GC tests pass.

## Phase 4 - Coordinator image service

Boundaries: `src/images/service.ts`, `src/images/client.ts`, tests.

- `RunnerImageClient.purgeApp(appId)` (DELETE, parse `ImageGcReport`) and optional
  `ImageRunnerClient.purgeApp`.
- `ImageService.assertRunnerIdle(appId)` (runner `get` status building -> 409
  `build_in_progress`).
- `reserveDelete(appId, observed)` synchronous local reservation: fail if `#active` has `"pending"`
  or a concrete build id not reported not-building by `observed`; reconcile only concrete stale ids;
  add to `#deleting`. `endDelete` clears it.
- `build` checks `#deleting` and `apps/projects.deleting` before setting `#active`.
- `status`: after `runner.get`, synchronously re-read the app row; if gone, return the
  runner-available view without `#applyRecord`/`#recordVersion` writes.
- `purgeApp(appId)` calls the runner by id (no `#getApp`), and `forgetApp(appId)` clears `#active`
  and `#builds` for the app in `finally`.
- Tests: check→reserve window, pending never stale, delayed status after row deletion, purge/forget
  after deletion, build refusal on markers.

Acceptance: no image DB write after deletion; purge is targeted and best-effort at the caller.

## Phase 5 - DeletionService

Boundaries: new `src/coordinator/deletion.ts`, DB/manifest/path helpers, tests.

- `DeletionService` constructor: `db`, `workspaceRoot`, `agentsHome`, `coordinatorStateDir`,
  `manager`, `images`, logger. One process-wide mutex plus synchronous `isActive`,
  `isDeletingProject`, `isDeletingApp`, `isDeletingPath` reservations. `deleteProject` reserves the
  canonical project root/state dir; `deleteApp` reserves the app id and, when `deleteFiles`, the
  canonical source path.
- `DeleteResult` / `DeletionError`; exact-name `confirm`; `deleteFiles` default false.
- Path helpers: canonicalize roots with `realpath`; require two safe state segments; reject
  `.`/`..`/empty; `lstat` both segments and refuse symlink/non-directory; reject equality,
  containment, and ancestry against other app state dirs, the workspace/agents/coordinator-state
  roots, and project roots; source checks per the design.
- Manifest helper: verify `.hanse`/`project.yaml` with `lstat`/`realpath` inside the project root; at
  write time synchronously re-read/re-parse, remove the entry by resolved app path, and write via
  temp+rename in the verified real `.hanse`.
- `deleteApp` order: validate/lock/pre-parse -> guards -> `assertRunnerIdle` + `reserveDelete` ->
  `manager.stopForDeletion` -> re-read/write manifest -> remove app state dir -> DB transaction
  (null target_task_id, delete handoffs, delete app-scoped settings/provider_keys/setting_secrets,
  insert `events('app','app.deleted',...)`, delete app) -> `images.purgeApp` -> optional guarded
  source deletion (re-query by resolved path; skip on any re-add) -> `endDelete`/release.
- `deleteProject` order: validate/lock -> set `projects.deleting=1` -> re-query apps -> per-app
  `assertRunnerIdle`+reserve+`stopForDeletion` (never clear the project marker on failure) -> remove
  manifest -> remove project agents dir -> DB transaction (null target_task_id, delete handoffs,
  delete all project-scoped settings/provider_keys/setting_secrets, insert `events`, delete apps and
  project) -> purge images -> optional guarded source deletion -> release. Project retry keeps
  `deletion_incomplete`.
- Tests: app/project DB results, cascades and handoffs, events rows, settings/secrets, marker
  lifecycle, retry, add-app/create-project reservation refusal, path collision/symlink/root guards,
  manifest atomic/idempotent/preserved sibling entries, source re-add skip, SSH audit/global rows
  preserved.

Acceptance: a delete leaves no managed runtime/DB/state/image residue for the target and nothing
else; every failure path is retryable or a warning as designed.

## Phase 6 - HTTP and auth

Boundaries: `src/http/deletion.ts`, `src/http/server.ts`, `src/http/handler.ts`,
`src/http/chat.ts`, `src/http/prompts.ts`, tests.

- Add `deletion?: DeletionService` to `HttpDeps`; wire in `serveCommand` only when `images` exists
  (runner + host workspace), with `coordinatorStateDir(ctx.stateHome)` and
  `path.resolve(agentsHome())`.
- Async `handleDeletion`: `isDeletionRoute` for
  `POST /api/projects/:id/delete`, `POST /api/projects/:id/apps/:key/delete`,
  `DELETE /api/projects/:id`, `DELETE /api/projects/:id/apps/:key`; dispatch in `server.ts` before
  `isChat`. Return `503` when `deletion` is absent.
- Auth: reject MCP agent tokens (`verifyAgentToken`) and non-human principals (`403`); anonymous
  JSON `401`; browser login redirect. Parse `confirm` from form/query and `deleteFiles`; exact-name
  validation is also enforced by the service. Browser success `303` (`/projects` or the project
  page) with a notice; JSON `200 {deleted,...}`; map `400/404/409/502`; ignore `return_to` after
  success.
- Forward `origin`/`host` into `HttpRequest` and reject a cross-site origin on destructive routes.
- Add-app guard: refuse `projects.deleting=1` (`409 deletion_incomplete`), an existing app row with
  `deleting=1`, and active deletion reservations (`409 deletion_in_progress`). Create-project guard:
  refuse an active-deletion root/path. Keep both checks synchronous and before any manifest write.
- Tests: route/auth/confirm/redirect/JSON/409/503, origin check, add-app/create-project races,
  `handleChat` interception not triggered.

Acceptance: the deletion API is human-only, confirmed, async-safe, and consistently mapped; no route
collides with chat/git/settings/ssh/images.

## Phase 7 - UI

Boundaries: `src/http/dashboard.ts`, `src/http/application.ts`, `src/http/ui.ts`, `assets/app.js`
(no change expected), tests.

- Project table and app rows: `Deletion incomplete` badge for `deleting`.
- Project page: `Danger zone` card; `Delete project` `btn-danger` -> native `<dialog>` with required
  exact project-name input, optional `Delete files too`, hidden `return_to`, Cancel, confirm. While
  `project.deleting`, show the incomplete state and `Retry deletion`.
- App page: same with exact app key; when `app.deleting` or `project.deleting`, banner, disabled
  chat/terminal/start, retry app deletion or project deletion as appropriate.
- Use existing `data-dialog-open`/`data-dialog-close` and `btn-danger`; do not add a client script.
  Add minimal CSS only if an existing card style is insufficient.
- Tests: markup/badges/dialog fields/flags/retry targets; page tests keep auth redirects.

Acceptance: both pages render the destructive flow with exact-name confirmation and a truthful
incomplete state; no JavaScript dependency beyond the global dialog behavior.

## Phase 8 - Documentation and record

- Update `docs/current-state.md` (deletion surfaces, retention, limitations), `docs/design/README.md`,
  `docs/plans/README.md`, `docs/open-questions.md` (owner decisions closed).
- Write `docs/journal/0015-project-and-application-deletion.md` with what changed, decisions,
  verification evidence, residual risks, and next steps; update the journal index.
- Run the full gates. If a live deployment is requested, perform the throwaway-app smoke on `deployment-host`
  and record it; do not deploy or commit without explicit owner instruction.

## Risks and mitigations

- **FK/order:** handoffs are deleted before apps; `target_task_id` is nulled as a safety net; the
  whole DB change is one transaction.
- **Path destruction:** canonical paths, `lstat`/realpath, symlink refusal, two-direction
  containment, shared-dir checks, source-deletion re-query.
- **Races:** durable markers + `stopForDeletion` under the app lock; global deletion mutex; add-app/
  create-project reservations; image reservation + runner gate + status row re-check.
- **Runner images:** targeted purge can still fail on an in-use/shared image; that is a warning and
  the global GC remains.
- **Migration:** additive only; v10→v11 tested; older code ignores the new columns.

## Out of scope

- Commit/push/deploy (owner instruction required), bulk/undo/cancel deletion, global secret/host
  cleanup, pre-existing orphan state, CLI delete, distributed locking.
