# Deployment safety and release identity

- Status: design review PASS (oracle, 2026-10-22); plan review PASS (momus); implemented and verified (journal 0019)
- Date: 2026-10-22
- Stage: `0016-deployment-safety`
- Owners: Hanse maintainers
- Design reviewer: `oracle`
- Plan reviewer: `momus`
- Documentation language: English

## Delivery bindings

| Binding | Value |
| --- | --- |
| Design docs | `docs/design/`; index `docs/design/README.md` |
| Plans | `docs/plans/`; index `docs/plans/README.md` |
| Journal | `docs/journal/`; index `docs/journal/README.md` |
| Decision record | `docs/decisions/0012-deployment-lock.md` |
| Open questions | this document, section 10 |
| Verification | `npm run lint && npm run check:sensitive && npm run typecheck && npm test && npm run build` |
| Commit policy | one coherent stage commit; the owner authorized this stage |

## 1. TL;DR

Add the coordinator-side primitives an external deployment orchestrator needs, without adding
host-specific code or a new privileged API:

1. a **deployment lock** file plus a **lifecycle activity counter** that make destructive app
   lifecycle operations fail closed and give the external orchestrator a two-poll quiescence
   handshake before it switches images;
2. a **schema guard** that refuses a database newer than the running binary and verifies applied
   migration checksums;
3. a non-mutating **readiness/version** endpoint;
4. an **asynchronous restart** mode that returns immediately and is pollable;
5. **MCP-token reconciliation** for running apps, so a database restore does not force a container
   recreation;
6. **CI-gated publishing**, a **full-SHA image identity**, a runtime **revision** value, and
   **independent IDE/runner/agent tags**.

The external deploy worker, SSH forced command, host checkout, backup/rollback script, and runbook
are deliberately out of scope. They follow the owner's deployment design and must use the contracts
defined here.

## 2. Context

Hanse's static services (`hanse`, `hanse-ide`, `hanse-runner`) are Compose services; per-app
containers are created by the runner and are not Compose-managed. Recreating the static stack
therefore leaves app containers running, and an in-flight agent turn can continue while the
coordinator restarts. That property is the foundation of self-deployment, but it is not sufficient:
an external deploy must be able to tell the coordinator "do not recreate app containers now", and the
coordinator must survive a database restore without destroying the app it is trying to protect.

Current constraints found in the code:

- `InstanceManager.ensure()` has a fast reconnect path for a running app, but it requires both the
  opencode password file and a matching MCP token. If the token row is missing after a DB restore,
  it falls through to `runtime.delete()` and recreates the container (`src/opencode/manager.ts:354-432`).
- `runMigrations()` silently ignores rows newer than the code and never verifies the checksums it
  stores (`src/store/database.ts:26-66`).
- `/healthz` is a constant `{"status":"ok"}` and does not expose schema, revision, or deployment
  state (`src/http/handler.ts:474-476`).
- The restart route awaits stop + start, which can outlive the HTTP client
  (`src/http/settings.ts:667-730`).
- Publish and CI run independently; images have only `sha-<short>` tags, and `REVISION` is a label,
  not a runtime value (`compose.yaml`, `.github/workflows/publish.yml`, `Dockerfile`).
- `HANSE_AGENT_TAG` currently drives the per-app agent, IDE, and runner images, so they cannot be
  updated or rolled back independently (`compose.yaml:23,54,91,101`).

The owner decisions that bound this stage:

- the deploying agent is trusted; it may deploy commits that change the coordinator, runner, or
  Compose files, and therefore already has host-root authority through the deploy pipeline;
- a host-owned checkout, not an archive overlay, updates the deployment root;
- images come from GHCR + CI, not a local build farm;
- failed health checks roll back automatically, including restoring the pre-deploy database when a
  migration ran;
- the dev app may be restarted automatically only after the agent's report and an idle period;
- the repository remains host-agnostic: no hostnames, addresses, paths, or host-specific runbooks in
  tracked files; host specifics live in an untracked runbook;
- both runtime safety and release hardening are one stage.

## 3. Goals and non-goals

### Goals

| ID | Goal |
| --- | --- |
| G1 | A deployment lock plus a lifecycle activity counter block every **coordinator-process** operation that would delete, stop, recreate, build over, or roll back a managed app while an external deploy is switching images, with a two-poll quiescence handshake. A running app may still reconnect and serve chat. `hanse images` is operator-only, honors the lock, and is excluded from the counter. |
| G2 | A schema guard rejects a database whose migrations are newer than the binary (or has an unknown applied version) and logs a warning for applied migrations whose checksums do not match the code, continuing startup. |
| G3 | A non-mutating readiness endpoint reports process/DB health, schema version, build revision, and whether a deploy lock is active. |
| G4 | An async restart mode returns before the restart completes and exposes an in-flight marker that can be polled. Sync restart behavior is unchanged. |
| G5 | A running app's MCP token can be reconciled with the coordinator database without deleting or recreating the app container. |
| G6 | Publish runs only after the repository gates pass for the exact commit, publishes a full-SHA tag, and makes the revision available in the image and at runtime. |
| G7 | IDE, runner, and agent tags can be overridden independently with backward-compatible fallbacks. |
| G8 | Documentation, release-config tests, and `current-state` reflect the new contracts; no host-specific data enters tracked files. |

### Non-goals

- The external deployment worker, SSH forced command, host checkout, systemd units, backup/rollback
  script, and host runbook. These belong to the deployment stage that follows the owner's design.
- Automatic deployment from the coordinator; a runner self-deploy endpoint; a generic host-exec
  surface.
- Database downgrade migrations. Rollback still restores a pre-deploy backup when a migration ran;
  this stage only detects and reports the incompatible state.
- A distributed or multi-node lock. Hanse remains a single-host, single-writer application.
- Multi-architecture publishing changes. The publish matrix stays amd64 by default, with the
  existing manual arm64 dispatch.
- A generic self-deploy guide in tracked documentation. Only host-agnostic contracts are documented
  here; the operator runbook stays untracked.
- Changing the `/healthz` contract or the Compose healthcheck.
- Changing chat, handoff, git, terminal, or deletion semantics beyond the lock gates and token
  reconciliation described here.
- CLI image builds as part of the quiescence contract. `hanse images` honors the lock but runs in a
  separate process and is not counted in `inFlightLifecycle`; it must not run during a deploy. The
  external orchestrator uses the coordinator/runner path, not the CLI.

## 4. Requirements

Each requirement is a testable scenario.

