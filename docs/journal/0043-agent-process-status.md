# 0043 - Agent process lifecycle and status tracking

Stage: `0036-agent-process-status`
Design: [`docs/design/agent-process-status.md`](../design/agent-process-status.md) (`oracle` round 3 PASS)
Plan: [`docs/plans/0036-agent-process-status.md`](../plans/0036-agent-process-status.md) (`momus` round 2 OKAY)
Current state: [`docs/current-state.md`](../current-state.md)
Commit: not made; owner authorization is still required

## Context

The chat Start button was a component-local flag, the durable row was written only after the long
runtime call, a failed readiness wait was visible only as a transient toast, and an `error` row
rendered as the same neutral "Agent is not running" shell as `stopped`. A remount during a slow start
therefore re-enabled Start, and the operator could not see what the last attempt did. Stage 0036
makes the agent process a durable object with one writer, bounded history, two human-only read
surfaces, an always-on SSE stream, and distinct chat, application-page, and overview presentations.
The design decisions and requirement IDs (L1-L12) are frozen in the design document; this record
summarizes the shipped implementation and evidence without restating the design.

## What shipped

### Schema and store (Phase A)

- Migration v23 is append-only after v22. It adds `instances.process_attempt_id`, `process_phase`,
  `process_started_at`, `process_error_code`, `process_error_message`, `process_error_at`, and
  `process_updated_at`, and backfills `process_phase` from the coarse state
  (`running -> ready`, `starting -> requested`, `stopped -> stopped`, `failed`/`error -> failed`)
  with `process_updated_at = updated_at`.
- `agent_run_events` stores append-only history with a global `id`, `app_id` FK cascade,
  `attempt_id`, positive `seq`, normalized `state`, nullable `phase`, `source`, bounded
  `reason`/`error_code`/`message`, and `created_at`. The unique `(app_id, attempt_id, seq)` index,
  the `(app_id, id DESC)` read index, and the `created_at` index implement the history and retention
  queries.
- `src/store/process.ts` adds the process types, `readProcess`, `readProcessSnapshot` (one statement
  with a `MAX(id)` scalar subquery), `readProcessEvents` (newest first, `before` cursor, 1..100),
  `pruneProcessEvents` (newest 1,000 per app), and `pruneAllProcessEvents` (30 days, all apps,
  batches of 500).

### Manager lifecycle (Phase B)

- `InstanceManager.#transitionProcess` is the single process writer. Every caller holds the per-app
  lock; the helper never acquires it. One transaction upserts the current row, inserts the history
  row, allocates `seq = MAX(seq)+1`, validates the state/phase pair, normalizes legacy `failed` to
  `error`, and sanitizes the message. After commit it queues the existing runtime observation and
  emits on the module-level `processEvents` bus.
- `#launches` is a `Map<string, Promise<string>>` that resolves the endpoint and is registered
  synchronously by `ensure`, `beginRestart`, `restartIfRunning`, and `rollbackImage`. A duplicate
  start returns the in-flight promise; a restart during a start chains after it; a start during a
  restart joins it.
- The attempt boundary follows the design: explicit start, restart of a running/starting app, and
  lazy start are new attempts; reconnect is visible without a new attempt; stop closes the current
  attempt; restart of a stopped app is a no-op; an out-of-band restart creates a runtime-keyed
  attempt. Pre-attempt refusals write nothing; an image-preflight failure writes the attempt.
- Write order is `requested -> preparing -> creating -> waiting_ready -> ready`; `running`/`ready`
  is written only after readiness succeeds and sets `instances.started_at`. Reconnect writes
  `starting`/`waiting_ready` before reconciliation and readiness when the persisted state is not
  `running`, then `running`/`ready` on success or `token_reconcile_failed`/`readiness_timeout` on
  failure.
- Restart is one attempt. Its stop half uses `terminal=false` and suppresses the generic terminal
  `stopped` write, event, coarse change, and observation. A stop failure writes
  `error`/`runtime_unavailable`; `#handleRestartFailure` treats the same attempt/state/code as a
  no-op.
