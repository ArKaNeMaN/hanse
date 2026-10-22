# Plan 0016: Deployment safety and release identity

- Status: implemented, verified, and pushed; host deployment deferred by owner
- Design: [`docs/design/deployment-safety.md`](../design/deployment-safety.md)
- Design reviewer: `oracle` - PASS
- Plan reviewer: `momus`
- Owner decisions: resolved; design section 10
- Date: 2026-10-22

## Delivery bindings

| Binding | Value |
| --- | --- |
| Stage | `0016-deployment-safety` |
| Design artifact | `docs/design/deployment-safety.md` |
| Plan artifact | `docs/plans/0016-deployment-safety.md` |
| Design index | `docs/design/README.md` |
| Plan index | `docs/plans/README.md` |
| Journal | `docs/journal/0019-deployment-safety.md`; index `docs/journal/README.md` |
| Decision record | `docs/decisions/0012-deployment-lock.md` |
| Open questions | none; design section 10 records the resolved owner decisions |
| Verification | `npm run lint && npm run check:sensitive && npm run typecheck && npm test && npm run build` |
| Extra verification | `docker compose config` with dummy required variables; release-config tests |
| Commit policy | one coherent stage commit + push to `origin/main` (owner authorized) |
| Deploy | host deployment is deferred by owner instruction to the separate deployment-worker stage; the push may publish images but does not touch a host |

## Global invariants

- **No DB migration and no new npm dependency.** This stage adds runtime contracts, not schema or
  packages. An existing v12 database starts unchanged.
- **No host-specific data.** No tracked file contains a hostname, address, install path, project id,
  session id, token, or real deployment name. All examples use placeholders; the host runbook stays
  untracked. `npm run check:sensitive` must pass.
- **`/healthz` stays exactly `{"status":"ok"}`.** The new readiness route is separate and
  non-mutating.
- **The deployment lock is advisory, not a security boundary.** It is a state-directory file written
  by the external orchestrator; the coordinator only reads it. The app never sees the state mount.
- **Destructive operations count, fast reconnect does not.** `LifecycleActivity` wraps only
  operations that can mutate a container or image. `inFlightLifecycle` is process-local; the
  `hanse images` CLI is outside the counter but still honors the deployment lock and must not run
  during a deploy.
- **One guard, then run to completion.** A public lifecycle entry point takes its lock guard once at
  entry, before its first destructive step. Once destructive work starts it runs to completion and is
  counted; there are no mid-operation lock rechecks that could leave partial state. Multi-step
  operations (`restartIfRunning`, deletion, `stopAll`, image rollback) must call **private ungated**
  helpers (`#stopLocked`, `#ensureLocked`, `#restartLocked`, or an equivalent already-guarded flag)
  so nested public methods cannot recheck the lock after a container was stopped/deleted. One
  logical operation gets one `LifecycleActivity` span; nested helpers do not open a second span.
- **`ensure` re-reads launch authority.** Inside the per-app lock, the manager constructs an
  authoritative app object from the current `apps` row and passes its `image_ref`/`image_status` to
  `resolveAgentImage`/the runtime spec, not just to a branch decision. Request `ManagedApp`
  snapshots are display data only. Running fast-path reconnect and settings restart-required
  behavior are unchanged.
- **One restart claim per app.** A private `#acquireRestartClaim`/release primitive is used by
  `beginRestart` and `rollbackImage`; `beginRestart` claims synchronously before any await. Sync,
  async, and image-rollback restarts share it. A second claim receives
  `409 restart_in_progress`. Every claim is released in `finally` on success, failure, lock-guard
  abort, or exception. Rollback checks the deployment lock **before** taking the claim, so a
  lock-active rollback cannot leave a stuck claim.
- **Token reconciliation never recreates a container.** A running app's token is reconciled in
  place; any failure returns a typed error and leaves the container untouched. The DB/file invariant
  is eventual, not crash-safe.
- **Schema policy.** A newer/unknown applied migration fails before listen. A checksum mismatch logs
  `schema_checksum_mismatch` with the version and continues (owner decision).
- **Readiness performance.** `/readyz` uses the existing synchronous DB handle. The design's 50 ms
  p99 is a target, not a gate in this stage; `better-sqlite3` inherits `busy_timeout=5000`, so a
  concurrent restore can delay the response. The limitation is documented; a separate read-only
  connection with a short timeout is a follow-up if the target becomes hard.
- **Image identity.** Published images get `sha-<full>`, keep the short tag, and expose the full
  revision through the OCI label and `HANSE_REVISION`. Tags remain mutable; the orchestrator pins
  digests.