| ID | Requirement |
| --- | --- |
| R1 | **Lock blocks destruction, not reads.** While an active lock exists, a running app's `ensure` reconnects and returns its endpoint only when the password and endpoint are usable; server-side `restartIfRunning`, image build/rollback, and app/project deletion return HTTP `409 deployment_in_progress`. A stopped app or a running app with no endpoint is not recreated. The separate `hanse images` CLI honors the lock and must not run during a deploy. Before switching, the orchestrator observes `deploying:true` and `inFlightLifecycle:0` on two consecutive polls at least two seconds apart. |
| R2 | **Lock staleness.** A lock whose `updatedAt` heartbeat is older than the configured stale window, or whose `expiresAt` has passed, is inactive. A malformed lock is treated as active until its file mtime is older than the stale window; it is logged. |
| R3 | **Schema mismatch fails before listen.** Starting against a DB with `max(schema_migrations.version) > max(MIGRATIONS.version)` exits non-zero before the HTTP listener opens and names both versions. |
| R4 | **Checksum mismatch warns and continues.** An applied migration whose stored checksum differs from the code checksum is logged with its version, but startup continues. A newer-than-code or unknown applied version still fails before listen. |
| R5 | **Readiness is non-mutating.** `GET /readyz` performs only reads, returns 200 with `status`, `version`, `revision`, `schemaVersion`, `deploying`, and `inFlightLifecycle`; it never calls `manager.ensure`, `runtime.ensure`, `runtime.delete`, or any writer. If the schema query fails, it returns 503. |
| R6 | **Async restart returns fast.** `POST /api/apps/:app/restart?async=1` returns 202 before a slow restart completes, allows one in-flight restart per app, and returns `409 restart_in_progress` for a duplicate. The sync route keeps its current response shape. |
| R7 | **Token reconciliation preserves the container.** If the DB token row is missing or rotated while the app is running, `ensure`/startup rewrites the token row and file and reconnects without `runtime.delete`; the app container's identity and start time are unchanged. |
| R8 | **Lock-safe token failure.** If a running app's token cannot be reconciled and a deploy lock is active, `ensure` returns `409 deployment_in_progress` rather than deleting the container. |
| R9 | **Publish is CI-gated.** A commit whose repository gates fail produces no published image. The publish workflow has an explicit verification job for the same SHA before the image matrix. |
| R10 | **Image identity is unambiguous.** Published images carry a `sha-<full-commit>` tag; the OCI revision label and a runtime `HANSE_REVISION` value both contain the full commit SHA. |
| R11 | **Tags are independently overridable.** Existing `.env` files without the new tag variables resolve exactly as today. `HANSE_IDE_TAG` and `HANSE_RUNNER_TAG` override only their service; the per-app agent continues to use `HANSE_AGENT_TAG`. |
| R12 | **No schema migration and no new dependency.** The stage adds no DB migration and no npm dependency; an existing v12 database starts unchanged. |
| R13 | **Documentation and secrets.** `docs/current-state.md` and `docs/deployment.md` describe the new behavior; `npm run check:sensitive` passes; readiness, lock, and log output contain no tokens, keys, or host-specific data. |
| R14 | **Performance.** A lock check adds less than 1 ms per lifecycle call; `/readyz` p99 is under 50 ms on a local state database; the async restart response is under 100 ms with a slow restart fake. |

## 5. Design

### 5.1 Deployment lock

#### Contract

The lock is a JSON file in the coordinator state directory, written by the external orchestrator and
read by the coordinator. The default path is `<stateHome>/hanse/deploy.lock`; the environment variable
`HANSE_DEPLOY_LOCK_FILE` overrides it. The app container cannot see or write it because only
`state/hanse` is mounted into the coordinator, never into an app.

```json
{
  "version": 1,
  "id": "0b3c1f8e-6f0e-4b9e-9a51-3d7f0e2a1c44",
  "phase": "switching",
  "startedAt": "2026-10-22T12:00:00.000Z",
  "updatedAt": "2026-10-22T12:00:30.000Z",
  "expiresAt": "2026-10-22T14:00:00.000Z"
}
```

- `phase` is informational and must be one of `preparing`, `backing_up`, `pulling`, `switching`,
  `health_checking`, `rolling_back`. Unknown phases are accepted and logged; the coordinator does
  not act on them.
- `version` must be `1`; `id` must be a non-empty string; `startedAt`, `updatedAt`, and `expiresAt`
  must be valid ISO timestamps; `expiresAt` must not precede `updatedAt`. Missing or invalid
  required fields make the file malformed. An unknown `version` makes it malformed; a future
  version is never silently interpreted with v1 semantics. An unknown `phase` is accepted and
  logged, consistent with the informational-phase rule above; it does not affect lock activity.
- The orchestrator refreshes `updatedAt` and `expiresAt` every 60 seconds. The lock is stale when
  `updatedAt` is older than 300 seconds or when `expiresAt` has passed. `expiresAt` is a **sliding
  cap** from the last heartbeat, not a fixed cap from `startedAt`: the orchestrator writes
  `expiresAt = updatedAt + two hours` on every heartbeat. A valid value longer than two hours from
  the last heartbeat is clamped. A legitimate long image pull therefore stays locked as long as the
  orchestrator heartbeats.
- Read policy: `ENOENT` means inactive. Any other read/stat/permission error is treated as active
  (fail closed) and logged; an operator must remove or repair the file. A malformed file is active
  until its file mtime is older than 300 seconds, then inactive. This fails closed during a switch
  and recovers from a crashed writer.
- Write atomically: write a temporary file in the same directory, `fsync` the file, rename over
  `deploy.lock`, `fsync` the directory, and set mode `0644` explicitly rather than relying on
  `umask`. `HANSE_DEPLOY_LOCK_FILE`, when set, must be an absolute path.
- The lock file is not part of the database backup. A rollback script that restores the whole
  `state/` directory can remove or replace the lock; the orchestrator contract requires restoring
  only the coordinator database (and other non-lock state) or rewriting the lock before continuing.
  This is an external-worker obligation, recorded here because the file lives under `state/hanse/`.

#### Code shape

A new `src/coordinator/deployment-lock.ts` exposes:

```ts
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
  assertUnlocked(operation: string): void; // throws DeploymentInProgressError
}

export class DeploymentInProgressError extends Error {
  readonly code = "deployment_in_progress";
  readonly status = 409;
  readonly operation: string;
  readonly staleAt?: string;
}

export class AgentTokenReconcileError extends Error {
  readonly code = "agent_token_reconcile_failed";
  readonly status = 500;
  readonly appId: string;
}
```

A second injected primitive, `LifecycleActivity`, counts lifecycle operations that can mutate a
container or image:

```ts
export class LifecycleActivity {
  begin(operation: string): () => void;
  readonly count: number;
}
```

`begin()` increments and returns an idempotent `end` callback that decrements in `finally`. It wraps
only operations that can **mutate** a container or image: the destructive part of
`InstanceManager.ensure` (not the fast reconnect path), `restartIfRunning`, `stopApp`,
`stopForDeletion`, `stopAll`, `ImageService` build/rollback, and `DeletionService` operations.
Fast-path reconnect is excluded so continuous chat cannot starve quiescence. The counter is
process-local; the separate `hanse images` CLI is explicitly excluded from G1 (see non-goals) and
must not run during a deploy.

`serveCommand` constructs both the lock and the activity counter from `stateHome` (or
`HANSE_DEPLOY_LOCK_FILE`) and injects them into `InstanceManager`, `ImageService`, and
`DeletionService`. No HTTP endpoint mutates the lock: the external orchestrator owns it, and the
coordinator only reports it.

