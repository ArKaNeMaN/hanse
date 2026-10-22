# ADR-012: External deployment lock and quiescence handshake

## Status

Accepted (2026-10-22).

## Context

The coordinator is deployed by an external orchestrator while per-app containers keep running. The
orchestrator needs a safe way to stop or replace the static stack without a coordinator lifecycle
operation recreating the app that is running the deployment agent. The coordinator must also survive
a database restore without destroying a running app, and a target database may be restored from a
pre-deploy backup.

Three storage options were considered:

- a database table: the external worker would need SQLite access, and a database restore could erase
  the lock;
- a coordinator HTTP API: it would require the coordinator to be available exactly when it is being
  replaced;
- a file in the coordinator state directory: the external worker can write it, the coordinator can
  read it, and a database-only restore leaves it intact.

A single check-once lock is not enough: an operation that already passed the check can still reach a
container delete/recreate. A quiescence signal is needed.

## Decision

The coordinator reads, and never writes, an advisory JSON lock in its state directory:

- default path `<stateHome>/hanse/deploy.lock`, overridable with an absolute
  `HANSE_DEPLOY_LOCK_FILE`;
- fields `version:1`, `id`, `phase`, `startedAt`, `updatedAt`, `expiresAt`;
- 60-second heartbeat; stale after 300 seconds without a heartbeat or after the sliding
  `expiresAt = updatedAt + 2 hours`;
- `ENOENT` is inactive; other read/stat/permission errors fail closed; malformed content is active
  until its file mtime is older than the stale window.

The external orchestrator protocol is:

1. write the lock atomically;
2. poll `GET /readyz` until `deploying:true` and `inFlightLifecycle:0` are observed on two
   consecutive polls at least two seconds apart;
3. only then stop/replace containers or change images;
4. keep heartbeating until the deploy completes or is rolled back;
5. remove the lock on success and failure.

The coordinator counts destructive lifecycle operations in a process-local `LifecycleActivity`. A
public entry point guards once at entry; multi-step operations use private ungated helpers so no
nested public call rechecks the lock after a container was stopped or deleted. Fast reconnect is
excluded from the counter; the separate `hanse images` CLI is excluded from the counter but honors
the lock and must not run during a deploy.

## Consequences

- A running app with a usable password, token, and endpoint still reconnects and serves chat while
  the lock is active; stopped apps are not started.
- Restart, deletion, image build/rollback, and rollback paths fail closed with
  `409 deployment_in_progress`.
- The external orchestrator can distinguish "the coordinator is quiescent" from "the file exists"
  without a new privileged coordinator API.
- The lock is not a security boundary; a compromised coordinator can ignore it.
- A runner call that outlives a coordinator timeout is not observed by the process-local counter;
  the orchestrator must also wait for runner health and follow its own step ordering.
- The `hanse images` CLI is an operational exception: it honors the lock but is outside quiescence
  and must not run during a deploy.
- A whole-`state/` restore can remove or replace the lock; restore only the database/non-lock state
  or rewrite the lock before continuing.
- The response contract is exact: `409` with
  `{"error":"deployment_in_progress","message":"deployment in progress: <phase|operation>","retryAfter":30}`
  and `Retry-After: 30`.

## Confirmation

The lock, activity counter, quiescence polls, route mappings, restart claims, image rollback
ordering, and schema guard are covered by unit/HTTP tests; the stage gates include
`npm run lint`, `npm run check:sensitive`, `npm run typecheck`, `npm test`, and `npm run build`.