- **Errors.** `DeploymentInProgressError` carries `status = 409` and
  `code = deployment_in_progress`. `AgentTokenReconcileError` carries `status = 500` and
  `code = agent_token_reconcile_failed`. A new shared `src/http/errors.ts` maps both:
  - 409: `{"error":"deployment_in_progress","message":"deployment in progress: <phase ?? operation>","retryAfter":30}`
    with `Retry-After: 30`;
  - 409: `{"error":"restart_in_progress"}` for `RestartInProgressError`;
  - 500: `{"error":"agent_token_reconcile_failed"}`.
  The helper is used by **every** affected route: chat/SSE, prompts, context, settings restart,
  image build/rollback, and deletion app/project paths (including the inner deletion catch blocks,
  which must rethrow/map the typed error instead of replacing it with `runtime_stop_failed`).
  Service-level wrappers must not swallow the typed errors.

## Shared interfaces (implement first)

Create these before touching callers.

```ts
// src/coordinator/deployment-lock.ts
export interface DeploymentLockState {
  version: 1;
  id: string;
  phase: string;
  startedAt: string;
  updatedAt: string;
  expiresAt: string;
}

export type DeploymentLockStatus =
  | { active: false; state?: undefined; reason?: "missing" | "stale" | "malformed" }
  | { active: true; state?: DeploymentLockState; reason?: "malformed" };

export class DeploymentLock {
  constructor(path: string, options?: { staleAfterMs?: number; now?: () => number });
  status(): DeploymentLockStatus;
  isActive(): boolean;
  assertUnlocked(operation: string): void;
}

export class DeploymentInProgressError extends Error {
  readonly code: "deployment_in_progress";
  readonly status: 409;
  readonly operation: string;
  readonly phase?: string; // copied from the lock; the HTTP message uses phase ?? operation
  readonly staleAt?: string;
}

// Extend the existing deletion bridge so DeletionService can use an already-guarded stop:
// stopForDeletion(appId: string, options?: { lockChecked?: boolean }): Promise<RuntimeAppStatus>
// deleteApp/deleteProject call it with { lockChecked: true } after their own guard.

// src/coordinator/lifecycle-activity.ts
export class LifecycleActivity {
  begin(operation: string): () => void; // idempotent end
  readonly count: number;
}

// src/opencode/manager.ts
export class AgentTokenReconcileError extends Error {
  readonly code: "agent_token_reconcile_failed";
  readonly status: 500;
  readonly appId: string;
}

export interface RestartClaim {
  accepted: boolean;
  completion?: Promise<boolean>;
}

// Private in InstanceManager (not exported): one shared primitive used by
// beginRestart and rollbackImage. Returns a release function or undefined.
// #acquireRestartClaim(appId: string): (() => void) | undefined

export class RestartInProgressError extends Error {
  readonly code: "restart_in_progress";
  readonly status: 409;
  readonly appId: string;
}

// InstanceManager public rollback entry point.
export interface ImageRollbackOutcome {
  result: AppImageRollbackResult;
  restarted: boolean;
}
rollbackImage(
  app: ManagedApp,
  rollback: () => Promise<AppImageRollbackResult>,
): Promise<ImageRollbackOutcome>;

// src/store/database.ts
export class SchemaTooNewError extends Error {
  readonly code: "schema_too_new";
  readonly applied: number;
  readonly known: number;
}
export class UnknownMigrationError extends Error {
  readonly code: "unknown_migration";
  readonly version: number;
  readonly knownMax: number;
}
```

Environment/config:

- `HANSE_DEPLOY_LOCK_FILE` (absolute; optional). Default:
  `<stateHome>/hanse/deploy.lock`.
- `HANSE_REVISION` is image-provided, not an operator setting.
- `HANSE_TAG`, `HANSE_AGENT_TAG`, `HANSE_IDE_TAG`, `HANSE_RUNNER_TAG` are the release tags.
- `HANSE_IMAGE`, `HANSE_AGENT_IMAGE`, `HANSE_IDE_IMAGE`, `HANSE_RUNNER_IMAGE` remain repository
  values; Compose always appends `:${tag}`.

## Phase 1 - Deployment lock, lifecycle activity, readiness

### Files