#### Quiescence handshake

The lock alone is check-once and cannot stop an operation that has already passed its check. The
external orchestrator contract is therefore:

1. write the lock atomically;
2. poll `GET /readyz` until `deploying: true` and `inFlightLifecycle: 0` are observed on two
   consecutive polls at least two seconds apart;
3. only then stop/replace containers or change images;
4. keep heartbeating the lock until the deploy is complete or rolled back;
5. remove the lock on success and on failure.

Each operation calls `LifecycleActivity.begin()` **before** its initial lock guard, so an operation
that starts while the lock is being written is counted. The guard runs once at entry, before the
first destructive step. Once an operation has passed the guard and started destructive work, it must
run to completion and must **not** recheck mid-operation: a mid-operation lock read could abort after
a container was already stopped/deleted and leave partial state. The orchestrator waits for the
counted operation to finish (two zero polls) instead. This is why the quiescence handshake, not a
per-call recheck, is the contract.

Residual limitation: a runtime HTTP call that times out can outlive the coordinator-side operation
the counter sees. The external orchestrator must treat a coordinator-side zero as the coordinator's
quiescence, not a proof that the runner has finished a timed-out call; it should also wait for
runner health and use the deploy worker's own step ordering. This is documented as the best-effort
boundary of a single-host advisory lock. If the owner accepts a strictly best-effort lock, G1/R1
must be downgraded; this design treats the two-poll handshake plus the counted-operation rule as
mandatory.

#### Enforcement points

| Operation | Behavior under an active lock |
| --- | --- |
| `InstanceManager.ensure` with a running app, a working password, a reconciled token, and a non-null endpoint | Reconnect; return the endpoint. No `runtime.delete`/`runtime.ensure`. |
| `InstanceManager.ensure` with a stopped or missing app | Throw `DeploymentInProgressError`; do not create. |
| `InstanceManager.ensure` running/starting but endpoint null, status unknown, password missing, or token reconciliation failed | Throw `DeploymentInProgressError`; do not delete/recreate. |
| `InstanceManager.restartIfRunning` / async restart | Unconditional guard before the status probe; throw/return 409. Once the guard passes, the restart completes and is counted; no mid-operation recheck. |
| `InstanceManager.stopApp` / `stopForDeletion` / `stopAll` | Guard at entry inside the per-app lock; throw before the first stop, including deletion-retry paths. Once stop begins, the counted operation completes. |
| `ImageService` build/rollback in the server | Guard before build/rollback. Image rollback is one claimed operation (DB update + restart) as described in 5.4. The `hanse images` CLI honors the lock but is excluded from the coordinator quiescence counter and must not run during a deploy. |
| `DeletionService` app/project deletion and retries | Throw before the durable deletion marker or runtime stop. |

The lock is advisory, not a security boundary: a compromised coordinator can ignore it. The
quiescence handshake and the counted, run-to-completion operations make it an operational contract;
they do not make it a kernel lock.

#### HTTP mapping

`DeploymentInProgressError` maps to:

```json
{ "error": "deployment_in_progress", "message": "deployment in progress: switching", "retryAfter": 30 }
```

with status `409` and `Retry-After: 30`. A single shared helper, used by every route that can hit
the error, is mandatory: chat/SSE ensure (`src/http/chat.ts`), prompts (`src/http/prompts.ts`),
context compact (`src/http/context.ts`), settings restart (`src/http/settings.ts`), image
build/rollback (`src/http/images.ts`), and deletion (`src/http/deletion.ts`). The image and deletion
services must not wrap `DeploymentInProgressError` into their generic 502/500 error envelopes; the
error carries `status = 409`, and `DeletionService.asDeletionError()` must special-case or pass it
through. The same helper maps `AgentTokenReconcileError` to
`500 {"error":"agent_token_reconcile_failed"}` for chat/prompts/context, so it does not become a
generic 502. Browser form posts receive the same status; no UI redesign is in scope.

### 5.2 Schema guard

`runMigrations` selects `version, checksum` for applied rows and validates them against the code
before applying anything new:

```ts
const appliedRows = db
  .prepare("SELECT version, checksum FROM schema_migrations ORDER BY version")
  .all() as Array<{ version: number; checksum: string }>;
const known = new Map(MIGRATIONS.map((migration) => [migration.version, migration]));
const knownMax = MIGRATIONS.at(-1)?.version ?? 0;
const appliedMax = appliedRows.at(-1)?.version ?? 0;

if (appliedMax > knownMax) {
  throw new SchemaTooNewError(appliedMax, knownMax);
}
for (const row of appliedRows) {
  const migration = known.get(row.version);
  if (migration === undefined) {
    throw new UnknownMigrationError(row.version, knownMax);
  }
  if (checksum(migration.sql) !== row.checksum) {
    // Owner decision: a checksum mismatch is a warning, not a startup gate.
    console.warn(
      `[schema] schema_checksum_mismatch version=${row.version}: the stored checksum differs from the code; continuing`,
    );
  }
}
```

- The newer/unknown-version guard runs before the migration loop, so an incompatible DB is never
  partially migrated.
- `SchemaTooNewError` and `UnknownMigrationError` extend `Error`, carry `code` values
  (`schema_too_new`, `unknown_migration`), and produce a single clear sentence naming the versions.
- A checksum mismatch is a **warning** (`schema_checksum_mismatch`), not a throw; it is logged with
  the version and startup continues. The owner chose compatibility over fail-closed here; a mismatch
  is still visible in the startup log and should trigger an operator investigation.
- `serveCommand` wraps `openDatabase`/`runMigrations` in a local `try/catch`, prints
  `serve: <message>`, closes the DB handle, and returns `1` before any service construction or
  listener for a newer/unknown schema. Other CLI commands (`status`, `images`, `mcp`) keep the
  existing top-level error path; the guard still prevents them from proceeding. Checksum warnings do
  not abort any command.
- Existing test fixtures seed `schema_migrations` with the placeholder checksum `"existing"`
  (`test/migrations.test.ts` and `test/skills-store.test.ts`). The plan must replace those with real
  checksums and add a real-v12 fixture; otherwise strict validation breaks the fixtures rather than
  the product. Git history shows append-only migration changes, so a real v12 database should pass;
  this is an explicit compatibility check, not an assumption.
- No downgrade path and no DB write on failure. The operator restores the pre-deploy backup.

### 5.3 Readiness and version

Add `GET /readyz` next to `/healthz` in `src/http/handler.ts`, before login/API auth, matching the
existing unauthenticated liveness pattern. It is a synchronous read-only handler:

```json
{
  "status": "ok",
  "version": "0.1.0",
  "revision": "0123456789abcdef0123456789abcdef01234567",
  "schemaVersion": 12,
  "deploying": false,
  "inFlightLifecycle": 0
}
```

- `version` comes from `VERSION` (`src/version.ts`).
- `revision` comes from `process.env.HANSE_REVISION || "unknown"`; an empty environment value must
  not become an empty string.
