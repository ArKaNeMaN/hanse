# 0016 - Runtime state reconciliation

Status: implemented and verified; deployment pending.

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

## Deployment

Pending.