- `src/coordinator/deployment-lock.ts` (new)
- `src/coordinator/lifecycle-activity.ts` (new)
- `src/cli/commands.ts`
- `src/opencode/manager.ts`
- `src/images/service.ts`
- `src/coordinator/deletion.ts`
- `src/http/handler.ts`
- `src/http/errors.ts` (new; shared 409/500 mapping)
- `src/http/chat.ts`, `src/http/prompts.ts`, `src/http/context.ts`, `src/http/settings.ts`,
  `src/http/images.ts`, `src/http/deletion.ts` (typed error mapping; Phase 4/5 also touch their
  routes)
- `src/http/server.ts` only if the readiness route needs dispatch changes
- `compose.yaml`, `.env.example`
- New/updated tests: `test/deployment-lock.test.ts`, `test/lifecycle-activity.test.ts`,
  `test/http.test.ts`, `test/manager.test.ts`, `test/image-lifecycle.test.ts`,
  `test/deletion.test.ts`, `test/deletion-http.test.ts`, `test/cli.test.ts`,
  `test/chat-page.test.ts`, `test/prompts-http.test.ts`, `test/context-http.test.ts`

### Implementation

1. Implement `DeploymentLock` exactly as designed:
   - default path `<stateHome>/hanse/deploy.lock`; env override must be absolute;
   - `ENOENT` inactive; all other read/stat/permission errors active;
   - validate `version: 1`, non-empty `id`, valid ISO timestamps, `expiresAt >= updatedAt`;
   - unknown `phase` accepted and logged; unknown `version` malformed;
   - malformed active until file mtime is older than 300 s;
   - stale when `updatedAt` is older than 300 s or `expiresAt` has passed;
   - sliding `expiresAt` clamped to `updatedAt + 2h`;
   - no writes from the coordinator; the file is owned by the orchestrator.
2. Implement `LifecycleActivity` with an idempotent `begin`/end callback and a monotonic count.
   Wrap each **logical** destructive operation once:
   - the destructive part of `InstanceManager.ensure` (not the fast reconnect);
   - `restartIfRunning` as one span (its internal stop/start helpers must not open a second span);
   - `stopApp`, `stopForDeletion`, `stopAll` as their own entry-point spans;
   - `ImageService` build/rollback;
   - `DeletionService` operations.
3. Inject the lock and activity into `InstanceManager`, `ImageService`, `DeletionService`, and
   `HttpDeps`. Construct them once in `serveCommand` from `stateHome`/env. Also construct the lock in
   `imagesCommand` and pass it to the CLI's `ImageService`, so `hanse images build` honors the lock
   (it remains outside the process-local activity counter and is forbidden during a deploy).
4. Enforce the lock:
   - `ensure`: fast reconnect allowed; any fall-through to delete/ensure throws
     `DeploymentInProgressError`, including running/starting with a null endpoint, unknown status,
     missing password, or token-reconciliation failure;
   - `restartIfRunning`: unconditional guard before the status probe; once the guard passes, use
     private `#stopLocked`/`#ensureLocked`/`#restartLocked` helpers so no nested public method
     rechecks the lock;
   - `stopApp`, `stopForDeletion`: guard at entry inside the per-app lock; a multi-step deletion uses
     the private ungated stop helper after its own guard;
   - `stopAll`: one global guard at entry; it does not use per-app locks, and its internal
     stop/reconcile path must not recheck the lock;
   - `ImageService` build/rollback: guard before any mutation;
   - `DeletionService` app/project deletion and retries: guard before the first stop/marker; the
     project `deleting` marker is written only after the guard. Extend the `DeletionManager` bridge
     with `stopForDeletion(appId, { lockChecked?: boolean })`; `deleteApp`/`deleteProject` pass
     `{ lockChecked: true }` after their own guard so a lock appearing mid-operation cannot leave a
     marker without a stop. The default (`lockChecked` false) keeps the public guarded behavior.
5. Do not add mid-operation rechecks. The guard runs once; the counted operation completes. Add a
   test that toggles the lock immediately after the first destructive step and verifies the
   operation either finishes or fails before any partial state (no stopped app with no restart, no
   deletion marker without a stop).
6. Implement `src/http/errors.ts` with the exact 409/500 bodies and `Retry-After` header from the
   global invariants. Update every affected route in the file list, including the inner deletion
   catch blocks that currently replace the error with `runtime_stop_failed`.
7. Add `GET /readyz` next to `/healthz` in `src/http/handler.ts`:
   - unauthenticated, synchronous, read-only;
   - returns `status`, `version`, `revision` (`process.env.HANSE_REVISION || "unknown"`),
     `schemaVersion` (`MAX(version)` or `null`), `deploying`, `inFlightLifecycle`;
   - `Cache-Control: no-store`;
   - database error → `503 {"status":"error","error":"database_unavailable"}`;
   - no `manager`, runtime, or writer calls.