- `schemaVersion` comes from `SELECT MAX(version) FROM schema_migrations`; an absent row is reported
  as `null`.
- `deploying` is `DeploymentLock.isActive()`; `inFlightLifecycle` is `LifecycleActivity.count`.
- It performs no `manager.ensure`, runtime, or writer calls. If the schema query throws, it returns
  `503 {"status":"error","error":"database_unavailable"}` with a bounded message. The synchronous
  `better-sqlite3` read inherits `busy_timeout=5000`; if the 50 ms p99 requirement is treated as
  hard, the plan must use a short-lived read-only connection or a shorter busy timeout for this
  query. The default is acceptable for a single-operator deployment, but the limitation is explicit.
- The response sets `Cache-Control: no-store`.
- The lock and activity objects are injected into `HttpDeps` (or a small readiness callback) so the
  handler does not construct them per request.
- `/healthz` remains exactly `{"status":"ok"}` so existing healthchecks and tests are untouched.
- Add `ENV HANSE_REVISION=${REVISION}` to every final image stage (`runtime`, `agent-base`,
  `agent-ide`, `runner`; `agent-default` inherits from `agent-base`). The publish workflow already
  passes the full commit SHA as `REVISION`. A source build without `REVISION` reports `unknown`.
- Readiness is unauthenticated because it exposes only build/schema/deploy state already visible on
  a trusted LAN, and because it must answer even when settings/auth rows are unavailable. If the
  service can be exposed beyond a trusted LAN, it must sit behind the operator-authenticated surface
  or a network boundary. Section 10 records the alternative.

### 5.4 Async restart

Keep the existing `POST /api/apps/:app/restart` route and add a query mode; the route matcher is
path-based (`src/http/settings.ts:499`), so `?async=1` already dispatches to the same handler.

- `POST .../restart?async=1` returns `202 {"accepted":true,"appId":"..."}` immediately.
- The HTTP handler calls `InstanceManager.beginRestart(app)` **synchronously**, before returning
  202. The return shape is:

  ```ts
  interface RestartClaim {
    accepted: boolean;
    completion?: Promise<boolean>;
  }
  beginRestart(app: ManagedApp): RestartClaim;
  ```

  `beginRestart` claims the app and schedules the work on the next tick. If the app is already
  claimed, it returns `{accepted:false}` without a completion promise; the route returns
  `409 {"error":"restart_in_progress"}`. The claim is never taken inside the timer: two requests in
  the same tick must not both receive 202.
- `beginRestart` is used by the async route (which returns 202 after `accepted`), the sync route
  (which awaits `completion`), and the image-rollback path (which awaits `completion` to decide
  whether to revert), so a sync restart, an async restart, and an image-rollback restart cannot
  overlap. The claim clears in `finally`; errors are logged and reflected in the instance row.
  `restartIfRunning` becomes the synchronous wrapper over the same claimed operation.
- The async path is not tied to the HTTP response; the claim is made before 202 and the work is
  deferred with the existing `setTimeout(() => void ...)` pattern, so a client disconnect does not
  cancel it.
- The sync route keeps `await manager.restartIfRunning` and its existing browser/JSON responses. If
  any restart is in flight, it returns `409 restart_in_progress`; the check and claim are one atomic
  operation.
- `GET /api/apps/:app/runtime` gains an additive `restarting: boolean` field from
  `manager.isRestarting(app.id)`; the rest of the response is unchanged. The route remains DB-only
  and non-mutating.
- Under an active deployment lock, both sync and async restart return `409 deployment_in_progress`.
- Browser forms continue to use the sync route; automation uses async + `/runtime` polling.
- **Limitation:** the claim is in memory. If the coordinator exits after returning 202 and before the
  restart completes, the app can remain stopped and no `restarting` marker survives. The caller must
  treat a stopped app after a 202 as a failure and retry (or use the sync route when the caller needs
  a completion signal). Making 202 durable would require a new persisted intent, which is out of
  scope for this stage.

#### Image rollback is one locked, claimed operation

The current HTTP rollback route changes the image reference in the DB and schedules a restart on the
next tick (`src/http/images.ts:242-253`). Under a lock, or if another restart is in flight, the DB
could say “rolled back” while the running container still uses the old image. The design changes
this interaction:

- **Authoritative app row.** `InstanceManager.ensure` must re-read `apps.image_ref` and
  `image_status` **inside its per-app lock**; it must not use the `imageRef`/`imageStatus` from the
  HTTP `ManagedApp` snapshot (`toManagedApp(found)`), which can be stale. Request snapshots are
  display data, not start authority. This does not change the running fast-path reconnect or the
  settings “restart required” behavior; it only makes the stopped/start decision use the current
  image row.
- **Manager-owned rollback.** The route calls a new manager operation, for example
  `manager.rollbackImage(app, () => imageService.rollback(app.id, app.appKey))`. The manager owns
  the per-app lock; `ImageService.rollback` remains DB-only and is called inside that lock. The
  manager uses private locked helpers for stop/start; it must never call the public `ensure` or
  `restartIfRunning` while holding the lock (non-reentrant).
- **Exact order inside the lock:**
  1. Re-read the authoritative app row and runtime status.
  2. If running or starting, take the restart claim synchronously **before** the DB update. If the
     claim is unavailable, return `409 restart_in_progress` and leave the DB untouched.
  3. Snapshot every image field that `ImageService.rollback` will change: `image_status`,
     `image_ref`, `image_hash`, `image_base_digest`, `image_built_at`, and `image_error`.
  4. Update the DB through `ImageService.rollback`.
  5. If the app was running/starting (including a start that completed before the lock was
     acquired), restart it with the new ref through the private locked helper. A start cannot begin
     during this lock, so the pre-update status is authoritative.
  6. If the app was stopped, no restart is needed; a later `ensure` re-reads the new ref.
- **Failure/revert contract.** If the restart fails after the DB update, restore **all** snapshot
  fields (not only `image_ref`), release the claim, and return `502` with
  `{error:"image_rollback_incomplete"}`. The DB then matches the pre-rollback image row. If the
  restore itself fails, return `500 image_rollback_restore_failed` and leave the diagnostics; do not
  report success.
- **Success response.** On success return `200` with the `AppImageRollbackResult` fields plus
  `restarted: boolean`. The request can be long (stop + start); a disconnected client does not
  cancel the server-side operation. The route no longer schedules a restart after responding.
- **Process-exit qualification.** If the coordinator exits between the DB update and the restart,
  the DB can say “rolled back” while the app still runs the old image. This is the same in-memory
  limitation as async restart: the next explicit restart applies the committed `image_ref`; the
  route cannot revert a process that no longer exists. The design does not claim crash durability
  for the rollback completion.
- **Lock guard.** The deployment lock guard runs before the manager-owned rollback; under an active
  lock the route returns `409 deployment_in_progress` and does not touch the DB.
- The `restarting` flag in `/runtime` covers the rollback's restart portion.

### 5.5 MCP-token reconciliation

