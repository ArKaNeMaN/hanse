# 0019 - Deployment safety and release identity

- Date: 2026-10-22
- Stage: `0016-deployment-safety`
- Status: implemented, verified, and pushed; host deployment deferred by owner
- Design: [`docs/design/deployment-safety.md`](../design/deployment-safety.md)
- Plan: [`docs/plans/0016-deployment-safety.md`](../plans/0016-deployment-safety.md)
- Decision: [`docs/decisions/0012-deployment-lock.md`](../decisions/0012-deployment-lock.md)

## Why

An external deployment orchestrator must be able to replace the coordinator, IDE, runner, and
per-app images without recreating the very app container that is running the deployment agent. The
coordinator also has to fail closed while that switch is in progress, survive a database restore
without destroying a running agent, and expose an unambiguous release identity.

## What changed

- **Deployment lock and quiescence.** A read-only JSON lock at
  `HANSE_DEPLOY_LOCK_FILE` (default `<state>/hanse/deploy.lock`), plus a process-local
  `LifecycleActivity` counter. Destructive coordinator operations fail with
  `409 deployment_in_progress`; a running app with a working password, token, and endpoint still
  reconnects. The external orchestrator writes the lock, waits for `deploying:true` and
  `inFlightLifecycle:0` on two consecutive `/readyz` polls at least two seconds apart, and only
  then switches. Heartbeat 60 s, stale 300 s, sliding two-hour expiry.
- **Private lifecycle helpers.** `restartIfRunning`, deletion, `stopAll`, and image rollback use
  ungated private stop/ensure/restart helpers so a multi-step operation cannot be aborted after it
  has already stopped or deleted a container. One logical operation has one activity span.
- **Schema guard.** A newer-than-code or unknown applied migration aborts before the listener opens
  and names both versions. A checksum mismatch is logged as `schema_checksum_mismatch` and startup
  continues (owner decision), so a compatible existing database is not blocked.
- **Readiness.** Unauthenticated `GET /readyz` returns `status`, `version`, `revision`,
  `schemaVersion`, `deploying`, and `inFlightLifecycle` with `Cache-Control: no-store`; it is
  non-mutating and returns 503 if the schema query fails. `/healthz` is unchanged.
- **MCP-token reconciliation.** A running app's token is reconciled in place (transactional mint,
  atomic file write, compensation on write failure) instead of deleting/recreating the container.
  Startup reconciliation happens before the monitor gate; the 15 s status reconciler remains
  status-only.
- **Async restart.** `POST /api/apps/:app/restart?async=1` claims synchronously before returning
  202; sync/async/image-rollback restarts share one claim and a duplicate returns
  `409 restart_in_progress`. `/runtime` exposes `restarting`. The claim is in memory; a coordinator
  exit after 202 can leave the app stopped and the caller must retry.
- **Manager-owned image rollback.** The rollback route takes an activity span, the per-app lock,
  authoritative app state, the deployment guard, and the restart claim in that order; it snapshots
  every image field, updates the DB, restarts through a private locked helper, and restores the full
  snapshot on failure. `ensure` re-reads the authoritative `image_ref`/`image_status` inside its
  lock, so a stale request snapshot cannot start the old image after a rollback.
- **Release identity.** Publish is gated by `verify` and a `docker-verify` matrix, publishes
  `sha-<full>` in addition to the short tag, bakes `HANSE_REVISION` into the final images, and runs
  an always-on `verify-images` job that retries manifest inspection, records digests, and uploads
  `image-digests`. IDE and runner tags are independently overridable with backward-compatible
  fallbacks.
- **Documentation.** Deployment and current-state docs now describe the tag matrix, lock/quiescence
  contract, readiness, digest pinning, CLI-during-deploy prohibition, and accepted limits. The
  tracked repository contains no host-specific data.

## Release

- Commit: `1458306` (`feat(deploy): add deployment safety and release identity`).
- CI run: `39784046189` - success.
- Publish run: `39784046194` - success, including `verify`, `docker-verify` (five targets),
  the five-image publish matrix, and `verify-images`.
- Published full-SHA tags (all five images): `sha-1458306f60722c81b82207d34cbb382884390270`.
- Digests are recorded in the workflow artifact `image-digests` (`digests.txt`), for example
  coordinator `sha256:3dd7e69576208d6f7c1bdde5473d4f500521ea8ba74ceab37ad8cbd413733fbc`.
- The runner image was pulled and inspected locally: OCI revision and `HANSE_REVISION` both equal
  the full commit SHA.
- No host deployment was performed; the external deployment-worker stage remains separate.

## Verification

- `npm run lint` - passed.
- `npm run check:sensitive` - passed.
- `npm run typecheck` - passed.
- `npm test` - 1591 tests across 97 files passed.
- `npm run build` - passed.
- `npx vitest run test/release-config.test.ts` - 30 passed.
- `docker compose config --images` with dummy required env validated the old configuration,
  `HANSE_AGENT_TAG`, independent `HANSE_IDE_TAG`/`HANSE_RUNNER_TAG`, and empty-tag fallbacks.
- No host deployment was performed. The owner deferred it to the separate deployment-worker stage
  per the explicit exception in the local deployment runbook.

## Accepted debt and residual risks

- The lock is advisory and single-host. A runner operation that outlives a coordinator timeout is
  not covered by `inFlightLifecycle`; the external orchestrator must also wait for runner health and
  follow its own step ordering.
- The `hanse images` CLI honors the lock but is outside the process-local counter and must not run
  during a deploy.
- Async restart claims and image-rollback completion are in memory; a coordinator exit can leave a
  stop/rollback incomplete and the caller must retry.
- Token reconciliation is eventual, not crash-safe across the DB-commit/file-rename window; the next
  startup/ensure repairs the pair without recreating the container.
- A whole-`state/` restore can remove or replace the deploy lock; restore only the DB/non-lock state
  or rewrite the lock before continuing.
- `/readyz` uses the existing `busy_timeout=5000` handle; the 50 ms p99 is a target, not a gate in
  this stage.
- The publish workflow duplicates the npm and Docker gates in `verify`/`docker-verify`; this is the
  cost of gating the exact publishing commit without a reusable-workflow refactor.