8. Pass `HANSE_DEPLOY_LOCK_FILE` through the `hanse` service environment in `compose.yaml`.
9. Add the state-directory path and readiness/lock docs to `.env.example` comments only where
   appropriate (no host data).

### Acceptance criteria

- An active, stale, expired, malformed-active, malformed-stale, unreadable, and future-mtime lock
  behaves as specified.
- A running app with password/endpoint reconnects under an active lock without
  `runtime.delete`/`runtime.ensure`.
- A stopped app, or a running app with a null endpoint/status failure/token failure, throws
  `DeploymentInProgressError` under an active lock and does not touch the container.
- Manager methods `restartIfRunning`, `stopApp`, `stopForDeletion`, and `stopAll` throw
  `DeploymentInProgressError` under a lock. HTTP routes (restart, image build/rollback, deletion)
  return the exact 409 body/`Retry-After`; `stopAll`/`stopForDeletion` have no HTTP body contract.
- A lock-active 409 is tested through chat/SSE, prompts, context, image build/rollback, settings
  restart, and deletion HTTP paths, not only through manager unit tests.
- An operation that started before the lock runs to completion and keeps `inFlightLifecycle > 0`
  until done.
- Two `/readyz` polls at least two seconds apart are the documented quiescence handshake; a test
  holds a fake operation in flight, asserts the first poll is nonzero, releases it, and only then
  observes two zero polls.
- `hanse images build` honors the lock (CLI) but is not in `inFlightLifecycle`.
- `/readyz` returns the exact contract, is non-mutating, and returns 503 on schema-query failure.
- `/healthz` remains byte-for-byte compatible.
- Every affected route maps `DeploymentInProgressError`/`AgentTokenReconcileError` through the shared
  helper; deletion inner catches preserve the typed error.

### Verification

```bash
npm run lint
npm run check:sensitive
npm run typecheck
npx vitest run test/deployment-lock.test.ts test/lifecycle-activity.test.ts test/http.test.ts test/manager.test.ts test/image-lifecycle.test.ts test/deletion.test.ts test/deletion-http.test.ts test/cli.test.ts test/chat-page.test.ts test/prompts-http.test.ts test/context-http.test.ts
```

## Phase 2 - Schema guard and startup error path

### Files

- `src/store/database.ts`
- `src/cli/commands.ts`
- `test/migrations.test.ts`, `test/store.test.ts`, `test/commands.test.ts`,
  `test/skills-store.test.ts` (fixtures)

### Implementation

1. In `runMigrations`, select `version, checksum` for applied rows and compute `knownMax`/`appliedMax`.
2. Throw `SchemaTooNewError` when `appliedMax > knownMax`; throw `UnknownMigrationError` for an
   applied version absent from `MIGRATIONS` (after the newer check).
3. For a checksum mismatch, log
   `[schema] schema_checksum_mismatch version=<n>: ...` and continue. Do not throw; do not alter the
   applied row.
4. Run the newer/unknown checks before applying any pending migration, so a failing DB is not
   partially migrated.
5. Wrap `openDatabase`/`runMigrations` in `serveCommand`:
   - on `SchemaTooNewError`/`UnknownMigrationError`, print `serve: <message>`, close the DB, return 1
     before any service/listener;
   - a checksum warning does not change the exit code.
6. Other CLI commands keep the top-level error path; they abort on newer/unknown and continue on a
   checksum warning.
7. Replace placeholder checksums in fixtures with real checksums where the fixture is not explicitly
   testing the warning. Keep one fixture that asserts the warning and continued startup.
8. Add a real-v12 fixture (the exact v12 schema/checksum set) that starts unchanged, not only a
   fresh-migration assertion. This is the compatibility check required by the design.

### Acceptance criteria

- A real v12 DB starts unchanged; `runMigrations` is idempotent.
- A v13/unknown-version DB exits 1 before listen with a clear message; no partial migration.
- A tampered checksum logs a warning and startup continues.
- Existing migration tests are updated and green.

### Verification

```bash
npx vitest run test/migrations.test.ts test/store.test.ts test/commands.test.ts test/skills-store.test.ts
```

## Phase 3 - MCP-token reconciliation

### Files

- `src/mcp/agent-tokens.ts`
- `src/opencode/manager.ts`
- `src/cli/commands.ts` (startup order only if needed)
- `src/http/chat.ts`, `src/http/prompts.ts`, `src/http/context.ts` (500 mapping)
- `test/agent-token.test.ts`, `test/manager.test.ts`, `test/context-resume.test.ts`,
  `test/chat-page.test.ts`, `test/prompts-http.test.ts`, `test/context-http.test.ts`,
  `test/mcp-remote.test.ts`