The app's MCP bridge reads the token file on every JSON-RPC request
(`src/mcp/remote.ts:82`). The coordinator therefore can rotate the token file while the app container
is running; no app image or container change is required.

Changes in `InstanceManager`:

- **Fast reconnect** (`ensure`): replace `running && password && agentTokenMatches(...)` with
  `running && password`, then call `ensureAgentToken(db, app.id, tokenFile)` before setting endpoint
  authorization. `ensureAgentToken` reuses a matching token or mints and writes a new one (mode
  `0600`, atomic rename).
  - On success, continue only if a non-null endpoint exists.
  - On **any** token reconciliation failure for an already-running app, throw (or return a typed
    coordinator error) and leave the container untouched. Do **not** fall through to
    `runtime.delete`/`runtime.ensure`; recreating the container cannot fix a token-file write or DB
    failure and would destroy an in-flight turn. Under a lock, map this to
    `DeploymentInProgressError`/409; without a lock, surface a `500 agent_token_reconcile_failed`.
  - A running/starting app with a null endpoint, or a failed/unknown status lookup with an existing
    entry, is also a non-reconnectable state: under a lock, throw before any delete.
- **Startup resume** (`resumeRunning`): reconcile the token **before** the `#monitorsEnabled()` gate,
  so a running app with a restored DB gets a valid token even when context monitors are disabled.
  The monitor attachment remains gated by `#monitorsEnabled()`. If reconciliation fails, log and
  skip monitor attachment; never delete the container.
- `#reconcileStatuses` remains status-only; no token writes on the 15-second tick. The startup
  resume and the reconciler are serialized per app by the existing app lock, so they cannot race a
  token write.
- `mintAgentToken` must revoke the previous active row and insert the new one in a single
  `better-sqlite3` transaction. `ensureAgentToken` then writes the file atomically. If the file write
  fails after the DB mint, it revokes the new row and throws; it does **not** restore the previous
  active row unless it also restores the previous file bytes. The failure state is therefore “no
  active token row plus possibly an orphan file”; the next reconciliation mints a new token and
  rewrites the file. The app's MCP calls fail until that reconciliation, but no container is
  recreated.
- The “no active DB row without a matching file” property is **eventual, not crash-safe**: the
  implementation order is “commit the new row, then atomically rename the new file.” A crash between
  those two steps leaves the **new active row plus the old file** (a mismatch), not an absent row.
  A file-write failure after the commit triggers the compensation above and leaves no active row
  (plus a possible orphan file). Startup/`ensure` reconciliation sees the mismatch/no-active state
  and mints/rewrites. The design does not claim a two-phase commit across SQLite and the filesystem,
  and R12 forbids a new pending-token schema.
- **Security:** rotation invalidates the old token immediately. Any in-flight MCP request using the
  old token fails with 401; the bridge's next request re-reads the new file. The token is scoped to
  one app and was already readable by that app.

The reconciliation is the only new behavior that touches running apps; it does not call
`runtime.ensure`, `runtime.delete`, or stop the container.

### 5.6 Release identity and CI gate

#### Publish gate

Add a `verify` job to `.github/workflows/publish.yml`:

```yaml
jobs:
  verify:
    runs-on: ubuntu-latest
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run lint
      - run: npm run check:sensitive
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
  docker-verify:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    permissions: { contents: read }
    strategy:
      fail-fast: false
      matrix:
        target: [runtime, agent-base, agent-default, agent-ide, runner]
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/build-push-action@v6
        with:
          context: .
          target: ${{ matrix.target }}
          platforms: linux/amd64
          push: false
          load: false
          cache-from: type=gha,scope=ci-${{ matrix.target }}
          cache-to: type=gha,mode=max,scope=ci-${{ matrix.target }}
  publish:
    needs: [verify, docker-verify]
    # existing matrix; push true
  verify-images:
    needs: publish
    if: always() && needs.publish.result != 'cancelled'
    runs-on: ubuntu-latest
    permissions: { contents: read, packages: read }
    steps:
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/setup-buildx-action@v3
      - name: Verify all five full-SHA manifests and record digests
        run: |
          base="ghcr.io/${GITHUB_REPOSITORY,,}"
          rm -f digests.txt
          for suffix in "" "-agent-base" "-agent-default" "-agent-ide" "-runner"; do
            ref="${base}${suffix}:sha-${GITHUB_SHA}"
            ok=0
            for attempt in $(seq 1 12); do
              if docker manifest inspect "$ref" >/dev/null 2>&1; then ok=1; break; fi
              sleep 10
            done
            [ "$ok" = 1 ] || { echo "missing manifest: $ref"; exit 1; }
            digest=$(docker buildx imagetools inspect "$ref" | awk '/^Digest:/{print $2; exit}')
            [ -n "$digest" ] || { echo "no digest: $ref"; exit 1; }
            echo "$ref $digest" >> digests.txt
          done
          cat digests.txt
      - uses: actions/upload-artifact@v4
        with:
          name: image-digests
          path: digests.txt
          if-no-files-found: error
```

- `docker-verify` covers the existing CI Docker gate for the exact commit, so a Dockerfile
  regression blocks every image push before the publish matrix starts. It uses the same
  `ci-<target>` cache scopes as CI.
- `publish` has `fail-fast: false`; a transient push failure can still leave a partial set of
  images. `verify-images` runs with `if: always() && needs.publish.result != 'cancelled'`, so it
  executes even after a partial matrix failure. It retries manifest inspection for GHCR propagation,
  records each manifest digest in `digests.txt`, uploads it as the `image-digests` artifact, and
  fails if any of the five full-SHA tags or digests is missing. It does not pull the images to
  inspect config labels; the external orchestrator must verify the revision label and pin the
  digest from the artifact (or inspect manifests itself) when switching.
- `verify` and `docker-verify` override the workflow-level `packages: write` permission to
  `contents: read`. Only `publish` needs the package/attestation permissions.
- This duplicates the CI workflow for the exact commit that publishes. A `workflow_run` trigger was
  rejected because it introduces default-branch context, separate-run bookkeeping, and awkward
  manual dispatch/tag handling; merging CI and publish into one workflow would restructure the
  existing CI for every PR. The duplication is bounded and explicit.

#### Full SHA and revision

- Add `type=sha,format=long` to `docker/metadata-action` in `publish.yml`, in addition to the current
  `type=sha,format=short`. Published images then have `sha-<40-hex>` and `sha-<7-hex>` tags.
- Keep `REVISION=${{ github.sha }}` as a build arg (already present).
- Add `ENV HANSE_REVISION=${REVISION}` to the final Dockerfile stages, so the value is available at
  runtime and in `/readyz`.
- The OCI `org.opencontainers.image.revision` label remains; it is one external verification
  source (`docker image inspect`). Tags and labels are mutable; the deployment orchestrator must
  record and pin the **digest** for each of the five images after `verify-images`, and verify the
  revision label matches the full SHA. This stage does not add a digest tag because Docker tags
  cannot hold a digest; it makes the digest discoverable and gates on all five manifests.
