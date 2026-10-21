# 0016 - Runtime state reconciliation

Status: implemented, verified, and deployed as coordinator `sha-98033f5`.

## Problem

`instances.state` and `instances.runtime_state` were written on `ensure()` and `stopApp()` only. A
container stopped out of band, or a coordinator restarted while an agent was no longer running, left
the row claiming `running`. The settings/app/chat surfaces then showed `Restart required`; posting the
restart found the agent stopped, returned `Agent is not running; settings apply on next start.`, but
left the row `running`, so the stale marker survived the notice. The same stale row also fed the
runtime endpoint and the overview counts.

## Decision

- `InstanceManager.reconcileStatuses()` probes the runner for every row whose persisted state is not
  already `stopped`, then records the runner's state/endpoint/spec/container through the existing
  `#recordStatusById()`. A row that is `stopped`, `error`, or has no container loses its in-memory
  entry and endpoint authorization.
- Transport failures are not treated as `stopped`: the last known state is preserved, so a
  temporarily unavailable runner cannot turn a live agent into a stopped one.
- The coordinator starts a best-effort reconciler (`15s`, `unref`, initial tick) and stops it in
  `detach()`. This covers both coordinator restarts and out-of-band container stops.
- `restartIfRunning()` now probes the runner first. If the agent is not running, it persists
  `stopped` before returning `false`; a runner transport error propagates to the existing `502`
  path instead of being reported as "not running". The browser failure copy is now neutral:
  `Restart failed. Check the runtime log and retry.`

## Verification

- New manager tests cover a stale `running` row after the container disappears, a failing status
  probe preserving the row, `restartIfRunning()` persisting `stopped`, and the background
  reconciler clearing a stale row.
- `npm run typecheck`, `npm run lint`, `npm test` (84 files, 1,214 tests), and `npm run build`
  pass.

## Accepted debt

- A row already recorded as `stopped` is not continuously reconciled; a stopped row whose
  container was started outside the coordinator stays stopped until the next `ensure`.
- The UI can be stale for up to one reconcile interval; an explicit restart in that window probes
  and corrects the row immediately.
- Each active row is written on every tick even when the state is unchanged. This is cheap at the
  current app scale but not a high-frequency design.
- An externally stopped container does not revoke its agent token; the token remains valid for a
  future start, consistent with `detach()`.

## Deployment - 2026-10-21

Deployed commit `98033f5` to `deployment-host`. The coordinator image is
`ghcr.io/arkaneman/hanse:sha-98033f5` (`sha256:a42642dd...`, ID `573b58a5993e`);
`HANSE_TAG=sha-98033f5`. `HANSE_AGENT_TAG` remains `sha-d2fcc3b`, so
`hanse-agent-default`, `hanse-agent-ide`, and `hanse-runner` stay on their previous tag: this
change is coordinator-only. Pre-deploy backup:
`<BACKUP_DIR>/20261021-152502-pre-runtime-state-reconcile/`; rollback tags
`hanse:rollback-20261021-152502` (`81211910fa40`), `hanse-agent-ide:rollback-20261021-152502`,
and `hanse-runner:rollback-20261021-152502`. Health: static services healthy; `/healthz`, login,
assets, authenticated pages, `/api/projects`, and `/ide/` passed. Live behavior: the row left
`running` by the pre-deploy stop-all was reconciled to `stopped` on startup and the settings page
showed zero `Restart required`; a controlled external `docker stop` was reflected as `error` within
one 15-second tick and the restart marker disappeared; the app was restarted, sessions returned
`200`, and B1/B2 probes passed. Deployment record: `docs/deploy/deploy-log.md` (local-only).