### Implementation

1. Make `mintAgentToken` revoke the previous active row and insert the new row in one
   `better-sqlite3` transaction.
2. In `ensureAgentToken`, after a successful mint, write the token file atomically. If the file write
   fails, revoke the new row and throw; leave no active token row. An orphan file is tolerated and
   repaired on the next reconciliation. Do not restore the previous row unless the previous file
   bytes are also restored.
3. In `InstanceManager.ensure`:
   - replace the fast-path condition with `running && password` and call `ensureAgentToken` before
     setting endpoint authorization;
   - on success require a non-null endpoint;
   - on any reconciliation failure for a running app, throw `AgentTokenReconcileError` (or
     `DeploymentInProgressError` under a lock) and never fall through to delete/recreate;
   - a running/starting app with a null endpoint or unknown status throws under a lock.
4. In `resumeRunning`:
   - reconcile the token before the `#monitorsEnabled()` gate;
   - attach the monitor only if the gate is enabled;
   - on failure log and skip, never delete.
5. `#reconcileStatuses` remains status-only; no token writes on the 15s tick.
6. Extend the shared HTTP error helper to map `AgentTokenReconcileError` to
   `500 {"error":"agent_token_reconcile_failed"}` in chat/SSE, prompts, and context.

### Acceptance criteria

- A running app whose DB token row is missing/rotated is reconciled without `runtime.delete`; the
  container identity/start time is unchanged; the old token gets 401 and the next request succeeds.
- A file-write failure leaves no active row and does not recreate the container; the next reconcile
  repairs it.
- A simulated crash between DB commit and file rename (new active row + old file) is repaired on the
  next startup/ensure; the app container is not recreated.
- Startup reconciliation works with monitors enabled and disabled.
- The 15s reconciler never writes tokens.
- Existing token-mismatch tests are rewritten to expect reconnect, not recreation.
- An in-flight MCP request with the old token gets 401; the next request with the new file succeeds.

### Verification

```bash
npx vitest run test/agent-token.test.ts test/manager.test.ts test/context-resume.test.ts test/chat-page.test.ts test/prompts-http.test.ts test/context-http.test.ts test/mcp-remote.test.ts
```

## Phase 4 - Async restart and shared restart claim

### Files

- `src/opencode/manager.ts`
- `src/http/settings.ts`
- `src/http/handler.ts` (runtime `restarting` field)
- `test/settings-http.test.ts`, `test/manager.test.ts`, `test/http.test.ts`,
  `test/application-page.test.ts`

### Implementation

1. Add `RestartClaim` and `beginRestart`:
   - claim synchronously before any `await`;
   - schedule the work on the next tick;
   - return `{accepted:false}` without a completion promise if already claimed;
   - clear the claim in `finally`;
   - never reject to an HTTP caller; log and reflect errors in the instance row.
2. Make `restartIfRunning` the synchronous wrapper over the same claimed operation; it awaits
   `completion` and uses private `#stopLocked`/`#ensureLocked` helpers so the restart is one guard,
   one `LifecycleActivity` span, and cannot abort between stop and start. A duplicate claim throws
   `RestartInProgressError` (or returns a typed result the route can map).
3. Extend `POST /api/apps/:app/restart`:
   - the handler checks the deployment lock and calls `beginRestart` synchronously **before**
     returning 202; an active lock returns 409 without a claim;
   - `?async=1` returns 202 only after `accepted:true`;
   - duplicate → 409 `restart_in_progress`;
   - the sync route keeps its browser/JSON shape but maps a duplicate claim to 409
     `restart_in_progress` (not the generic 502);
   - both paths honor the deployment lock (`409 deployment_in_progress`).
4. Add `restarting: boolean` to `GET /api/apps/:app/runtime` from `manager.isRestarting(app.id)`;
   keep the rest of the response and DB-only/non-mutating behavior.
5. Document the process-exit limitation: a 202 claim is in memory; if the coordinator exits, the
  app can remain stopped and the caller must retry.

### Acceptance criteria

- Two same-tick async requests cannot both receive 202; exactly one claim wins.
- An active deployment lock returns 409 before a claim/202; no stuck claim.
- Sync and async restarts cannot overlap; image rollback uses the same claim.
- A duplicate sync/async claim maps to 409 `restart_in_progress`, not 502.
- The async response returns before a slow restart completes; errors do not crash the process.
- The sync route keeps its browser/JSON response shape.
- A restart that starts under an active lock completes its stop/start without a mid-operation recheck.
- `/runtime` exposes `restarting` without mutation.