- Do not add an unused `id: build` output. If future tooling needs per-image digests, add it together
  with the consumer rather than leaving a dangling output.

#### Independent tags

`compose.yaml` becomes:

```yaml
# coordinator
image: ${HANSE_IMAGE:-ghcr.io/arkaneman/hanse}:${HANSE_TAG:-latest}

# IDE
image: ${HANSE_IDE_IMAGE:-ghcr.io/arkaneman/hanse-agent-ide}:${HANSE_IDE_TAG:-${HANSE_AGENT_TAG:-${HANSE_TAG:-latest}}}

# runner
image: ${HANSE_RUNNER_IMAGE:-ghcr.io/arkaneman/hanse-runner}:${HANSE_RUNNER_TAG:-${HANSE_AGENT_TAG:-${HANSE_TAG:-latest}}}

# per-app agent
HANSE_AGENT_IMAGE: ${HANSE_AGENT_IMAGE:-ghcr.io/arkaneman/hanse-agent-default}:${HANSE_AGENT_TAG:-${HANSE_TAG:-latest}}
```

The fallback chain preserves every existing `.env`: a deployment that sets only `HANSE_TAG` still
gets the same agent/IDE/runner tag; one that sets `HANSE_AGENT_TAG` keeps the old coupling unless it
also sets the new variables. `.env.example` documents all image/tag variables (`HANSE_IMAGE`,
`HANSE_TAG`, `HANSE_AGENT_IMAGE`, `HANSE_AGENT_TAG`, `HANSE_IDE_TAG`, `HANSE_RUNNER_TAG`), the lock path, and
`HANSE_REVISION` as an image-provided value (not an operator setting).

### 5.7 Documentation corrections

The stage also fixes the release/configuration drift found in the current docs:

- `docs/deployment.md` quick-start and update commands use shell `${HANSE_TAG:-latest}` for the
  explicit agent image pull (lines 59 and 267), which ignores `.env` unless it was sourced and ignores
  `HANSE_AGENT_TAG`. Replace with a `.env`-aware command or `set -a; . ./.env; set +a` before the
  pull; use the resolved agent tag, not `HANSE_TAG`. `README.md:73` has the same issue.
- The source-build overlay claim that it tags `hanse-agent-default:dev` (lines 322-324) is false:
  `compose.build.yaml` has no agent-default service. Document the explicit
  `docker build --target agent-default -t ...` command and remove the nonexistent
  `HANSE_AGENT_BUILD_IMAGE` variable, or add the build target; this stage chooses the documentation
  fix because local agent builds are out of scope. Also fix the stale comment in
  `compose.build.yaml:5-6`.
- The "both architectures" claim (lines 374-375) conflicts with the workflow default
  `linux/amd64`; describe amd64-by-default and the manual arm64 dispatch as the publishing section
  already does (line 570).
- The local publish example (lines 592-595) omits `--target runtime`; because `runner` is the final
  Dockerfile stage, that command would tag the runner image as `hanse:dev`. Add the target and pass
  `VERSION`/`REVISION` explicitly if the example is meant to reproduce a release.
- The published image list (lines 38-40) omits `hanse-runner` and `hanse-agent-base`; the publish
  matrix builds five images. Correct the list. `README.md:55-57` already includes the runner and
  omits only `hanse-agent-base`; fix only the missing base, not a false runner omission.
- `docs/current-state.md` environment table (lines 596-618) lacks the deployment tag variables; add
  `HANSE_TAG`, `HANSE_AGENT_TAG`, `HANSE_IDE_TAG`, `HANSE_RUNNER_TAG`,
  `HANSE_DEPLOY_LOCK_FILE`, and `HANSE_REVISION`, and document `/readyz` and the lock. Add the same
  variables to the `docs/deployment.md` configuration table (lines 163-185), and change the
  `HANSE_AGENT_TAG` description at line 172 from “Agent, IDE, and runner” to “Agent; fallback for
  IDE/runner”.
- Update the rollback guidance at `docs/deployment.md:289` to mention `HANSE_IDE_TAG` and
  `HANSE_RUNNER_TAG`; the current text pins only `HANSE_TAG`.
- Update the health-check section (`docs/deployment.md:392-408`) and the smoke test at
  `docs/deployment.md:599` to include `/readyz` alongside `/healthz`. Update
  `docs/current-state.md:48`, which currently describes only `/healthz`, to cover the separate
  readiness contract.
- Document in `docs/deployment.md` and the untracked host runbook that `hanse images` (CLI) must not
  run during a deploy; it honors the lock but is outside the coordinator quiescence counter.
- Add the new tag variables, lock path, and revision to `.env.example`; document that
  `HANSE_IMAGE`, `HANSE_AGENT_IMAGE`, `HANSE_IDE_IMAGE`, and `HANSE_RUNNER_IMAGE` are repository
  values, not full references, because Compose always appends `:${tag}`. A full reference or digest
  in those variables produces an invalid/double-tagged result.
- Add `HANSE_DEPLOY_LOCK_FILE` to the `hanse` service environment in `compose.yaml` (pass-through
  from `.env`) so the advertised override actually reaches the coordinator; the default
  `state/hanse/deploy.lock` works without it.
- `docs/design/README.md`, `docs/plans/README.md`, and `docs/journal/README.md` get the new entries;
  the new journal entry links this design and the plan rather than restating them.
- No tracked file may contain a hostname, address, install path, project id, session id, or token;
  all examples use placeholders. The untracked host runbook is not part of this stage.

## 6. Alternatives considered

| Decision | Chosen | Alternatives and why rejected |
| --- | --- | --- |
| Lock storage | State-directory JSON file written by the external orchestrator | DB table: the external worker would need SQLite access and a DB restore could erase the lock; a coordinator API would require the coordinator to be up at the exact moment it is being replaced. File is the only contract that survives both. |
| Lock quiescence | File plus `inFlightLifecycle` in `/readyz` and a two-poll handshake | Check-once file only: an operation that already passed the check can still delete/recreate. A kernel-level barrier is out of scope; the two-poll handshake plus counted operations that run to completion is the practical contract. |
| Lock lifetime | Sliding two-hour cap from the last heartbeat | Fixed cap from `startedAt`: a long image pull would silently unlock mutations; a no-cap file would block forever after a crashed writer. |
| Readiness auth | Unauthenticated `GET /readyz` | Human-only `/api/ready`: automation would need the operator token and the endpoint would fail when auth data is unavailable. The response exposes only version/schema/deploy/lifecycle state on a trusted LAN. |
| Restart API | `?async=1` on the existing route | A new `/restart-async` route duplicates auth/lookup/response code; a separate job system is out of scope. The query mode preserves every existing caller. |
| CI gate | `verify` + `docker-verify` in the publish workflow, plus an always-run `verify-images` | `workflow_run` adds cross-workflow context and tag/manual complexity; merging CI and publish restructures PR CI. The explicit preflight costs a duplicate build but blocks any push when a Dockerfile target is broken; `verify-images` runs with `if: always()` and detects partial pushes after a matrix failure. |
| Image identity | Full-SHA tag + revision label + runtime env | Short tag alone: collision risk and no exact identity. Digest-only tag: Docker tags cannot be digests; digests are digests, not tags. Full SHA plus label is human- and machine-readable; digest verification remains the orchestrator's job. |
| Tag coupling | Independent IDE/runner tags with fallbacks | Keeping one `HANSE_AGENT_TAG` for three services: cannot update runner without changing the agent image; cannot roll back independently. Fallbacks preserve existing deployments. |
| Schema guard strictness | Fail on newer/unknown versions; warn on checksum mismatch | Fully strict checksum failure was rejected by the owner to avoid blocking a compatible existing database on a metadata mismatch; fully warn-only was rejected because a newer binary must not run against an incompatible schema. The split keeps the hard safety gate and makes checksum drift visible without a startup outage. |

