# Journal 0046 - Runtime orphan reaping and bounded in-memory state

Stage: runtime resource-leak fix (handoff specification; no separate design/plan artifact).
Date: 2026-11-08.

## Context

A long-running per-app container accumulated hundreds of zombie processes and approached its
configured memory cap after several days of uptime, then became sluggish. Recreating the container
reset the symptom, which placed the cause in the app runtime rather than the static stack.

The runner creates the app container with the fixed `Entrypoint:
/usr/local/bin/hanse-agent-entrypoint`, which `exec`s `opencode serve`. That overrides the image's
`ENTRYPOINT ["/usr/bin/dumb-init", "--"]`, so `opencode serve` was PID 1 with no reaper. Orphaned
shell/tool/MCP/terminal grandchildren were reparented to it and stayed zombies. Separately, the
stdio-to-HTTP MCP bridge had an unbounded serial request queue with no fetch timeout, and several
coordinator caches were TTL-only or never pruned.

## What changed

- **Runner reaper.** `DockerClient.createContainer` now emits `HostConfig.Init: true` (default), and
  the per-app create site passes `init: true` explicitly. Docker's init is PID 1 and
  `opencode serve` is its child, so orphaned children are reaped. uid 1000, read-only root,
  `cap_drop: ALL`, `no-new-privileges`, mounts, network, and memory/CPU/PID limits are unchanged.
  Applying the default to every runner container also covers the git and image-validation one-shots.
- **MCP bounds.** `runRemoteMcpServer` caps its serial queue (`DEFAULT_MCP_MAX_QUEUED`) and gives
  each forwarded request a timeout (`DEFAULT_MCP_REQUEST_TIMEOUT_MS`); a full queue returns a
  JSON-RPC error instead of holding the request. `runWebMcpServer` caps concurrent handlers
  (`DEFAULT_MCP_MAX_PENDING`). Both servers run inside the app container, so this bounds their
  memory when the coordinator stalls or a burst of tool calls arrives.
- **Coordinator caches.** `src/shared/bounded-cache.ts` adds `setBounded()`. The chat turn-snapshot
  cache (512 entries) and the UI manifest cache (64) use it. `AppStreamRegistry` prunes stale active
  ids even while browser slots stay open, and `ProcessRecovery` evicts expired session-map entries
  (1024 max).
- **Terminal handshake.** The coordinator terminal proxy aborts the in-flight upstream upgrade
  request when the client disconnects before the runner answers. The listener is on `end` as well as
  `close`/`error` because Node HTTP server sockets allow half-open: a normal client FIN emits `end`
  before `close`.
- **Tests.** Docker create-body assertions for `Init`, an opt-in Docker soak that checks PID 1 is an
  init and an orphan burst leaves no zombies, MCP timeout/queue-cap tests, a pre-upgrade terminal
  cleanup test, bounded-cache tests, and app-stream pruning tests.

## Decisions

- Use Docker's built-in init instead of prepending a reaper: it preserves the fixed entrypoint and
  does not add a binary to app images.
- Apply `Init` to every runner container; it is harmless for one-shots and avoids a second code path.
- Keep the configured memory cap. The fix bounds Hanse-owned queues and caches; `opencode`'s own
  session/runtime memory remains outside this repository.
- Do not change isolation or the deploy contracts (`/readyz`, deployment lock, schema guard,
  revision identity).

## Verification

- `npm run lint` - clean (831 files).
- `npm run typecheck` and `npm run typecheck:ui` - clean.
- `npm test` - 242 files passed, 1 skipped; 3576 tests passed, 1 skipped. The skip is the opt-in
  Docker reaper soak.
- `npm run build` - clean.
- `npm run check:ui` - clean (79 SFCs, sentinel present).
- `npm run check:sensitive` - clean.
- The Docker soak was not executed in this environment (no Docker socket). Run it with
  `HANSE_TEST_DOCKER=1 HANSE_TEST_SOAK_IMAGE=debian:bookworm-slim npx vitest run
  test/container-reaper.integration.test.ts`.

## Before/after evidence

The operator reported the pre-fix container at hundreds of zombie processes with RSS near its
configured cap. Recreating it returned to zero zombies and a small idle footprint. The fix removes
the cause (no reaper) rather than resetting the symptom; the opt-in soak is the repeatable check.

## Follow-ups

- Run a multi-day soak with real sessions and MCP tools, and watch RSS and PID counts.
- Treat `opencode`'s own session/runtime memory as a separate upstream concern (retention or
  compaction), not a reason to raise the cap.
- Host/supervisor mode still kills only the direct child; runner mode is the production boundary and
  the container lifecycle is the hard teardown.