### Verification

```bash
npx vitest run test/settings-http.test.ts test/manager.test.ts test/http.test.ts test/application-page.test.ts
```

## Phase 5 - Manager-owned image rollback

### Files

- `src/opencode/manager.ts`
- `src/images/service.ts`
- `src/http/images.ts`
- `src/http/apps.ts` (no snapshot authority; display only)
- `test/image-lifecycle.test.ts`, `test/manager.test.ts`, `test/http.test.ts`,
  `test/app-image-api.test.ts`

### Implementation

1. Keep `ImageService.rollback` DB-only. Add service helpers if needed to read the full image state
   and restore it.
2. Add `InstanceManager.rollbackImage(app, rollback)` with this exact order:
   - start one `LifecycleActivity` span before the deployment guard;
   - acquire the per-app lock;
   - re-read the authoritative app row and runtime status;
   - **guard the deployment lock before taking any claim**; active lock → 409 with no claim/DB;
   - if running/starting, acquire the private restart claim synchronously before the DB update; a
     duplicate claim → 409 with no DB;
   - snapshot `image_status`, `image_ref`, `image_hash`, `image_base_digest`, `image_built_at`, and
     `image_error`;
   - call the DB-only rollback;
   - if running/starting, restart through a private locked helper that re-reads the authoritative
     image row; never call public `ensure`/`restartIfRunning` while holding the lock;
   - if stopped, no restart; a later `ensure` re-reads the new ref;
   - release the claim in `finally` on every exit (success, restart failure, exception, lock guard
     abort — the guard is before the claim, so the abort path has no claim to release);
   - if the restart fails, restore all snapshot fields and return
     `502 image_rollback_incomplete`;
   - if the restore fails, return `500 image_rollback_restore_failed`.
3. Change the HTTP rollback route to call `manager.rollbackImage` and return:
   - `200` with the rollback result plus `restarted: boolean`; preserve the existing browser form
     redirect/notice path instead of returning JSON to a form post;
   - `409 deployment_in_progress` / `409 restart_in_progress`;
   - `502 image_rollback_incomplete`;
   - `500 image_rollback_restore_failed`.
   Remove the `setTimeout`/post-response restart and update the existing test that expects
   `restartScheduled:true`.
4. In `InstanceManager.ensure`, re-read `apps.image_ref`/`image_status` inside the per-app lock and
   build an **authoritative app object** whose values are passed to `resolveAgentImage` and the
   runtime spec, not just to the branch decision. Do not trust `toManagedApp(found)` image fields.
   Do not change running fast-path reconnect or settings restart-required behavior.
5. Ensure the rollback's DB update, restart, and failure restore are under the one `LifecycleActivity`
   span from item 2, with `begin` before the deployment guard per the global rule.

### Acceptance criteria

- Rollback on a stopped app updates the DB; a later `ensure` starts the new ref.
- Rollback on a running app claims, updates, restarts, and reports `restarted:true`.
- A concurrent `ensure` cannot start the old image after the DB update: it either runs before the
  rollback (and is restarted) or after it (and re-reads the new ref).
- Claim unavailable → 409 and no DB change; lock active → 409 and no DB change and no stuck claim.
- The claim is cleared on success and on every failure path; `isRestarting` returns false afterward.
- Restart failure restores all image fields; restore failure returns 500.
- A later `ensure` on a stopped app uses the re-read `image_ref`/`image_status`, not the stale
  `ManagedApp` snapshot.
- Browser form rollback preserves its existing redirect/notice behavior; JSON callers get the
  documented statuses.
- Existing `test/manager.test.ts` image fixtures seed `apps.image_*`, and
  `test/image-lifecycle.test.ts` no longer expects `restartScheduled:true`.
- No public `ensure`/`restartIfRunning` is called while the app lock is held; the reentrancy test
  fails if either is invoked.

### Verification

```bash
npx vitest run test/image-lifecycle.test.ts test/manager.test.ts test/http.test.ts test/app-image-api.test.ts
```

## Phase 6 - Release identity, CI gate, independent tags, docs

### Files

- `.github/workflows/publish.yml`
- `Dockerfile`
- `compose.yaml`, `compose.build.yaml`, `.env.example`
- `docs/deployment.md`, `README.md`, `docs/current-state.md`
- `test/release-config.test.ts` (new)
- `test/http.test.ts` (readyz/healthz)

### Implementation