## 7. Cross-cutting concerns

### Security

- The deployment lock is advisory and not a privilege boundary. The app cannot write it; only the
  coordinator state directory is mounted, and the app does not receive that mount.
- `/readyz` is unauthenticated but exposes only version, revision, schema version, `deploying`, and
  `inFlightLifecycle`. It contains no tokens, paths, project ids, or app data.
- Async restart remains human-only; the existing human principal check is reused.
- Token reconciliation rotates a secret already readable by the app; it does not widen the app's
  access. It removes a reason to recreate the container.
- Checksum verification detects edited/corrupted migrations; it is not a substitute for filesystem
  permissions or backups.
- CI gating reduces the chance of publishing broken images; full-SHA/revision labels make the
  artifact verifiable. Tags remain mutable, so the orchestrator must verify the label/digest.
- No host-specific data enters tracked code, tests, or docs.

### Observability

- Lock transitions (active, stale, malformed) are logged once per status change, with the lock id and
  phase but no secrets.
- `/readyz` includes `deploying`, `inFlightLifecycle`, `schemaVersion`, and `revision`; the external
  orchestrator can gate on it.
- Async restart logs start, failure, and duration; the `/runtime` response exposes `restarting`.
- Schema guard errors are single-line, actionable, and include the applied/known versions.
- Publish verification failures are visible on the same workflow run as the failed publish.

### Rollout

- No DB migration; deploy the coordinator image, then the rest of the release as usual.
- Existing `.env` files keep working; new variables are optional.
- The external orchestrator begins writing the lock only after this stage is deployed. Until then,
  the file is absent and behavior is unchanged.
- The readiness endpoint and async restart are additive; existing clients are unaffected.
- Rollback of this stage is a normal image rollback; no schema state depends on it.

## 8. Failure modes

| Failure | Behavior | Owner |
| --- | --- | --- |
| Lock file malformed | Treated as active until mtime is older than 300 s, logged, 409 for mutations; reads/reconnect still work. | Coordinator / orchestrator |
| Lock file unreadable (`EACCES`, I/O, stat) | Treated as active (fail closed), logged; operator repairs/removes it. `ENOENT` is inactive. | Coordinator / orchestrator |
| Lock writer crashes | Heartbeat stops; lock stale after 300 s; readiness keeps reporting until then; orchestrator recovery removes it. | External orchestrator |
| Long deploy | The sliding `expiresAt = updatedAt + 2h` keeps the lock valid while heartbeats continue; a missed heartbeat makes it stale. | External orchestrator |
| Backup/restore replaces `state/` | The lock may disappear or become stale; the orchestrator must restore only the DB or rewrite the lock before switching. | External orchestrator |
| DB newer than binary | Startup exits 1 before listen with `schema_too_new`; no partial migration. | Operator / rollback |
| Checksum mismatch | Startup logs `schema_checksum_mismatch` with the version and continues; the operator investigates (possible edited migration or corruption). | Operator |
| Readiness DB query fails | 503 `database_unavailable`; no mutation. Under `busy_timeout=5000`, a concurrent restore can delay the response up to five seconds. | Coordinator |
| Async restart fails | Promise logs and clears; instance row reflects stop/running state; caller polls `/runtime`; no HTTP request hangs. | Caller |
| Coordinator exits after 202 restart | The app may remain stopped; no durable marker. The caller detects `state: stopped` and retries; sync restart is the durable-signal alternative. | Caller |
| Token reconcile fails under lock | 409 `deployment_in_progress`; container remains untouched. | Orchestrator |
| Token reconcile fails without lock, running app | Typed 500 (`agent_token_reconcile_failed`); container remains untouched; no fall-through to delete. | Coordinator/operator |
| Publish npm verify fails | `publish` is skipped; no image is pushed. | CI |
| Publish Docker preflight fails | `publish` is skipped; no image is pushed. | CI |
| Publish matrix partially fails | `verify-images` fails because at least one full-SHA manifest is missing; the workflow is not a release. | CI / orchestrator |
| Tag/revision mismatch after pull | Out of scope for this stage; the orchestrator must verify the revision label and pin the digest before switching. | External orchestrator |

## 9. Verification