- The 15 s reconciler never promotes `error` or an ownerless `starting` from Docker state alone. It
  runs a bounded readiness probe, keeps an `error` sticky, interrupts a stale ownerless `starting`
  only after the probe fails and `process_updated_at` is at least 90 s old (or the runtime is
  absent), and promotes a healthy probe to `running`/`ready`. Out-of-band restarts append history
  even when the coarse state stays `running`.
- `sanitizeProcessError` removes ANSI/control characters, keeps the first line, redacts
  Bearer/Authorization values, credential-shaped tokens, private-key blocks, and caller-supplied
  secrets, caps at 2,000 characters, and substitutes a generic code-keyed message for an unknown
  internal exception. Stable codes are `image_unavailable`, `default_image_unavailable`,
  `token_reconcile_failed`, `skills_materialize_failed`, `readiness_timeout`, `runtime_unavailable`,
  and `interrupted`.
- Retention is wired: every transition prunes the app to its newest 1,000 events, and every
  reconciler tick prunes events older than 30 days for all apps regardless of state.

### Read API and props (Phase C)

- `GET /api/apps/:app/runtime` keeps every existing field and adds the `process` block
  (`attemptId`, `phase`, `startedAt`, `updatedAt`, `error`, `lastEventId`). It stays DB-only and
  keeps the in-memory `restarting` flag.
- `GET /api/apps/:app/process` returns `{current, events, nextCursor}` with newest-first history,
  `limit` 1..100 (default 50), positive-integer `before`, and a string or null cursor.
- Both routes are human-only and require `?project`. They reject an agent principal with `403`, a
  missing project with `400`, an unknown app with `404`, and a deleting app with
  `409 deletion_pending`, and never probe the agent runtime.
- `SiteModel` carries the process detail. Chat and application props include it without changing the
  existing runtime counts; the overview summary excludes the master and orders affected apps by
  `process_updated_at` descending.

### Process SSE (Phase D)

- `GET /api/apps/:app/process/events` is always available while stopped, starting, stopping, or in
  error. It sends `stream.ready` (`seq: 0`), `process.snapshot` (`seq: 1`, `{current,
  lastEventId}`), and `process.transition` (`seq: 2+`) in the existing `{seq, streamID}` envelope.
- The route subscribes into a bounded 256-frame buffer before the one-statement snapshot, flushes
  transitions with `id > lastEventId`, and filters or dedupes every later delivery by id. Global ids
  are not per-app contiguous, so no `id+1` gap check is used. `stream.warning` covers
  `process_buffer_overflow`, `process_snapshot_failed`, and `process_slow_consumer` (over 1 MiB
  queued).
- A separate `ProcessStreamRegistry` allows 4 browser streams per app; the fifth gets
  `429 stream_limit`. The client closes the `EventSource` on 429/terminal errors and falls back to
  the existing polling with backoff.
- The route is dispatched before the `/api/apps/` chat catch-all and works with `deps.manager`
  undefined.

### UI (Phases E and F)

- Chat uses the process state as authoritative over transport `503`s. Only `agent_stopped` confirms
  stopped; `agent_starting` maps to starting, and `agent_unavailable`/`default_image_unavailable`
  map to their own error presentations. Starting, stopping, stopped, and error render distinct
  panels; stopping is never labelled Starting. Start/Retry is disabled from server state during
  `starting`/`stopping`, including after a remount. A failed POST refetches the process view.
- The application Runtime strip shows phase and elapsed time for starting/stopping. An error shows
  the sanitized message and time plus a `#process-history` disclosure that fetches
  `/api/apps/:app/process?limit=50&project=<id>`, renders newest first, dedupes by id, and supports
  Load older. The 10 s runtime poll remains the fallback and the page subscribes to the process SSE
  while visible.
- The overview adds the Agent processes block with starting/stopping/error counts and up to five
  affected applications (starting or error), with chat and application links. It excludes the
  master and is hidden when empty; the existing watch strip is unchanged.

## Decisions and rationale

The ten owner-confirmed defaults are implemented as written: full lifecycle history; chat,
application page, and compact overview surfaces; SSE with a snapshot and per-app `lastEventId`
(polling remains a fallback); 1,000 events per app and 30 days; sanitized runner text with no
secrets and a generic code-keyed fallback; lazy starts as `system` attempts with a caller reason;
the coarse `starting` count may include `stopping` while the new block splits them by phase;
restart of a stopped app is a no-op with no attempt; and an explicit stop from `error` clears the
current error fields while retaining the history event.