1. Publish workflow:
   - add a `verify` job (`checkout`, `setup-node` 22, `npm ci`, `lint`, `check:sensitive`,
     `typecheck`, `test`, `build`), job permissions `contents: read`;
   - add a `docker-verify` matrix for `runtime`, `agent-base`, `agent-default`, `agent-ide`,
     `runner` with `push:false`, `load:false`, `linux/amd64`, `ci-<target>` cache, job permissions
     `contents: read`;
   - `publish` `needs: [verify, docker-verify]`, keeps its matrix and pushes;
   - add `type=sha,format=long` to metadata (keep short);
   - add `verify-images` with `needs: publish`,
     `if: always() && needs.publish.result != 'cancelled'`, login, buildx, 12×10s retry on
     `docker manifest inspect`, digest extraction via `docker buildx imagetools inspect`, fail if any
     of the five full-SHA tags/digests is missing, upload `digests.txt` as `image-digests`.
2. Dockerfile: add `ENV HANSE_REVISION=${REVISION}` to the final `runtime`, `agent-base`,
   `agent-ide`, and `runner` stages (agent-default inherits).
3. Compose:
   - IDE image tag `${HANSE_IDE_TAG:-${HANSE_AGENT_TAG:-${HANSE_TAG:-latest}}}`;
   - runner tag `${HANSE_RUNNER_TAG:-${HANSE_AGENT_TAG:-${HANSE_TAG:-latest}}}`;
   - agent `${HANSE_AGENT_TAG:-${HANSE_TAG:-latest}}`;
   - coordinator `${HANSE_TAG:-latest}`;
   - pass `HANSE_DEPLOY_LOCK_FILE` through the `hanse` service;
   - update `compose.build.yaml` comment (remove the false agent-default claim).
4. `.env.example`: document `HANSE_IMAGE`, `HANSE_TAG`, `HANSE_AGENT_IMAGE`, `HANSE_AGENT_TAG`,
   `HANSE_IDE_IMAGE`, `HANSE_IDE_TAG`, `HANSE_RUNNER_IMAGE`, `HANSE_RUNNER_TAG`,
   `HANSE_DEPLOY_LOCK_FILE`, `HANSE_REVISION` (image-provided), and the repository-only semantics of
   the image variables.
5. `docs/deployment.md`:
   - fix the explicit agent pull commands to source `.env`/use `HANSE_AGENT_TAG`, not shell
     `HANSE_TAG`;
   - fix the overlay `agent-default:dev` claim and `HANSE_AGENT_BUILD_IMAGE`;
   - fix the “both architectures” claim;
   - add `--target runtime` to the local publish example;
   - list all five published images;
   - add the tag table, lock path, `/readyz`, digest pinning, and the CLI-during-deploy prohibition;
   - document the two-poll quiescence handshake (`deploying:true` + `inFlightLifecycle:0` twice,
     ≥2 s apart), 60 s heartbeat, 300 s stale window, sliding 2 h expiry, and the rule that a
     whole-`state/` restore must not remove the lock without rewriting it;
   - update the rollback guidance for independent IDE/runner tags.
6. `README.md`: fix the image list (add agent-base; runner already present), the agent pull command,
   and the readiness reference.
7. `docs/current-state.md`: add `/readyz`, the lock, async restart, token reconciliation, the
   deployment tag variables, `HANSE_REVISION`, the checksum warning policy, and the async-restart
   process-exit limitation; update the topology and limits sections.
8. `test/release-config.test.ts`:
   - parse `compose.yaml`, `compose.build.yaml`, `.env.example`,
     `.github/workflows/publish.yml`, `.github/workflows/ci.yml`, and `Dockerfile`;
   - assert the tag fallbacks and independent tags;
   - assert `verify`, `docker-verify`, `needs`, full-SHA metadata, `verify-images` `if`, retries,
     upload artifact, `ENV HANSE_REVISION` in all final stages;
   - assert no host-specific strings.

### Acceptance criteria

- A Dockerfile regression fails `docker-verify` and prevents `publish`.
- A partial publish is detected by `verify-images`; digests are uploaded.
- Full-SHA tags and `HANSE_REVISION` are present; revision matches the commit.
- Existing `.env` files resolve exactly as before; new tags override independently.
- `/readyz` and lock docs are accurate; the two-poll handshake, heartbeat/stale window, and
  backup/lock interaction are documented; no host data is tracked.
- `docker compose config` validates old, new, empty, and full-reference inputs (full refs are
  documented invalid for image variables).

### Verification