- `npm run lint`
- `npm run check:sensitive`
- `npm run typecheck`
- `npm test`
- `npm run build`
- New unit tests:
  - `src/coordinator/deployment-lock.ts`: missing, valid, stale, expired, malformed-active,
    malformed-stale, `EACCES`/unreadable-active, future mtime, invalid field/version, sliding-cap
    boundary, heartbeat/stale interaction, and atomic/read-only behavior.
  - Quiescence: a destructive operation that passed its guard before the lock was written runs to
    completion without partial state while `/readyz` reports `inFlightLifecycle > 0`; a new
    destructive operation after the lock is written throws; two zero polls occur only after the
    first finishes. Fast-path reconnect does not increment the counter.
  - `runMigrations`: newer version and unknown version fail; a checksum mismatch warns and continues;
    v12 unchanged; no partial application for the failing cases; placeholder-checksum fixtures role
    depends on whether they intentionally exercise the warning.
  - `serveCommand`: newer/unknown schema returns 1 before listen and closes the DB; a tampered
    checksum is logged but does not prevent startup. Other CLI commands fail on newer/unknown schema
    through the top-level path and continue on a warning.
  - `InstanceManager`: lock + running fast path; lock + stopped → 409; lock + running/starting with
    null endpoint or status failure → 409 and no `runtime.delete`; lock + token reconcile failure →
    409; `stopForDeletion` retry under lock; `stopAll` under lock; token mismatch → reconcile
    without delete; startup resume reconciliation with monitors enabled and disabled; the 15s
    reconciler never writes tokens.
  - Token mint: transactional revoke+insert; a file-write failure revokes the new row and leaves no
    active token, with an orphan file tolerated; the next reconciliation repairs it; a simulated
    crash between DB commit and file rename is repaired on restart. No active row with a different
    file is accepted as a terminal state.
  - In-flight MCP request with the old token returns 401 after rotation; the next request with the
    new file succeeds; the app container is not recreated.
  - `ImageService`/`DeletionService`: lock gates; image rollback takes the restart claim before the
    DB update for running/starting apps, returns 409 without changing the DB when the claim is
    unavailable, and restores **all** image fields (`image_status`, `image_ref`, `image_hash`,
    `image_base_digest`, `image_built_at`, `image_error`) if the restart fails; deletion retries
    under lock.
  - Image rollback vs concurrent `ensure`: for a running and a stopped app, an `ensure` using a stale
    `ManagedApp` snapshot must either run before the rollback and be restarted by it, or after it and
    re-read the new `image_ref`; it must never leave the old image running after the DB update.
    `ensure` re-reads the authoritative app row inside the per-app lock. Add a stopped-at-precheck
    case where a start completes before the rollback lock: rollback must see running, take the
    restart claim, and restart; it must not update the DB without a claim.
  - Image rollback internal helpers: the locked operation must call private locked stop/start
    helpers; a test/type-level assertion must prevent a public `ensure`/`restartIfRunning` call
    while the app lock is held (re-entrant deadlock guard).
  - CLI image build: the lock blocks a new build; a build started before the lock is documented as
    outside the coordinator quiescence counter, so the test asserts the documented exclusion rather
    than a false zero.
  - Existing `test/manager.test.ts` cases at lines 633, 683, 721, and 1148 must be rewritten: they
    currently force teardown by tampering with the token and expect recreation. Under token
    reconciliation they reconnect; use a different teardown trigger and assert no recreation.
  - HTTP: `GET /readyz` body, `Cache-Control: no-store`, empty `HANSE_REVISION` → `unknown`, schema
    query failure → 503, and no manager/runtime call; 409 `deployment_in_progress` from chat,
    prompts, context, settings restart, images, and deletion; 500
    `agent_token_reconcile_failed` from chat/prompts/context; async restart 202/409; sync restart
    unchanged; runtime `restarting`; human-only auth.
  - Async: two same-tick requests cannot both receive 202 (the claim is taken before the response);
    sync-vs-async duplicate; image-rollback restart duplicate; rejection cleanup; and the documented
    process-exit limitation (stopped app + no `restarting` marker).
  - Release config: parse `compose.yaml`, `compose.build.yaml`, `.env.example`,
    `.github/workflows/publish.yml`, `.github/workflows/ci.yml`, `Dockerfile`; assert tag fallbacks,
    `needs: [verify, docker-verify]`, full-SHA metadata, `verify-images` with
    `if: always() && needs.publish.result != 'cancelled'` and bounded retries, `ENV
    HANSE_REVISION` in all final stages, and no host-specific strings.
- Manual/CI checks:
  - `docker compose config` with dummy required variables validates interpolation for old configs,
    new independent tags, empty values, and full-reference inputs (the last must be documented as
    invalid for the image variables).
  - `docker manifest inspect` for all five full-SHA images and digest recording after a real
    publish (release drill, not this stage's default test run).
  - `npm run check:sensitive` passes on all tracked files.
- Live deployment is not part of this stage; the external orchestrator stage performs the drill.

## 10. Owner decisions (resolved)

All owner decisions are closed; no open questions remain.

1. **Quiescence contract.** Accepted: write the lock, poll `/readyz` until `deploying:true` and
   `inFlightLifecycle:0` on two consecutive polls at least two seconds apart, then switch. G1/R1 are
   not downgraded to a best-effort single check.
2. **Readiness exposure.** `/readyz` is unauthenticated, like `/healthz`, and returns only
   `status`, `version`, `revision`, `schemaVersion`, `deploying`, and `inFlightLifecycle` with
   `Cache-Control: no-store`. It must sit behind the operator surface or a network boundary if the
   deployment is exposed beyond a trusted LAN.
3. **Token rotation.** Accepted: rotate a running app's MCP token in place, fail closed on
   reconciliation failure, never recreate the container as a token-recovery mechanism. The eventual
   no-active-row/orphan-file state is repaired on the next reconciliation.
4. **Checksum policy.** Owner chose **warn and continue** for an applied-migration checksum mismatch;
   a newer-than-code or unknown applied version still fails before listen. The warning carries
   `schema_checksum_mismatch` and the version and is visible in the startup log; operators should
   investigate edited migrations or corruption, but a compatible existing DB is not blocked.
5. **Lock lifetime.** 60-second heartbeat, 300-second stale window, sliding two-hour `expiresAt`
   from the last heartbeat (not from `startedAt`).
6. **Scope.** This stage ships coordinator-side contracts and release hardening only. The external
   deploy worker, SSH forced command, host checkout, backup/rollback script, systemd units, and
   runbook remain a separate stage after the owner describes the deployment idea.
7. **Commit/push.** The owner authorized one coherent stage commit and a push to `origin/main` after
   the gates pass. The push may trigger CI and Publish; it does not deploy to a host.

## 11. Document history

- 2026-10-22: initial design for `0016-deployment-safety`, incorporating the owner decisions from
  the research and the independent architecture review.
- 2026-10-22: revised after the first Oracle design review. Added the two-poll quiescence handshake
  and lifecycle activity counter; explicit lock guards for every destructive fall-through and the
  `stopForDeletion`/CLI image paths; shared 409 mapping across all routes; no-fall-through token
  reconciliation with transactional mint and startup ordering; atomic restart claims across sync,
  async, and image rollback; Docker preflight and final image verification in Publish; lock read
  policy, sliding lifetime, atomicity, Compose pass-through, and documentation/test corrections.
- 2026-10-22: second revision after re-review. Removed mid-operation rechecks in favor of a counted
  operation that runs to completion; excluded fast-path reconnect from the counter; explicitly
  excluded the CLI from quiescence and forbade it during deploy; made image rollback one claimed DB
  + restart operation; moved the async claim before 202; made token failure leave no active row and
  documented eventual, not crash-safe, reconciliation; added `status=409`/`agent_token_reconcile_failed`
  mapping; fixed the lock phase contradiction; made `verify-images` always-run with retries and
  digest recording; and expanded the test plan.
- 2026-10-22: third revision after the second re-review. Made image rollback and `ensure` share the
  per-app lifecycle lock and made `ensure` re-read the authoritative `image_ref` instead of trusting
  the request snapshot; defined the rollback completion/process-exit contract; specified the
  `RestartClaim` return shape; corrected the token crash-state wording; uploaded `digests.txt` as
  an artifact; added the CLI prohibition to deployment docs; and added the 500 mapping and
  concurrent-rollback tests.
- 2026-10-22: fourth revision after the final re-review. Made the rollback order explicit (lock →
  runtime status → claim → full image snapshot → DB update → locked restart), made the rollback
  manager-owned and forbade public `ensure`/`restartIfRunning` under the lock, restored all image
  fields on failure, defined the 200/409/502/500 response contract, and corrected the last
  “rechecks” wording.
- 2026-10-22: design review PASS (oracle). Owner decisions closed: two-poll quiescence, unauthenticated
  `/readyz`, in-place token rotation with fail-closed reconciliation, **warn-and-continue on checksum
  mismatch** (newer/unknown still fail), 60s/300s/sliding-2h lock, contracts-only scope, and
  commit+push authorization. Plan pending.