Implementation choices that follow from those decisions:

- One writer and one transaction keep the current row and history consistent; `seq` is allocated
  under the same lock so concurrent writers cannot duplicate a sequence.
- The attempt is written before the long preparation and readiness wait, which closes the remount
  window without changing the synchronous start contract.
- `stopping` maps to coarse `starting` for compatibility. Existing readers keep their vocabulary;
  the new UI uses the phase and the overview block splits the counts.
- Process state is process-level. OpenCode turn errors, retries, and compaction stay in the existing
  chat machinery.

## Artifacts and files

- Schema/store: `src/store/migrations.ts`, `src/store/process.ts`.
- Runtime: `src/opencode/manager.ts`, `src/opencode/process-events.ts`,
  `src/opencode/process-errors.ts`.
- HTTP and props: `src/http/process.ts`, `src/http/handler.ts`, `src/http/server.ts`,
  `src/http/dashboard.ts`, `src/http/props/{chat,app,overview}.ts`.
- UI: `ui/process/{types,stream}.ts`, `ui/composables/useAgentProcess.ts`,
  `ui/pages/{ChatPage,AppPage,OverviewPage}.vue`, `ui/components/chat/ChatThread.vue`,
  `ui/components/AppStateStrip.vue`, `ui/status.ts`, `ui/app-types.ts`.
- Tests: `test/migrations.test.ts`, `test/process-store.test.ts`, `test/process-http.test.ts`,
  `test/process-sse.test.ts`, `test/process-sanitizer.test.ts`, `test/manager.test.ts`,
  `test/application-props.test.ts`, `test/dashboard-runtime.test.ts`, `test/ui/chat-page.test.ts`,
  `ui/pages/AppPage.test.ts`, `ui/pages/OverviewPage.test.ts`, `ui/process/stream.test.ts`,
  `e2e/{app,chat,overview,spa-chat}.spec.ts`, and `e2e/support/{seed,server}.ts`.
- Documentation: this record, `docs/current-state.md` (new process section and schema v23), the
  design/plan status lines, the design/plan/journal indexes, and `docs/open-questions.md`.

## Verification

Run on 2026-11-07 from the repository root, in the order required by `docs/process.md`:

| Command | Result |
| --- | --- |
| `npm run lint` | pass, 806 files checked, no fixes applied |
| `npm run typecheck` | pass |
| `npm run typecheck:ui` | pass |
| `npm test` | pass, 238 test files, 3,580 tests, 793.41 s |
| `npm run build` | pass, `tsc`, Tailwind CSS, and Vite (283 modules) |
| `npm run check:sensitive` | pass |
| `npm run test:e2e` | pass, 229 tests: 223 passed, 6 skipped, 11.2 min |

The only gate correction was test-only: `e2e/chat.spec.ts:134` now accounts for the application
page's process stream when asserting the cumulative EventSource count (`(cycle + 1) * 3`) and for
the one active process stream after returning to the application page. The first full matrix run
also saw one flaky `e2e/spa-chat.spec.ts:941` failure; it passed on a targeted rerun and in the final
full matrix. No product code, migration, or UI file was changed to clear the gate.

## Accepted debt and limitations

- The coarse `starting` count and coarse-state readers include `stopping` by design. The new overview
  block splits them by phase.
- History is bounded to 1,000 events per app and 30 days, with no backfill before v23.
- There is no container-log streaming, no turn-level error history, and no cancellation of an
  in-flight start. A stop during `starting` still waits for the attempt to finish.
- A legacy row without an attempt has no attempt id and a null phase until its next event; the UI
  falls back to the coarse state.
- The process SSE is best-effort. Polling is the correctness fallback when the stream is limited,
  paused, or unavailable.

## Next steps

- The test-only `e2e/chat.spec.ts` navigation count was corrected and the full E2E matrix is green.
- Obtain explicit owner authorization before the single stage commit, then commit code, tests, and
  documentation together. Do not push or deploy without that authorization.
- After deployment, verify the process SSE and the chat/application/overview states against a running
  app, including a slow start, a readiness failure, and a stop.