```bash
npm run lint
npm run check:sensitive
npm run typecheck
npx vitest run test/release-config.test.ts test/http.test.ts
docker compose config   # with dummy required env
```

## Phase 7 - Record and commit

1. Write `docs/journal/0019-deployment-safety.md`: context, phases, decisions, evidence, accepted
   debt, deployment deferral, and next steps. Do not restate the design/plan; link them.
2. Update `docs/journal/README.md`, `docs/plans/README.md`, and the design index status (design
   approved, plan reviewed).
3. Write `docs/decisions/0012-deployment-lock.md` (Nygard): advisory file lock, two-poll quiescence,
   sliding lifetime, external-orchestrator ownership, and the residual runner-timeout boundary.
   Record that the owner-authorized deferral is the explicit exception to the local
   `docs/deploy/README.md` rule that every update is deployed after the gates; the host worker stage
   performs the deployment later. Record that `/readyz`'s 50 ms p99 is a target, not a gate in this
   stage, and that the existing `busy_timeout=5000` can delay it under a concurrent restore.
4. Run the full gate:
   ```bash
   npm run lint
   npm run check:sensitive
   npm run typecheck
   npm test
   npm run build
   ```
5. Commit one coherent stage commit (code + tests + docs + record) and push to `origin/main` (owner
   authorized). Do not deploy to a host; the host worker stage is separate.
6. Update the plan status to `implemented, verified, pushed` and the design status remains approved.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Lock is advisory; a runner call can outlive a coordinator timeout | Document the residual; the external orchestrator waits for coordinator zero *and* runner health/step ordering. |
| CLI image build is outside the counter | Explicitly forbid `hanse images` during deploys in deployment docs and the untracked runbook; CLI honors the lock at start. |
| Fast reconnect counted would starve quiescence | Count only destructive paths; fast reconnect excluded. |
| Token reconciliation has a crash window | Eventual repair on startup/ensure; no DB row without file as a terminal state; no container recreation. |
| Image rollback is long and can leave a crash window | Document the long request and process-exit limitation; restore all fields on handled failure. |
| CI duplicate builds increase cost | `docker-verify` uses the CI cache scopes; publish reuses layer cache. |
| Checksum warning can mask an edited migration | Log `schema_checksum_mismatch` with the version; document operator investigation; newer/unknown still fail. |
| Readiness DB query can block on `busy_timeout` | The 50 ms p99 is a target, not a gate in this stage; document the 5 s bound. A separate read-only connection with a short timeout is a follow-up if the target becomes hard. |
| Full-SHA tags are still mutable | Orchestrator pins the digest from the `image-digests` artifact and verifies the revision label. |
| Compose nested interpolation edge cases | `test/release-config.test.ts` plus `docker compose config` for old/new/empty/full-ref inputs. |

## Out of scope

- The external deploy worker, SSH forced command, host checkout, systemd units, backup/rollback
  script, approval flow, and host runbook.
- A DB migration or downgrade path.
- A distributed/multi-node lock.
- Multi-architecture publishing changes.
- A generic self-deploy guide in tracked documentation.
- Changes to chat/handoff/git/terminal semantics beyond the lock guards and token reconciliation.
- Any host-specific data in tracked files.

## Completion checklist

- [ ] Design approved; owner decisions recorded; plan reviewed by Momus.
- [ ] Lock/activity/readiness implemented and tested, including the two-poll quiescence test.
- [ ] Private ungated stop/ensure/restart helpers used by restart, deletion, and `stopAll`; no
      mid-operation lock rechecks.
- [ ] Shared `src/http/errors.ts` used by chat/SSE, prompts, context, settings, images, and deletion;
      inner deletion catches preserve the typed 409.
- [ ] `hanse images build` honors the lock and is tested; it is outside `inFlightLifecycle`.
- [ ] Schema guard + checksum warning implemented and tested, with a real-v12 fixture.
- [ ] Token reconciliation implemented and tested; existing mismatch tests updated; old-token 401 /
      next-request-succeeds and crash-repair tests included.
- [ ] Async restart + shared claim implemented and tested, including lock-before-202 and duplicate
      claim signals.
- [ ] Manager-owned image rollback + full-field restore implemented and tested, including claim
      release in `finally`, authoritative re-read, and browser response compatibility.
- [ ] CI gate, full-SHA/revision, independent tags, docs, release-config tests implemented.
- [ ] `npm run lint`, `check:sensitive`, `typecheck`, `test`, `build` green.
- [ ] Journal, decision record, and indexes written.
- [ ] One coherent commit pushed to `origin/main`.
